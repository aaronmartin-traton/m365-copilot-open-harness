/**
 * Tool-path result producer: turns the buffered M365 response into the final
 * tool-call / text result — parse fenced tool calls, apply the prose-document
 * guard, handle reply→text, enforce one-call-per-turn, and gate on the
 * steering-attribution fingerprint. Extracted from the produce() closure in
 * handler.ts; the upstream retry loop (runBuffered) is injected so the
 * orchestration stays in the handler.
 */

import {
  parseToolCalls,
  isProseDocument,
  looksLikeConfabulation,
  looksLikeHallucinatedCompletion,
  looksLikeRemoteArtifactCompletion,
  getMessageContent,
  textAfterFirstToolCall,
  truncateAtFabricatedToolResponse,
  trunc,
  createLogger,
  type Message,
  type ToolDef,
  type ParsedToolCall,
  type ParseResult,
} from "@m365-copilot/core";
import type { ToolRepair } from "./tool-repair.js";

const log = createLogger("tool-path");

/** The buffered upstream result, as produced by the handler's runBuffered. */
type BufferedTurn =
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
  /**
   * Steering-attribution gate (ticket 03): thunk returning the fingerprint of
   * the last buffered turn, read at decision time (after retries). When the
   * ladder is active (`M365_STEERING=1`), a parsed fence routes to tools ONLY
   * when the response is attributable as steered; unsteered responses degrade
   * to raw text. Omit => legacy routing, byte-for-byte.
   */
  steeringFingerprint?: () => string | undefined;
  /**
   * Small tool-caller repair pass (`M365_TOOL_REPAIR=1`, see tool-repair.ts).
   * Called at most once per turn, only when the parse found no tool call and a
   * failure detector fired. Omit => no repair, byte-for-byte.
   */
  repair?: ToolRepair;
}

/** Prose shapes where M365 should have acted but did not. */
function looksLikeFailedAction(text: string): boolean {
  return looksLikeConfabulation(text) ||
    looksLikeHallucinatedCompletion(text) ||
    looksLikeRemoteArtifactCompletion(text);
}

/**
 * Ask the repair model for one fenced call and re-parse it. Any non-tool or
 * document-shaped repair keeps the original parse (fail-closed to text).
 */
async function tryRepair(
  repair: ToolRepair,
  fullText: string,
  messages: Message[],
  tools: ToolDef[],
  original: ParseResult,
): Promise<ParseResult> {
  const last = messages[messages.length - 1];
  const request = last ? getMessageContent(last) : "";
  let repaired: string | null;

  try {
    repaired = await repair({ request, response: fullText, tools });
  } catch (err) {
    log.info(`Tool repair threw, keeping text: ${err instanceof Error ? err.message : String(err)}`);

    return original;
  }

  if (!repaired) return original;
  const parsed = parseToolCalls(repaired, tools);

  if (!parsed.hasToolCalls || isProseDocument(parsed)) {
    log.info("Tool repair output carried no usable tool call, keeping text");

    return original;
  }

  log.info(`Tool repair produced ${parsed.toolCalls.length} call(s): ${parsed.toolCalls[0].function.name}`);

  return parsed;
}

export type ToolPathResult =
  | { kind: "error"; resp: Response }
  | { kind: "text"; text: string }
  | { kind: "tools"; toolCalls: ParsedToolCall[]; note?: string | null };

/**
 * The correction the model needs on the turn that carries the real result.
 *
 * When the proxy executes less than the model wrote — the head before a
 * self-written `<tool_response>`, or the first of several batched calls — M365's
 * server-side history still holds the WHOLE reply. The model then believes its
 * invented results happened, often including an invented "done", and reads the
 * real result as stale ("It looks like this tool response came in out of
 * context"). Upstream measured 9 of 56 Sonnet 4.6 bench runs ending that way
 * without this note and 0 of 70 with it (upstream 4f6c95f, #31).
 *
 * Deterministic statement of what the proxy ran — not an inference about
 * intent. Null when the whole turn executed.
 */
const TRAILING_NOTE_CHARS = 120;

