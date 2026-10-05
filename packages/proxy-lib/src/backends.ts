/**
 * Backend selection: which `ModelProvider` every conversation runs on.
 *
 * Read from `PROVIDER` at call time, the same way the rest of this
 * package reads `M365_TOOL_MODEL` and friends. Default is the M365
 * backend the proxy was built on, so an unconfigured host behaves
 * exactly as before.
 *
 * The ChatGPT Web lane is a browser-driven, ToS-constrained fallback:
 * it is opt-in by configuration, never by accident.
 */

import {
  getAvailableModels,
  ModelSession,
  type ModelProvider,
  type ModelSessionOptions,
} from "@m365-copilot/core";
import {
  ChatGptWebProvider,
  chatGptWebModelNames,
} from "@m365-copilot/chatgpt-web";

export type BackendId = "m365" | "chatgpt-web";

export interface BackendDescriptor {
  id: BackendId;
  /** `owned_by` on `/v1/models`, and the `usage` key namespace. */
  ownedBy: string;
  /** Models to advertise on `GET /v1/models`. */
  listModels(): string[];
  /** Context/output hints for harnesses. Advertised only. */
  contextWindowTokens: number;
  maxOutputTokens: number;
  /** The single seam `SessionPool` uses to build a conversation session. */
  createSession(options: ModelSessionOptions): ModelProvider;
}

const DEFAULT_CONTEXT_WINDOW = 1_000_000;

const M365_BACKEND: BackendDescriptor = {
  id: "m365",
  ownedBy: "microsoft",
  listModels: getAvailableModels,
  contextWindowTokens: Number(process.env.M365_CONTEXT_WINDOW) || DEFAULT_CONTEXT_WINDOW,
  maxOutputTokens: Number(process.env.M365_MAX_OUTPUT_TOKENS) || DEFAULT_CONTEXT_WINDOW,
  createSession: (options) => new ModelSession(options),
};

const CHATGPT_WEB_BACKEND: BackendDescriptor = {
  id: "chatgpt-web",
  ownedBy: "chatgpt-web",
  listModels: chatGptWebModelNames,
  // Measured ChatGPT Plus Medium/High window (docs/models.ts); the
  // advertised figure is a hint only, ChatGPT compacts its own context.
  contextWindowTokens: Number(process.env.CHATGPT_WEB_CONTEXT_WINDOW) || 90_000,
  maxOutputTokens: Number(process.env.CHATGPT_WEB_MAX_OUTPUT_TOKENS) || DEFAULT_CONTEXT_WINDOW,
  createSession: (options) => new ChatGptWebProvider(options),
};

const BACKENDS: Record<BackendId, BackendDescriptor> = {
  m365: M365_BACKEND,
  "chatgpt-web": CHATGPT_WEB_BACKEND,
};

/** Parse a backend id, treating an unset/unknown value as the M365 default. */
export function parseBackendId(value: string | undefined): BackendId {
  // SAFETY: guarded by the `in` check above, so `value` is a key of BACKENDS.
  return value && value in BACKENDS ? (value as BackendId) : "m365";
}

/** The configured backend. */
export function activeBackend(): BackendDescriptor {
  return BACKENDS[parseBackendId(process.env.PROVIDER)];
}
