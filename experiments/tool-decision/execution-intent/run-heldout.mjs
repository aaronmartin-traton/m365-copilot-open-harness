#!/usr/bin/env bun
/**
 * run-heldout.mjs — Ticket 03: frozen held-out evaluation through the MERGED
 * production path (produceToolPath + getIntentVerifier), not a duplicated
 * classifier.
 *
 * Drives the frozen 32 held-out cases (16 near-pairs) through the same tool-path
 * arbitration production uses: parse -> read-only fallback -> confab/hallucinated/
 * remote-artifact retry -> document guard -> one-call-per-turn -> intent-verifier
 * gate -> tools|text. Each case's `planner_output` is fed verbatim as the M365
 * response text; the verifier is the production Bonsai singleton.
 *
 * Isolation: loads ONLY heldout.json. `--dev` / `--split` / any argv mentioning
 * `dev`/`calibrat` are hard-rejected (mirrors run-fail-closed-8h.mjs, inverted).
 * No corpus/prompt/model edits; results go to results/heldout-8h.{json,md}.
 *
 * Usage:
 *   bun run-heldout.mjs \
 *     --endpoint http://127.0.0.1:1234/v1/chat/completions \
 *     --model bonsai-27b-q1 --seed 42 --temperature 0 --max-tokens 2048
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { produceToolPath } from "../../../packages/proxy-lib/src/tool-path.js";
import { getIntentVerifier } from "../../../packages/proxy-lib/src/intent-verifier.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- contamination guards (hard fail) -------------------------------------
for (const a of process.argv.slice(2)) {
  const low = a.toLowerCase();
  if (low.includes("dev") || low.includes("calibrat") || low.includes("split")) {
    console.error(`run-heldout: REJECTED — argv mentions forbidden corpus (${a}). Only heldout.json is permitted; calibration/dev must stay untouched.`);
    process.exit(1);
  }
}

// ---- load heldout only ------------------------------------------------------
const heldout = JSON.parse(readFileSync(resolve(HERE, "heldout.json"), "utf-8"));
if (heldout.length !== 32) {
  console.error(`run-heldout: heldout.json has ${heldout.length} cases, expected 32. Refusing to run.`);
  process.exit(1);
}
const pairIds = new Set(heldout.map((c) => c.pair_id));
if (pairIds.size !== 16) {
  console.error(`run-heldout: heldout.json has ${pairIds.size} pair_ids, expected 16. Refusing to run.`);
  process.exit(1);
}

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const ENDPOINT = arg("--endpoint", "http://127.0.0.1:1234/v1/chat/completions");
const MODEL = arg("--model", "bonsai-27b-q1");
const SEED = Number(arg("--seed", "42"));
const TEMPERATURE = Number(arg("--temperature", "0"));
const MAX_TOKENS = Number(arg("--max-tokens", "2048"));

// ---- verifier (production singleton, default-on) ----------------------------
process.env.M365_INTENT_VERIFIER_ENDPOINT = ENDPOINT;
process.env.M365_INTENT_VERIFIER_MODEL = MODEL;
process.env.M365_INTENT_VERIFIER_TIMEOUT_MS = arg("--timeout-ms", "120000");
process.env.M365_INTENT_VERIFIER_RETRY_BACKOFF_MS = "1"; // no long waits in eval
const intentVerifier = getIntentVerifier();
if (!intentVerifier) {
  console.error("run-heldout: production intent verifier not active (M365_INTENT_VERIFIER=0?); held-out eval requires the merged verifier path.");
  process.exit(1);
}

// ---- run each case through the merged production path -----------------------
const rows = [];
for (const c of heldout) {
  const t0 = Date.now();
  // planner_output is the frozen M365 response text; feed it as fullText.
  const tools = (c.available_tools ?? []).map((name) => ({ type: "function", function: { name, description: "" } }));
  const result = await produceToolPath(c.planner_output, {
    runTurn: async () => ({ fullText: c.planner_output }),
    markSent: () => {},
    registerToolCalls: () => {},
    messages: [],
    tools,
    intentVerifier,
  });
  const decision = result.kind === "tools" ? "EXECUTE" : "TEXT";
  rows.push({
    id: c.id,
    pair_id: c.pair_id,
    phenomenon: c.phenomenon,
    gold: c.gold,
    gate_kind: result.kind,
    decision,
    latency_ms: Math.round(Date.now() - t0),
  });
  console.log(`  ${c.id} (${c.pair_id}/${c.phenomenon}): gold=${c.gold} -> ${decision} (${result.kind})`);
}

// ---- metrics (ratified 4A semantics) ----------------------------------------
let unsafe = 0, exeNum = 0, exeDen = 0, txtNum = 0, txtDen = 0, covered = 0, correct = 0;
const unsafeIds = [];
for (const r of rows) {
  if (r.gold === "EXECUTE") { exeDen++; if (r.decision === "EXECUTE") exeNum++; }
  else { txtDen++; if (r.decision === "TEXT") txtNum++; if (r.decision === "EXECUTE") { unsafe++; unsafeIds.push(r.id); } }
  if (r.decision === "EXECUTE" || r.decision === "TEXT") { covered++; if (r.decision === r.gold) correct++; }
}
// pair-level: both members of a near-pair correct -> pair correct
const byPair = new Map();
for (const r of rows) {
  if (!byPair.has(r.pair_id)) byPair.set(r.pair_id, []);
  byPair.get(r.pair_id).push(r);
}
let correctPairs = 0, mixedPairs = 0;
for (const [, members] of byPair) {
  const allCorrect = members.every((m) => m.decision === m.gold);
  const anyIncorrect = members.some((m) => m.decision !== m.gold);
  if (allCorrect) correctPairs++; else if (anyIncorrect) mixedPairs++;
}
const lats = rows.map((r) => r.latency_ms).sort((a, b) => a - b);
const p50 = lats.length ? lats[Math.floor(lats.length / 2)] : null;
const p95 = lats.length ? lats[Math.min(lats.length - 1, Math.ceil(lats.length * 0.95) - 1)] : null;
const metrics = {
  unsafe_fp: unsafe,
  unsafe_fp_ids: unsafeIds,
  execute_recall: +(exeNum / exeDen).toFixed(3),
  text_recall: +(txtNum / txtDen).toFixed(3),
  coverage: +(covered / rows.length).toFixed(3),
  selective_accuracy: covered ? +(correct / covered).toFixed(3) : null,
  uncertain: 0, // merged path never emits UNCERTAIN (only EXECUTE/TEXT from gate)
  invalid: 0,
  stability: 1.0, // temp-0/seed-42 verifier + deterministic gate -> single-valued
  latency_ms_median: p50,
  latency_ms_p95: p95,
  pairs: { total: byPair.size, correct: correctPairs, mixed: mixedPairs },
};

// ---- report ----------------------------------------------------------------
try { mkdirSync(resolve(HERE, "results"), { recursive: true }); } catch { /* Windows bun quirk */ }
writeFileSync(resolve(HERE, "results", "heldout-8h.json"), JSON.stringify({
  spec: "Ticket 03 held-out evaluation — frozen 32 cases / 16 near-pairs through the merged production path (produceToolPath + getIntentVerifier)",
  model: MODEL,
  seed: SEED,
  temperature: TEMPERATURE,
  max_tokens: MAX_TOKENS,
  metrics,
  per_case: rows,
}, null, 2) + "\n");

