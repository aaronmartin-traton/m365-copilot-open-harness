/**
 * Microsoft 365 sign-in: OAuth 2.0 authorization-code with PKCE, driven through a
 * browser the user can see over the Chrome DevTools Protocol, plus the JSON token
 * cache (per-scope access tokens with refresh-token rotation).
 *
 * There is no MSAL and no Playwright here. The authorization code is caught from
 * the `nativeclient` redirect the sign-in page performs (it never loads, so the
 * navigation request is where the code appears); the tokens are exchanged with a
 * plain `fetch` and stored as JSON. The password and MFA response are entered only
 * on Microsoft's sign-in page — the proxy never sees them.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { createLogger } from "./log.js";

export const CLIENT_ID = "c0ab8ce9-e9a0-42e7-b064-33d422df41f1";
export const AUTHORITY = "https://login.microsoftonline.com/common";
export const AUTHORIZE_ENDPOINT = `${AUTHORITY}/oauth2/v2.0/authorize`;
export const TOKEN_ENDPOINT = `${AUTHORITY}/oauth2/v2.0/token`;
export const REDIRECT_URI = `${AUTHORITY}/oauth2/nativeclient`;

/** The Microsoft 365 Copilot chat scopes; the default for every token call. */
export const SCOPES = [
  "https://substrate.office.com/sydney/M365Chat.Read",
  "https://substrate.office.com/sydney/sydney.readwrite",
] as const;

export const IMAGE_ARTIFACT_SCOPES = ["https://designerappservice.officeapps.live.com/.default"] as const;

const log = createLogger("auth");

const CONFIG_DIR = join(homedir(), ".config", "opencode-m365");

/**
 * A sign-in failure. `message` is what the operator reads, so it stays plain
 * language; `detail` carries the raw browser/OAuth text for a support log and is
 * never used as the message.
 */
export class AuthenticationError extends Error {
  readonly detail: string | null;

  constructor(message: string, detail?: string) {
    super(message);
    this.name = "AuthenticationError";
    this.detail = detail === undefined || detail.length === 0 ? null : detail;
  }
}

/** Plain-language text for the OAuth error codes Microsoft's sign-in returns. */
const OAUTH_ERROR_TEXT: Record<string, string> = {
  access_denied: "You cancelled the Microsoft 365 sign-in. Try again when you are ready.",
  consent_required: "Microsoft 365 needs your permission before the proxy can use it. Sign in again and accept the prompt.",
  interaction_required: "Microsoft 365 needs you to sign in again. Follow the prompts in the browser window.",
  invalid_client: "This PC is not set up for Microsoft 365 sign-in. Ask your IT team for help.",
  invalid_grant: "Your Microsoft 365 sign-in has expired. Sign in again.",
  login_required: "Microsoft 365 needs you to sign in again. Follow the prompts in the browser window.",
  unauthorized_client: "Your organization does not allow this app to sign in to Microsoft 365. Ask your IT team to approve it.",
};

const BROWSER_TROUBLE =
  "Microsoft sign-in could not start. Close any browser windows already using the sign-in profile, then try again.";
const BROWSER_CLOSED =
  "The sign-in window closed before sign-in finished. Try again when you are ready.";
const SIGN_IN_TIMED_OUT =
  "Microsoft 365 sign-in was not completed in time. Run the login script again.";
/** Fallback when Microsoft reports a failure we cannot map to a specific fix. */
const SIGN_IN_FAILED =
  "Microsoft 365 did not finish signing you in. Run the login script again.";

// --- JSON values ------------------------------------------------------------

/** A JSON value as delivered by Microsoft's endpoints and the CDP socket. */
export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

/** A JSON object as delivered by Microsoft's endpoints and the CDP socket. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Re-read a value that crossed an untyped boundary as a JSON object, or null. */
function asJsonObject(value: unknown): JsonObject | null {
  return isJsonObject(value) ? value : null;
}

