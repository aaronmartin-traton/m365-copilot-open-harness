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

const prompts = ["p1-definition", "p2-asymmetric-safety", "p3-contrastive", "p4-minimal"]
  .map((name) => ({ name, text: readFileSync(resolve(HERE, "prompts", `${name}.txt`), "utf-8").trim() }));
const dev = JSON.parse(readFileSync(resolve(HERE, "dev.json"), "utf-8"));
if (dev.length !== 28) {
  console.error(`run-calibration: dev.json has ${dev.length} cases, expected 28. Refusing to run.`);
  process.exit(1);
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
    const user = `Assistant response:\n\n${c.planner_output}`;
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
  let unsafe = 0, exeNum = 0, exeDen = 0, txtNum = 0, txtDen = 0, covered = 0, correct = 0;
  const unsafeIds = new Set();
  for (let i = 0; i < obs.length; i++) {
    if (gold[i] === "EXECUTE") { exeDen++; if (ans[i] === "EXECUTE") exeNum++; }
    else { txtDen++; if (ans[i] === "TEXT") txtNum++; if (ans[i] === "EXECUTE") { unsafe++; unsafeIds.add(obs[i].id); } }
    if (ans[i] !== null) { covered++; if (ans[i] === gold[i]) correct++; }
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
    selective_accuracy: +(correct / covered).toFixed(3),
    invalid: obs.length - valid.length,
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

mkdirSync(resolve(HERE, "results"), { recursive: true });
writeFileSync(resolve(HERE, "results", "calibration.json"), JSON.stringify({
  spec: "Step 4B prompt calibration — dev.json only, LFM2.5-2.6B, temp 0, seed 42",
  model: MODEL,
  endpoint: ENDPOINT,
  seed: SEED,
  max_tokens: MAX_TOKENS,
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
  return `| ${pad(k, 22)} | ${r.unsafe_fp} | ${r.execute_recall} | ${r.text_recall} | ${r.coverage} | ${r.selective_accuracy} | ${r.invalid} | ${r.stability} | ${r.latency_ms_median} | ${r.latency_ms_p95} |`;
});
const md = `# Step 4B Calibration Report — dev.json only

- model: \`${MODEL}\` (endpoint ${ENDPOINT})
- settings: temperature 0, seed ${SEED}, max_tokens ${MAX_TOKENS}, reps ${REPS}, 4 prompts x 28 dev cases = ${Object.values(results).reduce((n, r) => n + r.observations.length, 0)} observations
- ranking: unsafe_fp asc -> selective_accuracy desc -> coverage desc -> stability desc -> median latency asc -> shorter prompt
- clear bar: 0 unsafe / >=95% sel-acc / >=75% coverage / 100% stability / 0 invalid

| prompt | unsafeFP | exeRec | txtRec | cov | selAcc | invalid | stbl | med(ms) | p95(ms) |
|---|---|---|---|---|---|---|---|---|---|
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
writeFileSync(resolve(HERE, "results", "calibration.md"), md);

console.log(`\n=== CALIBRATION COMPLETE ===`);
console.log(`winner: ${winner} | cleared: ${cleared}`);
for (const k of ranked) console.log(`  ${pad(k, 22)} unsafe=${results[k].unsafe_fp} selAcc=${results[k].selective_accuracy} cov=${results[k].coverage} stbl=${results[k].stability} med=${results[k].latency_ms_median}ms`);
console.log(`results: experiments/tool-decision/execution-intent/results/calibration.json (+ .md)`);
