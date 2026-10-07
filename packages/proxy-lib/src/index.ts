import {
  type ModelSessionOptions,
  getDegradationBackoffState,
  getAgentAvailability,
  isDegradationBackoff,
  getThrottleEventCounts,
} from "@m365-copilot/core";
import { activeBackend, type BackendDescriptor } from "./backends.js";
import { handleChatCompletion } from "./handler.js";
import { SessionPool } from "./session-pool.js";
import { ChatCompletionRequest } from "./schemas.js";
import {
  ResponsesRequest,
  handleResponse,
  type ResponsesRequestBody,
} from "./responses.js";

export { handleChatCompletion } from "./handler.js";

export {
  SessionPool,
  type ConversationState,
  type ConversationPruneSelector,
  type RemoteConversationPruner,
  type SessionPoolOptions,
} from "./session-pool.js";

export { ChatCompletionRequest, ChatMessage, ToolCall, ToolDefinition } from "./schemas.js";

export { ImageGenerationRequest, handleImageGeneration, type ImageGenerationBody } from "./images-generation.js";

export {
  activeBackend,
  parseBackendId,
  type BackendDescriptor,
  type BackendId,
} from "./backends.js";

export { ResponsesRequest, handleResponse } from "./responses.js";

export { RequestScheduler, SchedulerBusyError, type SchedulerStats } from "./scheduler.js";

export {
  compileDelta,
  LOCAL_TOOL_REMINDER,
  type DeltaContextInput,
} from "./context-compiler.js";

export { buildUsage, type UsageInput } from "./usage-builder.js";

export {
  jsonResponse,
  sseResponse,
  rateLimitMessage,
  rateLimitResponse,
  schedulerBusyResponse,
  emptyResponseResponse,
} from "./response-helpers.js";

export { parseImageDataUrl, type ParsedImageInput } from "./images.js";

export {
  SessionStateStore,
  type PersistedSessionState,
} from "./session-store.js";

export {
  ConversationPruneSelectorSchema,
  handleConversationPrune,
  type ConversationPruneRequest,
} from "./pruning.js";

export {
  AttestationRequestSchema,
  handleAttestationRequest,
  getAttestationGate,
  requestedAttestationClient,
  resetAttestationGate,
  type AttestationClient,
  type AttestationGate,
  type AttestationRequest,
} from "./attestation.js";

// Re-export tool utilities from core
export {
  formatMessages,
  formatToolDefinitions,
  parseToolCalls,
  getMessageContent,
  type Message,
  type ToolDef,
  type ToolChoice,
  type ParsedToolCall,
  type ParseResult,
} from "@m365-copilot/core";


export function buildHealthPayload(pool?: SessionPool, reaper?: { lastRunAt: number | null; pruned: number; failed: number; disabled?: boolean }) {
  const backoff = getDegradationBackoffState();

  return {
    backend: activeBackend().id,
    status: "ok" as const,
    ...(pool ? pool.diagnostics() : {}),
    ...(reaper ? { reaper } : {}),
    backoff: {
      active: isDegradationBackoff(),
      until: backoff.backoffUntil,
      level: backoff.level,
      recentEmptyConversations: new Set(backoff.empties.map((entry) => entry.conv)).size,
      telemetry: getThrottleEventCounts(),
    },
    temporaryChat: process.env.M365_TEMPORARY_CHAT === "1",
    toolModel: process.env.M365_TOOL_MODEL?.trim() || null,
    agent: getAgentAvailability(),
  };
}


/** Build the OpenAI-compatible `GET /v1/models` payload for the active backend. */
export function buildModelsPayload(backend: BackendDescriptor = activeBackend()) {
  const created = Math.floor(Date.now() / 1000);

  return {
    object: "list",
    data: backend.listModels().map((id) => ({
      id,
      object: "model",
      created,
      owned_by: backend.ownedBy,
      // Non-standard but widely-read by OpenAI-compatible harnesses. Several
      // aliases because clients disagree on the key name. Unknown keys are
      // ignored by strict clients.
      context_window: backend.contextWindowTokens,
      max_context_length: backend.contextWindowTokens,
      max_input_tokens: backend.contextWindowTokens,
      max_output_tokens: backend.maxOutputTokens,
    })),
  };
}

// --- CORS (permissive, matches the previous Hono `cors()` default) ---

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-M365-Session-Key",
};

function withCors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);

  return res;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A minimal Web fetch handler — the same shape Hono exposed via `app.fetch`. */
interface FetchApp {
  fetch(req: Request): Promise<Response>;
}

/**
 * Create a framework-free fetch handler that serves an OpenAI-compatible API
 * backed by M365 Copilot. Each distinct conversation automatically gets its own
 * M365 session via the SessionPool.
 *
 * This is the embeddable entry point used by tests and `proxy-verify` for
 * generic shell-capable clients. The standalone server is the Nitro app in
 * `@m365-copilot/proxy`, whose routes reuse the same `handleChatCompletion` /
 * `buildModelsPayload` helpers.
 */
export function createApp(sessionOptions: ModelSessionOptions = {}): FetchApp {
  const backend = activeBackend();
  const pool = new SessionPool(sessionOptions, { createSession: backend.createSession });

  async function fetch(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    const method = req.method.toUpperCase();

    if (method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    if (method === "GET" && pathname === "/health") {
      return withCors(json(200, buildHealthPayload(pool)));
    }

    if (method === "GET" && pathname === "/v1/models") {
      return withCors(json(200, buildModelsPayload()));
    }

    if (method === "POST" && pathname === "/v1/chat/completions") {
      let body: ReturnType<typeof ChatCompletionRequest.parse>;

      try {
        body = ChatCompletionRequest.parse(await req.json());
      } catch (err: any) {
        return withCors(
          json(400, { error: { message: err.message, type: "invalid_request_error" } }),
        );
      }

      // req.signal aborts when the client disconnects → cancels the M365 turn.
      return withCors(await handleChatCompletion(body, pool, {
        signal: req.signal,
        sessionKey: req.headers.get("x-m365-session-key") ?? undefined,
      }));
    }

    if (method === "POST" && pathname === "/v1/responses") {
      let body: ResponsesRequestBody;

      try {
        body = ResponsesRequest.parse(await req.json());
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);

        return withCors(
          json(400, { error: { message, type: "invalid_request_error" } }),
        );
      }

      return withCors(await handleResponse(body, pool, {
        signal: req.signal,
        sessionKey: req.headers.get("x-m365-session-key") ?? undefined,
      }));
    }

    return withCors(
      json(404, { error: { message: "Not found", type: "invalid_request_error" } }),
    );
  }

  return { fetch };
}
