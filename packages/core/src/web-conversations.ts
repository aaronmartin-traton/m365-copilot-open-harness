import { createHash } from "node:crypto";
import { z } from "zod/v4";
import type { BrowserContext, LaunchPersistentContextOptions, Page, Request } from "playwright";
import { getBrowserProfileDir } from "./auth.js";
import { createLogger } from "./log.js";

const log = createLogger("web-conversations");
const CHAT_URL = "https://m365.cloud.microsoft/chat/";
const ALLOWED_CONTEXT_HEADERS = [
  "x-client-eligibility", "x-host-context", "x-route-id", "x-session-id",
  "referer", "accept", "user-agent",
] as const;
type AllowedContextHeader = typeof ALLOWED_CONTEXT_HEADERS[number];

type NavigationStore = {
  conversationPageHistoryList?: { chats?: Array<Record<string, unknown>> } | null;
  chatLandingPageHistoryList?: unknown;
  tasksHub?: unknown;
  tasksFlyout?: unknown;
};

type BrowserFetchResult = { status: number; body: unknown };

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
  launchPersistentContext?: (userDataDir: string, options?: LaunchPersistentContextOptions) => Promise<BrowserContext>;
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

const JsonObject = z.record(z.string(), z.unknown());

function navigationStore(body: unknown): NavigationStore {
  const rootResult = JsonObject.safeParse(body);
  if (!rootResult.success) return {};
  const root = rootResult.data;
  const candidateResult = JsonObject.safeParse(root.store ?? root.navigationStore);
  const source = candidateResult.success ? candidateResult.data : root;
  const historyResult = JsonObject.safeParse(source.conversationPageHistoryList);
  const chatsResult = historyResult.success ? z.array(JsonObject).safeParse(historyResult.data.chats) : null;
  return {
    conversationPageHistoryList: historyResult.success
      ? { chats: chatsResult?.success ? chatsResult.data : [] }
      : null,
    chatLandingPageHistoryList: source.chatLandingPageHistoryList,
    tasksHub: source.tasksHub,
    tasksFlyout: source.tasksFlyout,
  };
}

function conversationId(chat: Record<string, unknown>): string | undefined {
  for (const key of ["conversationId", "conversationID", "id"]) {
    if (typeof chat[key] === "string") return chat[key];
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
      return chromium.launchPersistentContext(userDataDir, {
        headless: options.headless ?? process.env.M365_WEB_HEADLESS !== "0",
        ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
        ...launchOptions,
      });
    });
    this.profileDir = options.profileDir ?? getBrowserProfileDir();
  }

  async deleteConversation({ conversationId: id }: { conversationId: string }): Promise<void> {
    let context: BrowserContext | undefined;
    try {
      context = await this.launchPersistentContext(this.profileDir, {});
      const page = context.pages()[0] ?? await context.newPage();
      const headers = await this.openAndCaptureHeaders(page);
      const before = await this.post(page, headers, { action: "RefreshNavPane" });
      const beforeStore = navigationStore(before.body);
      const beforeChats = beforeStore.conversationPageHistoryList?.chats ?? [];
      log.info(`RefreshNavPane chats=${beforeChats.length} target=${redactedId(id)} present=${hasConversation(beforeStore, id)}`);
      if (!hasConversation(beforeStore, id)) {
        throw new M365WebConversationError("target_missing", `Managed conversation was not present in M365 navigation (${beforeChats.length} chats)`);
      }

      const state = {
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
      await context?.close();
    }
  }

  private async openAndCaptureHeaders(page: Page): Promise<Record<string, string>> {
    const captured = new Map<AllowedContextHeader, string>();
    const onRequest = (request: Request) => {
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

  private async post(page: Page, headers: Record<string, string>, body: unknown): Promise<BrowserFetchResult> {
    return page.evaluate(async (input: { headers: Record<string, string>; body: unknown }) => {
      const response = await fetch("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...input.headers },
        body: JSON.stringify(input.body),
        credentials: "include",
      });
      let parsed: unknown = null;
      try { parsed = await response.json(); } catch {}
      return { status: response.status, body: parsed };
    }, { headers, body });
  }
}