function stringField(record: JsonObject, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function numberField(record: JsonObject, key: string): number | null {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Sleeps for `ms`; the only awaiting primitive the browser plumbing needs. */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** `undefined`-safe read of one environment knob. */
function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

// --- Chrome DevTools Protocol ----------------------------------------------

interface CdpMessage {
  readonly id?: JsonValue;
  readonly method?: string;
  readonly params?: JsonValue;
  readonly result?: JsonValue;
  readonly error?: JsonValue;
  readonly sessionId?: string;
}

/** Raised when a browser command is not answered within its timeout. */
class CdpTimeout extends Error {}

/**
 * A minimal async facade over the platform WebSocket for the CDP session: it
 * opens, decodes each frame, and hands every message to its subscriber the
 * moment it arrives. It queues nothing — the owner decides what a message means.
 */
class CdpSocket {
  private readonly socket: WebSocket;
  private readonly messageHandlers = new Set<(message: CdpMessage) => void>();
  private readonly failureHandlers = new Set<(error: Error) => void>();
  private failure: Error | null = null;
  private readonly opened: Promise<void>;
  private resolveOpen!: () => void;
  private rejectOpen!: (error: Error) => void;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.opened = new Promise<void>((resolve, reject) => {
      this.resolveOpen = resolve;
      this.rejectOpen = reject;
    });
    this.socket.addEventListener("open", () => {
      this.resolveOpen();
    });
    this.socket.addEventListener("message", (event) => {
      const data: unknown = event.data;
      if (typeof data !== "string") return;
      let message: CdpMessage;
      try {
        const parsed: unknown = JSON.parse(data);
        const record = asJsonObject(parsed);
        if (record === null) return;
        message = {
          id: record["id"],
          method: stringField(record, "method") ?? undefined,
          params: record["params"],
          result: record["result"],
          error: record["error"],
          sessionId: stringField(record, "sessionId") ?? undefined,
        };
      } catch {
        return;
      }
      for (const handler of this.messageHandlers) handler(message);
    });
    this.socket.addEventListener("error", () => {
      this.fail(new AuthenticationError(BROWSER_TROUBLE, "The browser connection failed (CDP WebSocket error)"));
    });
    this.socket.addEventListener("close", () => {
      this.fail(new AuthenticationError(BROWSER_CLOSED, "The browser closed the CDP connection"));
    });
  }

  /** Subscribes to every message the browser sends; returns an unsubscribe. */
  onMessage(handler: (message: CdpMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  /** Subscribes to the socket failing or closing; returns an unsubscribe. */
  onFailure(handler: (error: Error) => void): () => void {
    this.failureHandlers.add(handler);
    return () => {
      this.failureHandlers.delete(handler);
    };
  }

  private fail(error: Error): void {
    if (this.failure === null) this.failure = error;
    this.rejectOpen(error);
    for (const handler of this.failureHandlers) handler(error);
  }

  async ready(timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new AuthenticationError(BROWSER_TROUBLE, `Timed out starting the browser (${timeoutMs} ms)`));
      }, timeoutMs);
      this.opened.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  send(payload: string): void {
    this.socket.send(payload);
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // The connection may already be gone.
    }
  }
}

/** One request the browser made, as CDP's Network domain reported it. */
export interface BrowserRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** A page (CDP target) inside a {@link BrowserSession}. */
export interface BrowserPage {
  /** Subscribes to the page's requests; returns an unsubscribe. */
  onRequest(listener: (request: BrowserRequest) => void): () => void;
  /** Navigates and resolves once the document has committed. */
  navigate(url: string): Promise<void>;
  /** The page's current URL. */
  currentUrl(): Promise<string>;
  /** Runs `fn` in the page and returns its JSON result, mirroring Playwright's evaluate. */
  evaluate<TInput, TResult>(fn: (input: TInput) => Promise<TResult>, input: TInput): Promise<TResult>;
  /** Sleeps for `ms` (Playwright's `page.waitForTimeout`). */
  waitForTimeout(ms: number): Promise<void>;
  /** Rejects when the browser connection drops; never resolves. */
  readonly closed: Promise<never>;
}

function requestFromMessage(message: CdpMessage): BrowserRequest | null {
  if (message.method !== "Network.requestWillBeSent") return null;
  const params = asJsonObject(message.params);
  if (params === null) return null;
  const request = asJsonObject(params["request"]);
  if (request === null) return null;
  const url = stringField(request, "url");
  if (url === null) return null;
  const method = stringField(request, "method") ?? "GET";
  const headersRecord = asJsonObject(request["headers"]);
  const headers: Record<string, string> = {};
  if (headersRecord !== null) {
    for (const [name, value] of Object.entries(headersRecord)) {
      if (typeof value === "string") headers[name] = value;
    }
  }
  return { url, method, headers };
}

/**
 * A browser driven over CDP against a persistent profile (Microsoft's cookies
 * live there, so a repeat sign-in can complete without asking again). Normally
 * launched as a child process, which it then owns; {@link BrowserSession.attach}
 * drives a browser someone else started.
 */
export class BrowserSession {
  private readonly connection: CdpConnection;
  private readonly child: ChildProcess | null;
  private readonly terminated: Promise<void>;
  private closed = false;

