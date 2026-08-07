/**
 * Response renderer: turns a produced turn result (Produced) into the final
 * OpenAI-compatible Response — JSON for non-streaming requests, an
 * early-flushed SSE stream for stream:true. Extracted from handler.ts; the
 * produce() callable is injected so the renderer is pure and testable without
 * M365.
 */

import { createLogger, type ParsedToolCall } from "@m365-copilot/core";
import { jsonResponse, sseResponse } from "./response-helpers.js";
import { outputFinishReason } from "./output-ceiling.js";

const log = createLogger("response-renderer");

/** The final turn result, produced by handler orchestration. */
export type Produced =
  | { kind: "error"; resp: Response }
  | { kind: "text"; text: string }
  | { kind: "tools"; toolCalls: ParsedToolCall[] };

export interface RenderResponseArgs {
  stream: boolean;
  /** Run one turn and return its result; onDelta forwards live text deltas (SSE only). */
  produce: (onDelta?: (delta: string) => void) => Promise<Produced>;
  /** Whether tools are present — gates live delta passthrough (tool mode buffers). */
  hasTools: boolean;
  /** Build the usage block (called lazily so telemetry is captured by produce time). */
  usage: () => Record<string, unknown>;
  /** Include the usage block in the final chunk (stream_options.include_usage). */
  includeUsage: boolean;
  completionId: string;
  created: number;
  model: string;
}

/**
 * Render the turn result as JSON (non-stream) or an early-flushed SSE stream
 * (stream:true). For streaming, HTTP 200 + a role chunk + heartbeats go out
 * immediately, and produce() runs INSIDE the stream so the client never waits
 * out the whole (up to ~160s) M365 turn before the first byte.
 */
export async function renderResponse(args: RenderResponseArgs): Promise<Response> {
  const { stream, produce, hasTools, usage, includeUsage, completionId, created, model } = args;

  if (!stream) {
    const p = await produce();
    if (p.kind === "error") return p.resp;
    if (p.kind === "tools") {
      return jsonResponse(200, {
        id: completionId, object: "chat.completion", created, model,
        choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: p.toolCalls }, finish_reason: "tool_calls" }],
        usage: usage(),
      });
    }
    return jsonResponse(200, {
      id: completionId, object: "chat.completion", created, model,
      choices: [{ index: 0, message: { role: "assistant", content: p.text }, finish_reason: outputFinishReason(p.text) }],
      usage: usage(),
    });
  }

  // Streaming: send HTTP 200 + a role chunk + keepalive comments from t=0, then run
  // produce() INSIDE the stream so the client never waits out the whole M365 turn
  // (up to ~160s) before the first byte — avoids client read-timeouts.
  //
  // On the non-tool path we forward each text delta AS IT ARRIVES (`liveDelta`), so
  // `stream:true` is genuinely incremental. Tool mode still buffers: the raw text is
  // parsed for tool-call fences and can't be shown verbatim, so its tool_calls (or a
  // prose fallback) are emitted once at the end.
  return sseResponse(new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (obj: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const base = { id: completionId, object: "chat.completion.chunk", created, model };
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      const hb = setInterval(() => { try { controller.enqueue(enc.encode(": keepalive\n\n")); } catch {} }, 15000);

      // Live token passthrough (non-tool only). Track exactly what we've sent so the
      // final render emits only the not-yet-streamed remainder. session.ts guarantees
      // every forwarded delta extends the answer, so `sent` is always a prefix of the
      // final text — the remainder is a clean tail, never a duplicate.
      let sent = "";
      const liveDelta = hasTools ? undefined : (delta: string) => {
        if (!delta) return;
        sent += delta;
        try { send({ ...base, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] }); } catch {}
      };

      let p: Produced;
      try { p = await produce(liveDelta); }
      catch (err: unknown) { p = { kind: "error", resp: jsonResponse(502, { error: { message: err instanceof Error ? err.message : String(err), type: "upstream_error" } }) }; }
      clearInterval(hb);
      try {
        if (p.kind === "error") {
          let message = "upstream error";
          try { message = (JSON.parse(await p.resp.text())?.error?.message) || message; } catch {}
          // HTTP 200 is already committed, so surface the failure as an in-stream error chunk.
          send({ ...base, error: { message, type: "upstream_error" } });
        } else if (p.kind === "tools") {
          p.toolCalls.forEach((tc, i) =>
            send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } }] }, finish_reason: null }] }));
          send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], ...(includeUsage ? { usage: usage() } : {}) });
        } else {
          // Emit only what wasn't already streamed live: the whole text if nothing was
          // (tool-mode prose fallback, or a fully-buffered turn), or just the tail when
          // live deltas already covered a prefix. If `sent` somehow isn't a prefix of
          // the final text (a divergent snapshot upstream chose not to stream), fall
          // back to sending nothing more rather than duplicating already-sent bytes.
          const remainder = p.text.startsWith(sent) ? p.text.slice(sent.length) : "";
          if (!p.text.startsWith(sent)) log.info(`Streamed prefix diverged from final text (sent ${sent.length}, final ${p.text.length} chars) — not re-sending to avoid duplication`);
          if (remainder) send({ ...base, choices: [{ index: 0, delta: { content: remainder }, finish_reason: null }] });
          send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: outputFinishReason(p.text) }], ...(includeUsage ? { usage: usage() } : {}) });
        }
      } catch {
        // client likely disconnected mid-emit — nothing more to do
      } finally {
        try { controller.enqueue(enc.encode("data: [DONE]\n\n")); controller.close(); } catch {}
      }
    },
  }));
}
