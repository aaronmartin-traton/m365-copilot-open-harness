/**
 * The OpenAI API backend: a `ModelProvider` that spends an API key instead of an
 * M365 subscription. Supersedes the ChatGPT Web lane, which drove a personal
 * chatgpt.com session and so could not honour the requested `model`.
 *
 * `model` really selects the model here, and refusals/quota arrive as ordinary
 * `finish_reason` values, so there is no Disengage-recovery machinery.
 *
 * Local and self-hosted routes are the same code: point `OPENAI_BASE_URL` at any
 * OpenAI-compatible `/v1` server (LM Studio, llama.cpp, vLLM, Ollama's shim).
 *
 * Tool calling is still prompt-emulated through the shared fenced framing: the
 * `ModelProvider` seam carries text, not a tool-call channel, so OpenAI's native
 * `tool_calls` are deliberately unused.
 */
import { z } from "zod/v4";
import { createLogger, trunc } from "./log.js";
import type { ImageInput } from "./images.js";
import type { ModelProvider, ProviderStopReason, ProviderTurn } from "./provider.js";

const log = createLogger("openai");

/** Raised when the OpenAI API rejects a turn; carries the HTTP status. */
export class OpenAiError extends Error {
  readonly status: number;
  readonly detail: string | null;

  constructor(message: string, status: number, detail: string | null = null) {
    super(message);
    this.name = "OpenAiError";
    this.status = status;
    this.detail = detail;
  }
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * Chat Completions model ids this lane advertises. A client may still request
 * any other id — the field is passed through verbatim — so a new OpenAI model
 * works without a proxy release. This list only populates `GET /v1/models`.
 * Override with `OPENAI_MODELS` (comma-separated).
 */
export type OpenAiModelId = (typeof DEFAULT_MODELS)[number];

const DEFAULT_MODELS = [
  "gpt-6.1-sol",
  "gpt-6-luna",
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.2",
  "gpt-5",
  "gpt-5-mini",
  "gpt-4.1",
  "o3",
] as const;

/** The `GET /models` listing an OpenAI-compatible endpoint returns. */
const ModelListSchema = z.object({ data: z.array(z.object({ id: z.string() })) });

/**
 * Asks a configured endpoint which models it serves, for the setup script to
 * print. Returns null when discovery is unavailable — the caller falls back to
 * {@link openAiModelNames}. Only called off the request path.
 */
export async function discoverOpenAiModels(baseUrl?: string): Promise<string[] | null> {
  const root = baseUrl ?? openAiBaseUrl();

  try {
    const response = await fetch(`${root}/models`, {
      headers: openAiApiKey() === null ? {} : { Authorization: `Bearer ${openAiApiKey()}` },
      signal: AbortSignal.timeout(3_000),
    });

    if (!response.ok) { return null; }

    const listed = ModelListSchema.safeParse(await response.json());

    if (!listed.success || listed.data.data.length === 0) { return null; }

    return listed.data.data.map((entry) => entry.id);
  } catch {
    return null;
  }
}

/** Context window advertised for the models above; OpenAI reports 1,050,000. */
const CONTEXT_WINDOW = 1_050_000;

/** Model ids to advertise on `/v1/models`. */
export function openAiModelNames(): string[] {
  const override = process.env.OPENAI_MODELS?.trim();

  if (override !== undefined && override.length > 0) {
    return override.split(",").map((id) => id.trim()).filter((id) => id.length > 0);
  }

  return [...DEFAULT_MODELS];
}

/** The advertised context window; `OPENAI_CONTEXT_WINDOW` overrides it. */
export function openAiContextWindow(): number {
  const override = Number(process.env.OPENAI_CONTEXT_WINDOW);

  return Number.isFinite(override) && override > 0 ? override : CONTEXT_WINDOW;
}

/** The API root, without a trailing slash. `OPENAI_BASE_URL` overrides it. */
export function openAiBaseUrl(): string {
  const configured = process.env.OPENAI_BASE_URL?.trim();

  if (configured !== undefined && configured.length > 0) return configured.replace(/\/+$/, "");

  return DEFAULT_BASE_URL;
}

/**
 * The API key, or null when none is set. Null is only an error against
 * `api.openai.com`: a self-hosted endpoint (`OPENAI_BASE_URL`) may authenticate
 * by nothing at all, which is how LM Studio and friends are meant to be used.
 */
export function openAiApiKey(): string | null {
  const key = process.env.OPENAI_API_KEY?.trim();

  return key !== undefined && key.length > 0 ? key : null;
}

/** Whether the lane talks to OpenAI itself, which always needs a key. */
export function openAiRequiresKey(): boolean {
  return openAiBaseUrl() === DEFAULT_BASE_URL;
}

/** Plain-language text for the statuses an operator can actually fix. */
function explain(status: number, body: string): string {
  if (status === 401) {
    return "The OpenAI API key was rejected. Check OPENAI_API_KEY.";
  }

  if (status === 403) {
    return "This OpenAI API key may not use the requested model. Check the project's model access.";
  }

  if (status === 404) {
    return "OpenAI has no model by that id. Check GET /v1/models for the ids this lane serves.";
  }

  if (status === 429) {
    return "OpenAI rate-limited or exhausted this key's quota.";
  }

  if (status >= 500) {
    return `OpenAI returned HTTP ${status}. This is OpenAI-side; retry shortly.`;
  }

  return `OpenAI rejected the request (HTTP ${status}): ${trunc(body, 300)}`;
}

/** The user message content: plain text, or text plus image parts. */
type OpenAiMessageContent = string | OpenAiContentPart[];

/** One part of a multi-part user message. */
type OpenAiContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image_url"; readonly image_url: { readonly url: string } };

/** The Chat Completions request this lane sends. */
interface OpenAiChatRequest {
  readonly model: string;
  readonly stream: boolean;
  readonly messages: readonly { readonly role: string; readonly content: OpenAiMessageContent }[];
}

/** One SSE frame's worth of a streamed completion. */
interface StreamChunk {
  readonly content: string;
  readonly finishReason: string | null;
}

/**
 * Reads a `text/event-stream` of OpenAI chunks, yielding each content delta in
 * order. Exported for the unit test that drives a real stream shape.
 */
export async function* readOpenAiStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf("\n");

      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");