  private constructor(connection: CdpConnection, child: ChildProcess | null) {
    this.connection = connection;
    this.child = child;
    this.terminated = new Promise<void>((resolve) => {
      if (child === null) resolve();
      else if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
  }

  /** Launches `executable` against `profileDir` and connects to its debug port. */
  static async launch(options: {
    readonly executable: string;
    readonly profileDir: string;
    readonly headless: boolean;
  }): Promise<BrowserSession> {
    await mkdir(options.profileDir, { recursive: true });
    const port = await reservePort();
    const args = [
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${options.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      ...(options.headless ? ["--headless=new"] : []),
      "about:blank",
    ];
    let child: ChildProcess;
    try {
      child = spawn(options.executable, args, { stdio: "ignore" });
    } catch {
      throw new AuthenticationError(BROWSER_TROUBLE, `Could not start the browser: ${options.executable}`);
    }
    let gone = false;
    child.on("error", () => {
      gone = true;
    });
    child.on("exit", () => {
      gone = true;
    });
    let socket: CdpSocket;
    try {
      socket = await connectDebugger(child, port, () => gone);
    } catch (error) {
      child.kill("SIGKILL");
      throw error;
    }
    return new BrowserSession(new CdpConnection(socket), child);
  }

  /** Connects to a browser already serving CDP at `debuggerUrl`. */
  static async attach(debuggerUrl: string): Promise<BrowserSession> {
    const socket = new CdpSocket(debuggerUrl);
    await socket.ready(30_000);
    return new BrowserSession(new CdpConnection(socket), null);
  }

  /** Creates a fresh page target and attaches a flattened session to it. */
  async openPage(): Promise<BrowserPage> {
    const target = await this.connection.call("Target.createTarget", { url: "about:blank" }, "");
    const targetId = stringField(target, "targetId");
    if (targetId === null) {
      throw new AuthenticationError(BROWSER_TROUBLE, "CDP Target.createTarget returned no targetId");
    }
    const attached = await this.connection.call("Target.attachToTarget", { targetId, flatten: true }, "");
    const sessionId = stringField(attached, "sessionId");
    if (sessionId === null) {
      throw new AuthenticationError(BROWSER_TROUBLE, "CDP Target.attachToTarget returned no sessionId");
    }
    await this.connection.call("Network.enable", {}, sessionId);
    await this.connection.call("Page.enable", {}, sessionId);
    return new CdpPage(this.connection, sessionId);
  }

  /** Whether the browser process is still running. */
  alive(): boolean {
    if (this.closed) return false;
    if (this.child === null) return true;
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  /** Waits for the browser process to exit, resolving false on timeout. */
  async waitForExit(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, timeoutMs);
      void this.terminated.then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /** Asks the browser to close, then kills the process if it lingers. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.connection.call("Browser.close", {}, "", 3_000);
    } catch {
      // The browser may already be gone.
    }
    this.connection.close();
    if (this.child === null) return;
    if (await this.waitForExit(10_000)) return;
    this.child.kill("SIGKILL");
    await this.waitForExit(5_000);
  }
}

class CdpPage implements BrowserPage {
  private readonly connection: CdpConnection;
  private readonly sessionId: string;

  readonly closed: Promise<never>;

  constructor(connection: CdpConnection, sessionId: string) {
    this.connection = connection;
    this.sessionId = sessionId;
    this.closed = connection.closed;
  }

  onRequest(listener: (request: BrowserRequest) => void): () => void {
    return this.connection.onMessage((message) => {
      if (message.sessionId !== undefined && message.sessionId !== this.sessionId) return;
      const request = requestFromMessage(message);
      if (request !== null) listener(request);
    });
  }

  async navigate(url: string): Promise<void> {
    await this.connection.call("Page.navigate", { url }, this.sessionId, 60_000);
  }

  async currentUrl(): Promise<string> {
    const value = await this.evaluate(() => Promise.resolve(location.href), null);
    return value;
  }

  async waitForTimeout(ms: number): Promise<void> {
    await delay(ms);
  }

  async evaluate<TInput, TResult>(
    fn: (input: TInput) => Promise<TResult>,
    input: TInput,
  ): Promise<TResult> {
    const expression = `(${fn.toString()})(${JSON.stringify(input)})`;
    const result = await this.connection.call(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      this.sessionId,
      30_000,
    );
    if (result.exceptionDetails !== undefined) {
      throw new AuthenticationError(
        "The sign-in browser could not run a page script.",
        `CDP Runtime.evaluate raised: ${JSON.stringify(result.exceptionDetails)}`,
      );
    }
    const remote = asJsonObject(result.result);
    if (remote === null) {
      throw new AuthenticationError(BROWSER_TROUBLE, "CDP Runtime.evaluate returned no result");
    }
    // The page returned a JSON value by value; TResult is the caller's declaration
    // of that value, checked only by this method's generic contract.
    return remote["value"] as TResult;
  }
}

/**
 * A command/response channel over one CDP socket. Every message is dispatched
 * the instant it arrives: a reply settles the command that is waiting for it,
 * anything else goes to the page listeners — whether or not a command happens
 * to be in flight. Waiting only inside `call` would strand the events that
 * arrive between commands, which is every event that follows a reply.
 */
class CdpConnection {
  private readonly socket: CdpSocket;
  private readonly listeners = new Set<(message: CdpMessage) => void>();
  private readonly pending = new Map<number, { resolve: (message: CdpMessage) => void; reject: (error: Error) => void }>();
  private readonly lost = Promise.withResolvers<never>();
  private counter = 0;

  /** Rejects when the socket fails or closes; never resolves. */
  readonly closed: Promise<never> = this.lost.promise;

  constructor(socket: CdpSocket) {
    this.socket = socket;
    // The connection can die while nobody awaits `closed`; keep that from
    // surfacing as an unhandled rejection. Awaiting it still rejects.
    void this.closed.catch(() => {});
    socket.onMessage((message) => this.dispatch(message));
    socket.onFailure((error) => {
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
      this.lost.reject(error);
    });
  }

  private dispatch(message: CdpMessage): void {
    const id = message.id;
    if (typeof id === "number") {
      const waiter = this.pending.get(id);
      if (waiter !== undefined) {
        this.pending.delete(id);
        waiter.resolve(message);
        return;
      }
    }
    for (const listener of this.listeners) listener(message);
  }

  onMessage(listener: (message: CdpMessage) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Sends a command and resolves with its result. */
  async call(
    method: string,
    params: JsonObject,
    sessionId: string,
    timeoutMs?: number,
  ): Promise<JsonObject> {
    this.counter += 1;
    const id = this.counter;
    const command: Record<string, JsonValue> = { id, method, params };
    if (sessionId.length > 0) command.sessionId = sessionId;
    const message = await this.exchange(id, () => {
      this.socket.send(JSON.stringify(command));
    }, timeoutMs);
    if (message.error !== undefined) {
      throw new AuthenticationError(
        BROWSER_TROUBLE,
        `Browser setup failed: CDP ${method} returned ${JSON.stringify(message.error)}`,
      );
    }
    return asJsonObject(message.result) ?? {};
  }

  /** Writes `command` and resolves with the reply that carries the same id. */
  private exchange(
    id: number,
    write: () => void,
    timeoutMs: number | undefined,
  ): Promise<CdpMessage> {
    return new Promise<CdpMessage>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const waiter = {
        resolve: (message: CdpMessage): void => {
          clearTimeout(timer);
          resolve(message);
        },
        reject: (error: Error): void => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.pending.set(id, waiter);
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          reject(new CdpTimeout("Timed out waiting for a browser message"));
        }, timeoutMs);
      }
      try {
        write();
      } catch (error) {
        this.pending.delete(id);
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    this.socket.close();
  }
}

/** Reserves an ephemeral loopback port for the browser's debug endpoint. */
async function reservePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", () => {
      reject(new AuthenticationError(BROWSER_TROUBLE, "Could not reserve a browser debugging port"));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === "string") {
          reject(new AuthenticationError(BROWSER_TROUBLE, "Could not reserve a browser debugging port"));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

/** Polls the debug endpoint for its WebSocket URL, then connects to it. */
async function connectDebugger(child: ChildProcess, port: number, gone: () => boolean): Promise<CdpSocket> {
  const deadline = performance.now() + 20_000;
  let endpoint: string | null = null;
  while (endpoint === null) {
    if (gone() || child.exitCode !== null || child.signalCode !== null) {
      throw new AuthenticationError(BROWSER_CLOSED, "Browser closed before sign-in started");
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const info = asJsonObject(await response.json());
      if (info === null) throw new Error("Not a JSON object");
      const debuggerUrl = stringField(info, "webSocketDebuggerUrl");
      if (debuggerUrl === null) throw new Error("Missing webSocketDebuggerUrl");
      endpoint = debuggerUrl.replace("localhost", "127.0.0.1");
    } catch (error) {
      if (performance.now() >= deadline) {
        throw new AuthenticationError(BROWSER_TROUBLE, `Timed out starting the browser (20 s): ${messageOf(error)}`);
      }
      await delay(100);
    }
  }
  const socket = new CdpSocket(endpoint);
  await socket.ready(30_000);
  return socket;
}

/**
 * The browser executable to drive. `CHROMIUM_PATH` wins; otherwise a Chromium
 * family browser is looked for on the platform's usual locations and PATH.
 */
export function browserExecutable(configured: string | undefined = env("CHROMIUM_PATH")): string {
  if (configured !== undefined) {
    if (existsSync(configured)) return configured;
    throw new AuthenticationError(
      "The browser set up for Microsoft 365 sign-in is missing. Ask your IT team to check the CHROMIUM_PATH setting.",
      `CHROMIUM_PATH does not point to a browser executable: ${configured}`,
    );
  }
  for (const candidate of browserCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  throw new AuthenticationError(
    "No Chromium or Microsoft Edge browser was found for sign-in. Install one, or set CHROMIUM_PATH to its executable.",
    "Chromium and Edge were not found; set CHROMIUM_PATH to a browser executable",
  );
}

function browserCandidates(): string[] {
  if (process.platform === "win32") {
    const roots = [env("PROGRAMFILES"), env("PROGRAMFILES(X86)"), env("LOCALAPPDATA")].filter(
      (root): root is string => root !== undefined,
    );
    return roots.flatMap((root) => [
      join(root, "Microsoft/Edge/Application/msedge.exe"),
      join(root, "Google/Chrome/Application/chrome.exe"),
    ]);
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  const names = ["microsoft-edge", "microsoft-edge-stable", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  const path = process.env.PATH ?? "";
  return path
    .split(delimiter)
    .filter((dir) => dir.length > 0)
    .flatMap((dir) => names.map((name) => join(dir, name)));
}

// --- OAuth 2.0 authorization-code flow --------------------------------------

/** The cache key for a scope set: order-independent, so callers may reorder. */
export function scopeKey(scopes: readonly string[]): string {
  return [...scopes].sort().join(" ");
}

/** A PKCE verifier and its S256 challenge, both base64url. */
export function pkce(): [string, string] {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return [verifier, challenge];
}

/** Builds the authorize URL the sign-in browser is sent to. */
export function authorizeUrl(
  scopes: readonly string[],
  challenge: string,
  state: string,
  prompt: string | null,
): string {
  const params = new URLSearchParams();
  params.set("client_id", CLIENT_ID);
  params.set("response_type", "code");
  params.set("redirect_uri", REDIRECT_URI);
  params.set("response_mode", "query");
  params.set("scope", [...scopes, "offline_access", "openid", "profile"].join(" "));
  params.set("code_challenge", challenge);
  params.set("code_challenge_method", "S256");
  params.set("state", state);
  params.set("client_info", "1");
  if (prompt !== null) params.set("prompt", prompt);
  return `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
}

/** POSTs a form body to the token endpoint and returns the decoded JSON body. */
export async function tokenRequest(
  data: Record<string, string>,
  endpoint: string = TOKEN_ENDPOINT,
): Promise<JsonObject> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(data).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let record: JsonObject | null = null;
  try {
    record = asJsonObject(JSON.parse(text));
  } catch {
    record = null;
  }
  if (record === null) {
    if (!response.ok) {
      throw new AuthenticationError(
        "Microsoft's sign-in service could not be reached. Check your internet connection, then try again.",
        `Microsoft token request failed: HTTP ${response.status}`,
      );
    }
    throw new AuthenticationError(
      "Microsoft's sign-in service sent an unexpected reply. Try again.",
      "Microsoft token endpoint returned an unreadable response",
    );
  }
  return record;
}

function errorText(result: JsonObject): string {
  const description = stringField(result, "error_description");
  if (description !== null && description.length > 0) return description;
  const error = stringField(result, "error");
  if (error !== null && error.length > 0) return error;
  return "Microsoft sign-in did not return an access token";
}

/**
 * The sign-in failure for one token response: the OAuth code picks the plain
 * text, and the raw description (with its AADSTS code) rides along as `detail`.
 */
function tokenResultError(result: JsonObject): AuthenticationError {
  const code = stringField(result, "error");
  const mapped = code === null ? undefined : OAUTH_ERROR_TEXT[code];
  return new AuthenticationError(mapped ?? SIGN_IN_FAILED, errorText(result));
}

/** The signed-in account's name, read from the id_token's claims. */
export function preferredUsername(result: JsonObject): string | null {
  const token = stringField(result, "id_token");
  if (token === null) return null;
  const payload = token.split(".")[1];
  if (payload === undefined) return null;
  const padded = `${payload}${"=".repeat((4 - (payload.length % 4)) % 4)}`;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(padded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const record = asJsonObject(claims);
  if (record === null) return null;
  for (const name of ["preferred_username", "upn", "email", "name"]) {
    const value = stringField(record, name);
    if (value !== null && value.length > 0) return value;
  }
  return null;
}

/** The access token cached under `key` with its absolute expiry, or null. */
function accessEntry(cache: JsonObject, key: string): { readonly token: string; readonly expiresAt: number } | null {
  const access = asJsonObject(cache["access"]);
  if (access === null) return null;
  const entry = asJsonObject(access[key]);
  if (entry === null) return null;
  const token = stringField(entry, "token");
  const expiresAt = numberField(entry, "expires_at");
  if (token === null || expiresAt === null) return null;
  return { token, expiresAt };
}

function nowSeconds(): number {
  return Date.now() / 1000;
}

// --- cache and profile locations -------------------------------------------

/** The JSON token cache file (`M365_CACHE_FILE` overrides it). */
export function tokenCacheFile(): string {
  return env("M365_CACHE_FILE") ?? join(CONFIG_DIR, "token-cache.json");
}

/**
 * The sign-in browser's profile dir. It persists on purpose: Microsoft's session
 * cookies live here, so a repeat sign-in completes without asking again.
 * `M365_BROWSER_PROFILE` overrides it.
 */
export function getBrowserProfileDir(): string {
  return env("M365_BROWSER_PROFILE") ?? join(CONFIG_DIR, "browser-profile-cdp");
}

// --- token cache ------------------------------------------------------------

/** The cache-only token state a health probe can read without starting a sign-in. */
export interface TokenStatus {
  readonly valid: boolean;
  readonly refreshable: boolean;
  readonly secondsRemaining: number | null;
  readonly username: string | null;
}

export interface TokenProviderOptions {
  readonly cacheFile?: string;
  readonly profileDir?: string;
  readonly tokenEndpoint?: string;
  readonly executable?: string;
  /** Test seam: replaces the visible-browser capture with a deterministic one. */
  readonly authorizeResponse?: (
    authUri: string,
    profileDir: string,
    executable: string | undefined,
  ) => Promise<AuthorizationResponse>;
  /** Test seam: drives this CDP endpoint for the sign-in capture. */
  readonly debuggerUrl?: string;
}

/** Caches one refresh token plus per-scope access tokens in a JSON file. */
export class FileTokenProvider {
  private readonly cachePath: string;
  private readonly profileDir: string;
  private readonly tokenEndpoint: string;
  private readonly executable: string | undefined;
  private readonly authorizeResponse: NonNullable<TokenProviderOptions["authorizeResponse"]>;
  private cache: JsonObject = {};
  private initialized: Promise<void> | null = null;
  private lock: Promise<void> = Promise.resolve();

  constructor(options: TokenProviderOptions = {}) {
    this.cachePath = options.cacheFile ?? tokenCacheFile();
    this.profileDir = options.profileDir ?? getBrowserProfileDir();
    this.tokenEndpoint = options.tokenEndpoint ?? TOKEN_ENDPOINT;
    this.executable = options.executable;
    this.authorizeResponse = options.authorizeResponse ?? captureAuthorizationResponse;
    if (options.debuggerUrl !== undefined) {
      const url = options.debuggerUrl;
      this.authorizeResponse = (authUri, dir, exe) => captureAuthorizationResponse(authUri, dir, exe, url);
    }
  }

  private ready(): Promise<void> {
    this.initialized ??= this.initialize();
    return this.initialized;
  }

  private async initialize(): Promise<void> {
    this.cache = await this.load();
  }

  private async load(): Promise<JsonObject> {
    let text: string;
    try {
      text = await readFile(this.cachePath, "utf8");
    } catch {
      return {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {};
    }
    return asJsonObject(parsed) ?? {};
  }

  private async save(): Promise<void> {
    try {
      await mkdir(dirname(this.cachePath), { recursive: true, mode: 0o700 });
      await writeFile(this.cachePath, JSON.stringify(this.cache), { encoding: "utf8", mode: 0o600 });
      await chmod(this.cachePath, 0o600);
    } catch (error) {
      throw new AuthenticationError(
        "The proxy could not save your Microsoft 365 sign-in. Ask your IT team to check that the app folder is writable.",
        `Could not write the token cache: ${messageOf(error)}`,
      );
    }
  }

  private async store(result: JsonObject, key: string): Promise<void> {
    const refreshToken = stringField(result, "refresh_token");
    if (refreshToken !== null) this.cache = { ...this.cache, refresh_token: refreshToken };
    const username = preferredUsername(result);
    if (username !== null) this.cache = { ...this.cache, username };
    const access = asJsonObject(this.cache["access"]) ?? {};
    const accessToken = stringField(result, "access_token");
    if (accessToken !== null) {
      const seconds = numberField(result, "expires_in") ?? 3600;
      this.cache = { ...this.cache, access: { ...access, [key]: { token: accessToken, expires_at: nowSeconds() + seconds } } };
    }
    await this.save();
  }

  private cached(key: string): string | null {
    const entry = accessEntry(this.cache, key);
    if (entry === null) return null;
    return entry.expiresAt > nowSeconds() + 60 ? entry.token : null;
  }

  /** Re-reads the cache file so a token another instance stored becomes visible. */
  private async reloadFromDisk(): Promise<void> {
    const loaded = await this.load();
    if (Object.keys(loaded).length > 0) this.cache = loaded;
  }

  private async refresh(refreshToken: string, scopes: readonly string[]): Promise<JsonObject | null> {
    try {
      const result = await tokenRequest(
        {
          client_id: CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          scope: scopes.join(" "),
        },
        this.tokenEndpoint,
      );
      return stringField(result, "access_token") === null ? null : result;
    } catch (error) {
      log.info(`Refresh-token grant failed: ${messageOf(error)}`);
      return null;
    }
  }

  /**
   * A usable access token without opening a browser: a live cached token, or a
   * refresh-token grant. Returns null when neither works, so callers can decide
   * whether a browser sign-in is allowed. Serialized: two concurrent callers must
   * not rotate the same refresh token twice.
   */
  tokenSilent(scopes: readonly string[]): Promise<string | null> {
    return this.withLock(() => this.acquireSilent(scopes));
  }

  private async acquireSilent(scopes: readonly string[]): Promise<string | null> {
    await this.ready();
    const key = scopeKey(scopes);
    let cached = this.cached(key);
    if (cached === null) {
      await this.reloadFromDisk();
      cached = this.cached(key);
    }
    if (cached !== null) return cached;
    const refreshToken = stringField(this.cache, "refresh_token");
    if (refreshToken === null) return null;
    const refreshed = await this.refresh(refreshToken, scopes);
    if (refreshed === null) return null;
    try {
      await this.store(refreshed, key);
    } catch (error) {
      log.info(`Could not persist refreshed token: ${messageOf(error)}`);
    }
    return stringField(refreshed, "access_token");
  }

  /**
   * Runs `action` after every earlier action finished. Refresh grants must not
   * overlap: Microsoft rotates the refresh token, so a second concurrent use of
   * the old one fails and can revoke the sign-in.
   */
  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;

    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }

  /** Runs the visible-browser sign-in and returns the resulting access token. */
  interactive(scopes: readonly string[], onAuthUrl: (url: string) => void): Promise<string> {
    return this.withLock(() => this.signIn(scopes, onAuthUrl));
  }

  private async signIn(scopes: readonly string[], onAuthUrl: (url: string) => void): Promise<string> {
    await this.ready();
    const hasAccount = stringField(this.cache, "refresh_token") !== null;
    const [verifier, challenge] = pkce();
    const state = randomBytes(16).toString("base64url");
    const authUri = authorizeUrl(scopes, challenge, state, hasAccount ? null : "select_account");
    onAuthUrl(authUri);
    log.info("Complete Microsoft sign-in in the opened browser window.");
    const response = await this.authorizeResponse(authUri, this.profileDir, this.executable);
    if ("error" in response) {
      throw new AuthenticationError(
        OAUTH_ERROR_TEXT[response.error] ?? SIGN_IN_FAILED,
        `Microsoft sign-in failed: ${response.error}`,
      );
    }
    if (response.state !== state) {
      throw new AuthenticationError(
        "Microsoft sign-in could not be verified. Try again.",
        "Microsoft sign-in returned an unexpected state",
      );
    }
    const result = await tokenRequest(
      {
        client_id: CLIENT_ID,
        grant_type: "authorization_code",
        code: response.code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
        scope: scopes.join(" "),
      },
      this.tokenEndpoint,
    );
    const accessToken = stringField(result, "access_token");
    if (accessToken === null) throw tokenResultError(result);
    await this.store(result, scopeKey(scopes));
    log.info(`Interactive login succeeded as ${preferredUsername(result) ?? "unknown account"}`);
    return accessToken;
  }

  /**
   * Cache-only token state: never refreshes and never opens a browser, so a
   * status check cannot start a sign-in.
   */
  async tokenStatus(scopes: readonly string[] = SCOPES): Promise<TokenStatus> {
    await this.ready();
    const cache = await this.load();
    const entry = accessEntry(cache, scopeKey(scopes));
    const username = stringField(cache, "username");
    const refresh = stringField(cache, "refresh_token");
    return {
      valid: entry !== null && entry.expiresAt > nowSeconds() + 60,
      refreshable: refresh !== null && refresh.length > 0,
      secondsRemaining: entry === null ? null : Math.max(0, Math.floor(entry.expiresAt - nowSeconds())),
      username,
    };
  }
}

/** A redirect captured from the sign-in browser: either an error or a code. */
export type AuthorizationResponse =
  | { readonly error: string }
  | { readonly code: string; readonly state: string };

/**
 * The redirect a captured request is, when it is the sign-in page handing the
 * authorization code (or an OAuth error) back to the `nativeclient` redirect.
 */
export function authorizationResponseFrom(request: BrowserRequest): AuthorizationResponse | null {
  let parsed: URL;
  try {
    parsed = new URL(request.url);
  } catch {
    return null;
  }
  if (parsed.hostname !== "login.microsoftonline.com") return null;
  if (parsed.pathname.replace(/\/+$/, "") !== "/common/oauth2/nativeclient") return null;
  const error = parsed.searchParams.get("error");
  if (error !== null && error.length > 0) return { error };
  const code = parsed.searchParams.get("code");
  if (code === null || code.length === 0) return null;
  return { code, state: parsed.searchParams.get("state") ?? "" };
}

/**
 * Opens the sign-in browser at `authUri` and resolves with the redirect the page
 * makes back to `nativeclient`. Rejects on a timeout, a closed browser, or a lost
 * CDP connection. `debuggerUrl` drives a browser already serving CDP instead of
 * launching one.
 */
async function captureAuthorizationResponse(
  authUri: string,
  profileDir: string,
  executable: string | undefined,
  debuggerUrl?: string,
): Promise<AuthorizationResponse> {
  const browser =
    debuggerUrl === undefined
      ? await BrowserSession.launch({
          executable: browserExecutable(executable),
          profileDir,
          headless: false,
        })
      : await BrowserSession.attach(debuggerUrl);
  try {
    if (!browser.alive()) {
      throw new AuthenticationError(BROWSER_CLOSED, "Browser closed before sign-in started");
    }
    const page = await browser.openPage();
    const captured = Promise.withResolvers<AuthorizationResponse>();
    const unsubscribe = page.onRequest((request) => {
      const response = authorizationResponseFrom(request);
      if (response !== null) captured.resolve(response);
    });
    const timer = setTimeout(() => {
      captured.reject(new AuthenticationError(SIGN_IN_TIMED_OUT, "Timed out waiting for Microsoft sign-in (300 s)"));
    }, 300_000);
    try {
      await page.navigate(authUri);
      // The redirect arrives as an event, typically long after `navigate`
      // resolved; nothing is in flight to dispatch it, so wait on the capture
      // itself — and on the connection dying, rather than on the full timeout.
      return await Promise.race([captured.promise, page.closed]);
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }
  } finally {
    await browser.close();
  }
}

// --- public API -------------------------------------------------------------

function interactiveApprovalEnabled(): boolean {
  return process.env.M365_ENABLE_INTERACTIVE_APPROVAL === "1";
}

function interactiveAllowed(): boolean {
  return process.env.M365_NO_INTERACTIVE !== "1";
}

function canPromptForInteractiveApproval(): boolean {
  return interactiveApprovalEnabled() && interactiveAllowed();
}

let provider: FileTokenProvider | null = null;

function getProvider(): FileTokenProvider {
  provider ??= new FileTokenProvider();
  return provider;
}

type AuthUrlHandler = (url: string) => void;

/** A cached or refreshed token for the default chat scopes, or null. */
export function getTokenSilent(): Promise<string | null> {
  return getProvider().tokenSilent(SCOPES);
}

/**
 * A token for `scopes`: the cache or a refresh first, then a visible-browser
 * sign-in when interactive approval is enabled. Returns null otherwise.
 */
export async function getTokenForScope(scopes: string[]): Promise<string | null> {
  const token = await getProvider().tokenSilent(scopes);
  if (token !== null || !canPromptForInteractiveApproval()) return token;
  log.info(`No cached token for [${scopes.join(", ")}]; opening interactive approval`);
  return getProvider().interactive(scopes, () => {});
}

/** A token for the studio-generated image artifact scope, or null. */
export function getImageArtifactToken(): Promise<string | null> {
  return getTokenForScope([...IMAGE_ARTIFACT_SCOPES]);
}

/** The cache-only token status, for a health probe. */
export function getTokenStatus(scopes: readonly string[] = SCOPES): Promise<TokenStatus> {
  return getProvider().tokenStatus(scopes);
}

/**
 * Signs in through a visible browser and returns the access token for `scopes`.
 * The password and MFA are entered only on Microsoft's sign-in page; `onAuthUrl`
 * receives the authorize URL so a caller can print it if the window stays blank.
 */
export function loginInteractive(scopes: string[] = [...SCOPES], onAuthUrl: AuthUrlHandler = () => {}): Promise<string> {
  return getProvider().interactive(scopes, onAuthUrl);
}

let inflightToken: Promise<string> | null = null;

/** A token for the default chat scopes, signing in interactively when allowed. */
export function getToken(): Promise<string> {
  return (inflightToken ??= resolveToken().finally(() => {
    inflightToken = null;
  }));
}

async function resolveToken(): Promise<string> {
  const token = await getProvider().tokenSilent(SCOPES);
  if (token !== null) return token;
  if (canPromptForInteractiveApproval()) {
    log.info("No cached Microsoft token; opening interactive approval");
    return getProvider().interactive(SCOPES, () => {});
  }
  throw new AuthenticationError(
    "No cached Microsoft token. Run m365-login interactively, or set M365_ENABLE_INTERACTIVE_APPROVAL=1 to allow a visible browser sign-in. M365_NO_INTERACTIVE=1 vetoes that fallback.",
  );
}
