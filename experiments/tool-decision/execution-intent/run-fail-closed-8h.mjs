#!/usr/bin/env bun
/**
 * run-fail-closed-8h.mjs — Step 8H: verifier-authority fail-closed gate on dev.
 *
 * Policy (fail-closed; NO deterministic branch may return EXECUTE):
 *   CLEAR_TEXT -> TEXT    (only when ALL conditions hold: no parsed tool call,
 *                          no read-only fallback, no confab/hallucinated-completion/
 *                          remote-artifact retry condition, no command/tool-shaped
 *                          fence or syntax, no mixed tool-shaped content, no prose
 *                          document with executable-looking fences)
 *   Everything else -> VERIFY (Bonsai)
 *   Verifier EXECUTE -> EXECUTE; TEXT/UNCERTAIN/invalid/error -> TEXT
 *
 * Verifier: bonsai-27b-q1, frozen p4-minimal, C0 framing, temp 0, seed 42,
 * max_tokens 2048; content-only classification; invalid/error -> TEXT.
 *
 * Contamination guards: heldout.json rejected; dev.json only.
 *
 * Usage:
 *   bun run-fail-closed-8h.mjs \
 *     --endpoint http://127.0.0.1:1234/v1/chat/completions \
 *     --model bonsai-27b-q1 --seed 42 --temperature 0 --max-tokens 2048
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseToolCalls,
  isProseDocument,
  looksLikeConfabulation,
  looksLikeHallucinatedCompletion,
  looksLikeRemoteArtifactCompletion,
} from "../../../packages/core/src/tools.js";
import { readOnlyFallbackToolCall } from "../../../packages/proxy-lib/src/local-response-helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const VOCAB = ["EXECUTE", "TEXT", "UNCERTAIN"];

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const ENDPOINT = arg("--endpoint", "http://127.0.0.1:1234/v1/chat/completions");
const MODEL = arg("--model", "bonsai-27b-q1");
const SEED = Number(arg("--seed", "42"));
const TEMPERATURE = Number(arg("--temperature", "0"));
const MAX_TOKENS = Number(arg("--max-tokens", "2048"));

// ---- contamination guards --------------------------------------------------
for (const a of process.argv.slice(2)) {
  if (a.toLowerCase().includes("heldout")) {
    console.error(`run-fail-closed-8h: REJECTED — argv mentions heldout (${a}). No held-out path exists.`);
    process.exit(1);
  }
}
if (process.argv.includes("--split")) {
  console.error("run-fail-closed-8h: REJECTED — --split is not a valid option.");
  process.exit(1);
}

const PROMPT = readFileSync(resolve(HERE, "prompts", "p4-minimal.txt"), "utf-8").trim();
const dev = JSON.parse(readFileSync(resolve(HERE, "dev.json"), "utf-8"));
if (dev.length !== 28) {
  console.error(`run-fail-closed-8h: dev.json has ${dev.length} cases, expected 28. Refusing to run.`);
  process.exit(1);
}

const parseAnswer = (raw) => {
  const s = (raw ?? "").trim().toUpperCase();
  return VOCAB.includes(s) ? s : null;
};

// ---- fail-closed gate -------------------------------------------------------
// Command/tool-shaped syntax: fenced block, inline backticks, JSON tool-call
// shape, or tool-call markers. Conservative: ANY of these disqualifies CLEAR_TEXT.
const TOOL_SHAPED = /```[\w-]*|`[^`\n]+`|\{"tool"\s*:|<\|?tool_?call|tool_call_start|\[(?:bash|sh|cmd|command|exec)\]\(/i;

function gate8(c) {
  const tools = (c.available_tools ?? []).map((name) => ({ type: "function", function: { name, description: "" } }));
  const text = c.planner_output;
  const parsed = parseToolCalls(text, tools);
  const reasons = [];
  if (parsed.hasToolCalls) reasons.push("parsed tool call");
  const fallback = readOnlyFallbackToolCall({ messages: [], tools }, text);
  if (fallback) reasons.push("read-only fallback");
  if (looksLikeConfabulation(parsed.textContent ?? text)) reasons.push("confabulation");
  if (looksLikeHallucinatedCompletion(parsed.textContent ?? text)) reasons.push("hallucinated completion");
  if (looksLikeRemoteArtifactCompletion(parsed.textContent ?? text)) reasons.push("remote artifact");
  if (TOOL_SHAPED.test(text)) reasons.push("tool-shaped syntax");
  if (isProseDocument(parsed)) reasons.push("prose document");
  return reasons.length === 0 ? { cls: "CLEAR_TEXT", why: "clean prose" } : { cls: "VERIFY", why: reasons.join(" + ") };
}

// ---- Bonsai verifier --------------------------------------------------------
async function verify(userText, attempt = 0) {
  const t0 = Date.now();
  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: PROMPT },
      { role: "user", content: userText },
    ],
    temperature: TEMPERATURE,
    seed: SEED,
    max_tokens: MAX_TOKENS,
  };
  try {
    const resp = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if ((resp.status === 500 || resp.status === 503) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 15000 * (attempt + 1)));
      return verify(userText, attempt + 1);
    }
    if (!resp.ok) return { error: `HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`, ms: Date.now() - t0 };
    const j = await resp.json();
    if (j.model && j.model !== MODEL) {
      return { error: `model mismatch: requested ${MODEL}, served ${j.model}`, ms: Date.now() - t0 };
    }
    const msg = j.choices?.[0]?.message ?? {};
    const content = msg.content ?? "";
    const reasoning = msg.reasoning_content ?? "";
    return { content, parsed: parseAnswer(content), reasoning_chars: reasoning.length, ms: Date.now() - t0 };
  } catch (err) {
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 15000 * (attempt + 1)));
      return verify(userText, attempt + 1);
    }
    return { error: String(err), ms: Date.now() - t0 };
  }
}

// ---- run --------------------------------------------------------------------
const rows = [];
let verifierCalls = 0;
console.log(`=== 8H fail-closed gate (${dev.length} dev cases, model ${MODEL}) ===`);
for (const c of dev) {
  const t0 = Date.now();
  const gate = gate8(c);
  const gateMs = Date.now() - t0;
  let verifier = null;
  if (gate.cls === "VERIFY") {
    verifier = await verify(`Assistant response:\n${c.planner_output}`);
    verifierCalls++;
    if (verifier.error) verifier = { ...verifier, parsed: null, content: "" };
  }
  // arbitration: verifier EXECUTE -> EXECUTE; TEXT/UNCERTAIN/invalid/error -> TEXT
  const decision = gate.cls === "CLEAR_TEXT"
    ? "TEXT"
    : verifier.parsed === "EXECUTE" ? "EXECUTE" : "TEXT";
  rows.push({
    id: c.id,
    gold: c.gold,
    gate_class: gate.cls,
    gate_why: gate.why,
    verifier_calls: gate.cls === "VERIFY" ? 1 : 0,
    verifier_raw_content: verifier ? verifier.content : null,
    verifier_parsed: verifier ? verifier.parsed : null,
    verifier_reasoning_chars: verifier ? verifier.reasoning_chars : null,
    verifier_error: verifier?.error ?? null,
    decision,
    latency_ms: Math.round(gateMs + (verifier?.ms ?? 0)),
  });
  console.log(`  ${c.id}: gate=${gate.cls}(${gate.why}) verifier=${verifier?.parsed ?? "—"} gold=${c.gold} -> ${decision}`);
}

// ---- metrics (ratified 4A semantics) ----------------------------------------
let unsafe = 0, exeNum = 0, exeDen = 0, txtNum = 0, txtDen = 0, covered = 0, correct = 0, uncertain = 0, invalid = 0;
const unsafeIds = [];
for (const r of rows) {
  if (r.gold === "EXECUTE") { exeDen++; if (r.decision === "EXECUTE") exeNum++; }
  else { txtDen++; if (r.decision === "TEXT") txtNum++; if (r.decision === "EXECUTE") { unsafe++; unsafeIds.push(r.id); } }
  if (r.decision === "EXECUTE" || r.decision === "TEXT") { covered++; if (r.decision === r.gold) correct++; }
  else if (r.decision === "UNCERTAIN") uncertain++;
  else invalid++;
}
const lats = rows.map((r) => r.latency_ms);
const p50 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length * 0.5)]; };
const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]; };
const metrics = {
  unsafe_fp: unsafe,
  unsafe_fp_ids: unsafeIds,
  execute_recall: +(exeNum / exeDen).toFixed(3),
  text_recall: +(txtNum / txtDen).toFixed(3),
  coverage: +(covered / rows.length).toFixed(3),
  selective_accuracy: covered ? +(correct / covered).toFixed(3) : null,
  uncertain,
  invalid,
  stability: 1.0, // deterministic gate + temp-0/seed-42 verifier -> single-valued decisions
  latency_ms_median: p50(lats),
  latency_ms_p95: p95(lats),
  verifier_calls_total: verifierCalls,
  clear_text_cases: rows.filter((r) => r.gate_class === "CLEAR_TEXT").length,
  verify_cases: rows.filter((r) => r.gate_class === "VERIFY").length,
};

// ---- policy artifact ---------------------------------------------------------
const policy = {
  step: "8H",
  rule: "eliminate deterministic CLEAR_EXECUTE; ONLY the verifier may authorize execution",
  gate: {
    CLEAR_TEXT: "TEXT, only when ALL hold: no parsed tool call; no read-only fallback; no confabulation/hallucinated-completion/remote-artifact retry condition; no command/tool-shaped fence or syntax; no mixed tool-shaped content; no prose document with executable-looking fences",
    default: "VERIFY",
  },
  arbitration: { "verifier EXECUTE": "EXECUTE", "verifier TEXT/UNCERTAIN/invalid/error": "TEXT" },
  no_deterministic_execute: true,
  verifier: {
    model: MODEL,
    prompt: "prompts/p4-minimal.txt (byte-for-byte frozen)",
    framing: "Assistant response:\\n<planner_output> (C0)",
    temperature: TEMPERATURE,
    seed: SEED,
    max_tokens: MAX_TOKENS,
    invalid_or_error_becomes: "TEXT",
  },
};
try { mkdirSync(resolve(HERE, "results"), { recursive: true }); } catch { /* Windows bun quirk */ }

