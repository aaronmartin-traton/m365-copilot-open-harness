import { z } from "zod/v4";
import { createLogger } from "./log.js";
import {
  buildSpecMap,
  currentFramingVariant,
  deriveFencedSpec,
  findFirstToolFence,
  formatFencedToolDefinitions,
  parseFencedToolCalls,
  renderFencedCall,
  type FencedParseResult,
} from "./fenced.js";
import type { ImageInput } from "./images.js";

const log = createLogger("tools");

// Tool calls use the **fenced** Markdown format exclusively (see fenced.ts and
// docs/hypotheses.md §9). The old `{"tool":...,"arguments":{}}` JSON format was
// removed — it produced 0/5 on real agentic tasks; fenced + shell-routing produces
// genuine multi-turn loops. We still *parse* a stray JSON tool call as a tolerance
// fallback (M365 occasionally emits one), but we never instruct the model to use it.

// --- Types (standalone, no zod dependency) ---

/** Any JSON value: what `JSON.parse` yields for a client-supplied payload. */
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/** A JSON object — the shape of a tool call's parsed `arguments`. */
type JsonObject = { [key: string]: JsonValue };

/** One JSON-Schema property of a tool parameter: `type` is what the fenced
 *  renderer reads; every other keyword (`description`, `enum`, `items`, …) stays
 *  the JSON value the client sent. */
export interface ToolParameterProperty {
  type?: string;
  [keyword: string]: JsonValue | undefined;
}

/** A tool's JSON-Schema `parameters` block as OpenAI clients send it. */
export interface ToolParameters {
  type?: string;
  properties?: Record<string, ToolParameterProperty>;
  required?: string[];
}

export interface ToolFunction {
  name: string;
  description?: string;
  parameters?: ToolParameters;
}

export interface ToolDef {
  type?: string;
  function: ToolFunction;
}

export interface ImageContentPart {
  type: "image_url";
  image_url: { url: string; detail?: "auto" | "low" | "high" };
  image: ImageInput;
}

export interface TextContentPart {
  type: string;
  text?: string;
}

export interface Message {
  role: string;
  content?: string | Array<TextContentPart | ImageContentPart> | null;
  tool_calls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } }
  | undefined;

// --- JSON payload decoding ---

/** Decodes any JSON value — the boundary parse for the untyped payloads this
 *  module receives (tool-call `arguments`, M365's `{"final": …}` wrapper). */
const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

const JsonObjectSchema = z.record(z.string(), JsonValueSchema);

const TextValueSchema = z.string();

/** The object form of `tool_choice` — the model must call the one named function. */
const NamedToolChoiceSchema = z.object({ function: z.object({ name: z.string() }) });

// --- Tool call format ---

// Fenced Markdown is the format we instruct and primarily parse (see fenced.ts).
// The regex below is a tolerance-only FALLBACK: M365 occasionally ignores the
// fenced contract and emits a stray `{"tool":...,"arguments":{...}}` object, bare
// or wrapped in a ```json / ```tool_call fence (the fence markers are cleaned up
// when the matched JSON is stripped from the leftover). We parse it if it shows
// up but never teach the model to produce it — the JSON format scored 0/5 and
// was removed (§9).
const TOOL_CALL_REGEX = /\{\s*"(?:tool|name)"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/g;

/** The object `TOOL_CALL_REGEX` matches: a `tool`/`name` label plus the arguments
 *  payload M365 emitted instead of a fenced call. */
const StrayToolCallSchema = z.object({
  tool: z.string().optional(),
  name: z.string().optional(),
  arguments: JsonValueSchema,
});

// M365 invents bookkeeping objects ({"confidence": 0.5}) and wraps its answer in
// {"final": "..."} — neither is a real tool call. Strip confidence everywhere;
// drop final when it rides alongside tool calls (it's usually a premature
// success claim), and unwrap it when it stands alone as the response.
const CONFIDENCE_REGEX = /\{\s*"confidence"\s*:\s*-?[0-9.]+\s*\}/g;

const FINAL_OBJECT_REGEX = /\{\s*"final"\s*:\s*"(?:[^"\\]|\\.)*"\s*\}/g;

/** The `{"final": "<text>"}` wrapper M365 invents around an answer. */
const FinalObjectSchema = z.object({ final: z.string() });