        if (!line.startsWith("data:")) continue;

        const payload = line.slice("data:".length).trim();

        if (payload === "[DONE]") return;

        const chunk = parseStreamPayload(payload);

        if (chunk !== null) yield chunk;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** One SSE `data:` payload, as OpenAI frames a streamed choice. */
const StreamChunkSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: z.object({ content: z.string().optional() }).optional(),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
});

/** One decoded SSE `data:` payload, or null for a frame that carries no choice. */
function parseStreamPayload(payload: string): StreamChunk | null {
  let raw: unknown;

  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }

  const decoded = StreamChunkSchema.safeParse(raw);

  if (!decoded.success) return null;

  const [first] = decoded.data.choices;

  return {
    content: first.delta?.content ?? "",
    finishReason: first.finish_reason ?? null,
  };
}

/** Maps OpenAI's `finish_reason` onto the seam's vocabulary. */
function stopReasonFor(finishReason: string | null, hasContent: boolean): ProviderStopReason {
  // A stated refusal is a refusal even when the body is empty — the handler
  // retries `empty` and fails fast on `refused`, so classifying a content
  // filter as empty would re-send a request OpenAI has already declined.

  if (finishReason === "content_filter") { return "refused"; }

  return hasContent ? "completed" : "empty";
}

export interface OpenAiSessionOptions {
  /** Injected for tests; defaults to the process environment. */
  readonly apiKey?: string | null;
  readonly baseUrl?: string;
  readonly sessionId?: string;
  readonly conversationId?: string;
  readonly turnCount?: number;
}

/**
 * One OpenAI conversation from the proxy's point of view. The Chat Completions
 * API is stateless, so `conversationId` is a proxy-side label only — it exists
 * because the session store keys threads by it. Turns are stateless too: the
 * caller sends the whole history as the prompt, exactly as the M365 lane does.
 */
export class OpenAiProvider implements ModelProvider {
  readonly id = "openai";
  readonly sessionId: string;
  /** A proxy-side thread label; OpenAI itself keeps no conversation. */
  conversationId: string;