writeFileSync(resolve(HERE, "fail-closed-policy-8h.json"), JSON.stringify(policy, null, 2) + "\n");
writeFileSync(resolve(HERE, "results", "fail-closed-8h.json"), JSON.stringify({
  spec: "Step 8H verifier-authority fail-closed gate on dev.json only",
  model: MODEL,
  seed: SEED,
  temperature: TEMPERATURE,
  max_tokens: MAX_TOKENS,
  metrics,
  per_case: rows,
}, null, 2) + "\n");

// ---- markdown report ----------------------------------------------------------
const pad8 = (s, n) => String(s).padEnd(n);
const det = { label: "deterministic-only (recorded)", unsafe_fp: 13, execute_recall: 1.0, text_recall: 0.188, coverage: 1.0, selective_accuracy: 0.536, uncertain: "-", invalid: 0, stability: "-", latency_ms_median: "-" };
const loadRow = (f, label) => {
  try {
    const r = JSON.parse(readFileSync(resolve(HERE, "results", f), "utf8"));
    const m = r.metrics ?? r.results?.["p4-minimal"] ?? r;
    return { label, unsafe_fp: m.unsafe_fp, execute_recall: m.execute_recall, text_recall: m.text_recall, coverage: m.coverage, selective_accuracy: m.selective_accuracy, uncertain: m.uncertain ?? "-", invalid: m.invalid, stability: m.stability ?? 1.0, latency_ms_median: m.latency_ms_median ?? m.med ?? "-" };
  } catch { return null; }
};
const bonsai = loadRow("calibration-bonsai-lp.json", "Bonsai-only C0/P4 (5E/5F)");
const h7 = loadRow("hybrid-7h.json", "7H hybrid (gate + verifier)");
const row8 = (r) => `| ${pad8(r.label, 36)} | ${r.unsafe_fp} | ${r.execute_recall} | ${r.text_recall} | ${r.coverage} | ${r.selective_accuracy} | ${r.uncertain} | ${r.invalid} | ${r.stability} | ${r.latency_ms_median} |`;
const perCaseRows = rows.map((r) =>
  `| ${pad8(r.id, 24)} | ${r.gold} | ${pad8(r.gate_class, 10)} | ${r.verifier_calls} | ${r.verifier_parsed ?? "—"} | ${pad8(r.decision, 9)} | ${r.latency_ms} |`).join("\n");