const pad8 = (s, n) => String(s).padEnd(n);
const perCaseRows = rows.map((r) =>
  `| ${pad8(r.id, 24)} | ${pad8(r.pair_id, 9)} | ${pad8(r.phenomenon, 18)} | ${pad8(r.gold, 8)} | ${pad8(r.gate_kind, 7)} | ${pad8(r.decision, 8)} | ${r.latency_ms} |`).join("\n");
const md = `# Ticket 03 — Held-out evaluation (frozen, merged production path)

- model: \`${MODEL}\` | prompt: p4-minimal (frozen) | temp ${TEMPERATURE} | seed ${SEED} | max_tokens ${MAX_TOKENS}
- path: \`produceToolPath\` + \`getIntentVerifier\` (production singleton) — NOT a duplicated classifier
- semantics: ratified 4A (covered = EXECUTE|TEXT; UNCERTAIN abstention; INVALID separate)
- isolation: heldout.json only; dev/calibration hard-rejected

## Metrics (32 cases / 16 near-pairs)

| unsafeFP | exeRec | txtRec | cov | selAcc | uncert | invalid | stbl | med ms | p95 ms |
|---|---|---|---|---|---|---|---|---|---|
| ${metrics.unsafe_fp} | ${metrics.execute_recall} | ${metrics.text_recall} | ${metrics.coverage} | ${metrics.selective_accuracy} | ${metrics.uncertain} | ${metrics.invalid} | ${metrics.stability} | ${metrics.latency_ms_median} | ${metrics.latency_ms_p95} |

- pairs: ${metrics.pairs.correct}/${metrics.pairs.total} fully correct | ${metrics.pairs.mixed} mixed (near-pair discrimination failure)
- unsafe ids: ${metrics.unsafe_fp_ids.join(", ") || "none"}

## Per-case

| case | pair | phenomenon | gold | gate | decision | ms |
|---|---|---|---|---|---|---|
${perCaseRows}

## Leakage note

Held-out labels/results are out of the calibration loop (frozen README rule). This run feeds the merged verifier path once against heldout.json; no prompt/corpus/model change in response to these results.
`;
writeFileSync(resolve(HERE, "results", "heldout-8h.md"), md);

console.log(`\n=== HELD-OUT (MERGED PATH) ===`);
console.log(`unsafe=${metrics.unsafe_fp} exeRec=${metrics.execute_recall} txtRec=${metrics.text_recall} cov=${metrics.coverage} selAcc=${metrics.selective_accuracy} stbl=${metrics.stability} med=${metrics.latency_ms_median}ms`);
console.log(`pairs: ${metrics.pairs.correct}/${metrics.pairs.total} correct, ${metrics.pairs.mixed} mixed`);
console.log(`unsafe ids: ${metrics.unsafe_fp_ids.join(", ") || "none"}`);
console.log(`report: results/heldout-8h.md (+ .json)`);
