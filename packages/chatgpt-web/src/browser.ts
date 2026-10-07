/**
 * A signed-in ChatGPT Web session, driven through a real browser.
 *
 * Auth is the browser session itself: a dedicated persistent profile that the
 * operator signs into once, by hand. No API key, no token in the repo.
 *
 * Headed by default. Cloudflare serves headless Chromium a "Just a moment…"
 * interstitial instead of the app, and no amount of waiting fixes it — the
 * same constraint the M365 interactive login already lives under, on a
 * workstation that already runs visible Chromium for it.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page, chromium } from "playwright";
import { createLogger, trunc } from "@m365-copilot/core";
import {
  captureBaseline,
  isChallengePage,
  isSignedIn,
  readTurn,
  waitForAssistantTurn,
} from "./dom.js";

const log = createLogger("chatgpt-web");

const DEFAULT_ORIGIN = "https://chatgpt.com";

const STREAM_POLL_MS = 150;

/** How long a single turn may take before we call it dead. */
const DEFAULT_TURN_DEADLINE_MS = 10 * 60 * 1000;

/** playwright inlines launchPersistentContext options; keep the seam typed. */
type LaunchPersistentContextOptions = Parameters<typeof chromium.launchPersistentContext>[1];

export interface ChatGptBrowserOptions {
  profileDir?: string;
  headless?: boolean;
  /** Origin to drive. Pointed at a fixture server by the smoke test. */
  origin?: string;
  turnDeadlineMs?: number;
  launchPersistentContext?: (
    dir: string,
    options?: LaunchPersistentContextOptions,
  ) => Promise<BrowserContext>;
}

/** The dedicated profile. Never the operator's own browsing profile. */
export function chatGptProfileDir(): string {
  return (
    process.env.CHATGPT_WEB_PROFILE ??
    join(homedir(), ".config", "opencode-m365", "chatgpt-web-profile")
  );
}

let shared: ChatGptBrowserSession | undefined;

/**
 * The process-wide browser session.
 *
 * Chromium allows exactly one instance per persistent profile directory — a
 * second `launchPersistentContext` on the same directory fails with a
 * ProcessSingleton error. So this is deliberately a singleton: one window, one
 * logged-in session, shared by every conversation. Turns are serialized by the
 * proxy's scheduler, which is also what ChatGPT expects.
 */
export function sharedChatGptSession(options: ChatGptBrowserOptions = {}): ChatGptBrowserSession {
  shared ??= new ChatGptBrowserSession(options);

  return shared;
}

/** Close the shared session, if one was ever opened. */
export async function closeSharedChatGptSession(): Promise<void> {
  await shared?.close();
  shared = undefined;
}

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);

  return promise;
};

export class ChatGptBrowserSession {
  private readonly options: ChatGptBrowserOptions;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(options: ChatGptBrowserOptions = {}) {
    this.options = options;
  }

  private get origin(): string {
    return (this.options.origin ?? DEFAULT_ORIGIN).replace(/\/$/, "");
  }

  /** The conversation ChatGPT is currently showing, if we are on one. */
  get conversationUrl(): string | null {
    return this.page?.url() ?? null;
  }

  /**
   * Open the app and confirm a signed-in session. Throws with the reason the
   * page is unusable rather than handing back a page nobody can type into.
   */
  async open(): Promise<Page> {
    if (this.page) return this.page;

    const launch =
      this.options.launchPersistentContext ??
      (async (dir: string, launchOptions?: LaunchPersistentContextOptions) => {
        // A static `import { chromium }` would eagerly load a browser into every
        // consumer of this package, including ones that only read model
        // metadata. Same deferral as core/web-conversations.ts.
        const { chromium: browser } = await import("playwright");

        const contextOptions: LaunchPersistentContextOptions = {
          headless: this.options.headless ?? process.env.CHATGPT_WEB_HEADLESS === "1",
          ...launchOptions,
        };

        if (process.env.CHROMIUM_PATH) contextOptions.executablePath = process.env.CHROMIUM_PATH;

        return browser.launchPersistentContext(dir, contextOptions);
      });

    this.context = await launch(chatGptProfileDir());
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    await this.page.goto(`${this.origin}/`, { waitUntil: "domcontentloaded" });

    if (await isChallengePage(this.page)) {
      throw new Error(
        `ChatGPT served an anti-bot challenge instead of the app (title=${JSON.stringify(
          await this.page.title(),
        )}). Run headed (CHATGPT_WEB_HEADLESS unset) and sign in interactively.`,
      );
    }

    if (!(await isSignedIn(this.page))) {
      throw new Error(
        `No ChatGPT composer at ${this.origin} — sign in interactively in the profile at ${chatGptProfileDir()}`,
      );
    }

    log.info(`ChatGPT session ready at ${this.origin}`);

    return this.page;
  }

  /** Start a fresh conversation so no prior history is in context. */
  async newConversation(): Promise<void> {
    const page = await this.open();
    await page.goto(`${this.origin}/`, { waitUntil: "domcontentloaded" });

    if (!(await isSignedIn(page))) {
      throw new Error("ChatGPT composer vanished after starting a new conversation");
    }
  }

  /**
   * Submit `prompt` and stream the reply as it renders.
   *
   * Deltas come from polling the bound turn's text: ChatGPT streams into the
   * DOM with no event to subscribe to. Each poll emits only the newly appended
   * suffix, so a delta is never re-sent.
   */
  async sendTurn(
    prompt: string,
    onDelta?: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<{ text: string; turnKey: string }> {
    const page = await this.open();
    const deadline = Date.now() + (this.options.turnDeadlineMs ?? DEFAULT_TURN_DEADLINE_MS);
    const baseline = await captureBaseline(page);

    const composer = page.locator("#prompt-textarea");
    await composer.fill(prompt);
    await composer.press("Enter");

    const turnKey = await waitForAssistantTurn(
      page,
      baseline,
      deadline - Date.now(),
      prompt,
      signal,
    );

    log.info(`ChatGPT turn ${turnKey} started for ${trunc(prompt, 120)}`);

    let emitted = "";

    for (;;) {
      if (signal?.aborted) {
        // Mirror the UI's Stop control so the turn ends instead of dangling.
        await page.locator(`[data-turn-key="${turnKey}"] button`).first().click().catch(() => {});
        throw Object.assign(new Error("ChatGPT turn aborted"), { name: "AbortError" });
      }

      const snapshot = await readTurn(page, turnKey);

      if (snapshot.text.length > emitted.length) {
        onDelta?.(snapshot.text.slice(emitted.length));
        emitted = snapshot.text;
      }

      // A turn that settles with no assistant text is still a completed turn —
      // moderation, a usage-limit interstitial, an errored generation. Return
      // it rather than polling to the deadline: the caller needs to see `empty`
      // and run its own retry policy.
      if (snapshot.finished) return { text: snapshot.text, turnKey };

      if (Date.now() > deadline) {
        throw new Error(`ChatGPT turn ${turnKey} did not finish within ${deadline}ms`);
      }

      await sleep(STREAM_POLL_MS);
    }
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => {});
    this.context = null;
    this.page = null;
  }
}
