/**
 * Small tool-caller repair pass (ticket small-toolcaller/01).
 *
 * When M365 answers a tool-mode turn with prose that a failure detector flags
 * (confabulated inability, hallucinated completion, remote-artifact patch), a
 * small local model on an OpenAI-compatible endpoint rewrites the turn as ONE
 * fenced tool call. The repaired text re-enters the normal fenced parser in
 * tool-path.ts, so one-call-per-turn and the prose-document guard still apply.
 *
 * Default OFF. Enabled only by `M365_TOOL_REPAIR=1`. When off,
 * `getToolRepair()` returns null and the tool path is byte-identical.
 *
 * Fail-closed: timeout / HTTP error / network error / model-mismatch / empty
 * output / NONE -> null, and the caller keeps the original text. No M365
 * traffic is ever generated here.
 */

import { z } from "zod/v4";
import { createLogger, formatToolDefinitions, type ToolDef } from "@m365-copilot/core";

const log = createLogger("tool-repair");

export interface ToolRepairContext {
  /** The last user/tool message the assistant was answering. */
  request: string;
  /** M365's prose response that failed to carry a tool call. */
  response: string;
  tools: ToolDef[];
}

/** Returns the repaired fenced text, or null when no repair applies. */
export type ToolRepair = (ctx: ToolRepairContext) => Promise<string | null>;

export const TOOL_REPAIR_PROMPT =
  "You repair a coding assistant's turn. The assistant was supposed to act by calling exactly one tool, " +
  "but it answered in prose instead. Read the request and the assistant's response. If the response " +
  "describes, claims, or refuses a concrete action that one of the tools below can perform now, output " +
  "exactly ONE fenced tool call in the format the tool list shows and nothing else. If no concrete " +
  "action applies, output exactly NONE.\n\n";

const RepairReply = z.object({
  model: z.string().nullish(),
  choices: z.array(z.object({
    message: z.object({ content: z.string().nullish() }).nullish(),
  })).nullish(),
});

const DEFAULT_ENDPOINT = "http://127.0.0.1:1234/v1/chat/completions";

const DEFAULT_MODEL = "watt-tool-8b";

const MAX_FIELD_CHARS = 8000;

let singleton: ToolRepair | null = null;

/** Lazy process-wide repair function. Null unless `M365_TOOL_REPAIR=1`. */
export function getToolRepair(): ToolRepair | null {
  if (process.env.M365_TOOL_REPAIR !== "1") return null;
  singleton ??= createToolRepair();

  return singleton;
}

/** Drop the cached singleton so the next call re-reads env (test hook). */
export function resetToolRepair(): void {
  singleton = null;
}

const clip = (s: string) => (s.length > MAX_FIELD_CHARS ? `${s.slice(0, MAX_FIELD_CHARS)}\n…[truncated]` : s);

function createToolRepair(): ToolRepair {
  const env = process.env;
  const endpoint = (env.M365_TOOL_REPAIR_ENDPOINT || "").trim() || DEFAULT_ENDPOINT;
  const model = (env.M365_TOOL_REPAIR_MODEL || "").trim() || DEFAULT_MODEL;
  const timeoutMs = Math.max(1, Number(env.M365_TOOL_REPAIR_TIMEOUT_MS) || 30000);
  const maxTokens = Math.max(1, Number(env.M365_TOOL_REPAIR_MAX_TOKENS) || 1024);
  let chain: Promise<unknown> = Promise.resolve();

  const fail = (reason: string, t0: number): null => {
    log.info(`tool-repair: model=${model} no-repair reason=${reason} latencyMs=${Date.now() - t0}`);

    return null;
  };

  const attempt = async (ctx: ToolRepairContext): Promise<string | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const t0 = Date.now();

    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: TOOL_REPAIR_PROMPT + formatToolDefinitions(ctx.tools, "baseline") },
            {
              role: "user",
              content: `Request:\n${clip(ctx.request)}\n\nAssistant response:\n${clip(ctx.response)}`,
            },
          ],
          temperature: 0,
          seed: 42,
          max_tokens: maxTokens,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) return fail(`HTTP ${resp.status}`, t0);

      const j = RepairReply.safeParse(await resp.json());

      if (!j.success) return fail("invalid", t0);

      if (j.data.model != null && j.data.model !== model) {
        return fail(`model-mismatch (${j.data.model})`, t0);
      }

      const out = j.data.choices?.[0]?.message?.content?.trim() ?? "";

      if (!out || /^NONE\b/i.test(out)) return fail("none", t0);
      log.info(`tool-repair: model=${model} repaired latencyMs=${Date.now() - t0}`);

      return out;
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";

      return fail(aborted ? "timeout" : "network", t0);
    } finally {
      clearTimeout(timer);
    }
  };

  return (ctx) => {
    const run = chain.then(() => attempt(ctx));
    chain = run.catch(() => undefined);

    return run;
  };
}
