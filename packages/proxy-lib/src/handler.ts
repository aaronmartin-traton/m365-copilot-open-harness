import {
  createLogger,
  trunc,
  getMessageContent,
  getMessageImages,
  formatMessages,
  noteRequestOutcome,
  awaitDegradationBackoff,
  emitThrottleEvent,
  hashConversationId,
  type ProviderTurn,
  type ProviderUsage,
} from "@m365-copilot/core";
import { ChatCompletionRequest } from "./schemas.js";
import { SchedulerBusyError } from "./scheduler.js";
import { SessionPool } from "./session-pool.js";
import { compileDelta, LOCAL_TOOL_REMINDER } from "./context-compiler.js";
import { buildUsage } from "./usage-builder.js";
import { jsonResponse, rateLimitResponse, schedulerBusyResponse, emptyResponseResponse, throttledResponse } from "./response-helpers.js";
import { localMetaResponse, renderLocalCompletion } from "./local-response-helpers.js";
import { renderImagesMarkdown } from "./image-renderer.js";
import { produceToolPath } from "./tool-path.js";
import { getToolRepair } from "./tool-repair.js";
import { renderResponse, type Produced } from "./response-renderer.js";
import { driftAlert, recordDriftSample } from "./drift-guard.js";
import type { z } from "zod/v4";

const log = createLogger("handler");

// The OpenAI-compatible request body shape accepted by the proxy.
type ChatBody = z.infer<typeof ChatCompletionRequest>;

/** The M365 steering-ladder fields in a ProviderTurn's usage. */
interface M365Usage extends ProviderUsage {
  system_fingerprint: string;
  dea_score: number;
}

// --- Main handler ---

/**
 * Handle a chat completion request, returning an OpenAI-compatible Response.
 * The SessionPool routes each conversation to its own ModelSession.
 */
