/**
 * ChatGPT Web as a `ModelProvider`.
 *
 * This is the second backend behind the proxy's OpenAI surface, and
 * the point of the seam: `proxy-lib` already speaks OpenAI in and
 * OpenAI out, its fenced tool-call parsing and shell-routing are
 * backend-agnostic, and the session pool now takes a session factory.
 * So a ChatGPT Web conversation is a drop-in lane — same retry
 * policy, same tool loop, different transport.
 *
 * Tool calling here is the same prompt-emulated path M365 uses: the
 * request's `tools` array is already rendered into the prompt as
 * fenced definitions (`formatFencedToolDefinitions`), and a fenced
 * ```bash block is routed by the existing shell tool. ChatGPT's own
 * native MCP connector (upstream's "full harness" mode) is a
 * follow-on, not this.
 */

import {
  createLogger,
  type ModelProvider,
  type ProviderImage,
  type ProviderStopReason,
  type ProviderTurn,
  type ProviderUsage,
} from "@m365-copilot/core";
import {
  ChatGptBrowserSession,
  type ChatGptBrowserOptions,
} from "./browser.js";
import {
  CHATGPT_WEB_MODELS,
  chatGptWebModelNames,
  describeChatGptModel,
} from "./models.js";

const log = createLogger("chatgpt-web-provider");

export interface ChatGptWebOptions extends ChatGptBrowserOptions {
  /** Transport id restored from the proxy session store. */
  sessionId?: string;
  /** Pre-built session. Injected by tests; production builds its own. */
  browser?: ChatGptBrowserSession;
}

/**
 * A turn still being produced by the browser. `run` returns it before
 * the turn is done, so a caller iterating it gets deltas as ChatGPT
 * streams them — the same live-streaming contract the M365 backend
 * offers.
 */
class StreamingTurn implements ProviderTurn {
  fullText = "";
  images: ProviderImage[] = [];
  hasContent = false;
  throttle: { current: number; max: number } | null = null;
  stopReason: ProviderStopReason = "empty";
  turnCount: number | null = null;
  usage?: ProviderUsage;

  private queue: string[] = [];
  private finished = false;
  private failure: Error | null = null;
  private waiter: PromiseWithResolvers<void> | null = null;

  push(delta: string): void {
    this.fullText += delta;
    this.queue.push(delta);
    this.wake();
  }

  finish(stopReason: ProviderStopReason, usage: ProviderUsage): void {
    this.stopReason = stopReason;
    this.hasContent = this.fullText.length > 0;
    this.usage = usage;
    this.finished = true;
    this.wake();
  }

  fail(error: Error): void {
    this.failure = error;
    this.finished = true;
    this.wake();
  }

  private wake(): void {
    this.waiter?.resolve();
    this.waiter = null;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    for (;;) {
      while (this.queue.length > 0) {
        const delta = this.queue.shift();

        if (delta !== undefined) yield delta;
      }

      if (this.finished) break;
      this.waiter = Promise.withResolvers<void>();
      await this.waiter.promise;
    }

    if (this.failure) throw this.failure;
  }
}

export class ChatGptWebProvider implements ModelProvider {
  readonly id = "chatgpt-web";
  readonly sessionId: string;
  readonly refusalHint =
    "The ChatGPT Web backend declined to answer. ChatGPT Web has no "
    + "tool-agent machinery to retry against — rephrase the request or "
    + "reduce the toolset.";

  private readonly browser: ChatGptBrowserSession;
  private turns = 0;
  private freshConversation = false;

  constructor(options: ChatGptWebOptions = {}) {
    this.browser = options.browser ?? new ChatGptBrowserSession(options);
    this.sessionId = options.sessionId ?? crypto.randomUUID();
  }

  /** The URL of the conversation ChatGPT is showing, when it has one. */
  get conversationId(): string {
    return this.browser.conversationUrl ?? `pending:${this.sessionId}`;
  }

  get turnCount(): number {
    return this.turns;
  }

  newConversation(): void {
    // Navigation is async but the interface is not, so the fresh-chat
    // request is applied at the start of the next turn.
    this.freshConversation = true;
    this.turns = 0;
  }

  async run(
    text: string,
    model: string,
    signal?: AbortSignal,
    wantTools?: boolean,
    images?: { referenceUrls: string[] }[],
  ): Promise<ProviderTurn> {
    if (images && images.length > 0) {
      throw new Error("chatgpt-web backend does not accept image inputs yet");
    }

    if (this.freshConversation) {
      this.freshConversation = false;
      await this.browser.newConversation();
    }

    const turn = new StreamingTurn();
    this.turns += 1;
    turn.turnCount = this.turns;

    void this.browser
      .sendTurn(text, (delta) => turn.push(delta), signal)
      .then(({ text: reply, turnKey }) => {
        log.info(
          `turn complete: model=${describeChatGptModel(model)}, turn=${turnKey}, chars=${reply.length}`,
        );
        turn.finish("completed", {
          conversation_url: this.browser.conversationUrl ?? null,
          turn_key: turnKey,
          requested_model: model,
        });
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        log.info(`turn failed: ${message}`);
        turn.fail(error instanceof Error ? error : new Error(message));
      });

    return turn;
  }

  /**
   * ChatGPT Web has no remote tool machinery to re-resolve — the tool
   * loop lives in the harness, not in the backend. Nothing to refresh,
   * so an empty turn is never worth resending.
   */
  async refreshTools(): Promise<boolean> {
    return false;
  }

  /**
   * ChatGPT Web has no per-conversation quota to burn by retrying a
   * refusal, but it also has no known framing that reliably flips a
   * refusal into an answer, so this never retries. Fail fast.
   */
  recoverFromRefusal(): string | null {
    return null;
  }

  /**
   * Tool definitions are rendered into the prompt as fenced blocks and
   * routed by the harness's shell tool, which works on any backend.
   */
  supportsTools(): boolean {
    return true;
  }

  describeModel(model: string): string {
    return describeChatGptModel(model);
  }

  listModels(): string[] {
    return chatGptWebModelNames();
  }

  /** Close the browser. Called on process exit. */
  async close(): Promise<void> {
    await this.browser.close();
  }
}

/** Model ids this backend accepts. */
export function listChatGptWebModels(): string[] {
  return chatGptWebModelNames();
}

/** Every model this backend can advertise, with its context window. */
export function chatGptWebCatalog(): Array<ChatGptWebModel> {
  return Object.values(CHATGPT_WEB_MODELS);
}

export {
  ChatGptBrowserSession,
  chatGptProfileDir,
  chatGptWebModelNames,
  CHATGPT_WEB_MODELS,
  describeChatGptModel,
};

export type { ChatGptBrowserOptions, ChatGptWebModel };
