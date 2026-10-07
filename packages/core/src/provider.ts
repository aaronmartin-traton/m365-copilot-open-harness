/**
 * The backend seam.
 *
 * `proxy-lib` speaks OpenAI in and OpenAI out; everything between those two
 * points is a `ModelProvider`. The M365 Copilot SignalR backend is one
 * implementation (`ModelSession`), the ChatGPT Web browser backend is another
 * (`ChatGptWebProvider`). A provider owns its own vocabulary — refusal signal,
 * quota shape, telemetry keys, tool-capability policy — and maps them onto the
 * small generic surface below, so the retry/fail-fast policy in the handler
 * never branches on which backend it is talking to.
 *
 * See docs/architecture/BACKENDS.md.
 */

import type { ImageInput } from "./images.js";

/**
 * One image the backend handed back, with the recipe for fetching its bytes.
 * Providers that can inline images as data URLs return none of these.
 */
export interface ProviderImage {
  referenceUrls: string[];
  fileToken?: string;
  pollUrl?: string;
  size?: string;
  orientation?: string;
  status?: number;
}

/**
 * Why a turn ended. Each provider maps its own vocabulary onto these, so the
 * proxy's fail-fast policy is written once.
 *
 * - `completed`   — content produced.
 * - `refused`     — a deliberate safety refusal. M365 sends `messageType:
 *                   "Disengaged"`; retrying it unchanged just refuses again and
 *                   burns quota, so the proxy asks the provider to recover.
 * - `rate_limited`— refused for quota. See `ProviderTurn.throttle`.
 * - `empty`       — no content and no classification (dead agent, dropped
 *                   connection, thread-rate throttle). Safe to retry briefly.
 */
export type ProviderStopReason = "completed" | "refused" | "rate_limited" | "empty";

/**
 * One telemetry value. Providers report numbers (quota counts), strings
 * (tones, conversation URLs) and nulls — deliberately not nested objects, so
 * a client can read `usage.x_<backend>_<field>` without knowing which backend
 * produced it.
 */
export type ProviderUsageValue = string | number | boolean | null;

/** Provider telemetry, keyed by field name. See `ProviderTurn.usage`. */
export interface ProviderUsage {
  readonly [field: string]: ProviderUsageValue;
}

/**
 * The backend's verdict on one turn, as its final frame reports it. M365's is
 * `{value: "Success"}` normally and `{value: "Throttled", errorCode:
 * "PerUserThrottled", message}` when the account is rate-limited — an explicit
 * signal that must not be mistaken for an empty reply.
 */
export interface TurnResult {
  value: string;
  errorCode?: string;
  message?: string;
}

/** The streaming result of one backend turn. */
export interface ProviderTurn {
  [Symbol.asyncIterator](): AsyncIterator<string>;
  /** Full assistant text once the turn completes. */
  fullText: string;
  /** Images generated during the turn. */
  images: ProviderImage[];
  /** True when the backend returned content (deltas or full text). */
  hasContent: boolean;
  /** Quota state, when the backend reports one. */
  throttle: { current: number; max: number } | null;
  stopReason: ProviderStopReason;
  /** Server-side turn count for this thread, when the backend knows it. */
  turnCount?: number | null;
  /** The turn's final verdict, when the backend states one. See TurnResult. */
  result?: TurnResult | null;
  /**
   * Provider telemetry, surfaced in the OpenAI `usage` block under
   * `x_<providerId>_*` keys. The provider owns this vocabulary — M365 emits
   * tone/classifier scores, a browser backend emits its conversation URL.
   */
  usage?: ProviderUsage;
}

export interface ModelProvider {
  /** Stable id: `m365`, `chatgpt-web`. Namespaces the `usage` keys. */
  readonly id: string;
  /** Transport-scoped id, restored from the session store across restarts. */
  readonly sessionId: string;
  /** Backend-side thread identifier. The throttle key, for M365. */
  readonly conversationId: string;
  /** Turns completed in this thread. */
  readonly turnCount: number;

  /** Rotate to a fresh backend thread. */
  newConversation(): void;

  /**
   * Send one prompt and stream the reply.
   *
   * `wantTools` asks the provider to shape this turn so the model emits tool
   * calls — how a provider achieves that is its own business (M365 attaches a
   * Copilot Studio agent; a browser backend injects the fenced framing).
   */
  run(
    text: string,
    model: string,
    signal?: AbortSignal,
    wantTools?: boolean,
    images?: ImageInput[],
  ): Promise<ProviderTurn>;

  /**
   * Re-resolve whatever tool machinery this provider needs, after an empty
   * turn. Returns true when something changed and the original prompt is worth
   * resending.
   */
  refreshTools(): Promise<boolean>;

  /**
   * Recovery for a `refused` turn. Returns a replacement prompt to retry once
   * with, or null to fail fast. `rebuild` re-renders the full prompt under a
   * named framing variant.
   */
  recoverFromRefusal(rebuild: (framing: "softened") => string): string | null;

  /**
   * Whether this provider can drive a tool-capable turn for `model`. Some
   * model/backend combinations tool-call better without extra machinery.
   */
  supportsTools(model: string): boolean;

  /** Short human-readable name for `model`, for logs. */
  describeModel(model: string): string;

  /** Model ids this provider accepts, for `GET /v1/models`. */
  listModels(): string[];

  /**
   * Operator-facing explanation of what this backend refuses on, returned to
   * the client verbatim when a turn comes back `refused`. M365 trips Azure
   * Prompt Shields on toolset size and jailbreak-shaped framing, so its hint
   * names those causes; a browser backend needs no such advice.
   */
  readonly refusalHint?: string;
}