export function executedOnlyFirstNote(fabricated: boolean, droppedCalls: number, trailingChars = 0): string | null {
  if (fabricated) {
    return "(Note: only the first tool call in your previous reply was actually run. Everything you wrote after it, including the <tool_response> you wrote yourself, did not happen. Here is the real output of that first call:)";
  }
  const speculated = trailingChars >= TRAILING_NOTE_CHARS;

  if (droppedCalls > 0) {
    const rest = droppedCalls === 1 ? "the other one was not" : `the other ${droppedCalls} were not`;
    const tail = speculated ? " Anything you wrote after it was written before its result existed." : "";

    return `(Note: only the first of the ${droppedCalls + 1} tool calls in your previous reply was run; ${rest}.${tail} Here is the real output of the first one:)`;
  }

  if (speculated) {
    return "(Note: only the tool call in your previous reply was acted on; anything you wrote after it was written before its result existed. Here is the real output of that call:)";
  }

  return null;
}

/**
 * Produce the tool-path result for one request. Returns either an error
 * response, plain text, or the tool calls to execute.
 */
export async function produceToolPath(
  initialPrompt: string,
  deps: ToolPathDeps,
): Promise<ToolPathResult> {
  const { runTurn, markSent, registerToolCalls, messages, tools } = deps;
  let droppedCalls = 0;

  // Initial turn — the handler has already compiled the prompt.
  const initial = await runTurn(initialPrompt);

  if ("error" in initial) return { kind: "error", resp: initial.error };
  markSent(messages.length);

  let fullText = initial.fullText;

  log.debug("Raw response (tool mode):", trunc(fullText, 1000));

  // Stop sequence: a <tool_response> the model wrote itself is invented. When a
  // real call precedes it, keep only that head (upstream #31).
  const cut = truncateAtFabricatedToolResponse(fullText, tools);
  const cutFabricated = cut !== fullText;

  if (cutFabricated) {
    log.info(`Self-written <tool_response> found after a tool call; dropped ${fullText.length - cut.length} fabricated chars`);
    fullText = cut;
  }
  let parsed = parseToolCalls(fullText, tools);
  log.info(`Parse result: hasToolCalls=${parsed.hasToolCalls}, count=${parsed.toolCalls.length}`);

  // Document guard: the shell-routing parser turns every ```bash block into a
  // tool call, so a model that ANSWERS with a markdown document full of code
  // fences (e.g. "here's a simplified README") would get its own answer executed
  // as shell. Detect that shape (multiple fences + prose) and return the document
  // as plain text instead of running it — unless the reply OPENS with a tool call,
  // which makes it an action with a speculative tail (upstream #33).
  if (isProseDocument(parsed, fullText, tools)) {
    log.info(`Response is a prose document (${parsed.toolCalls.length} embedded fences), returning as text instead of executing`);
    parsed = { hasToolCalls: false, toolCalls: [], textContent: fullText };
  } else if (!parsed.hasToolCalls && deps.repair && tools?.length && looksLikeFailedAction(fullText)) {
    parsed = await tryRepair(deps.repair, fullText, messages, tools, parsed);
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
      droppedCalls = parsed.toolCalls.length - 1;
      parsed.toolCalls = [parsed.toolCalls[0]];
    }
  }

  // Steering-attribution gate (ticket 03): when the injection ladder is
  // active, route a parsed fence ONLY when the response is attributable as
  // steered. An unsteered response degrades to raw text (honest degrade)
  // instead of executing on a possibly-unsteered turn. Legacy routing is
  // preserved byte-for-byte when M365_STEERING is unset.
  if (process.env.M365_STEERING === "1" && parsed.hasToolCalls && parsed.toolCalls.length > 0) {
    const fp = deps.steeringFingerprint?.();

    if (!fp || fp === "unsteered") {
      log.info(`Steering ladder active but response is unsteered (${fp ?? "no fingerprint"}), returning raw text instead of ${parsed.toolCalls.length} tool call(s)`);

      return { kind: "text", text: fullText };
    }
  }

  if (parsed.hasToolCalls && parsed.toolCalls.length > 0) {
    registerToolCalls(parsed.toolCalls);

    return {
      kind: "tools",
      toolCalls: parsed.toolCalls,
      note: executedOnlyFirstNote(
        cutFabricated,
        droppedCalls,
        textAfterFirstToolCall(fullText, tools).length,
      ),
    };
  }

  return { kind: "text", text: fullText };
}
