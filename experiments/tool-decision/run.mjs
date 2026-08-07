#!/usr/bin/env bun
/**
 * Offline deterministic-coverage runner for the tool-decision corpus.
 *
 * Feeds each case through the PRODUCTION produceToolPath() (plus the real core
 * parsing/detection functions) and compares the observed behavior with the
 * case's expected classification / expected action.
 *
 * No network. No M365. No LM Studio. No production changes.
 *
 * Outputs:
 *   results.json        — machine-readable per-case records
 *   stdout              — compact summary tables (A: classification, B: action)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseToolCalls,
  looksLikeConfabulation,
  looksLikeHallucinatedCompletion,
  looksLikeRemoteArtifactCompletion,
  isProseDocument,
} from "@m365-copilot/core";
import { produceToolPath } from "../../packages/proxy-lib/src/tool-path.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const cases = readFileSync(resolve(HERE, "cases.jsonl"), "utf-8")
  .trim().split("\n").map((line) => JSON.parse(line));

// Minimal ToolDefs derived from the corpus available_tools lists.
const SCHEMAS = {
  read_file: { path: { type: "string" } },
  write_file: { path: { type: "string" }, content: { type: "string" } },
  edit_file: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } },
  bash: { command: { type: "string" } },
  glob: { pattern: { type: "string" } },
  reply: { text: { type: "string" } },
};

function toolsFor(names) {
  return names.map((name) => {
    const properties = SCHEMAS[name] ?? { arg: { type: "string" } };
    return {
      type: "function",
      function: {
        name,
        description: `${name} tool`,
        parameters: { type: "object", properties, required: Object.keys(properties) },
      },
    };
  });
}

/**
 * Table A classification: what deterministic detection thinks the input is.
 * Reuses the real core functions in the same precedence tool-path.ts applies
 * (remote artifact > confabulation > hallucination; reply-only and prose
 * documents are detected on the parsed result).
 */
function observedClass(text, tools, everActed) {
  const parsed = parseToolCalls(text, tools);
  if (parsed.hasToolCalls) {
    const replyOnly = parsed.toolCalls.length === 1 && parsed.toolCalls[0].function.name === "reply";
    if (replyOnly) return "reply";
    if (isProseDocument(parsed)) return "mixed_tool_and_prose"; // doc -> text
    if (parsed.textContent) return "mixed_tool_and_prose";
    return "valid_tool";
  }
  if (looksLikeRemoteArtifactCompletion(parsed.textContent)) return "remote_artifact";
  if (looksLikeConfabulation(parsed.textContent)) return "confabulation";
  if (!everActed && looksLikeHallucinatedCompletion(parsed.textContent)) return "hallucinated_completion";
  return "plain_text";
}

function actionMatches(expected, observed) {
  if (expected === observed) return true;
  // The reply conversion's observable result IS plain text.
  return expected === "reply_as_text" && observed === "text";
}

async function runCase(c) {
  const tools = toolsFor(c.available_tools);
  const everActed = Boolean(c.recovery_state?.ever_acted);
  const messages = everActed
    ? [{ role: "assistant", tool_calls: [{ id: "call-prev", function: { name: "bash", arguments: "{}" } }] }]
    : [];

  let runTurnCount = 0;
  const runTurn = async () => { runTurnCount += 1; return { fullText: c.planner_output }; };

  let result;
  try {
    result = await produceToolPath(c.planner_output, {
      runTurn,
      markSent: () => {},
      registerToolCalls: () => {},
      messages,
      tools,
    });
  } catch (err) {
    result = { kind: "error", resp: new Response(String(err), { status: 500 }) };
  }

  let observedAction;
  if (runTurnCount > 1) observedAction = "retry_planner";
  else if (result.kind === "tools") observedAction = "tool";
  else if (result.kind === "error") observedAction = "fail_closed";
  else observedAction = "text";

  let observedTerminal;
  if (result.kind === "error") {
    let type = "";
    try { type = (await result.resp.json()).error?.type ?? ""; } catch { /* non-JSON body */ }
    observedTerminal = type === "file_mutation_without_local_tool"
      ? `fail_closed(502:${type})` : `error(${result.resp.status})`;
  } else if (result.kind === "tools") {
    observedTerminal = `tools(${result.toolCalls.map((t) => t.function.name).join(",")})`;
  } else {
    observedTerminal = "text";
  }

  const status = c.expected_action === "uncertain"
    ? "uncertain"
    : actionMatches(c.expected_action, observedAction) ? "pass" : "fail";

  return {
    id: c.id,
    expected: c.expected,
    expected_action: c.expected_action,
    observed_class: observedClass(c.planner_output, tools, everActed),
    observed_action: observedAction,
    observed_terminal: observedTerminal,
    run_turns: runTurnCount,
    status,
  };
}

