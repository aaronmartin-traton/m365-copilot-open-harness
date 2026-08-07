/**
 * Tool-path result producer: turns the buffered M365 response into the final
 * tool-call / text result, applying the retry-on-confabulation, read-only
 * fallback, prose-document guard, reply-call handling, and one-call-per-turn
 * policies. Extracted from the produce() closure in handler.ts; the upstream
 * retry loop (runBuffered) is injected so the orchestration stays in the
 * handler while the parsing/decision policy lives here.
 */

import {
  parseToolCalls,
  looksLikeConfabulation,
  looksLikeHallucinatedCompletion,
  looksLikeRemoteArtifactCompletion,
  isProseDocument,
  trunc,
  createLogger,
  type Message,
  type ToolDef,
  type ParsedToolCall,
} from "@m365-copilot/core";
import { jsonResponse } from "./response-helpers.js";
import { readOnlyFallbackToolCall } from "./local-response-helpers.js";
import {
  CONFAB_FORCE_PROMPT,
  HALLUCINATION_FORCE_PROMPT,
  REMOTE_ARTIFACT_FORCE_PROMPT,
} from "./force-prompts.js";

const log = createLogger("tool-path");

/** The buffered upstream result, as produced by the handler's runBuffered. */
export type BufferedTurn =
  | { fullText: string }
  | { error: Response };

/**
 * Injected dependencies. The handler owns the retry loop and session bookkeeping;
 * this module only decides what to do with each buffered turn's text.
 */
export interface ToolPathDeps {
  /** Run one buffered upstream turn with the given prompt text. */
  runTurn: (prompt: string) => Promise<BufferedTurn>;
  /** Tell the pool how many messages were sent for this turn. */
  markSent: (messageCount: number) => void;
  /** Record the tool calls the client will execute. */
  registerToolCalls: (calls: Array<{ id: string }>) => void;
  messages: Message[];
  tools?: ToolDef[];
}

export type ToolPathResult =
  | { kind: "error"; resp: Response }
  | { kind: "text"; text: string }
  | { kind: "tools"; toolCalls: ParsedToolCall[] };

/**
 * Produce the tool-path result for one request. Returns either an error
 * response, plain text, or the tool calls to execute.
 */