export async function handleChatCompletion(
  body: ChatBody,
  pool: SessionPool,
  opts: {
    signal?: AbortSignal;
    sessionKey?: string;
    managedKey?: string;
  } = {},
): Promise<Response> {
  const localMeta = localMetaResponse(body);

  if (localMeta !== null) return renderLocalCompletion(body, localMeta);

  const metadataSessionId = body.metadata?.session_id;

  const sessionKey = opts.sessionKey ?? body.conversation_id ?? metadataSessionId ?? body.user;
  const release = await pool.acquire(body.messages, sessionKey, opts.managedKey);

  try {
    const conv = pool.resolve(body.messages, sessionKey, opts.managedKey);
    const { session } = conv;
    const hasTools = body.tools && body.tools.length > 0 && body.tool_choice !== "none";
  const requestImages = body.messages.flatMap((message) => getMessageImages(message));
  const model = body.model;

  const routedModel = hasTools && process.env.M365_TOOL_MODEL?.trim()
    ? process.env.M365_TOOL_MODEL.trim()
    : model;

  // Whether this turn carries the backend's tool machinery is the provider's
  // call — M365 hides a tone-dependent rule behind it (ModelSession.supportsTools:
  // Claude tones tool-call better agent-less). The proxy only supplies request
  // facts; no backend vocabulary belongs in this decision.
  const useToolAgent = !!hasTools && requestImages.length === 0 && session.supportsTools(routedModel);
  const modelLabel = session.describeModel(routedModel);

  // Format message: full prompt on first turn, delta on follow-ups.
  // M365 is stateful — it remembers everything from prior turns,
  // so we only need to send new messages after the first turn.
  const isFirstTurn = session.turnCount === 0;
  const convId = session.conversationId;
  let text: string;

  if (isFirstTurn || conv.sentMessageCount === 0) {
    text = formatMessages(body.messages, body.tools, body.tool_choice, convId);
    log.info(`Chat completion: backend=${session.id}, model=${model}, routed=${routedModel}, resolved=${modelLabel}, stream=${body.stream}, messages=${body.messages.length}, turn=${session.turnCount}, mode=full, cid=${convId}`);
  } else {
    const firstUser = body.messages.find((message) => message.role === "user");
    const taskAnchor = firstUser ? getMessageContent(firstUser) : "";
    const newMessages = body.messages.slice(conv.sentMessageCount);

    const delta = newMessages.length > 0
      ? compileDelta({ messages: newMessages, taskAnchor, hasTools: !!hasTools, history: body.messages })
      : "";

    if (delta.length > 0) {
      text = delta;

      // Only a tool result is the thing the note corrects the model about.
      if (conv.pendingNote && newMessages.some((m) => m.role === "tool")) {
        text = `${conv.pendingNote}\n\n${delta}`;
        log.info("Prepended the only-the-first-call-ran note (last reply was partly executed)");
      }

      log.info(`Chat completion: backend=${session.id}, model=${model}, routed=${routedModel}, resolved=${modelLabel}, stream=${body.stream}, messages=${body.messages.length}, new=${newMessages.length}, turn=${session.turnCount}, mode=delta, cid=${convId}`);
    } else {
      // No meaningful new content to send — nudge the backend to continue.
      text = hasTools ? `${LOCAL_TOOL_REMINDER}\n\nPlease continue.` : "Please continue.";
      log.info(`Chat completion: backend=${session.id}, model=${model}, routed=${routedModel}, resolved=${modelLabel}, stream=${body.stream}, messages=${body.messages.length}, turn=${session.turnCount}, mode=retry, cid=${convId}`);
    }
  }

  conv.pendingNote = null; // one turn only: consumed above, or stale

  log.debug("Formatted prompt:", trunc(text, 1000));

  let imagesSent = false;
  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  // Buffer the full response, with a couple of quick retries on an empty reply.
  const MAX_RETRIES = 2;
  const SHORT_RETRY_DELAY_MS = 2_000;

  // Captured from the final attempt and surfaced through the OpenAI `usage` block,
  // so clients can see the backend's own telemetry. Token counts aren't exposed
  // by either backend, so the base fields stay zero.
  let lastUsage: ProviderUsage | undefined;
  let lastSteeringFingerprint: string | undefined;

  // `onDelta` (when provided) forwards each text delta to the caller AS IT ARRIVES,
  // for live incremental streaming. It's safe to forward without ever retracting:
  // runBuffered only retries on an EMPTY attempt (Disengaged, dead-agent, throttle),
  // and an empty attempt emits no deltas — so a forwarded delta always belongs to the
  // one attempt that produced content and is never re-sent by a subsequent retry.
  async function runBuffered(
    onDelta?: (delta: string) => void,
  ): Promise<{ fullText: string } | { error: Response }> {
    try {
      return await pool.schedule(
        { signal: opts.signal, newConversation: session.turnCount === 0 },
        async () => {
    let toolsRefreshed = false;
    let refusalRetried = false;
    const originalText = text;
    // Self-imposed pacing while the account is degraded (thread-rate throttle). A
    // no-op when healthy; during backoff it sleeps a jittered delay so we stop
    // starting fresh turns into the throttle and let it self-heal (H-R1). This
    // replaced the old auto-reauth, which didn't clear the throttle and raised our
    // detection profile. A single long pi thread never trips the trigger.
    await awaitDegradationBackoff();

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let turn: ProviderTurn;

      try {
        const images = imagesSent ? [] : requestImages;
        turn = await session.run(text, routedModel, opts.signal, useToolAgent, images);

        if (images.length > 0) imagesSent = true;
      } catch (err: any) {
        return { error: jsonResponse(502, { error: { message: err.message, type: "upstream_error" } }) };
      }

      let fullText = "";

      try {
        for await (const delta of turn) {
          fullText += delta;
          onDelta?.(delta);
        }

        if (turn.fullText && turn.fullText.length > fullText.length) {
          fullText = turn.fullText;
        }
      } catch (err: unknown) {
        // A client that disconnects mid-turn is not a server fault. Rethrow so
        // the scheduler's outer catch maps it to 499 `request_aborted`; only
        // genuine backend faults become 502 here.
        if (err instanceof Error && err.name === "AbortError") throw err;

        return { error: jsonResponse(502, { error: { message: err instanceof Error ? err.message : String(err), type: "upstream_error" } }) };
      }

      const capturedImages = turn.images ?? [];

      if (capturedImages.length > 0) {
        const imageMarkdown = await renderImagesMarkdown(capturedImages);

        if (imageMarkdown) {
          const addition = fullText ? `\n\n${imageMarkdown}` : imageMarkdown;
          fullText += addition;
          onDelta?.(addition);
        }
      }

      lastUsage = turn.usage;

      // `system_fingerprint` is emitted by the M365 steering ladder only, so it
      // is absent on every other backend.
      // SAFETY: M365Usage declares the two ladder fields the handler reads.
      const usage = turn.usage as Partial<M365Usage> | undefined;
      lastSteeringFingerprint = usage?.system_fingerprint;
      const deaScore = usage?.dea_score;

      // Disengagement/dea-drift guard (ticket 03): observational sink keyed by
      // fingerprint bucket — alerts (log line) when steered turns drift above
      // the unsteered baseline. Never fails the request, never fails the ladder.
      recordDriftSample({
        fingerprint: lastSteeringFingerprint ?? "unsteered",
        disengaged: turn.stopReason === "refused",
        deaScore,
        at: Date.now(),
      });
      const drift = driftAlert();

      if (drift) log.info(`Drift alert: ${drift}`);

      // M365 SAYS when it throttles: the final item's result is `Throttled` /
      // `PerUserThrottled` (upstream b3bf1ca, #35). Checked BEFORE the content
      // check so a BotConnection apology can never pass for an answer. Retrying
      // only sends more turns into the throttle, so fail fast with a 429 and
      // feed the degradation backoff.
      if (turn.result?.value === "Throttled") {
        noteRequestOutcome(true, convId);
        emitThrottleEvent({
          ts: new Date().toISOString(),
          event: "throttled",
          convIdHash: hashConversationId(convId ?? "anon"),
        });
        log.info(`Upstream Throttled (${turn.result.errorCode ?? "no errorCode"}) — 429, no retry`);

        return { error: throttledResponse(turn.result) };
      }

      if (turn.hasContent || fullText.length > 0) {
        noteRequestOutcome(false, convId); // clean response → degradation has lifted

        return { fullText };
      }

      // A refusal is a deliberate safety decision, NOT a transient empty. Retrying
      // it with "Please continue." just refuses again and burns the conversation
      // quota (observed: 5 wasted messages in one turn). Ask the backend whether it
      // knows how to recover; otherwise fail fast with a clear signal.
      if (turn.stopReason === "refused") {
        if (hasTools && !refusalRetried) {
          const recovery = session.recoverFromRefusal(
            (framing) => formatMessages(body.messages, body.tools, body.tool_choice, session.conversationId, framing),
          );

          if (recovery !== null) {
            refusalRetried = true;
            emitThrottleEvent({
              ts: new Date().toISOString(),
              event: "disengaged",
              framing: "softened",
              retryOutcome: "softened-retry",
              convIdHash: hashConversationId(convId ?? "anon"),
            });
            text = recovery;
            log.info(`Upstream refused — retrying once with the ${session.id} recovery framing in a fresh conversation`);
            attempt--; // free retry; bounded — refusalRetried flips once
            continue;
          }
        }

        log.info("Upstream refused — failing fast (no retry) to preserve quota");
        emitThrottleEvent({
          ts: new Date().toISOString(),
          event: "disengaged",
          framing: refusalRetried ? "softened" : "default",
          retryOutcome: "fail-fast",
          convIdHash: hashConversationId(convId ?? "anon"),
        });

        return {
          error: jsonResponse(502, {
            error: {
              message: session.refusalHint ?? `The ${session.id} backend declined to answer this request.`,
              type: "disengaged",
            },
          }),
        };
      }

      // Empty response. Only an at-limit throttle warrants treating this as rate
      // limiting; otherwise it's a different failure (content filter, an invalid
      // agent/session, a transient upstream error) where a long escalating
      // backoff is futile and reads as a silent hang. Fail fast after a couple of
      // quick retries instead.
      const t = turn.throttle;

      if (t && t.current >= t.max) {
        emitThrottleEvent({
          ts: new Date().toISOString(),
          event: "at-limit",
          convIdHash: hashConversationId(convId ?? "anon"),
          current: t.current,
          max: t.max,
        });

        return { error: rateLimitResponse(t) };
      }

      if (attempt < MAX_RETRIES) {
        // A dead/deleted agent returns an instant empty reply (throttle: null).
        // Re-resolve the agent once before retrying so a long-lived host
        // self-heals from the deleted-agent trap instead of looping on empties.
        if (!toolsRefreshed) {
          toolsRefreshed = true;
          const toolsChanged = await session.refreshTools();

          if (toolsChanged) {
            // The cached agent was stale/deleted and has been re-resolved.
            // Resend the original prompt to the fresh agent — a bare "continue"
            // would have no context since the dead agent processed nothing.
            log.info("Tool machinery re-resolved after empty reply, resending original prompt");
            text = originalText;
            await new Promise(r => setTimeout(r, SHORT_RETRY_DELAY_MS));
            continue;
          }
        }

        log.info(`Empty upstream response, quick retry in ${SHORT_RETRY_DELAY_MS / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, SHORT_RETRY_DELAY_MS));
        text = "Please continue."; // M365 already has context
      } else {
        // Final empty after retries, and not an at-limit (per-conversation) cap:
        // this is the thread-rate throttle signature (F13). Feed the degradation-
        // backoff policy — once empties span enough distinct conversations it paces
        // subsequent turns so the account can self-heal (H-R1). Never blocks this request.
        noteRequestOutcome(true, convId);

        return { error: emptyResponseResponse(t) };
      }
    }

    noteRequestOutcome(true, convId);

    return { error: emptyResponseResponse(null) };
        },
      );
    } catch (err: any) {
      if (err instanceof SchedulerBusyError) {
        return { error: schedulerBusyResponse(err) };
      }

      if (err?.name === "AbortError") {
        return { error: jsonResponse(499, { error: { message: err.message, type: "request_aborted" } }) };
      }

      return { error: jsonResponse(502, { error: { message: err?.message ?? "scheduler error", type: "upstream_error" } }) };
    }
  }

  // Produce the final turn result as DATA (not a Response), so the same logic
  // renders as either JSON (non-stream) or an early-flushed SSE stream (stream).
  // For streaming we return the SSE stream FIRST and run produce() INSIDE it, so the
  // `onDelta` streams text to the client live (non-tool path only — see produce's
  // caller). Tool mode ignores it: the raw text is parsed for tool-call fences and
  // can't be shown verbatim, so it stays fully buffered.
  async function produce(onDelta?: (delta: string) => void): Promise<Produced> {
  // When tools are present, buffer full response to detect tool calls
  if (hasTools) {
    // The upstream retry loop (runBuffered) is orchestration that stays here; the
    // parse/retry-on-confab/fallback/doc-guard/reply policy lives in tool-path.ts.
    // `text` is the mutable closure prompt runBuffered reads — set it per turn.
    const result = await produceToolPath(text, {
      runTurn: async (prompt: string) => {
        text = prompt;

        return runBuffered();
      },
      markSent: (messageCount) => pool.markSent(conv, messageCount),
      registerToolCalls: (calls) => pool.registerToolCalls(conv, calls),
      messages: body.messages,
      tools: body.tools,
      steeringFingerprint: () => lastSteeringFingerprint,
      repair: getToolRepair() ?? undefined,
    });

    // When the reply was only partly executed, remember the correction for the
    // turn that carries the real tool result.
    if (result.kind === "tools" && result.note) conv.pendingNote = result.note;

    return result;
  } else {
    // No tools — stream deltas live (onDelta) while buffering for the retry logic.
    const result = await runBuffered(onDelta);

    if ("error" in result) return { kind: "error", resp: result.error };
    pool.markSent(conv, body.messages.length);

    return { kind: "text", text: result.fullText };
  }
  } // end produce()

  // --- Render: JSON (non-stream) or an early-flushed SSE stream (stream) ---
  const includeUsage = !!body.stream_options?.include_usage;

  const usage = () => buildUsage({
    providerId: session.id,
    requestedModel: model,
    routedModel,
    fields: lastUsage,
  });

  return renderResponse({
    stream: !!body.stream,
    produce,
    hasTools: !!hasTools,
    usage,
    includeUsage,
    completionId,
    created,
    model,
    fingerprint: lastSteeringFingerprint,
  });
  } finally {
    release();
  }
}