/** Strip invented confidence/final objects from a no-tool-call response and
 *  unwrap a lone {"final": "..."} answer into bare text. Returns null if empty. */
function cleanLooseText(text: string): string | null {
  let out = text;

  for (const m of out.match(FINAL_OBJECT_REGEX) ?? []) {
    try {
      const value = FinalObjectSchema.safeParse(JSON.parse(m));

      if (value.success) out = out.replace(m, value.data.final);
    } catch {
      // leave the literal text in place if it isn't valid JSON
    }
  }

  out = out.replace(CONFIDENCE_REGEX, "").trim();

  return out.length ? out : null;
}

// --- Formatting ---

export function formatToolDefinitions(tools: ToolDef[], variantOverride?: string): string {
  return formatFencedToolDefinitions(tools, variantOverride);
}

export function formatToolChoiceInstruction(toolChoice: ToolChoice): string {
  if (!toolChoice || toolChoice === "auto") return "";

  if (toolChoice === "none") return "\nDo NOT call tools. Text only.";

  if (toolChoice === "required") return "\nYou MUST call at least one tool.";

  const called = NamedToolChoiceSchema.safeParse(toolChoice);

  return called.success ? `\nYou MUST call "${called.data.function.name}".` : "";
}

export function getMessageImages(msg: Message): ImageInput[] {
  if (!Array.isArray(msg.content)) return [];

  return msg.content.flatMap((part) => "image" in part ? [part.image] : []);
}

export function getMessageContent(msg: Message): string {
  if (msg.content === null || msg.content === undefined) return "";

  if (!Array.isArray(msg.content)) return msg.content;

  return msg.content.map((part) => "text" in part ? part.text || "" : "").join("");
}

/** Tool-call `arguments` as they reach us: the JSON string the OpenAI contract
 *  declares, or the already-parsed object a lenient client sends. */
type ToolArguments = string | JsonObject;

/** Decode one tool call's `arguments` field into a JSON argument object; `{}`
 *  when the payload is absent or unreadable (the call still renders). */
function decodeToolArguments(raw: ToolArguments): JsonObject {
  const direct = JsonObjectSchema.safeParse(raw);

  if (direct.success) return direct.data;

  const text = TextValueSchema.safeParse(raw);

  if (!text.success) return {};

  try {
    const parsed = JsonObjectSchema.safeParse(JSON.parse(text.data || "{}"));

    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** A short one-line description of what a tool call did, for labelling its result
 *  (e.g. the shell command, or the file path). Newlines collapsed, truncated. */
function toolCallSummary(rawArgs: ToolArguments): string {
  const args = decodeToolArguments(rawArgs);

  const primary =
    args.command ?? args.cmd ?? args.script ?? args.path ?? args.file ??
    args.filename ?? args.query ?? Object.values(args).find((v) => TextValueSchema.safeParse(v).success);

  const text = TextValueSchema.safeParse(primary);

  if (!text.success) return "";

  return text.data.replace(/\s+/g, " ").replace(/"/g, "'").trim().slice(0, 100);
}

/**
 * Inject a synthetic `reply(text)` tool that the model calls instead of
 * answering in prose. Wired by the handler (which converts `reply` back to a
 * plain assistant message), so it's invisible to the client. Off by default —
 * set `M365_INJECT_REPLY_TOOL=1` to enable.
 *
 * Why this matters: M365 mostly disobeys "only emit JSON" when the right
 * answer is text. Routing text through a `reply()` call makes EVERY turn a
 * tool call, which is a much cleaner contract for the model to follow.
 *
 * Tradeoff: adds 1 tool to the prompt, which nudges the Disengaged-filter
 * threshold a tiny bit. Safe with lean toolsets (<= ~10 tools).
 */
function maybeInjectReplyTool(tools: ToolDef[]): ToolDef[] {
  const enabled = process.env.M365_INJECT_REPLY_TOOL || currentFramingVariant() === "reply_tool";

  if (!enabled) return tools;

  if (tools.some((t) => t.function.name === "reply")) return tools;

  const replyTool: ToolDef = {
    type: "function",
    function: {
      name: "reply",
      description:
        "Send a plain-text answer to the user. Use this whenever you would otherwise reply in prose.",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "The text to send" } },
        required: ["text"],
      },
    },
  };

  return [replyTool, ...tools];
}

