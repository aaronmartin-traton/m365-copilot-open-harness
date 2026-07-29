import * as msal from "@azure/msal-node";
import { spawn } from "node:child_process";
import { get as httpGet } from "node:http";
import { createServer } from "node:net";
import { chromium } from "playwright";
import { z } from "zod";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "./log.js";

const CLIENT_ID = "c0ab8ce9-e9a0-42e7-b064-33d422df41f1";
const AUTHORITY = "https://login.microsoftonline.com/common";
const REDIRECT_URI = "https://login.microsoftonline.com/common/oauth2/nativeclient";
const SCOPES = [
  "https://substrate.office.com/sydney/M365Chat.Read",
  "https://substrate.office.com/sydney/sydney.readwrite",
];

const log = createLogger("auth");
const CONFIG_DIR = join(homedir(), ".config", "opencode-m365");

mkdirSync(CONFIG_DIR, { recursive: true });
const CACHE_FILE = process.env.M365_CACHE_FILE ?? join(CONFIG_DIR, "msal-cache.json");
const BROWSER_PROFILE_DIR =
  process.env.M365_BROWSER_PROFILE ?? join(CONFIG_DIR, "browser-profile-cdp");

function loadCache(app: msal.PublicClientApplication): void {
  if (!existsSync(CACHE_FILE)) return;
  try {
    app.getTokenCache().deserialize(readFileSync(CACHE_FILE, "utf-8"));
  } catch (error: unknown) {
    log.error(`Failed to load MSAL cache: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function saveCache(app: msal.PublicClientApplication): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, app.getTokenCache().serialize(), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

let appInstance: msal.PublicClientApplication | null = null;

function getApp(): msal.PublicClientApplication {
  if (!appInstance) {
    appInstance = new msal.PublicClientApplication({
      auth: { clientId: CLIENT_ID, authority: AUTHORITY },
    });
    loadCache(appInstance);
  }
  return appInstance;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a loopback port for Chromium");
  }
  const closed = Promise.withResolvers<void>();
  server.close((error) => (error ? closed.reject(error) : closed.resolve()));
  await closed.promise;
  return address.port;
}

const cdpVersionSchema = z.object({ webSocketDebuggerUrl: z.string() });
const cdpEnvelopeSchema = z.object({
  id: z.number().optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  sessionId: z.string().optional(),
  error: z.object({ message: z.string() }).optional(),
});
const targetResultSchema = z.object({ targetId: z.string() });
const sessionResultSchema = z.object({ sessionId: z.string() });
const requestEventSchema = z.object({
  request: z.object({ url: z.string() }),
});

interface PendingCdpOperation {
  promise: Promise<unknown>;
  resolve(value: unknown | PromiseLike<unknown>): void;
  reject(reason?: unknown): void;
}

type CdpEventHandler = (method: string, params: unknown, sessionId?: string) => void;

class CdpClient {
  private readonly socket: WebSocket;
  private readonly pending = new Map<number, PendingCdpOperation>();
  private readonly eventHandlers = new Set<CdpEventHandler>();
  private nextId = 1;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => this.handleMessage(event.data));
    socket.addEventListener("close", () => {
      for (const operation of this.pending.values()) {
        operation.reject(new Error("Chromium debugging connection closed"));
      }
      this.pending.clear();
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    const opened = Promise.withResolvers<void>();
    socket.addEventListener("open", () => opened.resolve(), { once: true });
    socket.addEventListener("error", () => opened.reject(new Error("Could not connect to Chromium debugging WebSocket")), { once: true });
    await opened.promise;
    return new CdpClient(socket);
  }

  onEvent(handler: CdpEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  command(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    const id = this.nextId++;
    const operation = Promise.withResolvers<unknown>();
    this.pending.set(id, operation);
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return operation.promise;
  }

  close(): void {
    this.socket.close();
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = cdpEnvelopeSchema.safeParse(decoded);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.id !== undefined) {
      const operation = this.pending.get(message.id);
      if (!operation) return;
      this.pending.delete(message.id);
      if (message.error) operation.reject(new Error(message.error.message));
      else operation.resolve(message.result);
      return;
    }
    if (message.method) {
      for (const handler of this.eventHandlers) {
        handler(message.method, message.params, message.sessionId);
      }
    }
  }
}

async function getCdpWebSocketUrl(endpoint: string): Promise<string> {
  const completed = Promise.withResolvers<string>();
  const request = httpGet(`${endpoint}/json/version`, (response) => {
    response.setEncoding("utf-8");
    let body = "";
    response.on("data", (chunk: string) => {
      body += chunk;
    });
    response.on("end", () => {
      try {
        completed.resolve(cdpVersionSchema.parse(JSON.parse(body)).webSocketDebuggerUrl);
      } catch (error: unknown) {
        completed.reject(error);
      }
    });
  });
  request.once("error", completed.reject);
  request.setTimeout(500, () => request.destroy(new Error("Chromium endpoint timed out")));
  return completed.promise;
}

export type AuthUrlHandler = (url: string) => void;

/**
 * Authenticate in a visible Chromium window through Microsoft's authorization-code
 * flow with PKCE. Bun drives Chromium through its native WebSocket implementation;
 * credentials and MFA are entered only on Microsoft's sign-in page.
 */
export async function loginInteractive(
  scopes: string[] = SCOPES,
  onAuthUrl: AuthUrlHandler = () => {},
): Promise<string> {
  const app = getApp();
  const cryptoProvider = new msal.CryptoProvider();
  const { verifier, challenge } = await cryptoProvider.generatePkceCodes();
  const authUrl = await app.getAuthCodeUrl({
    scopes,
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
  });

  const debuggingPort = await reserveLoopbackPort();
  const browserProcess = spawn(
    process.env.CHROMIUM_PATH ?? chromium.executablePath(),
    [
      `--remote-debugging-port=${debuggingPort}`,
      `--user-data-dir=${BROWSER_PROFILE_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
    { stdio: "ignore" },
  );
  const endpoint = `http://127.0.0.1:${debuggingPort}`;
  let webSocketUrl: string | null = null;
  for (let attempt = 0; attempt < 100 && !webSocketUrl; attempt++) {
    try {
      webSocketUrl = await getCdpWebSocketUrl(endpoint);
    } catch {
      const delay = Promise.withResolvers<void>();
      setTimeout(delay.resolve, 100);
      await delay.promise;
    }
  }
  if (!webSocketUrl) {
    browserProcess.kill();
    throw new Error("Chromium did not expose its local debugging endpoint");
  }

  const cdp = await CdpClient.connect(webSocketUrl);
  const target = targetResultSchema.parse(
    await cdp.command("Target.createTarget", { url: "about:blank" }),
  );
  const session = sessionResultSchema.parse(
    await cdp.command("Target.attachToTarget", { targetId: target.targetId, flatten: true }),
  );
  await cdp.command("Network.enable", {}, session.sessionId);
  await cdp.command("Page.enable", {}, session.sessionId);
  await cdp.command("Target.activateTarget", { targetId: target.targetId });

  const authCode = Promise.withResolvers<string>();
  const removeEventHandler = cdp.onEvent((method, params, sessionId) => {
    if (method !== "Network.requestWillBeSent" || sessionId !== session.sessionId) return;
    const event = requestEventSchema.safeParse(params);
    if (!event.success) return;
    const url = event.data.request.url;
    if (!url.includes("/oauth2/nativeclient") || !url.includes("code=")) return;
    const code = new URL(url).searchParams.get("code");
    if (code) authCode.resolve(code);
  });

  try {
    await cdp.command("Page.navigate", { url: authUrl }, session.sessionId);
    onAuthUrl(authUrl);
    const loginTimeout = Promise.withResolvers<string>();
    const loginTimeoutHandle = setTimeout(
      () => loginTimeout.reject(new Error("Timed out waiting for Microsoft login")),
      900_000,
    );
    const code = await Promise.race([authCode.promise, loginTimeout.promise]).finally(() =>
      clearTimeout(loginTimeoutHandle),
    );
    const result = await app.acquireTokenByCode({
      code,
      scopes,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
    });
    saveCache(app);
    log.info(`Interactive login succeeded as ${result.account?.username ?? "unknown account"}`);
    return result.accessToken;
  } finally {
    removeEventHandler();
    cdp.close();
    if (!browserProcess.killed) browserProcess.kill();
  }
}

async function acquireSilent(scopes: string[]): Promise<string | null> {
  const app = getApp();
  const accounts = await app.getTokenCache().getAllAccounts();
  if (accounts.length === 0) return null;

  try {
    const result = await app.acquireTokenSilent({ scopes, account: accounts[0] });
    saveCache(app);
    return result.accessToken;
  } catch (error: unknown) {
    log.info(`Silent token acquisition failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function getTokenSilent(): Promise<string | null> {
  return acquireSilent(SCOPES);
}

export function getTokenForScope(scopes: string[]): Promise<string | null> {
  return acquireSilent(scopes);
}

let inflightReauth: Promise<boolean> | null = null;

export function forceReauth(): Promise<boolean> {
  return (inflightReauth ??= getTokenSilent()
    .then((token) => !!token)
    .finally(() => {
      inflightReauth = null;
    }));
}

let inflightToken: Promise<string> | null = null;

export function getToken(): Promise<string> {
  return (inflightToken ??= getTokenSilent()
    .then((token) => {
      if (token) return token;
      throw new Error(
        "No cached Microsoft token. Run m365-login interactively, then restart the proxy.",
      );
    })
    .finally(() => {
      inflightToken = null;
    }));
}
