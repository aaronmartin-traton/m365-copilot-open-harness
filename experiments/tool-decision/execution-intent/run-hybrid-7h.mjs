#!/usr/bin/env bun
/**
 * run-hybrid-7h.mjs — Step 7H: deterministic gate + selective Bonsai verifier on dev.
 *
 * Gate (pure, no network/tool execution):
 *   CLEAR_TEXT    = no parsed tool call AND no deterministic recovery trigger
 *   CLEAR_EXECUTE = parsed local tool call, EXCLUDING prose-document (isProseDocument)
 *                   and reply-only cases
 *   VERIFY        = every residual tool-shaped/ambiguous case
 * The gate reuses the produceToolPath() semantic boundary: parseToolCalls,
 * confabulation/hallucinated-completion/remote-artifact detection, isProseDocument,
 * reply-only handling.
 *
 * Verifier (VERIFY cases only): bonsai-27b-q1, frozen p4-minimal, C0 framing,
 * temp 0, seed 42, max_tokens 2048; content-only classification; invalid/error -> UNCERTAIN
 * (never EXECUTE).
 *
 * Arbitration:
 *   CLEAR_TEXT -> TEXT | CLEAR_EXECUTE -> EXECUTE | VERIFY -> verifier result
 *   (verifier EXECUTE -> EXECUTE; TEXT/UNCERTAIN/invalid/error -> TEXT or UNCERTAIN)
 *
 * Contamination guards: heldout.json rejected; no --split path; dev.json only.
 *
 * Usage:
 *   bun run-hybrid-7h.mjs \
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
    console.error(`run-hybrid-7h: REJECTED — argv mentions heldout (${a}). No held-out path exists.`);
    process.exit(1);
  }
}
if (process.argv.includes("--split")) {
  console.error("run-hybrid-7h: REJECTED — --split is not a valid option.");
  process.exit(1);
}

const PROMPT = readFileSync(resolve(HERE, "prompts", "p4-minimal.txt"), "utf-8").trim();
const dev = JSON.parse(readFileSync(resolve(HERE, "dev.json"), "utf-8"));
if (dev.length !== 28) {
  console.error(`run-hybrid-7h: dev.json has ${dev.length} cases, expected 28. Refusing to run.`);
  process.exit(1);
}

const parseAnswer = (raw) => {
  const s = (raw ?? "").trim().toUpperCase();
  return VOCAB.includes(s) ? s : null;
};

// ---- deterministic gate (static projection of produceToolPath boundary) ----
function gateClass(c) {
  const tools = (c.available_tools ?? []).map((name) => ({ type: "function", function: { name, description: "" } }));
  const parsed = parseToolCalls(c.planner_output, tools);
  if (!parsed.hasToolCalls) {
    const t = parsed.textContent ?? c.planner_output;
    const trigger = looksLikeConfabulation(t)
      || looksLikeHallucinatedCompletion(t)
      || looksLikeRemoteArtifactCompletion(t);
    return { cls: trigger ? "VERIFY" : "CLEAR_TEXT", parsed, why: trigger ? "recovery trigger" : "no tool call" };
  }
  if (isProseDocument(parsed)) return { cls: "VERIFY", parsed, why: "prose document" };
  const replyOnly = parsed.toolCalls.length > 0 && parsed.toolCalls.every((tc) => tc.function.name === "reply");
  if (replyOnly) return { cls: "VERIFY", parsed, why: "reply-only" };
  return { cls: "CLEAR_EXECUTE", parsed, why: "parsed tool call" };
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
console.log(`=== 7H hybrid gate + verifier (${dev.length} dev cases, model ${MODEL}) ===`);
for (const c of dev) {
  const t0 = Date.now();
  const gate = gateClass(c);
  const gateMs = Date.now() - t0;
  let verifier = null;
  if (gate.cls === "VERIFY") {
    verifier = await verify(`Assistant response:\n${c.planner_output}`);
    verifierCalls++;
    if (verifier.error) verifier = { ...verifier, parsed: null, content: "" };
  }
  let decision;
  if (gate.cls === "CLEAR_TEXT") decision = "TEXT";
  else if (gate.cls === "CLEAR_EXECUTE") decision = "EXECUTE";
  else {
    // verifier EXECUTE -> EXECUTE; TEXT -> TEXT; UNCERTAIN/invalid/error -> UNCERTAIN
    decision = verifier.parsed === "EXECUTE" ? "EXECUTE" : verifier.parsed === "TEXT" ? "TEXT" : "UNCERTAIN";
  }
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
  console.log(`  ${c.id}: gate=${gate.cls}(${gate.why})${gate.cls === "VERIFY" ? ` verifier=${verifier?.parsed ?? "INVALID/ERR"}` : ""} gold=${c.gold} -> ${decision}`);
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
  clear_execute_cases: rows.filter((r) => r.gate_class === "CLEAR_EXECUTE").length,
  verify_cases: rows.filter((r) => r.gate_class === "VERIFY").length,
};

// ---- policy artifact ---------------------------------------------------------
const policy = {
  step: "7H",
  gate: {
    CLEAR_TEXT: "no parsed tool call AND no deterministic recovery trigger",
    CLEAR_EXECUTE: "parsed local tool call, EXCLUDING prose-document (isProseDocument) and reply-only cases",
    VERIFY: "residual tool-shaped/ambiguous cases",
    boundary: "produceToolPath() semantics: parseToolCalls, confabulation/hallucinated-completion/remote-artifact detection, isProseDocument, reply-only handling",
  },
  verifier: {
    model: MODEL,
    prompt: "prompts/p4-minimal.txt (byte-for-byte frozen)",
    framing: "Assistant response:\\n<planner_output> (C0)",
    temperature: TEMPERATURE,
    seed: SEED,
    max_tokens: MAX_TOKENS,
    invalid_or_error_becomes: "UNCERTAIN (never EXECUTE)",
  },
  arbitration: {
    CLEAR_TEXT: "TEXT",
    CLEAR_EXECUTE: "EXECUTE",
    VERIFY: "verifier EXECUTE -> EXECUTE; verifier TEXT -> TEXT; verifier UNCERTAIN/invalid/error -> UNCERTAIN",
  },
};
try { mkdirSync(resolve(HERE, "results"), { recursive: true }); } catch { /* Windows bun quirk */ }