const TOOL_RESULT_MAX_CHARS = Number(process.env.M365_TOOL_RESULT_MAX_CHARS ?? 12_000);

export function boundedToolResult(text: string): string {
  if (!Number.isFinite(TOOL_RESULT_MAX_CHARS) || TOOL_RESULT_MAX_CHARS <= 0 || text.length <= TOOL_RESULT_MAX_CHARS) {
    return text;
  }

  const marker = `\n...[tool output truncated: ${text.length - TOOL_RESULT_MAX_CHARS} chars omitted]...\n`;
  const available = Math.max(0, TOOL_RESULT_MAX_CHARS - marker.length);
  const head = Math.ceil(available * 0.7);

  return text.slice(0, head) + marker + text.slice(text.length - (available - head));
}

export function formatMessages(
  messages: Message[],
  tools?: ToolDef[],
  toolChoice?: ToolChoice,
  conversationId?: string,
  framingVariant?: string,
): string {
  const parts: string[] = [];

  if (conversationId) {
    parts.push(`<conversation_id>${conversationId}</conversation_id>`);
  }

  const effectiveTools = tools ? maybeInjectReplyTool(tools) : tools;
  const specMap = effectiveTools ? buildSpecMap(effectiveTools) : null;

  if (effectiveTools && effectiveTools.length > 0 && toolChoice !== "none") {
    parts.push(`<system>\n${formatToolDefinitions(effectiveTools, framingVariant)}${formatToolChoiceInstruction(toolChoice)}\n</system>`);
  }

  // Correlate each tool result back to the call that produced it, so the model
  // sees WHICH command's output it's reading (e.g. `bash: ls -la`). Without this
  // the result is labelled "unknown" and the model misreads it — observed: it ran
  // `ls`, saw `README.md`, and concluded the *file* was empty (docs §9 F15-adjacent).
  const callMeta = new Map<string, { name: string; summary: string }>();

  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (tc.id) callMeta.set(tc.id, { name: tc.function.name, summary: toolCallSummary(tc.function.arguments) });
      }
    }
  }

  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      const calls = m.tool_calls.map((tc) => {
        const argsObj = decodeToolArguments(tc.function.arguments);

        // Prefer the request's tool schema; otherwise synthesize one from the
        // recorded argument keys so a tool no longer in scope still renders.
        const spec = specMap?.get(tc.function.name) ?? deriveFencedSpec({
          type: "function",
          function: {
            name: tc.function.name,
            parameters: {
              properties: Object.fromEntries(
                Object.keys(argsObj).map((k) => [k, { type: "string" }]),
              ),
            },
          },
        });

        return renderFencedCall(spec, argsObj);
      }).join("\n");

      const content = getMessageContent(m);
      parts.push(`<assistant>${content ? "\n" + content : ""}\n${calls}\n</assistant>`);
    } else if (m.role === "tool") {
      const meta = m.tool_call_id ? callMeta.get(m.tool_call_id) : undefined;
      const name = m.name || meta?.name || "tool";
      // Show the command/args that produced this output so the model reads it in
      // context (a directory listing vs file contents vs a command's stdout).
      const cmdAttr = meta?.summary ? ` command="${meta.summary}"` : "";
      parts.push(`<tool_response tool="${name}"${cmdAttr}>\n${boundedToolResult(getMessageContent(m))}\n</tool_response>`);
    } else {
      parts.push(`<${m.role}>\n${getMessageContent(m)}\n</${m.role}>`);
    }
  }

  return parts.join("\n\n");
}

// --- Parsing ---

export interface ParsedToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ParseResult {
  hasToolCalls: boolean;
  toolCalls: ParsedToolCall[];
  textContent: string | null;
}

