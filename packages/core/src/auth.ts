import * as msal from "@azure/msal-node";
import { chromium } from "playwright";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createLogger } from "./log.js";

const CLIENT_ID = "c0ab8ce9-e9a0-42e7-b064-33d422df41f1";
const AUTHORITY = "https://login.microsoftonline.com/common";
const REDIRECT_URI = "https://login.microsoftonline.com/common/oauth2/nativeclient";
const SCOPES = [
  "https://substrate.office.com/sydney/M365Chat.Read",
  "https://substrate.office.com/sydney/sydney.readwrite",
];
const IMAGE_ARTIFACT_SCOPES = ["https://designerappservice.officeapps.live.com/.default"];

export function getImageArtifactToken(): Promise<string | null> {
  return getTokenForScope(IMAGE_ARTIFACT_SCOPES);
}

const log = createLogger("auth");
const CONFIG_DIR = join(homedir(), ".config", "opencode-m365");

mkdirSync(CONFIG_DIR, { recursive: true });
const CACHE_FILE = process.env.M365_CACHE_FILE ?? join(CONFIG_DIR, "msal-cache.json");
/** Playwright's persistent-context profile dir. The "cdp" suffix is legacy
 * (predates the playwright migration); renaming would orphan logged-in profiles. */
export function getBrowserProfileDir(): string {
  return process.env.M365_BROWSER_PROFILE ?? join(CONFIG_DIR, "browser-profile-cdp");
}

function loadCache(app: msal.PublicClientApplication): void {
  if (!existsSync(CACHE_FILE)) return;
  try {
    app.getTokenCache().deserialize(readFileSync(CACHE_FILE, "utf-8"));
  } catch (error: unknown) {
    log.error(`Failed to load MSAL cache: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function saveCache(app: msal.PublicClientApplication): void {
  mkdirSync(dirname(CACHE_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(CACHE_FILE, app.getTokenCache().serialize(), {
    encoding: "utf-8",
    mode: 0o600,
  });
  chmodSync(CACHE_FILE, 0o600);
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

type AuthUrlHandler = (url: string) => void;

/** Minimal request-event source; playwright's Page satisfies this structurally. */
export interface AuthCodeEventSource {
  on(
    event: "request",
    handler: (request: { url(): string }) => void,
  ): () => void;
}

/**
 * Parse the Microsoft authorization code from a nativeclient redirect URL.
 * Returns null when the URL is not the nativeclient redirect or has no code.
 */
export function extractAuthCode(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!parsed.pathname.includes("/oauth2/nativeclient")) return null;
  return parsed.searchParams.get("code");
}

/**
 * Resolve with the authorization code the moment the nativeclient redirect
 * fires. All other traffic is ignored; rejects after `timeoutMs` (default:
 * 15 minutes, matching the previous interactive-login deadline).
 */
export function waitForAuthCode(
  source: AuthCodeEventSource,
  timeoutMs = 900_000,
): Promise<string> {
  const code = Promise.withResolvers<string>();
  const timer = setTimeout(() => {
    unsubscribe();
    code.reject(new Error("Timed out waiting for Microsoft login"));
  }, timeoutMs);
  const unsubscribe = source.on("request", (request) => {
    const authCode = extractAuthCode(request.url());
    if (!authCode) return;
    clearTimeout(timer);
    unsubscribe();
    code.resolve(authCode);
  });
  return code.promise;
}

function interactiveApprovalEnabled(): boolean {
  return process.env.M365_ENABLE_INTERACTIVE_APPROVAL === "1";
}

function interactiveAllowed(): boolean {
  return process.env.M365_NO_INTERACTIVE !== "1";
}

function canPromptForInteractiveApproval(): boolean {
  return interactiveApprovalEnabled() && interactiveAllowed();
}

/**
 * Authenticate in a visible Chromium window through Microsoft's authorization-code
 * flow with PKCE. Playwright drives Chromium (launchPersistentContext); credentials
 * and MFA are entered only on Microsoft's sign-in page. The auth code is scraped
 * from the nativeclient redirect navigation — it is never present in the settled URL.
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

  const context = await chromium.launchPersistentContext(getBrowserProfileDir(), {
    headless: false,
    timeout: 60_000,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const source: AuthCodeEventSource = {
      on: (event, handler) => {
        page.on(event, handler);
        return () => page.off(event, handler);
      },
    };
    const authCode = waitForAuthCode(source);
    let codeArrived = false;
    // Navigate without blocking the flow; the code promise (15-min timeout) governs.
    // A rejection after the code arrived is a teardown artifact (context.close()
    // cancels the in-flight redirect) — not a real navigation failure.
    void page
      .goto(authUrl, { waitUntil: "domcontentloaded", timeout: 60_000 })
      .catch((error: unknown) => {
        if (codeArrived) return;
        log.error(
          `Could not navigate to the sign-in page: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    onAuthUrl(authUrl);
    const code = await authCode;
    codeArrived = true;
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
    await context.close();
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

export async function getTokenForScope(scopes: string[]): Promise<string | null> {
  const token = await acquireSilent(scopes);
  if (token || !canPromptForInteractiveApproval()) return token;

  log.info(
    `No cached token for [${scopes.join(", ")}]; opening interactive approval`,
  );
  return loginInteractive(scopes);
}

let inflightReauth: Promise<boolean> | null = null;

function forceReauth(): Promise<boolean> {
  return (inflightReauth ??= getTokenSilent()
    .then(async (token) => {
      if (token) return true;
      if (!canPromptForInteractiveApproval()) return false;
      await loginInteractive(SCOPES);
      return true;
    })
    .catch((error: unknown) => {
      log.error(
        `Interactive reauthentication failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    })
    .finally(() => {
      inflightReauth = null;
    }));
}

let inflightToken: Promise<string> | null = null;

export function getToken(): Promise<string> {
  return (inflightToken ??= getTokenSilent()
    .then(async (token) => {
      if (token) return token;
      if (canPromptForInteractiveApproval()) {
        log.info("No cached Microsoft token; opening interactive approval");
        return loginInteractive(SCOPES);
      }
      throw new Error(
        "No cached Microsoft token. Run m365-login interactively, or set M365_ENABLE_INTERACTIVE_APPROVAL=1 to allow a visible browser sign-in. M365_NO_INTERACTIVE=1 vetoes that fallback.",
      );
    })
    .finally(() => {
      inflightToken = null;
    }));
}