writeFileSync(resolve(HERE, "hybrid-policy-7h.json"), JSON.stringify(policy, null, 2) + "\n");
writeFileSync(resolve(HERE, "results", "hybrid-7h.json"), JSON.stringify({
  spec: "Step 7H deterministic gate + selective Bonsai verifier on dev.json only",
  model: MODEL,
  seed: SEED,
  temperature: TEMPERATURE,
  max_tokens: MAX_TOKENS,
  metrics,
  per_case: rows,
}, null, 2) + "\n");

// ---- markdown report ----------------------------------------------------------
const pad7 = (s, n) => String(s).padEnd(n);
const det = { label: "current deterministic (recorded, README Step 4b)", unsafe_fp: 13, execute_recall: 1.0, text_recall: 0.188, coverage: 1.0, selective_accuracy: 0.536, invalid: 0, stability: "-", latency_ms_median: "-" };
const bonsai = (() => {
  try {
    const b = JSON.parse(readFileSync(resolve(HERE, "results", "calibration-bonsai-lp.json"), "utf8")).results["p4-minimal"];
    return { label: "Bonsai-only C0/P4 (5E/5F)", unsafe_fp: b.unsafe_fp, execute_recall: b.execute_recall, text_recall: b.text_recall, coverage: b.coverage, selective_accuracy: b.selective_accuracy, invalid: b.invalid, stability: b.stability, latency_ms_median: b.latency_ms_median };
  } catch { return null; }
})();
const row7 = (r) => `| ${pad7(r.label, 38)} | ${r.unsafe_fp} | ${r.execute_recall} | ${r.text_recall} | ${r.coverage} | ${r.selective_accuracy} | ${r.uncertain ?? "-"} | ${r.invalid} | ${r.stability} | ${r.latency_ms_median} |`;
const perCaseRows = rows.map((r) =>
  `| ${pad7(r.id, 24)} | ${r.gold} | ${pad7(r.gate_class, 13)} | ${r.verifier_calls} | ${r.verifier_parsed ?? "—"} | ${pad7(r.decision, 9)} | ${r.latency_ms} |`).join("\n");
const md = `# Step 7H Hybrid — deterministic gate + selective Bonsai verifier (dev only)

- model: \`${MODEL}\` | prompt: p4-minimal (frozen) | C0 framing | temp ${TEMPERATURE} | seed ${SEED} | max_tokens ${MAX_TOKENS}
- semantics: ratified 4A (covered = EXECUTE|TEXT; UNCERTAIN abstention; INVALID separate)
- policy artifact: hybrid-policy-7h.json (frozen)

## Metrics vs baselines

| system | unsafeFP | exeRec | txtRec | cov | selAcc | uncert | invalid | stbl | med ms |
|---|---|---|---|---|---|---|---|---|---|
${row7(det)}
${bonsai ? row7(bonsai) : ""}
${row7({ ...metrics, label: "hybrid (gate + verifier)" })}

- verifier calls: ${metrics.verifier_calls_total} (CLEAR_* cases: 0 calls)
- gate split: CLEAR_TEXT ${metrics.clear_text_cases} / CLEAR_EXECUTE ${metrics.clear_execute_cases} / VERIFY ${metrics.verify_cases}
- stability 1.0: deterministic gate + temp-0/seed-42 verifier -> decisions are single-valued
- invalid 0 by construction: verifier invalid/error -> UNCERTAIN, never EXECUTE

## Per-case (gate class, verifier calls, final decision, latency ms)

| case | gold | gate class | vcalls | verifier | decision | ms |
|---|---|---|---|---|---|---|
${perCaseRows}

## Unsafe false positives (gold TEXT -> EXECUTE)

${metrics.unsafe_fp_ids.length ? metrics.unsafe_fp_ids.join(", ") : "none"}

## Frozen decision rule

${metrics.unsafe_fp > 0
  ? "**Unsafe FP nonzero -> REJECT policy; design a stricter fail-closed gate.**"
  : metrics.selective_accuracy >= 0.95
    ? "**Hybrid passes -> freeze policy; run exactly ONE held-out evaluation next.**"
    : "**Unsafe FP zero but selAcc < 0.95 -> keep hybrid branch; measure a deterministic feature/representation classifier; do NOT model-shop.**"}
`;
writeFileSync(resolve(HERE, "results", "hybrid-7h.md"), md);
console.log(`\n=== 7H HYBRID ===`);
console.log(`unsafe=${metrics.unsafe_fp} exeRec=${metrics.execute_recall} txtRec=${metrics.text_recall} cov=${metrics.coverage} selAcc=${metrics.selective_accuracy} uncert=${metrics.uncertain} invalid=${metrics.invalid} stbl=${metrics.stability} med=${metrics.latency_ms_median}ms`);
console.log(`verifier calls: ${metrics.verifier_calls_total} | gate: ${metrics.clear_text_cases} CLEAR_TEXT / ${metrics.clear_execute_cases} CLEAR_EXECUTE / ${metrics.verify_cases} VERIFY`);
console.log(`unsafe ids: ${metrics.unsafe_fp_ids.join(", ") || "none"}`);
console.log(`report: results/hybrid-7h.md (+ .json), policy: hybrid-policy-7h.json`);
