import {
  createLogger,
  trunc,
  getToneForModel,
  getMessageContent,
  getMessageImages,
  noteRequestOutcome,
  awaitDegradationBackoff,
  getImageArtifactToken,
  fetchImageBytes,
  type CapturedImage,
} from "@m365-copilot/core";
import { ChatCompletionRequest } from "./schemas.js";
import { RequestScheduler, SchedulerBusyError, type ScheduleOptions, type SchedulerStats } from "./scheduler.js";
import { SessionStateStore } from "./session-store.js";
import { SessionPool, type ConversationState, type ConversationPruneSelector, type RemoteConversationPruner, type SessionPoolOptions } from "./session-pool.js";
import { contextCompiler, LOCAL_TOOL_REMINDER } from "./context-compiler.js";
import { buildUsage } from "./usage-builder.js";
import { jsonResponse, rateLimitResponse, schedulerBusyResponse, emptyResponseResponse } from "./response-helpers.js";
import { localMetaResponse, renderLocalCompletion } from "./local-response-helpers.js";
import { OUTPUT_CHAR_CEILING } from "./output-ceiling.js";
import { renderImagesMarkdown } from "./image-renderer.js";
import { produceToolPath } from "./tool-path.js";
import { getIntentVerifier } from "./intent-verifier.js";
import { renderResponse, type Produced } from "./response-renderer.js";
import type { z } from "zod/v4";

const log = createLogger("handler");

// The OpenAI-compatible request body shape accepted by the proxy.
type ChatBody = z.infer<typeof ChatCompletionRequest>;

// --- Main handler ---

/**
 * Handle a chat completion request, returning an OpenAI-compatible Response.
 * The SessionPool routes each conversation to its own ModelSession.
 */
