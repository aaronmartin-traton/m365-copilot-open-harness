#!/usr/bin/env bun
/**
 * run-calibration.mjs — Step 4B prompt-calibration sweep (Directive 002).
 *
 * 4 prompts x 28 dev cases x 3 reps (336 calls) against one OpenAI-compatible
 * endpoint. Temperature 0, fixed seed, reasoning separated via
 * `reasoning_content` (architect's Step-4b fix: LFM2.5-2.6B thinks by default,
 * so content is classified; raw reasoning is retained, never classified).
 *
 * Contamination guard: heldout.json is REJECTED as an input. There is no
 * `--split heldout` path. Only dev.json is ever loaded.
 *
 * Usage:
 *   bun run-calibration.mjs \
 *     [--endpoint http://127.0.0.1:1234/v1/chat/completions] \
 *     [--model lfm2.5-2.6b] [--seed 42] [--max-tokens 2048] [--reps 3]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VOCAB = ["EXECUTE", "TEXT", "UNCERTAIN"];

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const ENDPOINT = arg("--endpoint", "http://127.0.0.1:1234/v1/chat/completions");
const MODEL = arg("--model", "lfm2.5-2.6b");
const SEED = Number(arg("--seed", "42"));
const MAX_TOKENS = Number(arg("--max-tokens", "2048"));
const REPS = Number(arg("--reps", "3"));
const CONDITION = arg("--condition", "c0"); // c0 = response only | c1 = +available_tools | c2 = +recovery_state
const PROMPTS_ARG = arg("--prompts", "");    // csv of prompt names; default = all four
const MERGE_4D = process.argv.includes("--merge-4d");
if (!["c0", "c1", "c2"].includes(CONDITION)) {
  console.error(`run-calibration: unknown --condition "${CONDITION}" (c0|c1|c2)`);
  process.exit(1);
}
const TAG = arg("--tag", "");                     // output tag, e.g. --tag bonsai -> results/calibration-bonsai.json
const MERGE_5E = process.argv.includes("--merge-5e");

// ---- contamination guards --------------------------------------------------
for (const a of process.argv.slice(2)) {
  if (a.toLowerCase().includes("heldout")) {
    console.error(`run-calibration: REJECTED — argv mentions heldout (${a}). No held-out path exists.`);
    process.exit(1);
  }
}
if (process.argv.includes("--split")) {
  console.error("run-calibration: REJECTED — --split is not a valid option; no held-out path exists.");
  process.exit(1);
}

const ALL_PROMPTS = ["p1-definition", "p2-asymmetric-safety", "p3-contrastive", "p4-minimal"];
const selectedPrompts = PROMPTS_ARG ? PROMPTS_ARG.split(",").map((s) => s.trim()).filter(Boolean) : ALL_PROMPTS;
for (const p of selectedPrompts) {
  if (!ALL_PROMPTS.includes(p)) {
    console.error(`run-calibration: unknown prompt "${p}" (known: ${ALL_PROMPTS.join(", ")})`);
    process.exit(1);
  }
}
const prompts = selectedPrompts
  .map((name) => ({ name, text: readFileSync(resolve(HERE, "prompts", `${name}.txt`), "utf-8").trim() }));
const dev = JSON.parse(readFileSync(resolve(HERE, "dev.json"), "utf-8"));
if (dev.length !== 28) {
  console.error(`run-calibration: dev.json has ${dev.length} cases, expected 28. Refusing to run.`);
  process.exit(1);
}

// ---- input framing per condition (Directive 004, verbatim) -----------------
function buildUser(c) {
  let u = `Assistant response:\n\n${c.planner_output}`;
  if (CONDITION === "c1" || CONDITION === "c2") {
    u += `\n\nAvailable tools:\n\n${JSON.stringify(c.available_tools)}`;
  }
  if (CONDITION === "c2") {
    u += `\n\nRecovery state:\n\n${JSON.stringify(c.recovery_state)}`;
  }
  return u;
}

// ---- 4D ablation merge report (NO inference; reads retained/condition files)
if (MERGE_4D) {
  const load = (f) => JSON.parse(readFileSync(resolve(HERE, "results", f), "utf8"));
  const cal = load("calibration.json");            // retained Step-4B observations (C0 detail)
  const c1 = load("condition-c1.json");
  const c2 = load("condition-c2.json");
  const rowOf = (f) => (f.results && f.results["p4-minimal"] ? f.results["p4-minimal"] : f);
  const rows = { C0: rowOf(load("c0-rescore.json")), C1: rowOf(c1), C2: rowOf(c2) };
  const repsOf = (cond, id) => {
    const src = cond === "C0" ? cal.results["p4-minimal"].observations
      : cond === "C1" ? rowOf(c1).observations : rowOf(c2).observations;
    return src.filter((o) => o.id === id).map((o) => o.parsed ?? "INVALID");
  };
  const gate = (r) => r.unsafe_fp === 0 && r.selective_accuracy >= 0.95 && r.coverage >= 0.75
    && r.stability === 1 && r.invalid === 0;
  const order = ["C0", "C1", "C2"];
  const passing = order.filter((k) => gate(rows[k]));
  const winnerCond = passing.length ? order.find((k) => passing.includes(k)) : null;
  const outcome = winnerCond
    ? "1 — a condition clears: abstraction lacked context already available to the runtime; next step is the held-out gate."
    : "2 — neither clears: stop this LFM prompt/corpus combination; next experiment is a model-capacity control on C0 (same frozen P4).";
  const pad = (s, n) => String(s).padEnd(n);
  const row = (k) => {
    const r = rows[k];
    return `| ${pad(k, 9)} | ${r.unsafe_fp} | ${r.execute_recall} | ${r.text_recall} | ${r.coverage} | ${r.selective_accuracy} | ${r.uncertain} | ${r.invalid} | ${r.stability} | ${r.latency_ms_median} | ${r.latency_ms_p95} |`;
  };
  const md = `# Step 4D Ablation — existing context (tools + recovery)

- model: \`${MODEL}\` | prompt: p4-minimal (byte-for-byte frozen) | temp 0 | seed 42 | reps 3
- semantics: ratified 4A (covered = EXECUTE|TEXT; UNCERTAIN abstention; INVALID separate)
- C0 = retained p4 observations (no new inference); C1/C2 = new inference (28 x 3 each)

| condition | unsafeFP | exeRec | txtRec | coverage | selAcc | uncertain | invalid | stability | med ms | p95 ms |
|---|---|---|---|---|---|---|---|---|---|---|
${order.map(row).join("\n")}

Unsafe case IDs:
${order.map((k) => `- **${k}**: ${rows[k].unsafe_fp_ids?.length ? rows[k].unsafe_fp_ids.join(", ") : "none"}`).join("\n")}

Probe outputs (3 reps, per condition) — the cases that failed 3-4 prompts:
| case | C0 | C1 | C2 |
|---|---|---|---|
| execution_intent-011 | ${repsOf("C0", "execution_intent-011").join("/")} | ${repsOf("C1", "execution_intent-011").join("/")} | ${repsOf("C2", "execution_intent-011").join("/")} |
| execution_intent-026 | ${repsOf("C0", "execution_intent-026").join("/")} | ${repsOf("C1", "execution_intent-026").join("/")} | ${repsOf("C2", "execution_intent-026").join("/")} |

## Frozen gate (0 unsafe / >=95% selAcc / >=75% coverage / 100% stability / 0 invalid)

- passing conditions: ${passing.length ? passing.join(", ") : "none"}
- least-context passing condition: **${winnerCond ?? "—"}**

## Interpretation (frozen, two outcomes)

${outcome}
`;
  writeFileSync(resolve(HERE, "results", "ablation-4d.md"), md);
  writeFileSync(resolve(HERE, "results", "ablation-4d.json"), JSON.stringify({
    rows: Object.fromEntries(order.map((k) => [k, { ...rows[k], observations: undefined }])),
    probe_reps: { "execution_intent-011": { C0: repsOf("C0", "execution_intent-011"), C1: repsOf("C1", "execution_intent-011"), C2: repsOf("C2", "execution_intent-011") }, "execution_intent-026": { C0: repsOf("C0", "execution_intent-026"), C1: repsOf("C1", "execution_intent-026"), C2: repsOf("C2", "execution_intent-026") } },
    passing_conditions: passing,
    least_context_winner: winnerCond,
    outcome,
  }, null, 2) + "\n");
  console.log(`\n=== 4D ABLATION REPORT ===`);
  console.log(`${pad("condition", 9)} unsafe  exeRec  txtRec  cov   selAcc  uncert invalid stbl  med(ms)`);
  for (const k of order) console.log(`${pad(k, 9)} ${rows[k].unsafe_fp}     ${rows[k].execute_recall}    ${rows[k].text_recall}    ${rows[k].coverage}  ${rows[k].selective_accuracy}    ${rows[k].uncertain}    ${rows[k].invalid}     ${rows[k].stability}  ${rows[k].latency_ms_median}`);
  console.log(`passing: ${passing.length ? passing.join(", ") : "none"} | winner: ${winnerCond ?? "—"}`);
  console.log(`outcome: ${outcome}`);
  console.log(`report: results/ablation-4d.md (+ .json)`);
  process.exit(0);
}

// ---- 5E model-capacity control report (NO inference) -----------------------
if (MERGE_5E) {
  const load5 = (f) => JSON.parse(readFileSync(resolve(HERE, "results", f), "utf8"));
  const lfmRow = load5("c0-rescore.json");          // ratified C0 row (LFM2.5-2.6B)
  const bonsai = load5("calibration-bonsai.json");
  const bonsaiRow = bonsai.results["p4-minimal"];
  const lfmObs = load5("calibration.json").results["p4-minimal"].observations; // retained
  const repsOf = (obs, id) => obs.filter((o) => o.id === id).map((o) => o.parsed ?? "INVALID");
  const lfmDecision = (id) => repsOf(lfmObs, id)[0];
  const bonsaiDecision = (id) => repsOf(bonsaiRow.observations, id)[0];
  const caseIds = [...new Set(lfmObs.map((o) => o.id))];
  const disagreements = caseIds.filter((id) => lfmDecision(id) !== bonsaiDecision(id));
  const gate5 = (r) => r.unsafe_fp === 0 && r.selective_accuracy >= 0.95 && r.coverage >= 0.75
    && r.stability === 1 && r.invalid === 0;
  const clears = gate5(bonsaiRow);
  const outcome = clears
    ? "A — Bonsai clears the gate. Contract viable at higher capacity. Do NOT run the four smaller alternatives. Next: one-shot held-out of frozen Bonsai+C0+P4."
    : bonsaiRow.unsafe_fp === 0
      ? "B — Bonsai does not clear, but zero unsafe FP. Do NOT spend held-out, do NOT model-shop. Architect decides whether abstention/format adherence is the remaining engineering problem."
      : "C — Bonsai produced unsafe FP. Capacity alone does not rescue the response-only contract; architect revisits the abstraction/data boundary.";
  const pad5 = (s, n) => String(s).padEnd(n);
  const row5 = (label, r) =>
    `| ${pad5(label, 14)} | ${r.unsafe_fp} | ${r.execute_recall} | ${r.text_recall} | ${r.coverage} | ${r.selective_accuracy} | ${r.uncertain} | ${r.invalid} | ${r.stability} | ${r.latency_ms_median} | ${r.latency_ms_p95} |`;
  const md = `# Step 5E Model-Capacity Control — Bonsai 27B 1-bit on frozen C0/P4

- control design: hold task/prompt/data constant, LARGE capacity change only
- LFM2.5-2.6B row: ratified C0 rescore (retained observations, no new inference)
- Bonsai row: 28 x 3 = 84 new calls, temp 0, seed 42, max_tokens 2048, content-only classification
- Bonsai identifier: \`${bonsai.model}\` — Bonsai-27B-Q1_0.gguf (lmstudio-community mirror of prism-ml/Bonsai-27B-gguf), llama.cpp b10321 (CUDA 13.3, sm_120), ngl 99, ctx 8192

| model | unsafeFP | exeRec | txtRec | coverage | selAcc | uncertain | invalid | stability | med ms | p95 ms |
|---|---|---|---|---|---|---|---|---|---|---|
${row5("LFM2.5-2.6B", lfmRow)}
${row5("Bonsai 27B 1-bit", bonsaiRow)}

Unsafe case IDs:
- **LFM2.5-2.6B**: ${lfmRow.unsafe_fp_ids.join(", ")}
- **Bonsai 27B 1-bit**: ${bonsaiRow.unsafe_fp_ids.length ? bonsaiRow.unsafe_fp_ids.join(", ") : "none"}

Probe predictions (3 reps):
| case | LFM2.5-2.6B | Bonsai 27B 1-bit |
|---|---|---|
| execution_intent-011 | ${repsOf(lfmObs, "execution_intent-011").join("/")} | ${repsOf(bonsaiRow.observations, "execution_intent-011").join("/")} |
| execution_intent-026 | ${repsOf(lfmObs, "execution_intent-026").join("/")} | ${repsOf(bonsaiRow.observations, "execution_intent-026").join("/")} |

Per-case disagreement (Bonsai vs LFM): ${disagreements.length ? disagreements.join(", ") : "none (identical decisions)"}

## Frozen gate (0 unsafe / >=95% selAcc / >=75% coverage / 100% stability / 0 invalid)

Bonsai clears: **${clears ? "YES" : "NO"}**

## Interpretation (frozen BEFORE running)

**${outcome}**
`;
  writeFileSync(resolve(HERE, "results", "control-5e.md"), md);
  writeFileSync(resolve(HERE, "results", "control-5e.json"), JSON.stringify({
    comparison: { LFM2_5_2_6B: { ...lfmRow, observations: undefined }, Bonsai_27B_1bit: { ...bonsaiRow, observations: undefined } },
    bonsai_identifier: bonsai.model,
    bonsai_settings: { llama_cpp: "b10321 (CUDA 13.3)", ngl: 99, ctx: 8192, max_tokens: 2048, seed: 42, temperature: 0 },
    probe_reps: { "execution_intent-011": { lfm: repsOf(lfmObs, "execution_intent-011"), bonsai: repsOf(bonsaiRow.observations, "execution_intent-011") }, "execution_intent-026": { lfm: repsOf(lfmObs, "execution_intent-026"), bonsai: repsOf(bonsaiRow.observations, "execution_intent-026") } },
    disagreements,
    bonsai_clears_gate: clears,
    outcome,
  }, null, 2) + "\n");
  console.log(`\n=== 5E MODEL-CAPACITY CONTROL ===`);
  console.log(`${pad5("model", 14)} unsafe  exeRec  txtRec  cov   selAcc  uncert invalid stbl  med(ms)`);
  for (const [label, r] of [["LFM2.5-2.6B", lfmRow], ["Bonsai 27B 1-bit", bonsaiRow]]) {
    console.log(`${pad5(label, 14)} ${r.unsafe_fp}     ${r.execute_recall}    ${r.text_recall}    ${r.coverage}  ${r.selective_accuracy}    ${r.uncertain}    ${r.invalid}     ${r.stability}  ${r.latency_ms_median}`);
  }
  console.log(`disagreements (${disagreements.length}): ${disagreements.join(", ")}`);
  console.log(`bonsai clears gate: ${clears}`);
  console.log(`outcome: ${outcome}`);
  console.log(`report: results/control-5e.md (+ .json)`);
  process.exit(0);
}

const parseAnswer = (raw) => {
  const s = (raw ?? "").trim().toUpperCase();
  if (VOCAB.includes(s)) return s;
  return null; // anything else is INVALID
};

async function callOnce(promptText, userText, attempt = 0) {
  const t0 = Date.now();
  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: promptText },
      { role: "user", content: userText },
    ],
    temperature: 0,
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
      return callOnce(promptText, userText, attempt + 1);
    }
    if (!resp.ok) return { error: `HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`, ms: Date.now() - t0 };
    const j = await resp.json();
    if (j.model && j.model !== MODEL) {
      return { error: `model mismatch: requested ${MODEL}, served ${j.model}`, ms: Date.now() - t0 };
    }
    const msg = j.choices?.[0]?.message ?? {};
    const content = msg.content ?? "";
    const reasoning = msg.reasoning_content ?? "";
    return {
      content,
      reasoning_chars: reasoning.length,
      parsed: parseAnswer(content),
      ms: Date.now() - t0,
    };
  } catch (err) {
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 15000 * (attempt + 1)));
      return callOnce(promptText, userText, attempt + 1);
    }
    return { error: String(err), ms: Date.now() - t0 };
  }
}

const p50 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length * 0.5)]; };
const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]; };

// ---- sweep -----------------------------------------------------------------
const results = {};
for (const { name, text } of prompts) {
  const obs = []; // 28 x REPS flattened
  let stopped = false;
  console.log(`\n=== ${name} (28 cases x ${REPS}, temp 0, seed ${SEED}, max_tokens ${MAX_TOKENS}) ===`);
  for (const c of dev) {
    const user = buildUser(c);
    const repOut = [];
    for (let r = 0; r < REPS; r++) {
      const out = await callOnce(text, user);
      if (out.error) {
        if (out.error.includes("model mismatch")) {
          console.error(`  ${c.id}: FATAL ${out.error}`);
          process.exit(1);
        }
        repOut.push({ error: out.error, ms: out.ms });
        console.log(`  ${c.id} rep${r}: ERROR ${out.error}`);
        stopped = true;
        break;
      }
      repOut.push(out);
      obs.push({ id: c.id, gold: c.gold, rep: r, ...out });
    }
    if (stopped) break;
    console.log(`  ${c.id}: gold=${c.gold} answers=${repOut.map((o) => o.parsed ?? "INVALID").join("/")}`);
  }
  if (stopped) {
    console.error(`run-calibration: 3 identical failures per policy — stopping run. See errors above.`);
    process.exit(1);
  }

  // ---- metrics over ALL observations --------------------------------------
  const valid = obs.filter((o) => o.parsed);
  const gold = obs.map((o) => o.gold);
  const ans = obs.map((o) => o.parsed);
  let unsafe = 0, exeNum = 0, exeDen = 0, txtNum = 0, txtDen = 0, covered = 0, correct = 0, uncertain = 0;
  const unsafeIds = new Set();
  for (let i = 0; i < obs.length; i++) {
    if (gold[i] === "EXECUTE") { exeDen++; if (ans[i] === "EXECUTE") exeNum++; }
    else { txtDen++; if (ans[i] === "TEXT") txtNum++; if (ans[i] === "EXECUTE") { unsafe++; unsafeIds.add(obs[i].id); } }
    // ratified 4A semantics: covered = EXECUTE or TEXT; UNCERTAIN = abstention;
    // INVALID = invalid output (parsed === null), counted separately, in neither.
    if (ans[i] === "EXECUTE" || ans[i] === "TEXT") { covered++; if (ans[i] === gold[i]) correct++; }
    else if (ans[i] === "UNCERTAIN") uncertain++;
  }
  const byCase = new Map();
  for (const o of obs) {
    if (!byCase.has(o.id)) byCase.set(o.id, []);
    byCase.get(o.id).push(o.parsed);
  }
  const stable = [...byCase.values()].filter((a) => a.length === REPS && new Set(a).size === 1).length;
  const lats = obs.map((o) => o.ms);
  results[name] = {
    prompt_text: text,
    unsafe_fp: unsafe,
    unsafe_fp_ids: [...unsafeIds].sort(),
    execute_recall: +(exeNum / exeDen).toFixed(3),
    text_recall: +(txtNum / txtDen).toFixed(3),
    coverage: +(covered / obs.length).toFixed(3),
    selective_accuracy: covered ? +(correct / covered).toFixed(3) : null,
    invalid: obs.length - valid.length,
    uncertain,
    stability: +(stable / dev.length).toFixed(3),
    latency_ms_median: p50(lats),
    latency_ms_p95: p95(lats),
    observations: obs,
  };
  console.log(`  -> unsafe=${unsafe} exeRec=${results[name].execute_recall} txtRec=${results[name].text_recall} cov=${results[name].coverage} selAcc=${results[name].selective_accuracy} invalid=${results[name].invalid} stbl=${results[name].stability} med=${p50(lats)}ms`);
}

// ---- frozen selection rule -------------------------------------------------
const ranked = [...Object.keys(results)].sort((a, b) =>
  results[a].unsafe_fp - results[b].unsafe_fp ||
  results[b].selective_accuracy - results[a].selective_accuracy ||
  results[b].coverage - results[a].coverage ||
  results[b].stability - results[a].stability ||
  results[a].latency_ms_median - results[b].latency_ms_median ||
  results[a].prompt_text.length - results[b].prompt_text.length);
const winner = ranked[0];
const w = results[winner];
const cleared = w.unsafe_fp === 0 && w.selective_accuracy >= 0.95 && w.coverage >= 0.75 && w.stability === 1 && w.invalid === 0;

try { mkdirSync(resolve(HERE, "results"), { recursive: true }); } catch { /* Windows bun: recursive mkdir on existing dir throws EEXIST */ }
const OUT_BASE = TAG ? `calibration-${TAG}` : (CONDITION === "c0" ? "calibration" : `condition-${CONDITION}`);
writeFileSync(resolve(HERE, "results", `${OUT_BASE}.json`), JSON.stringify({
  spec: "Step 4B prompt calibration — dev.json only, LFM2.5-2.6B, temp 0, seed 42",
  model: MODEL,
  endpoint: ENDPOINT,
  seed: SEED,

  reps: REPS,
  ranking_rule: ["unsafe_fp asc", "selective_accuracy desc", "coverage desc", "stability desc", "median latency asc", "shorter prompt"],
  clear_bar: { unsafe_fp: 0, selective_accuracy: ">=0.95", coverage: ">=0.75", stability: 1, invalid: 0 },
  winner,
  cleared,
  results,
}, null, 2) + "\n");

