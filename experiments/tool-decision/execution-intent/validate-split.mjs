#!/usr/bin/env bun
/**
 * validate-split.mjs — frozen-split guard for the execution-intent benchmark.
 *
 * Proves the constraints from Directive 001 (Step 4A) on dev.json / heldout.json:
 *   - dev = 28 cases, ids = the execution_intent ids from cases.jsonl, gold derived
 *   - heldout = 32 cases / 16 near-pairs / 16-16 EXECUTE-TEXT balance
 *   - 8 required phenomena, exactly 2 pairs each
 *   - >= 4 state-changing/destructive pairs (the costly gold-TEXT->EXECUTE error class)
 *   - 0 duplicate ids (heldout-internal and across both files)
 *   - 0 invalid gold labels (gold is EXECUTE or TEXT only; UNCERTAIN is never a gold)
 *   - every pair has opposite gold labels
 *   - pair members share identical fenced payload + fence language (near-pair rule:
 *     intent is the only variable, never superficial formatting)
 *
 * Usage: bun validate-split.mjs   (exit 0 = all constraints hold)
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(resolve(HERE, f), "utf-8"));

const dev = load("dev.json");
const heldout = load("heldout.json");
const corpus = readFileSync(resolve(HERE, "..", "cases.jsonl"), "utf-8")
  .trim().split("\n").map((l) => JSON.parse(l));

const REQUIRED_PHENOMENA = [
  "imperative", "recommendation", "quotation", "documentation",
  "destructive warning", "retrospective", "conditional", "troubleshooting",
];

// Markers for state-changing / destructive commands. Deliberately focused:
// the class that makes gold TEXT -> EXECUTE predictions expensive.
const DESTRUCTIVE_MARKERS = [
  "rm -rf", "rm -fr", "git reset --hard", "git push --force", "git push -f",
  "git commit", "db:migrate", "deploy --env", "del /s", "rd /s", "shutdown",
  "DROP TABLE", "drop table", "mkfs", "truncate -s 0", ">:(){",
];

const GOLD = new Set(["EXECUTE", "TEXT"]);
const errors = [];
const ok = (cond, msg) => { if (!cond) errors.push(msg); };

// ---- dev provenance --------------------------------------------------------

const corpusDevIds = corpus
  .filter((c) => c.expected === "execution_intent")
  .map((c) => c.id).sort();
const devIds = dev.map((c) => c.id).sort();
ok(dev.length === 28, `dev cases = ${dev.length}, expected 28`);
ok(
  JSON.stringify(devIds) === JSON.stringify(corpusDevIds),
  "dev ids must equal the execution_intent ids in cases.jsonl (order-insensitive check via sort)",
);
for (const c of dev) {
  ok(GOLD.has(c.gold), `dev ${c.id}: gold must be EXECUTE/TEXT, got ${c.gold}`);
  const derived = c.expected_action === "tool" ? "EXECUTE" : c.expected_action === "text" ? "TEXT" : null;
  ok(derived !== null, `dev ${c.id}: expected_action must be tool/text, got ${c.expected_action}`);
  ok(c.gold === derived, `dev ${c.id}: gold ${c.gold} must derive from expected_action ${c.expected_action}`);
  ok(c.expected === "execution_intent", `dev ${c.id}: expected must be execution_intent`);
  ok(c.note && c.planner_output, `dev ${c.id}: must carry planner_output and note`);
}

// ---- heldout structure -----------------------------------------------------

const pairs = new Map();
for (const c of heldout) {
  ok(GOLD.has(c.gold), `heldout ${c.id}: invalid gold ${c.gold}`);
  ok(c.expected_action === "tool" || c.expected_action === "text",
    `heldout ${c.id}: expected_action must be tool/text, got ${c.expected_action}`);
  ok(c.pair_id && c.phenomenon, `heldout ${c.id}: must carry pair_id and phenomenon`);
  if (c.pair_id) {
    if (!pairs.has(c.pair_id)) pairs.set(c.pair_id, []);
    pairs.get(c.pair_id).push(c);
  }
}
ok(heldout.length === 32, `held-out cases = ${heldout.length}, expected 32`);
ok(pairs.size === 16, `held-out near-pairs = ${pairs.size}, expected 16`);

const pairEntries = [...pairs.entries()];
for (const [pid, members] of pairEntries) {
  ok(members.length === 2, `pair ${pid}: must have exactly 2 members, got ${members.length}`);
  if (members.length !== 2) continue;
  const [a, b] = members;
  ok(a.gold !== b.gold, `pair ${pid}: members must have OPPOSITE gold (${a.id}=${a.gold}, ${b.id}=${b.gold})`);
  // near-pair rule: identical fence language + payload, intent is the only variable
  const fenceOf = (c) => {
    const m = /```(bash|sh|shell|zsh)\n([\s\S]*?)```/.exec(c.planner_output);
    return m ? `${m[1]}\n${m[2]}` : null;
  };
  const fa = fenceOf(a), fb = fenceOf(b);
  ok(fa !== null && fb !== null, `pair ${pid}: both members must contain a fenced block`);
  ok(fa === fb, `pair ${pid}: members must share identical fence language + payload\n  A: ${JSON.stringify(fa)}\n  B: ${JSON.stringify(fb)}`);
}

// ---- counts ----------------------------------------------------------------

const goldCounts = { EXECUTE: 0, TEXT: 0 };
for (const c of heldout) goldCounts[c.gold]++;
ok(goldCounts.EXECUTE === 16 && goldCounts.TEXT === 16,
  `held-out EXECUTE/TEXT balance = ${goldCounts.EXECUTE}/${goldCounts.TEXT}, expected 16/16`);

for (const ph of REQUIRED_PHENOMENA) {
  const n = pairEntries.filter(([, m]) => m[0].phenomenon === ph).length;
  ok(n === 2, `phenomenon "${ph}": ${n} pairs, expected 2`);
}
const phenoSet = new Set(pairEntries.map(([, m]) => m[0].phenomenon));
ok(
  REQUIRED_PHENOMENA.every((p) => phenoSet.has(p)) && phenoSet.size === REQUIRED_PHENOMENA.length,
  "held-out phenomena must be exactly the 8 required",
);

const isDestructive = (cmd) => DESTRUCTIVE_MARKERS.some((m) => cmd.includes(m));
const destructivePairs = pairEntries.filter(([, m]) =>
  m.some((c) => {
    const f = /```(?:bash|sh|shell|zsh)\n([\s\S]*?)```/.exec(c.planner_output);
    return f && isDestructive(f[1]);
  }));
ok(destructivePairs.length >= 4,
  `state-changing/destructive pairs = ${destructivePairs.length}, expected >= 4`);

// ---- ids -------------------------------------------------------------------

const allIds = [...dev.map((c) => c.id), ...heldout.map((c) => c.id)];
const dupes = allIds.filter((id, i) => allIds.indexOf(id) !== i);
ok(dupes.length === 0, `duplicate ids across dev+heldout: ${dupes.join(", ") || "none"}`);

// ---- report ----------------------------------------------------------------

if (errors.length) {
  console.error(`validate-split: FAIL (${errors.length})`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`validate-split: PASS
  dev cases:                         ${dev.length}
  held-out cases:                    ${heldout.length}
  held-out near-pairs:               ${pairs.size}
  EXECUTE/TEXT held-out balance:     ${goldCounts.EXECUTE}/${goldCounts.TEXT}
  destructive/state-changing pairs:  ${destructivePairs.length} (>= 4 required)
  phenomena (2 pairs each):          ${[...phenoSet].sort().join(", ")}
  duplicate ids:                     0
  invalid gold labels:               0
  opposite gold per pair:            all ${pairEntries.length} pairs
  identical payload/fence per pair:  all ${pairEntries.length} pairs`);
