import { createHash } from "node:crypto";
import { z } from "zod/v4";
import type { Response as PlaywrightResponse, chromium } from "playwright";
import { getBrowserProfileDir } from "./auth.js";
import { createLogger } from "./log.js";

/** playwright 1.58 inlines launchPersistentContext options; keep the seam typed. */
type LaunchPersistentContextOptions = Parameters<typeof chromium.launchPersistentContext>[1];

const log = createLogger("web-conversations");

const CHAT_URL = "https://m365.cloud.microsoft/chat/";

const ALLOWED_CONTEXT_HEADERS = [
  "x-client-eligibility", "x-host-context", "x-route-id", "x-session-id",
  "referer", "accept", "user-agent",
] as const;

type AllowedContextHeader = typeof ALLOWED_CONTEXT_HEADERS[number];

const JsonValueSchema = z.json();

const JsonObjectSchema = z.record(z.string(), JsonValueSchema);

const JsonObjectArraySchema = z.array(JsonObjectSchema);

const ConversationIdSchema = z.string();

/** A JSON value as delivered by M365 web payloads. */
type JsonValue = z.infer<typeof JsonValueSchema>;

/** A JSON object as delivered by M365 web payloads; echoed back to the server untouched. */
type JsonObject = z.infer<typeof JsonObjectSchema>;

/** Keys M365 exposes a chat's conversation id under, in precedence order. */
const CONVERSATION_ID_KEYS = ["conversationId", "conversationID", "id"] as const;

/** A chat entry in the M365 navigation store. */
type M365ChatEntry = JsonObject;

/** The navigation store M365 returns for `RefreshNavPane`. */
type NavigationStore = {
  conversationPageHistoryList?: { chats: M365ChatEntry[] } | null;
  chatLandingPageHistoryList?: JsonValue;
  tasksHub?: JsonValue;
  tasksFlyout?: JsonValue;
};

/** Navigation state echoed back with `DeleteConversation`. */
type M365NavigationSnapshot = {
  conversationPageHistoryList: { chats: M365ChatEntry[] } | null;
  chatLandingPageHistoryList: JsonValue | null;
  tasksHub: JsonValue | null;
  tasksFlyout: JsonValue | null;
};

/** JSON body accepted by M365's `/chat` endpoint. */
type M365ChatRequest =
  | { action: "RefreshNavPane" }
  | { action: "DeleteConversation"; conversationId: string; state: M365NavigationSnapshot };

/** A `/chat` response decoded at the boundary: a JSON object, or null for any other body. */
type BrowserFetchResult = { status: number; body: JsonObject | null };

/** Request facts the deletion flow reads from Playwright's request event. */
export interface M365WebRequest {
  method(): string;
  url(): string;
  headers(): Record<string, string>;
}

/** The `/chat` fetch the client runs inside the browser page. */
export interface M365ChatFetchInput {
  headers: Record<string, string>;
  body: M365ChatRequest;
}

/** The raw `/chat` response the browser page hands back for decoding in Node. */
export interface M365ChatFetchOutput {
  status: number;
  text: string;
}

/** The page function Playwright executes for a `/chat` fetch. */
export type M365ChatPageFunction = (input: M365ChatFetchInput) => Promise<M365ChatFetchOutput>;

/** The slice of Playwright's `Page` the deletion flow drives. */
export interface M365WebPage {
  on(event: "request", listener: (request: M365WebRequest) => void): void;
  off(event: "request", listener: (request: M365WebRequest) => void): void;
  goto(url: string, options: { waitUntil: "domcontentloaded" }): Promise<PlaywrightResponse | null>;
  url(): string;
  waitForTimeout(milliseconds: number): Promise<void>;
  evaluate(pageFunction: M365ChatPageFunction, input: M365ChatFetchInput): Promise<M365ChatFetchOutput>;
}

/** The slice of Playwright's `BrowserContext` the deletion flow drives. */
export interface M365WebBrowser {
  pages(): M365WebPage[];
  newPage(): Promise<M365WebPage>;
  close(): Promise<void>;
}

export class M365WebConversationError extends Error {
  readonly code: "target_missing" | "delete_failed" | "target_still_present" | "navigation_failed";

  constructor(code: M365WebConversationError["code"], message: string) {
    super(message);
    this.name = "M365WebConversationError";
    this.code = code;
  }
}

export class M365WebSessionUnavailableError extends Error {
  constructor(message = "Authenticated M365 web session unavailable") {
    super(message);
    this.name = "M365WebSessionUnavailableError";
  }
}

export interface M365WebConversationClientOptions {
  launchPersistentContext?: (userDataDir: string, options?: LaunchPersistentContextOptions) => Promise<M365WebBrowser>;
  profileDir?: string;
  headless?: boolean;
}

export interface M365WebConversationClientLike {
  deleteConversation(input: { conversationId: string }): Promise<void>;
}

function redactedId(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 12);
}

function isSignInHost(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith("login.microsoftonline.com");
  } catch {
    return false;
  }
}

/** Decode a `/chat` body at the I/O boundary; non-JSON and non-object bodies decode to null. */
function decodedJsonObject(text: string): JsonObject | null {
  try {
    const decoded = JsonObjectSchema.safeParse(JSON.parse(text));

    return decoded.success ? decoded.data : null;
  } catch {
    return null;
  }
}

