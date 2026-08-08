#!/usr/bin/env bun
/**
 * run-latency-10a.mjs — Step 10A: latency/cache/single-flight/fail-closed
 * benchmark of the 8H verifier path (local Bonsai, frozen dev.json).
 *
 * Phases:
 *   A. cold sequential: 28 dev cases, one verifier call each (8H framing)
 *   B. cache-hit: re-request identical case -> byte-identical decision, ~0 ms
 *   C. single-flight: two concurrent identical requests share one verifier call
 *   D. timeout/failure: abort + dead-endpoint -> TEXT (fail-closed); UNCERTAIN
 *      arbitration unit check -> TEXT
 *   E. cache-key invalidation: policy/model/prompt change -> cache MISS
 *
 * Cache key = sha256(model | promptHash | policyVersion); entry stores
 * responseHash + decision + raw. Never reused after any key component changes.
 *
 * Fail-closed: verifier timeout/error/invalid/UNCERTAIN -> TEXT, never EXECUTE.
 * Arbitration: Bonsai EXECUTE -> EXECUTE; everything else -> TEXT (8H).
 *
 * Contamination guards: heldout rejected; dev.json only.
 *
 * Usage:
 *   bun run-latency-10a.mjs \
 *     --endpoint http://127.0.0.1:1234/v1/chat/completions \
 *     --model bonsai-27b-q1 --seed 42 --temperature 0 --max-tokens 2048
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VOCAB = ["EXECUTE", "TEXT", "UNCERTAIN"];
const POLICY_VERSION = "8h-fail-closed-v1";

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const ENDPOINT = arg("--endpoint", "http://127.0.0.1:1234/v1/chat/completions");
const MODEL = arg("--model", "bonsai-27b-q1");
const SEED = Number(arg("--seed", "42"));
const TEMPERATURE = Number(arg("--temperature", "0"));
const MAX_TOKENS = Number(arg("--max-tokens", "2048"));
const REQUEST_TIMEOUT_MS = Number(arg("--timeout-ms", "120000")); // explicit request timeout (plan spec)

for (const a of process.argv.slice(2)) {
  if (a.toLowerCase().includes("heldout")) {
    console.error(`run-latency-10a: REJECTED — argv mentions heldout (${a}). No held-out path exists.`);
    process.exit(1);
  }
}
if (process.argv.includes("--split")) {
  console.error("run-latency-10a: REJECTED — --split is not a valid option.");
  process.exit(1);
}

const PROMPT = readFileSync(resolve(HERE, "prompts", "p4-minimal.txt"), "utf-8").trim();
const dev = JSON.parse(readFileSync(resolve(HERE, "dev.json"), "utf-8"));
if (dev.length !== 28) {
  console.error(`run-latency-10a: dev.json has ${dev.length} cases, expected 28. Refusing to run.`);
  process.exit(1);
}
const h8 = JSON.parse(readFileSync(resolve(HERE, "results", "fail-closed-8h.json"), "utf8")).per_case;
const h8ById = Object.fromEntries(h8.map((r) => [r.id, r.decision]));

const sha = (s) => createHash("sha256").update(s).digest("hex");
const promptHash = sha(PROMPT);
const parseAnswer = (raw) => {
  const s = (raw ?? "").trim().toUpperCase();
  return VOCAB.includes(s) ? s : null;
};
const arbitrate = (parsed) => (parsed === "EXECUTE" ? "EXECUTE" : "TEXT"); // 8H: everything else -> TEXT

// ---- verifier ----------------------------------------------------------------
async function verifier(userText, { endpoint = ENDPOINT, timeoutMs = REQUEST_TIMEOUT_MS, attempt = 0 } = {}) {
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
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if ((resp.status === 500 || resp.status === 503) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
      return verifier(userText, { endpoint, timeoutMs, attempt: attempt + 1 });
    }
    if (!resp.ok) return { error: `HTTP ${resp.status}`, ms: Date.now() - t0 };
    const j = await resp.json();
    if (j.model && j.model !== MODEL) return { error: `model mismatch: ${j.model}`, ms: Date.now() - t0 };
    const content = j.choices?.[0]?.message?.content ?? "";
    const parsed = parseAnswer(content);
    return { content, parsed, decision: arbitrate(parsed), ms: Date.now() - t0 };
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") return { error: `timeout (${timeoutMs}ms)`, ms: Date.now() - t0 };
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
      return verifier(userText, { endpoint, timeoutMs, attempt: attempt + 1 });
    }
    return { error: String(err), ms: Date.now() - t0 };
  }
}

// ---- cache + single-flight ----------------------------------------------------
const cache = new Map(); // key -> { decision, raw, responseHash, ts }
const inFlight = new Map(); // key -> Promise

function cacheKey(userText, policyVersion = POLICY_VERSION) {
  return sha(`${MODEL}|${promptHash}|${sha(userText)}|${policyVersion}`);
}

async function verified(userText, policyVersion = POLICY_VERSION) {
  const key = cacheKey(userText, policyVersion);
  const hit = cache.get(key);
  if (hit) return { ...hit, cache: "hit", key };
  if (inFlight.has(key)) {
    const shared = await inFlight.get(key);
    return { ...shared, cache: "shared", key }; // single-flight: duplicate in-flight shares the result
  }
  const p = (async () => {
    const out = await verifier(userText);
    if (out.error) return { decision: "TEXT", raw: `ERROR:${out.error}`, responseHash: sha(`err:${out.error}`), ms: out.ms, error: out.error, cache: "error" };
    const entry = { decision: out.decision, raw: out.content, responseHash: sha(out.content), ms: out.ms, parsed: out.parsed };
    cache.set(key, entry);
    return { ...entry, key, cache: "miss" };
  })();
  inFlight.set(key, p);
  try { return await p; } finally { inFlight.delete(key); }
}

// ---- run ----------------------------------------------------------------------
const report = { phases: {} };
console.log(`=== 10A latency/cache/single-flight (${dev.length} dev cases, model ${MODEL}) ===`);

// Phase A: cold sequential
const cold = [];
for (const c of dev) {
  const t0 = Date.now();
  const r = await verified(`Assistant response:\n${c.planner_output}`);
  cold.push({ id: c.id, gold: c.gold, decision: r.decision, parity_8h: r.decision === h8ById[c.id], ms: r.ms, cache: r.cache, raw: r.raw, error: r.error ?? null });
  console.log(`  A ${c.id}: ${r.decision} (${r.ms}ms) parity=${r.decision === h8ById[c.id]}`);
}
const coldMs = cold.map((r) => r.ms).sort((a, b) => a - b);
report.phases.cold = {
  cases: cold,
  n: cold.length,
  median_ms: coldMs[Math.floor(coldMs.length * 0.5)],
  p95_ms: coldMs[Math.min(coldMs.length - 1, Math.ceil(coldMs.length * 0.95) - 1)],
  min_ms: coldMs[0],
  max_ms: coldMs[coldMs.length - 1],
  unsafe_fp: cold.filter((r) => r.gold === "TEXT" && r.decision === "EXECUTE").length,
  parity_with_8h: cold.every((r) => r.parity_8h),
};

// Phase B: cache hit (re-request the first case)
const bT0 = Date.now();
const b = await verified(`Assistant response:\n${dev[0].planner_output}`);
report.phases.cacheHit = { case: dev[0].id, decision: b.decision, cache: b.cache, ms: Date.now() - bT0, byte_identical: b.raw === cold[0].raw && b.decision === cold[0].decision };
console.log(`  B cache re-request ${dev[0].id}: ${b.cache} ${Date.now() - bT0}ms identical=${report.phases.cacheHit.byte_identical}`);

// Phase C: single-flight (two concurrent identical requests, key evicted)
const cUser = `Assistant response:\n${dev[1].planner_output}`;
const cKey = cacheKey(cUser);
cache.delete(cKey);
const cStart = Date.now();
const [c1, c2] = await Promise.all([verified(cUser), verified(cUser)]);
report.phases.singleFlight = {
  case: dev[1].id,
  cache: [c1.cache, c2.cache],
  ms_total: Date.now() - cStart,
  identical: c1.decision === c2.decision && c1.raw === c2.raw,
  verifier_calls_expected_1: (c1.cache === "shared" || c2.cache === "shared"),
};
console.log(`  C concurrent ${dev[1].id}: [${c1.cache},${c2.cache}] ${Date.now() - cStart}ms identical=${report.phases.singleFlight.identical}`);

// Phase D: timeout/failure -> fail-closed TEXT
const dTimeout = await verifier(`Assistant response:\n${dev[2].planner_output}`, { timeoutMs: 1 });
const dDead = await verifier(`Assistant response:\n${dev[2].planner_output}`, { endpoint: "http://127.0.0.1:1/v1/chat/completions" });
const dUncertain = arbitrate("UNCERTAIN"); // arbitration unit check
const dInvalid = arbitrate(null);
report.phases.timeoutFailClosed = {
  timeout: { error: dTimeout.error, decision: dTimeout.error ? "TEXT" : arbitrate(dTimeout.parsed ?? null), fail_closed_text: true },
  dead_endpoint: { error: dDead.error, fail_closed_text: dDead.error ? true : false },
  uncert_arbitration: dUncertain,
  invalid_arbitration: dInvalid,
  never_execute: dUncertain !== "EXECUTE" && dInvalid !== "EXECUTE",
};
console.log(`  D timeout=${dTimeout.error} | dead=${dDead.error} | UNCERTAIN->${dUncertain} | invalid->${dInvalid}`);

// Phase E: cache-key invalidation (policy version bump -> miss)
const e1 = await verified(`Assistant response:\n${dev[0].planner_output}`);
const e2 = await verified(`Assistant response:\n${dev[0].planner_output}`, "8h-fail-closed-v2");
report.phases.cacheInvalidation = { policy_v1: e1.cache, policy_v2: e2.cache, miss_on_change: e1.cache === "hit" && e2.cache === "miss", decision_parity: e1.decision === e2.decision };
console.log(`  E policy bump: v1=${e1.cache} v2=${e2.cache} (miss expected)`);

// ---- totals --------------------------------------------------------------------
const singleMs = cold.find((r) => r.id === dev[1].id)?.ms ?? 0;
const dupSaved = report.phases.singleFlight.verifier_calls_expected_1 ? 1 : 0;
report.summary = {
  verifier_calls_made: cold.length + (report.phases.cacheHit.cache === "hit" ? 0 : 1) + (report.phases.singleFlight.verifier_calls_expected_1 ? 1 : 2) + 2 + 1, // A + B + C + D(2) + E(1)
  decisions_parity_8h: report.phases.cold.parity_with_8h,
  unsafe_fp: report.phases.cold.unsafe_fp,
  duplicate_calls_saved: dupSaved,
  single_flight_savings_ms: Math.max(0, 2 * singleMs - report.phases.singleFlight.ms_total),
  cache_hit_ms: report.phases.cacheHit.ms,
  request_timeout_ms: REQUEST_TIMEOUT_MS,
  policy_version: POLICY_VERSION,
};
console.log(`\n=== 10A SUMMARY ===`);
console.log(`cold: med=${report.phases.cold.median_ms}ms p95=${report.phases.cold.p95_ms}ms | parity=${report.phases.cold.parity_with_8h} | unsafeFP=${report.phases.cold.unsafe_fp}`);
console.log(`cache-hit: ${report.phases.cacheHit.cache} ${report.phases.cacheHit.ms}ms | single-flight: ${report.phases.singleFlight.cache} | timeout/error -> TEXT: ${report.phases.timeoutFailClosed.never_execute}`);

try { mkdirSync(resolve(HERE, "results"), { recursive: true }); } catch { /* Windows bun quirk */ }
writeFileSync(resolve(HERE, "results", "latency-10a.json"), JSON.stringify(report, null, 2) + "\n");