// Patterns of M365's stochastic turn-1 "give-up" confabulation: it claims it can't
// see/run anything and asks the user to paste files, WITHOUT ever calling a tool —
// even though the environment is real. Used to trigger a forcing retry (handler).
const CONFABULATION_PATTERNS: RegExp[] = [
  /return(?:ing|s|ed)?\s+no\s+(?:output|results?|content)/i,
  /no\s+(?:output|results?|content|data)\s+(?:was\s+|were\s+)?(?:return|provid|present)/i, // "no content was returned"
  // The `to` is optional — matches both "unable TO access" and "can't access" (the
  // old `to?` made the *t* mandatory, so "can't inspect"/"can't access" slipped
  // through). `execute`/`retrieve`/`fetch` added: the give-up reflex phrases them
  // ("unable to execute or retrieve any output") and they were absent from the list.
  /(?:unable|not able|can.?t|cannot)\s+(?:to\s+)?(?:access|inspect|list|read|run|execute|retrieve|fetch|locate|see|open)/i,
  /don.?t\s+have\s+access/i,
  /no\s+(?:longer\s+have|access\s+to)/i,   // "no access to" + "no longer have access/the tools"
  /lost\s+(?:access|my\s+access|the\s+ability)/i,
  // Mid-conversation give-up (F12.11, magic model): after a real tool call it claims
  // it "no longer has the tools" and asks to move to another session, e.g. "restart the
  // task in a coding-enabled session". A genuine completion never asks to start over.
  /(?:restart|start\s+over|begin\s+again|re-?run)\s+(?:the\s+|this\s+)?(?:task|session|conversation|work)\s+in\s+(?:a\s+)?/i,
  /(?:in|use|switch\s+to|need)\s+(?:a\s+)?(?:different|another|proper|coding-?enabled|tool-?enabled|shell-?enabled)\s+(?:session|environment|conversation|mode)/i,
  // "the live file-editing tools ... are not available to me here" (magic model, F12.11):
  // it claims its own tools are gone, then delegates the edit back to the user.
  /(?:tool|editor|shell|command|file-?editing)s?[^.\n]{0,40}\b(?:not\s+available|unavailable|aren.?t\s+available|isn.?t\s+available|are\s+not\s+accessible)/i,
  /(?:can.?t|cannot|not\s+able\s+to|unable\s+to)\s+(?:directly\s+)?(?:edit|modify|write\s+to|change|save|create|open)\s+(?:the\s+|any\s+|to\s+)?files?/i,
  /paste\s+(?:the\s+)?(?:contents?|files?|code|them)/i,
  /provide\s+(?:the\s+)?(?:contents?|files?)/i,
  /(?:current\s+working\s+directory|working\s+directory|cwd)[\s\S]{0,120}\/mnt\/data/i,
  /(?:\bpwd\b|\bcd\b)[\s\S]{0,60}\/mnt\/data/i,
  /(?:ran|used|executed|called)[\s\S]{0,80}container\.(?:exec|open_image|download)/i,
  /container\.(?:exec|open_image|download)[\s\S]{0,120}(?:returned|output|shows?|result)/i,
  /(?:environment|shell|tool)\s+(?:isn.?t|is not|aren.?t|are not|appears? to be)\s+(?:return|provid|respond|work|access)/i,
  /(?:file|directory|folder|it)\s+(?:appears?|seems?|looks?)\s+(?:to\s+be\s+)?empty/i, // "the file appears to be empty"
  /nothing\s+to\s+(?:simplify|fix|do|change|show|read)/i,                               // "nothing to simplify"
  /(?:tool|command|it)\s+returned\s+(?:no|empty|nothing)/i,
  // GPT-5.6 can truthfully describe M365's remote runtime as if it were the
  // caller's environment. This wording slipped past the older can't-access
  // patterns because it says the session "does not expose" the filesystem.
  /(?:session|environment|runtime)\s+(?:does\s+not|doesn.?t|cannot)\s+(?:expose|mount|provide)\s+(?:the\s+)?(?:local\s+)?(?:repository\s+)?filesystem/i,
  /(?:my|the)\s+filesystem\s+(?:only\s+)?(?:contained|contains|has)[\s\S]{0,80}\/mnt\/data/i,
];