  private turns: number;
  private readonly key: string | null;
  private readonly baseUrl: string;

  constructor(options: OpenAiSessionOptions = {}) {
    this.sessionId = options.sessionId ?? crypto.randomUUID();
    this.conversationId = options.conversationId ?? crypto.randomUUID();
    this.turns = options.turnCount ?? 0;
    this.key = options.apiKey === undefined ? openAiApiKey() : options.apiKey;
    this.baseUrl = options.baseUrl ?? openAiBaseUrl();
  }

  get turnCount(): number {
    return this.turns;
  }

  /** Nothing to rotate: the API keeps no server-side thread. */
  newConversation(): void {
    this.conversationId = crypto.randomUUID();
    this.turns = 0;
  }

  /** No agent machinery on this lane, so there is nothing to re-resolve. */
  async refreshTools(): Promise<boolean> {
    return false;
  }

  /** OpenAI states refusals as a `finish_reason`, so there is nothing to retry. */
  recoverFromRefusal(): null {
    return null;
  }

  supportsTools(): boolean {
    return true;
  }

  describeModel(model: string): string {
    return `OpenAI ${model}`;
  }

  listModels(): string[] {
    return openAiModelNames();
  }

  async run(
    text: string,
    model: string = "gpt-5",
    signal?: AbortSignal,
    _wantTools?: boolean,
    images: ImageInput[] = [],
  ): Promise<ProviderTurn> {
    // A self-hosted endpoint may legitimately need no credential; OpenAI's own
    // always does, and a missing key there would fail as an opaque 401.
    if (this.key === null && openAiRequiresKey()) {
      throw new OpenAiError(
        "No OpenAI API key is set. Set OPENAI_API_KEY and start the proxy again.",
        401,
      );
    }

    const body = {
      model,
      stream: true,
      messages: [{ role: "user", content: buildContent(text, images) }],
    } satisfies OpenAiChatRequest;

    log.info(`run: model=${model}, turn=${this.turns}, sid=${this.sessionId}, text=${JSON.stringify(trunc(text, 200))}`);

    const headers = new Headers({ "Content-Type": "application/json" });

    if (this.key !== null) { headers.set("Authorization", `Bearer ${this.key}`); }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new OpenAiError(explain(response.status, detail), response.status, detail || null);
    }

    if (response.body === null) {
      throw new OpenAiError("OpenAI returned an empty streaming body.", 502);
    }

    this.turns += 1;

    return this.turn(response.body, model);
  }

  /**
   * Wrap the upstream stream in the seam's shape. Deltas are forwarded as they
   * arrive, and `fullText` is accumulated so a caller that only reads the
   * final value (non-streaming responses) still gets the whole answer.
   */
  private turn(body: ReadableStream<Uint8Array>, model: string): ProviderTurn {
    let fullText = "";
    let finishReason: string | null = null;
    let hasContent = false;

    const stream: AsyncIterable<string> = {
      async *[Symbol.asyncIterator](): AsyncIterator<string> {
        for await (const chunk of readOpenAiStream(body)) {
          if (chunk.finishReason !== null) { finishReason = chunk.finishReason; }

          if (chunk.content.length === 0) { continue; }

          hasContent = true;
          fullText += chunk.content;

          yield chunk.content;
        }
      },
    };

    return {
      [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
      get fullText(): string {
        return fullText;
      },
      images: [],
      get hasContent(): boolean {
        return hasContent;
      },
      throttle: null,
      get stopReason() {
        return stopReasonFor(finishReason, hasContent);
      },
      turnCount: this.turns,
      usage: { model, backend: "openai" },
    };
  }
}

/** The user message: the prompt, plus any images as base64 data URLs. */
function buildContent(text: string, images: ImageInput[]): OpenAiMessageContent {
  if (images.length === 0) return text;

  const parts: OpenAiContentPart[] = [{ type: "text", text }];

  for (const image of images) {
    const encoded = Buffer.from(image.data).toString("base64");

    parts.push({
      type: "image_url",
      image_url: { url: `data:${image.mediaType};base64,${encoded}` },
    });
  }

  return parts;
}
