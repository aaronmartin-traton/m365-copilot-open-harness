/**
 * The ChatGPT Web models this proxy advertises.
 *
 * What an account can actually serve is decided by ChatGPT's own model picker,
 * not by us. Upstream's launcher generates its catalog from the signed-in
 * account and refuses to install a row that account cannot use; these are the
 * rows its documentation names. The picker stays the authority — a mismatch
 * surfaces as a failed turn, never as a silent downgrade to a different model.
 *
 * Context windows are the measured figures upstream reports for Plus
 * Medium/High (90k) and for the experimental 3x context (270k); the planner
 * reserves 10% on top for auto-compaction.
 */

export interface ChatGptWebModel {
  /** Slug accepted on the OpenAI `model` field. */
  id: string;
  /** Label ChatGPT's picker shows, for logs and operator diagnosis. */
  label: string;
  /** Context window advertised to harnesses on `/v1/models`. */
  contextWindow: number;
  /** Fraction of the window the planner leaves free for auto-compaction. */
  compactionReserve: number;
}

const MEASURED_WINDOW = 90_000;

const MEASURED_WINDOW_3X = 270_000;

const RESERVE = 0.1;

const model = (
  id: string,
  label: string,
  contextWindow: number = MEASURED_WINDOW,
): ChatGptWebModel => ({ id, label, contextWindow, compactionReserve: RESERVE });

export const CHATGPT_WEB_MODELS = {
  "chatgpt-web/luna": model("chatgpt-web/luna", "GPT-5.6 Luna (Web)"),
  "chatgpt-web/luna-think": model("chatgpt-web/luna-think", "GPT-5.6 Luna (Web) · Think"),
  "chatgpt-web/sol-instant": model("chatgpt-web/sol-instant", "GPT-5.6 Sol Instant (Web)"),
  "chatgpt-web/sol-medium": model("chatgpt-web/sol-medium", "GPT-5.6 Sol (Web) · Medium"),
  "chatgpt-web/sol-high": model("chatgpt-web/sol-high", "GPT-5.6 Sol (Web) · High"),
  "chatgpt-web/pro": model("chatgpt-web/pro", "GPT-5.6 Pro (Web)", MEASURED_WINDOW_3X),
} satisfies Record<string, ChatGptWebModel>;

export function chatGptWebModelNames(): string[] {
  return Object.keys(CHATGPT_WEB_MODELS);
}

/**
 * Describe a requested model for telemetry. An unrecognised slug is reported
 * verbatim rather than snapped to a known row — the picker decides what really
 * runs, so a guess here would be a lie in the usage block.
 */
export function describeChatGptModel(requested: string): string {
  return CHATGPT_WEB_MODELS[requested]?.label ?? requested;
}