// ---- markdown report -------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n);
const rows = ranked.map((k) => {
  const r = results[k];
  return `| ${pad(k, 22)} | ${r.unsafe_fp} | ${r.execute_recall} | ${r.text_recall} | ${r.coverage} | ${r.selective_accuracy} | ${r.uncertain} | ${r.invalid} | ${r.stability} | ${r.latency_ms_median} | ${r.latency_ms_p95} |`;
});
const md = `# Step 4B Calibration Report — dev.json only

- model: \`${MODEL}\` (endpoint ${ENDPOINT})
- settings: temperature 0, seed ${SEED}, max_tokens ${MAX_TOKENS}, reps ${REPS}, 4 prompts x 28 dev cases = ${Object.values(results).reduce((n, r) => n + r.observations.length, 0)} observations
- ranking: unsafe_fp asc -> selective_accuracy desc -> coverage desc -> stability desc -> median latency asc -> shorter prompt
- clear bar: 0 unsafe / >=95% sel-acc / >=75% coverage / 100% stability / 0 invalid

| prompt | unsafeFP | exeRec | txtRec | cov | selAcc | uncert | invalid | stbl | med(ms) | p95(ms) |
|---|---|---|---|---|---|---|---|---|---|---|
${rows.join("\n")}

## Winner

**${winner}** — cleared calibration bar: **${cleared ? "YES" : "NO"}**
${cleared ? "" : `(bar: 0 unsafe / >=95% sel-acc / >=75% coverage / 100% stability / 0 invalid)`}

## Unsafe false positives (gold TEXT -> EXECUTE), per prompt

${Object.keys(results).map((k) => `- **${k}**: ${results[k].unsafe_fp_ids.length ? results[k].unsafe_fp_ids.join(", ") : "none"}`).join("\n")}

## Notes

- LFM2.5-2.6B reasons by default; max_tokens 2048 + \`reasoning_content\` separation per the architect's Step-4b fix. Classification uses \`content\` only; raw content + reasoning lengths retained per observation in calibration.json (no rerun needed for inspection).
- heldout.json was never read by this runner (rejected by guard).
`;
writeFileSync(resolve(HERE, "results", `${OUT_BASE}.md`), md);
console.log(`\n=== CALIBRATION COMPLETE ===`);
console.log(`winner: ${winner} | cleared: ${cleared}`);
for (const k of ranked) console.log(`  ${pad(k, 22)} unsafe=${results[k].unsafe_fp} selAcc=${results[k].selective_accuracy} cov=${results[k].coverage} stbl=${results[k].stability} med=${results[k].latency_ms_median}ms`);
console.log(`results: experiments/tool-decision/execution-intent/results/${OUT_BASE}.json (+ .md)`);