// M365 sometimes creates a real patch in its Teams-hosted remote artifact
// store instead of calling the harness's local edit/write/bash tools. The link
// is valid in M365 but the referenced file is not present in the caller's
// working directory, so a later `git apply <basename>` inevitably fails.
// Every pattern must be ANCHORED to something only M365's remote runtime emits:
// a Teams artifact URL, a `sandbox:/mnt/data` path, or a citation marker. Talking
// about a "patch" or "diff" is normal for a coding agent, so an unanchored verb +
// noun pattern (e.g. /generated .{0,100} patch/) fires on "I generated a patch for
// review" and — because this detector fails closed below — turns an ordinary answer
// into a 502. Anchors are what separate a remote artifact from a local one.
const REMOTE_ARTIFACT_COMPLETION_PATTERNS: RegExp[] = [
  /sandbox:\/mnt\/data\/[^\s)\]]+/i,
  /https?:\/\/[^\s)\]]*asyncgw\.teams\.microsoft\.com\/[^\s)\]]+\.(?:patch|diff)(?:[?#][^\s)\]]*)?/i,
  // The remote artifact may be the whole updated source file rather than a
  // patch. Require a mutation claim near the Teams "views/original" URL so a
  // normal shared link is not mistaken for a failed local edit.
  /\b(?:updated|modified|replaced|rewrote|saved|applied|prepared|created)\b[\s\S]{0,600}https?:\/\/[^\s)\]]*asyncgw\.teams\.microsoft\.com\/[^\s)\]]*\/views\/original\//i,
  /https?:\/\/[^\s)\]]*asyncgw\.teams\.microsoft\.com\/[^\s)\]]*\/views\/original\/[\s\S]{0,600}\b(?:updated|modified|replaced|rewrote|saved|applied|prepared|created)\b/i,
  // Live GPT-5.6 variant: "Updated [plan.md](<turn1file1 citation>) locally".
  // The private-use citation resolves to an M365 artifact, not the harness disk.
  /\b(?:updated|modified|replaced|rewrote|saved|applied)\b[\s\S]{0,180}\uE200cite\uE202turn\d+file\d+\uE201/i,
  /\uE200cite\uE202turn\d+file\d+\uE201[\s\S]{0,180}\b(?:updated|modified|replaced|rewrote|saved|applied)\b/i,
];

/**
 * Heuristic: does this no-tool-call response look like M365 confabulating an
 * inability to act (rather than a genuine final answer)? The handler uses this to
 * decide whether to force one more turn. Conservative — needs an explicit
 * can't-access / paste-the-files phrasing, which a real completion won't contain.
 */