/** Narrow an already-decoded JSON object to the navigation store M365 sent. */
function navigationStore(body: JsonObject | null): NavigationStore {
  if (body === null) return {};
  const nested = JsonObjectSchema.safeParse(body["store"] ?? body["navigationStore"]);
  const source = nested.success ? nested.data : body;
  const history = JsonObjectSchema.safeParse(source["conversationPageHistoryList"]);
  const chats = history.success ? JsonObjectArraySchema.safeParse(history.data["chats"]) : null;

  return {
    conversationPageHistoryList: history.success
      ? { chats: chats?.success ? chats.data : [] }
      : null,
    chatLandingPageHistoryList: source["chatLandingPageHistoryList"],
    tasksHub: source["tasksHub"],
    tasksFlyout: source["tasksFlyout"],
  };
}

/** Read a chat's conversation id from M365's candidate keys; non-string values are ignored. */
function conversationId(chat: M365ChatEntry): string | undefined {
  for (const key of CONVERSATION_ID_KEYS) {
    const candidate = ConversationIdSchema.safeParse(chat[key]);

    if (candidate.success) return candidate.data;
  }

  return undefined;
}

function hasConversation(store: NavigationStore, id: string): boolean {
  return (store.conversationPageHistoryList?.chats ?? []).some((chat) => conversationId(chat) === id);
}

export class M365WebConversationClient implements M365WebConversationClientLike {
  private readonly launchPersistentContext: NonNullable<M365WebConversationClientOptions["launchPersistentContext"]>;
  private readonly profileDir: string;

  constructor(options: M365WebConversationClientOptions = {}) {
    this.launchPersistentContext = options.launchPersistentContext ?? (async (userDataDir, launchOptions) => {
      // Load Playwright only when a due deletion actually needs a browser.
      const { chromium } = await import("playwright");

      const launchOptionsWithDefaults: NonNullable<LaunchPersistentContextOptions> = {
        headless: options.headless ?? process.env.M365_WEB_HEADLESS !== "0",
        ...launchOptions,
      };

      const chromiumPath = process.env.CHROMIUM_PATH;

      if (chromiumPath !== undefined && !Object.hasOwn(launchOptionsWithDefaults, "executablePath")) {
        launchOptionsWithDefaults.executablePath = chromiumPath;
      }

      return chromium.launchPersistentContext(userDataDir, launchOptionsWithDefaults);
    });
    this.profileDir = options.profileDir ?? getBrowserProfileDir();
  }

  async deleteConversation({ conversationId: id }: { conversationId: string }): Promise<void> {
    let browser: M365WebBrowser | undefined;

    try {
      browser = await this.launchPersistentContext(this.profileDir, {});
      const page = browser.pages()[0] ?? await browser.newPage();
      const headers = await this.openAndCaptureHeaders(page);
      const before = await this.post(page, headers, { action: "RefreshNavPane" });
      const beforeStore = navigationStore(before.body);
      const beforeChats = beforeStore.conversationPageHistoryList?.chats ?? [];
      log.info(`RefreshNavPane chats=${beforeChats.length} target=${redactedId(id)} present=${hasConversation(beforeStore, id)}`);

      if (!hasConversation(beforeStore, id)) {
        throw new M365WebConversationError("target_missing", `Managed conversation was not present in M365 navigation (${beforeChats.length} chats)`);
      }

      const state: M365NavigationSnapshot = {
        conversationPageHistoryList: beforeStore.conversationPageHistoryList ?? null,
        chatLandingPageHistoryList: beforeStore.chatLandingPageHistoryList ?? null,
        tasksHub: beforeStore.tasksHub ?? null,
        tasksFlyout: beforeStore.tasksFlyout ?? null,
      };

      const deleted = await this.post(page, headers, {
        action: "DeleteConversation",
        conversationId: id,
        state,
      });

      log.info(`DeleteConversation status=${deleted.status} conversation=${redactedId(id)}`);

      if (deleted.status !== 200) {
        throw new M365WebConversationError("delete_failed", `DeleteConversation returned HTTP ${deleted.status}`);
      }

      const after = await this.post(page, headers, { action: "RefreshNavPane" });

      if (after.status !== 200) {
        throw new M365WebConversationError("navigation_failed", `RefreshNavPane returned HTTP ${after.status}`);
      }

      if (hasConversation(navigationStore(after.body), id)) {
        throw new M365WebConversationError("target_still_present", "M365 navigation still contains deleted conversation");
      }
    } finally {
      await browser?.close();
    }
  }

  private async openAndCaptureHeaders(page: M365WebPage): Promise<Record<string, string>> {
    const captured = new Map<AllowedContextHeader, string>();

    const onRequest = (request: M365WebRequest) => {
      if (request.method() !== "POST" || !new URL(request.url()).pathname.endsWith("/chat")) return;
      const requestHeaders = request.headers();

      for (const name of ALLOWED_CONTEXT_HEADERS) {
        const value = requestHeaders[name];

        if (value) captured.set(name, value);
      }
    };

    page.on("request", onRequest);

    try {
      await page.goto(CHAT_URL, { waitUntil: "domcontentloaded" });

      if (captured.size === 0) await page.waitForTimeout(5_000);
    } finally {
      page.off("request", onRequest);
    }

    if (isSignInHost(page.url())) throw new M365WebSessionUnavailableError();

    if (captured.size === 0) throw new M365WebSessionUnavailableError("M365 web navigation did not expose UI context");

    return Object.fromEntries(captured);
  }

  private async post(page: M365WebPage, headers: Record<string, string>, body: M365ChatRequest): Promise<BrowserFetchResult> {
    const raw = await page.evaluate(async (input) => {
      const response = await fetch("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...input.headers },
        body: JSON.stringify(input.body),
        credentials: "include",
      });

      const text = await response.text().catch(() => "");

      return { status: response.status, text };
    }, { headers, body });

    return { status: raw.status, body: decodedJsonObject(raw.text) };
  }
}