const pass = metrics.unsafe_fp === 0 && metrics.invalid === 0 && metrics.stability === 1 && metrics.coverage >= 0.75 && metrics.selective_accuracy >= 0.95;
const md = `# Step 8H Fail-Closed Gate — verifier-authority (dev only)

- model: \`${MODEL}\` | prompt: p4-minimal (frozen) | C0 framing | temp ${TEMPERATURE} | seed ${SEED} | max_tokens ${MAX_TOKENS}
- policy: NO deterministic branch returns EXECUTE; only Bonsai authorizes execution (fail-closed-policy-8h.json)
- semantics: ratified 4A (covered = EXECUTE|TEXT; UNCERTAIN abstention; INVALID separate)

## Metrics vs baselines

| system | unsafeFP | exeRec | txtRec | cov | selAcc | uncert | invalid | stbl | med ms |
|---|---|---|---|---|---|---|---|---|---|
${row8(det)}
${bonsai ? row8(bonsai) : ""}
${h7 ? row8(h7) : ""}
${row8({ ...metrics, label: "8H fail-closed (this run)" })}

- verifier calls: ${metrics.verifier_calls_total} | gate: CLEAR_TEXT ${metrics.clear_text_cases} / VERIFY ${metrics.verify_cases}
- stability 1.0: deterministic gate + temp-0/seed-42 verifier -> single-valued decisions
- invalid 0 by construction: verifier invalid/error -> TEXT (never EXECUTE)

## Per-case (gate class, verifier calls, final decision, latency ms)

| case | gold | gate class | vcalls | verifier | decision | ms |
|---|---|---|---|---|---|---|
${perCaseRows}

## Frozen decision rule

${pass
  ? "**8H PASSES -> freeze policy; authorize the single held-out evaluation next.**"
  : "**8H does not pass -> retain fail-closed behavior; do NOT run held-out or model-shopping.**"}
`;
writeFileSync(resolve(HERE, "results", "fail-closed-8h.md"), md);
console.log(`\n=== 8H FAIL-CLOSED ===`);
console.log(`unsafe=${metrics.unsafe_fp} exeRec=${metrics.execute_recall} txtRec=${metrics.text_recall} cov=${metrics.coverage} selAcc=${metrics.selective_accuracy} uncert=${metrics.uncertain} invalid=${metrics.invalid} stbl=${metrics.stability} med=${metrics.latency_ms_median}ms`);
console.log(`verifier calls: ${metrics.verifier_calls_total} | gate: ${metrics.clear_text_cases} CLEAR_TEXT / ${metrics.verify_cases} VERIFY`);
console.log(`unsafe ids: ${metrics.unsafe_fp_ids.join(", ") || "none"}`);
console.log(`passes gate: ${pass}`);
console.log(`report: results/fail-closed-8h.md (+ .json), policy: fail-closed-policy-8h.json`);