// Past-tense claims of having performed a file mutation. Paired with a "no tool
// call ran at all this conversation" check, this catches hallucinated completion:
// the model says "I've replaced the README" without ever calling write/bash.
const HALLUCINATED_COMPLETION_PATTERNS: RegExp[] = [
  /\bI(?:'ve|\s+have|\s+just|\s+now)?\s+(?:created|wrote|written|replaced|updated|saved|applied|added|overwrote|modified|generated|implemented|rewrote)\b/i,
  /\b(?:the\s+)?(?:file|readme|script|config|change|version|content)\s+(?:has|have|is|was|were)\s+(?:been\s+)?(?:created|replaced|updated|saved|written|applied|added|modified|overwritten)\b/i,
  /\bhere'?s\s+(?:the\s+)?(?:updated|new|simplified|replaced|final)\s+(?:file|readme|version|content)\b/i,
  // Fakeable create-from-scratch hallucination (docs/hypotheses.md §8.12 / §9
  // remaining gap): the model narrates having MADE and RUN a file with no tool
  // call — e.g. "Created fizzbuzz.py and executed it with python3." The patterns
  // above all need a leading "I" or a file/readme/script noun, so a bare
  // "Created <name>.py" + "executed it" slips through. Catch both shapes:
  //  (a) a bare past-tense create/write verb followed by a filename token
  //      (≥2 chars before the dot, so abbreviations like "e.g."/"i.e." don't match);
  //  (b) an execution claim ("executed it with python3", "ran the script").
  /\b(?:created|wrote|written|generated|saved|added|produced|implemented|overwrote)\b[^.\n]{0,60}\b[\w-]{2,}\.[a-z]{1,4}\b/i,
  /\b(?:executed|ran|invoked|launched|compiled)\b[^.\n]{0,40}\b(?:it|them|this|the\s+(?:script|program|file|code|command|tests?)|python3?|node|\S{2,}\.[a-z]{1,4})\b/i,
];

/**
 * Does this no-tool-call response CLAIM a file mutation it may not have performed?
 * The handler only acts on this when NO tool call ran in the whole conversation —
 * a model that actually did the work called at least one tool — so it's a low
 * false-positive signal for the "I've replaced the README" hallucination.
 */
export function looksLikeHallucinatedCompletion(text: string | null): boolean {
  if (!text) return false;
  const t = text.trim();

  if (t.length < 8) return false;

  return HALLUCINATED_COMPLETION_PATTERNS.some((re) => re.test(t));
}

/**
 * Did M365 substitute a remote Teams-hosted patch for a local filesystem edit?
 * Unlike the general hallucinated-completion detector this must fire even after
 * earlier tool calls: reading a file locally does not make a remote patch local.
 */
export function looksLikeRemoteArtifactCompletion(text: string | null): boolean {
  if (!text) return false;
  const t = text.trim();

  if (t.length < 12) return false;

  return REMOTE_ARTIFACT_COMPLETION_PATTERNS.some((re) => re.test(t));
}

export function looksLikeConfabulation(text: string | null): boolean {
  if (!text) return false;
  const t = text.trim();

  if (t.length < 12) return false;

  return CONFABULATION_PATTERNS.some((re) => re.test(t));
}

// A tool result the MODEL wrote. The proxy is the only thing that sends
// <tool_response> blocks, so one in the model's own output is invented.
const SELF_WRITTEN_RESULT = /<tool_(?:response|result)\b/i;

const ANY_FENCE = /```[A-Za-z0-9_.-]+[ \t]*\r?\n[\s\S]*?```/;

/**
 * Treat a self-written `<tool_response>` as a STOP SEQUENCE.
 *
 * Hand-ported from upstream 4f6c95f (#31). M365's chat models do not stop at
 * the call: they write a fence, then invent the `<tool_response>` they expect,
 * then act on it (Sonnet 4.6: 38 of 80 turns in an upstream bench run). With
 * 3-4 fences the turn looks like a prose document, so the document guard
 * returned it as text and dropped the one real action at the head.
 *
 * Everything from the invented tag onward is fabricated, so cut there and keep
 * the head — but only when the head holds a real call to one of `tools` (any
 * fence, if no tools are given). A tag after prose or an illustration is left
 * alone. Deterministic: no extra upstream turn.
 */
export function truncateAtFabricatedToolResponse(text: string, tools?: ToolDef[]): string {
  const i = text.search(SELF_WRITTEN_RESULT);

  if (i < 0) return text;
  const head = text.slice(0, i);
  const acted = tools && tools.length > 0 ? parseToolCalls(head, tools).hasToolCalls : ANY_FENCE.test(head);

  return acted ? head.trimEnd() : text;
}

/**
 * Did the model write a DOCUMENT (prose with embedded code fences) rather than
 * issue tool calls? The shell-routing parser greedily turns every ```bash block
 * into a tool call, so a model answering "here's a simplified README" — whose
 * markdown is full of ```bash / ```json examples — would get its own answer
 * executed as shell. Catch that: a real agentic turn is ONE action with little
 * prose; a document is multiple fences surrounded by substantial prose.
 *
 * Chosen empirically (scripts guard-experiment, README-about-bash fixture):
 * ≥2 fences AND (≥120 chars of surrounding prose OR ≥4 fences). A SINGLE action
 * is never reclassified regardless of prose, so the coding loop is untouched.
 */
export function isProseDocument(parsed: ParseResult, text?: string, tools?: ToolDef[]): boolean {
  if (!parsed.hasToolCalls || parsed.toolCalls.length < 2) return false;

  // A reply that OPENS with a tool call is an action, whatever follows it
  // (upstream 0b1538e, #33): a tool-calling model stops at its call, so
  // everything M365 writes after it was written before the result existed.
  // Judged as a whole, those tails made 34 of 42 guard verdicts in the upstream
  // Sep 28 bench runs discard a correct first action. Documents announce
  // themselves before their first fence, so the preamble decides.
  if (text !== undefined && tools && tools.length > 0) {
    const first = findFirstToolFence(text, buildSpecMap(tools));

    if (first && !looksLikeDocumentPreamble(text.slice(0, first.start))) return false;
  }

  const prose = parsed.textContent ? parsed.textContent.trim() : "";
  // Distinguish a coding-agent ACTION turn from a written DOCUMENT.
  //   ACTION  (execute it): a short preamble + a couple command fences, e.g. Claude's
  //           "I'll inspect the files first.\n```bash ls```\n```bash cat```" — common,
  //           must NOT be reclassified or we eat real tool calls (docs §10 F23).
  //   DOCUMENT (return as text): the model ANSWERING with markdown full of fences
  //           (F15: "here's a simplified README") — it carries document signatures:
  //           markdown headers, lots of prose, or many fences.
  // Flag only documents. (Old heuristic was prose≥120, which ate Claude's preambles.)
  const hasMarkdownHeaders = /^#{1,6}\s/m.test(prose);

  return parsed.toolCalls.length >= 4 || hasMarkdownHeaders || prose.length >= 300;
}

/** Is the text before a reply's first tool call the opening of a written
 *  document (a heading, example code, or a long intro) rather than a one-line
 *  lead-in like "I'll inspect the files first."? */
function looksLikeDocumentPreamble(preamble: string): boolean {
  return /^#{1,6}\s/m.test(preamble) || preamble.includes("```") || preamble.trim().length >= 200;
}

/** The text a reply carries after its first tool call (trimmed), or "" — used
 *  to tell the model its tail predates the call's result. */
export function textAfterFirstToolCall(text: string, tools?: ToolDef[]): string {
  if (!tools || tools.length === 0) return "";
  const first = findFirstToolFence(text, buildSpecMap(tools));

  return first ? text.slice(first.end).trim() : "";
}

export function parseToolCalls(text: string, tools?: ToolDef[]): ParseResult {
  // Fenced is the format: parse ```toolname blocks first (unknown info-strings
  // survive in `leftover`). The JSON parse below is a tolerance fallback for
  // when M365 ignores the contract and emits a `{"tool":...}` object anyway —
  // bare or wrapped in a ```json / ```tool_call fence whose markers the cleanup
  // below strips.
  const specMap = tools && tools.length > 0 ? buildSpecMap(tools) : null;

  const noFencedCalls: FencedParseResult = { calls: [], leftover: text };
  const fenced = specMap ? parseFencedToolCalls(text, specMap) : noFencedCalls;

  const resolveName = (raw: string | undefined): string | undefined =>
    raw === undefined ? undefined : (specMap?.get(raw)?.name ?? raw);

  // Tolerance fallback: a stray JSON tool call {"tool": "...", "arguments": {...}}
  const jsonRegex = new RegExp(TOOL_CALL_REGEX.source, "g");
  const jsonCalls: ParsedToolCall[] = [];
  let match: RegExpExecArray | null;

  while ((match = jsonRegex.exec(fenced.leftover)) !== null) {
    try {
      const parsed = StrayToolCallSchema.safeParse(JSON.parse(match[0]));

      if (!parsed.success) continue;
      const name = resolveName(parsed.data.tool ?? parsed.data.name);

      if (!name) continue;
      const textArgs = TextValueSchema.safeParse(parsed.data.arguments);

      jsonCalls.push({
        id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
        type: "function",
        function: {
          name,
          arguments: textArgs.success ? textArgs.data : JSON.stringify(parsed.data.arguments),
        },
      });
    } catch {
      log.error("Failed to parse tool call JSON:", match[0]);
    }
  }

  const toolCalls = [...fenced.calls, ...jsonCalls];

  if (toolCalls.length === 0) {
    return { hasToolCalls: false, toolCalls: [], textContent: cleanLooseText(fenced.leftover) };
  }

  // Strip matched tool calls from the leftover to get remaining content.
  // M365 is a markdown model and often wraps the JSON in a ```json / ```tool_call
  // fence even when told not to; remove the now-empty fence markers it leaves
  // behind so they aren't mistaken for real assistant prose. Also drop the
  // invented confidence/final objects so a premature "✅ SUCCESS" never reaches
  // the client and a junk-only leftover isn't flagged as mixed output.
  const remaining = fenced.leftover
    .replace(jsonRegex, "")
    .replace(CONFIDENCE_REGEX, "")
    .replace(FINAL_OBJECT_REGEX, "")
    .replace(/```(?:json|tool_call)?\s*```/g, "") // empty fence pair
    .replace(/```(?:json|tool_call)?/g, "") // dangling opening/closing fence
    .trim();

  return {
    hasToolCalls: true,
    toolCalls,
    textContent: remaining || null,
  };
}