export async function produceToolPath(
  initialPrompt: string,
  deps: ToolPathDeps,
): Promise<ToolPathResult> {
  const { runTurn, markSent, registerToolCalls, messages, tools } = deps;

  // Initial turn — the handler has already compiled the prompt.
  const initial = await runTurn(initialPrompt);
  if ("error" in initial) return { kind: "error", resp: initial.error };
  markSent(messages.length);

  let fullText = initial.fullText;

  log.debug("Raw response (tool mode):", trunc(fullText, 1000));
  let parsed = parseToolCalls(fullText, tools);
  log.info(`Parse result: hasToolCalls=${parsed.hasToolCalls}, count=${parsed.toolCalls.length}`);
  if (!parsed.hasToolCalls) {
    const fallback = readOnlyFallbackToolCall({ messages, tools }, fullText);
    if (fallback) {
      log.info(`Read-only fallback tool call: ${fallback.function.name}`);
      parsed = { hasToolCalls: true, toolCalls: [fallback], textContent: null };
    }
  }

  // Salvage stochastic turn-1 confabulation: M365's chat model sometimes claims it
  // "can't access the files / commands return no output" and asks the user to paste
  // them, WITHOUT calling a tool — even though the environment is real (the bench +
  // pi both reproduce this). Re-prompt forcefully in the SAME conversation (one
  // thread, cheap). Disable with M365_NO_CONFAB_RETRY; tune count with M365_CONFAB_RETRIES.
  const maxConfabRetries = process.env.M365_NO_CONFAB_RETRY
    ? 0
    : Number(process.env.M365_CONFAB_RETRIES ?? 1);
  // The model never actually acted if no assistant turn in the history carried a
  // tool call. Used to gate the hallucinated-completion retry (a model that did
  // real work called at least one tool), keeping false positives near zero.
  const everActed = (messages ?? []).some(
    (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
  );
  for (let attempt = 0; attempt < maxConfabRetries && !parsed.hasToolCalls; attempt++) {
    const confab = looksLikeConfabulation(parsed.textContent);
    const remoteArtifact = looksLikeRemoteArtifactCompletion(parsed.textContent);
    const halluc = !everActed && looksLikeHallucinatedCompletion(parsed.textContent);
    if (!confab && !remoteArtifact && !halluc) break;
    const retryKind = remoteArtifact ? "Remote artifact completion" : confab ? "Confabulation" : "Hallucinated completion";
    log.info(`${retryKind} detected (no tool call) — forcing retry ${attempt + 1}/${maxConfabRetries}`);
    const prompt = remoteArtifact ? REMOTE_ARTIFACT_FORCE_PROMPT : confab ? CONFAB_FORCE_PROMPT : HALLUCINATION_FORCE_PROMPT;
    const retry = await runTurn(prompt);
    if ("error" in retry) return { kind: "error", resp: retry.error };
    markSent(messages.length);
    fullText = retry.fullText;
    parsed = parseToolCalls(fullText, tools);
    log.info(`After forcing retry: hasToolCalls=${parsed.hasToolCalls}, count=${parsed.toolCalls.length}`);
  }

  // Never pass a remote M365 artifact off as a successful local edit. A retry
  // may merely transform a Teams URL into `sandbox:/mnt/data/...`; after the
  // configured attempts are exhausted, fail explicitly so the harness/user can
  // switch models instead of applying a nonexistent local file.
  if (!parsed.hasToolCalls && (looksLikeRemoteArtifactCompletion(parsed.textContent) || (!everActed && looksLikeHallucinatedCompletion(parsed.textContent)))) {
    log.info("Final response still claims a file mutation without a local tool call — failing closed");
    return {
      kind: "error",
      resp: jsonResponse(502, {
        error: {
          message: "M365 claimed a file update or returned a remote Teams or /mnt/data artifact instead of calling the local editing tools. No local file was changed. Retry with claude-sonnet-think-deeper, which is the recommended route for local file edits.",
          type: "file_mutation_without_local_tool",
        },
      }),
    };
  }

  // Document guard: the shell-routing parser turns every ```bash block into a
  // tool call, so a model that ANSWERS with a markdown document full of code
  // fences (e.g. "here's a simplified README") would get its own answer executed
  // as shell. Detect that shape (multiple fences + prose) and return the document
  // as plain text instead of running it. See isProseDocument (chosen empirically).
  if (isProseDocument(parsed)) {
    log.info(`Response is a prose document (${parsed.toolCalls.length} embedded fences), returning as text instead of executing`);
    parsed = { hasToolCalls: false, toolCalls: [], textContent: fullText };
  }

  // Fail-closed: if model mixed text with tool calls, strip text and re-prompt once.
  // This enforces the "output ONLY a tool call" contract.
  if (parsed.hasToolCalls && parsed.textContent) {
    const extraText = parsed.textContent.trim();
    if (extraText.length > 0) {
      log.info(`Mixed output detected (${extraText.length} chars of text alongside ${parsed.toolCalls.length} tool calls), stripping text`);
      // Strip the text — the tool calls are what the client needs.
      // Log the stripped text for debugging but don't send it downstream.
      log.debug("Stripped text:", trunc(extraText, 500));
      parsed = { ...parsed, textContent: null };
    }
  }

  // Handle "reply" tool calls — convert to plain text
  if (parsed.hasToolCalls) {
    const replyCall = parsed.toolCalls.find(tc => tc.function.name === "reply");
    const realToolCalls = parsed.toolCalls.filter(tc => tc.function.name !== "reply");

    if (replyCall && realToolCalls.length === 0) {
      let replyText: string;
      try {
        const args = JSON.parse(replyCall.function.arguments);
        replyText = args.text || args.message || args.content || fullText;
      } catch {
        replyText = fullText;
      }
      log.info("Reply tool detected, converting to text response");
      return { kind: "text", text: replyText };
    }

    if (realToolCalls.length > 0) {
      parsed.toolCalls = realToolCalls;
    }

    // Enforce one tool call per turn unless explicitly opted out. M365 — the
    // reasoning tones especially — batches its whole plan into a single
    // response. Executing a batch runs later steps on guessed state and lets a
    // premature success claim ride along at the end. Keeping only the first
    // call forces a real step-by-step loop where each call reacts to the
    // previous tool_response. Set M365_ALLOW_MULTI_TOOL to restore batching.
    if (!process.env.M365_ALLOW_MULTI_TOOL && parsed.toolCalls.length > 1) {
      log.info(`One-call-per-turn: keeping ${parsed.toolCalls[0].function.name}, dropping ${parsed.toolCalls.length - 1} batched call(s)`);
      parsed.toolCalls = [parsed.toolCalls[0]];
    }
  }

  if (parsed.hasToolCalls && parsed.toolCalls.length > 0) {
    registerToolCalls(parsed.toolCalls);
    return { kind: "tools", toolCalls: parsed.toolCalls };
  }
  return { kind: "text", text: fullText };
}