// ---- main ---------------------------------------------------------------

const results = [];
for (const c of cases) {
  const prevRetries = process.env.M365_CONFAB_RETRIES;
  const prevMulti = process.env.M365_ALLOW_MULTI_TOOL;
  const prevNoRetry = process.env.M365_NO_CONFAB_RETRY;
  try {
    if (c.recovery_state?.attempts) process.env.M365_CONFAB_RETRIES = String(c.recovery_state.attempts + 1);
    else delete process.env.M365_CONFAB_RETRIES;
    if (c.recovery_state?.multi_tool_allowed) process.env.M365_ALLOW_MULTI_TOOL = "1";
    else delete process.env.M365_ALLOW_MULTI_TOOL;
    delete process.env.M365_NO_CONFAB_RETRY;
    results.push(await runCase(c));
  } finally {
    if (prevRetries === undefined) delete process.env.M365_CONFAB_RETRIES; else process.env.M365_CONFAB_RETRIES = prevRetries;
    if (prevMulti === undefined) delete process.env.M365_ALLOW_MULTI_TOOL; else process.env.M365_ALLOW_MULTI_TOOL = prevMulti;
    if (prevNoRetry === undefined) delete process.env.M365_NO_CONFAB_RETRY; else process.env.M365_NO_CONFAB_RETRY = prevNoRetry;
  }
}

writeFileSync(resolve(HERE, "results.json"), JSON.stringify(results, null, 2) + "\n");

const pad = (s, n) => String(s).padEnd(n);
const line = (row) => row.join("  ");

console.log("=== A. Classification coverage (deterministic detection vs expected) ===");
console.log(line([pad("class", 26), "cases", "match"]));
const byClassA = new Map();
for (const r of results) {
  const e = byClassA.get(r.expected) ?? { cases: 0, match: 0 };
  e.cases += 1;
  if (r.expected === "ambiguous" || r.observed_class === r.expected) e.match += 1;
  byClassA.set(r.expected, e);
}
for (const [cls, e] of [...byClassA.entries()].sort()) {
  console.log(line([pad(cls, 26), String(e.cases).padStart(5), String(e.match).padStart(5)]));
}

console.log("\n=== B. Action correctness (deterministic action vs expected_action) ===");
console.log(line([pad("class", 26), "cases", "correct"]));
const byClassB = new Map();
for (const r of results) {
  const e = byClassB.get(r.expected) ?? { cases: 0, correct: 0 };
  e.cases += 1;
  if (r.status === "pass") e.correct += 1;
  byClassB.set(r.expected, e);
}
for (const [cls, e] of [...byClassB.entries()].sort()) {
  const note = cls === "ambiguous" ? " (uncertain expected — recorded, not failures)" : "";
  console.log(line([pad(cls, 26), String(e.cases).padStart(5), `${e.correct}${note}`]));
}

const fails = results.filter((r) => r.status === "fail");
console.log(`\npass=${results.filter((r) => r.status === "pass").length} fail=${fails.length} uncertain=${results.filter((r) => r.status === "uncertain").length}`);
if (fails.length) {
  console.log("\nFAILED:");
  for (const f of fails) console.log(`  ${f.id}: expected ${f.expected_action}, observed ${f.observed_action} (${f.observed_terminal})`);
}

const concreteOnUncertain = results.filter(
  (r) => r.expected_action === "uncertain" && r.observed_action !== "uncertain",
);
console.log("\nDeterministic takes a CONCRETE action on an uncertain case:");
for (const r of concreteOnUncertain) {
  console.log(`  ${r.id}: classified ${r.observed_class}, action ${r.observed_action} (${r.observed_terminal})`);
}