export async function handleChatCompletion(
  body: ChatBody,
  pool: SessionPool,
  opts: { signal?: AbortSignal; sessionKey?: string; managedKey?: string } = {},
): Promise<Response> {
  const localMeta = localMetaResponse(body);
  if (localMeta !== null) return renderLocalCompletion(body, localMeta);
  const metadataSessionId = body.metadata && typeof body.metadata.session_id === "string"
    ? body.metadata.session_id
    : undefined;
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

  // Claude (Claude_Sonnet tone) tool-calls reliably AGENT-LESS (probe: 4/4 ```bash,
  // 0 disengage) and self-IDs as Claude Sonnet 4.5; the declarative agent would
  // override the tone back to GPT-5 (H8.6) AND add jailbreak-shape signal. GPT-the-
  // chat-model, by contrast, won't tool-call agent-less (0/4) so it still needs the
  // agent. So: attach the tool agent EXCEPT on Claude models — there, stay agent-less
  // to get real Claude doing tools via shell-routing (docs §10 F23). Force the old
  // behavior with M365_FORCE_AGENT=1.
  // Stay agent-less ONLY when the tone is actually a Claude tone — empirically that's
  // the path that tool-calls right now (route-probe 2026-07-07: Claude_Sonnet agent-less
  // 2/2; the magic path 0/2). Derive it from the RESOLVED tone, not the raw model
  // string: getToneForModel now routes any unmapped `claude-*` (e.g. the
  // `claude-opus-4-8[1m]` a Claude Code client sends) to Claude_Sonnet, so this check
  // then keeps that request on the working agent-less path. The old
  // `/claude/i.test(model)` + `magic` fallback split a claude-* string into GPT-tone +
  // agent-suppressed — the confab quadrant we observed. One resolved tone drives both.
  const tone = getToneForModel(routedModel);
  const isClaudeTone = /^Claude_/i.test(tone);
  const useToolAgent = !!hasTools && requestImages.length === 0 &&
    (process.env.M365_FORCE_AGENT === "1" || !isClaudeTone);

  // Format message: full prompt on first turn, delta on follow-ups.
  // M365 is stateful — it remembers everything from prior turns,
  // so we only need to send new messages after the first turn.
  const isFirstTurn = session.turnCount === 0;
  const convId = session.conversationId;
  let text: string;
  if (isFirstTurn || conv.sentMessageCount === 0) {
    text = contextCompiler.compileFull({
      messages: body.messages,
      tools: body.tools,
      toolChoice: body.tool_choice,
      conversationId: convId,
    });
    log.info(`Chat completion: model=${model}, routed=${routedModel}, tone=${tone}, stream=${body.stream}, messages=${body.messages.length}, turn=${session.turnCount}, mode=full, cid=${convId}`);
  } else {
    const firstUser = body.messages.find((message) => message.role === "user");
    const taskAnchor = firstUser ? getMessageContent(firstUser) : "";
    const newMessages = body.messages.slice(conv.sentMessageCount);
    const delta = newMessages.length > 0
      ? contextCompiler.compileDelta({ messages: newMessages, taskAnchor, hasTools: !!hasTools })
      : "";
    if (delta.length > 0) {
      text = delta;
      log.info(`Chat completion: model=${model}, routed=${routedModel}, tone=${tone}, stream=${body.stream}, messages=${body.messages.length}, new=${newMessages.length}, turn=${session.turnCount}, mode=delta, cid=${convId}`);
    } else {
      // No meaningful new content to send — nudge M365 to continue.
      text = hasTools ? `${LOCAL_TOOL_REMINDER}\n\nPlease continue.` : "Please continue.";
      log.info(`Chat completion: model=${model}, routed=${routedModel}, tone=${tone}, stream=${body.stream}, messages=${body.messages.length}, turn=${session.turnCount}, mode=retry, cid=${convId}`);
    }
  }

  log.debug("Formatted prompt:", trunc(text, 1000));

  let imagesSent = false;
  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  // Buffer the full response, with a couple of quick retries on an empty reply.
  const MAX_RETRIES = 2;
  const SHORT_RETRY_DELAY_MS = 2_000;

  // Captured from the final attempt — surfaced through the OpenAI `usage` block
  // so clients can see M365's conversation-quota % (the closest proxy we have
  // to "context window remaining"). Token counts aren't exposed by M365.
  let lastThrottle: { current: number; max: number } | null = null;
  let lastContentOrigin: string | null | undefined;
  let lastMessageType: string | null | undefined;
  let lastScores: Record<string, number> | null | undefined;
  let lastTurnCount: number | null | undefined;

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
    let agentRefreshed = false;
    let disengageRetried = false;
    const originalText = text;
    // Self-imposed pacing while the account is degraded (thread-rate throttle). A
    // no-op when healthy; during backoff it sleeps a jittered delay so we stop
    // starting fresh turns into the throttle and let it self-heal (H-R1). This
    // replaced the old auto-reauth, which didn't clear the throttle and raised our
    // detection profile. A single long pi thread never trips the trigger.
    await awaitDegradationBackoff();
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let copilotStream;
      try {
        const images = imagesSent ? [] : requestImages;
        copilotStream = await session.run(text, routedModel, opts.signal, useToolAgent, images);
        if (images.length > 0) imagesSent = true;
      } catch (err: any) {
        return { error: jsonResponse(502, { error: { message: err.message, type: "upstream_error" } }) };
      }

      let fullText = "";
      try {
        for await (const delta of copilotStream) {
          fullText += delta;
          onDelta?.(delta);
        }
        if (copilotStream.fullText && copilotStream.fullText.length > fullText.length) {
          fullText = copilotStream.fullText;
        }
      } catch (err: unknown) {
        return { error: jsonResponse(502, { error: { message: err instanceof Error ? err.message : String(err), type: "upstream_error" } }) };
      }

      const capturedImages = copilotStream.images ?? [];
      if (capturedImages.length > 0) {
        const imageMarkdown = await renderImagesMarkdown(capturedImages);
        if (imageMarkdown) {
          const addition = fullText ? `\n\n${imageMarkdown}` : imageMarkdown;
          fullText += addition;
          onDelta?.(addition);
        }
      }

      lastThrottle = copilotStream.throttle;
      lastContentOrigin = copilotStream.contentOrigin;
      lastMessageType = copilotStream.messageType;
      lastScores = copilotStream.scores;
      lastTurnCount = copilotStream.turnCount;

      if (copilotStream.hasContent || fullText.length > 0) {
        noteRequestOutcome(false, convId); // clean response → degradation has lifted
        return { fullText };
      }

      // Disengaged is a deliberate safety refusal, NOT a transient empty. Retrying
      // it with "Please continue." just disengages again and burns the 600-msg
      // quota (observed: 5 wasted messages in one turn). Fail fast with a clear
      // signal instead. Commonly fires when a heavy tool prompt is paired with a
      // non-default model/agent (e.g. a Claude tone + the declarative agent).
      if (copilotStream.messageType === "Disengaged") {
        // F22: the default framing's override-shape language occasionally trips Azure
        // Prompt Shields (jailbreak classifier) on benign requests (e.g. "replace X
        // with Y, leave everything else unchanged"). Retry ONCE with the low-override
        // `softened` framing in a FRESH conversation (a Disengaged conversation stays
        // Disengaged). Drops the worst-case disengage ~100%→~4%. Off via
        // M365_NO_DISENGAGE_RETRY.
        if (hasTools && !disengageRetried && !process.env.M365_NO_DISENGAGE_RETRY) {
          disengageRetried = true;
          session.newConversation();
          text = contextCompiler.compileFull({
            messages: body.messages,
            tools: body.tools,
            toolChoice: body.tool_choice,
            conversationId: session.conversationId,
            framingVariant: "softened",
          });
          log.info("Upstream Disengaged — retrying once with 'softened' framing in a fresh conversation (F22)");
          attempt--; // free retry; bounded — disengageRetried flips once
          continue;
        }
        log.info("Upstream Disengaged — failing fast (no retry) to preserve quota");
        return {
          error: jsonResponse(502, {
            error: {
              message: "M365 Copilot disengaged from this request (its safety filter declined to answer). Common causes: too many tools, jailbreak-shaped instructions, or pairing a non-default model with the tool agent. Reduce the toolset or use the default model.",
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
      const t = copilotStream.throttle;
      if (t && t.current >= t.max) {
        return { error: rateLimitResponse(t) };
      }
      if (attempt < MAX_RETRIES) {
        // A dead/deleted agent returns an instant empty reply (throttle: null).
        // Re-resolve the agent once before retrying so a long-lived host
        // self-heals from the deleted-agent trap instead of looping on empties.
        if (!agentRefreshed) {
          agentRefreshed = true;
          const agentChanged = await session.refreshAgent();
          if (agentChanged) {
            // The cached agent was stale/deleted and has been re-resolved.
            // Resend the original prompt to the fresh agent — a bare "continue"
            // would have no context since the dead agent processed nothing.
            log.info("Agent re-resolved after empty reply, resending original prompt");
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
    return produceToolPath(text, {
      runTurn: async (prompt: string) => {
        text = prompt;
        return runBuffered();
      },
      markSent: (messageCount) => pool.markSent(conv, messageCount),
      registerToolCalls: (calls) => pool.registerToolCalls(conv, calls),
      messages: body.messages,
      tools: body.tools,
      intentVerifier: getIntentVerifier() ?? undefined,
    });
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
    throttle: lastThrottle,
    contentOrigin: lastContentOrigin,
    messageType: lastMessageType,
    scores: lastScores,
    turnCount: lastTurnCount,
    requestedModel: model,
    routedModel: routedModel,
    tone: tone,
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
  });
  } finally {
    release();
  }
}