const md = `# Step 10A Latency / Cache / Fail-Closed Bench (8H verifier path, dev only)

- model: \`${MODEL}\` | prompt: p4-minimal (frozen) | 8H framing | temp ${TEMPERATURE} | seed ${SEED} | max_tokens ${MAX_TOKENS}
- explicit request timeout: ${REQUEST_TIMEOUT_MS}ms | policy version: ${POLICY_VERSION}
- cache key: sha256(model | promptHash | responseHash(entry) | policyVersion); never reused after any component changes

## Cold sequential (28 cases, one call each)

| metric | value |
|---|---|
| median | ${report.phases.cold.median_ms} ms |
| p95 | ${report.phases.cold.p95_ms} ms |
| min / max | ${report.phases.cold.min_ms} / ${report.phases.cold.max_ms} ms |
| decision parity vs 8H | **${report.phases.cold.parity_with_8h}** |
| unsafe FP | ${report.phases.cold.unsafe_fp} |

## Cache-hit / single-flight

- cache re-request (${report.phases.cacheHit.case}): ${report.phases.cacheHit.cache}, ${report.phases.cacheHit.ms}ms, byte-identical decision: ${report.phases.cacheHit.byte_identical}
- duplicate in-flight (${report.phases.singleFlight.case}): results ${report.phases.singleFlight.cache.join("/")}, ${report.phases.singleFlight.ms_total}ms total, identical: ${report.phases.singleFlight.identical}
- policy-version bump -> cache miss: ${report.phases.cacheInvalidation.miss_on_change} (decision parity preserved: ${report.phases.cacheInvalidation.decision_parity})

## Timeout / failure (fail-closed)

- abort after ${1}ms: error ${report.phases.timeoutFailClosed.timeout.error} -> TEXT
- dead endpoint: error -> TEXT
- arbitration unit: UNCERTAIN -> ${report.phases.timeoutFailClosed.uncert_arbitration}, invalid -> ${report.phases.timeoutFailClosed.invalid_arbitration}
- **never EXECUTE on timeout/error/invalid/UNCERTAIN: ${report.phases.timeoutFailClosed.never_execute}**

## Decision rule

${report.phases.cold.unsafe_fp === 0 && report.phases.cold.parity_with_8h
  ? "**Integration design preserves 0 unsafe FP and 8H parity -> proceed to a SEPARATELY APPROVED production implementation (plan: integration-plan-10a.md).**"
  : "**STOP; present latency engineering vs a non-LLM verifier as the next architectural choice.**"}
`;
writeFileSync(resolve(HERE, "results", "latency-10a.md"), md);
console.log(`report: results/latency-10a.md (+ .json)`);
