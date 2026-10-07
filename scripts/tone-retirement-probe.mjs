// Are the retired Quick tones actually gone?
//
// Upstream 9fd9d36 claims M365 now REJECTS the `*_Quick` / `Gpt_Reasoning`
// tones and re-points `quick`, `think-deeper` and the 5.x `-quick` model ids at
// the Chat replacements. We have not verified that on this account, and AGENTS.md
// still documents `*-quick` as a working tone — so we are not taking the mapping
// blind. This probe settles it with one message per tone, sequentially.
//
// Falsifiable: a tone that errors with "Failed to invoke 'Chat'" (or returns an
// empty turn) is retired; a tone that returns content is alive. The CONTROL tone
// proves the harness can see a rejection at all — if the control also returns
// content, this run cannot distinguish anything and must be repeated.
//
// Cost: 1 message per tone (7), one conversation each. Serial on purpose: this
// repo is thread-rate limited (F13), never fire concurrent requests.
//
// Usage:
//   M365_NO_INTERACTIVE=1 bun scripts/tone-retirement-probe.mjs
// Writes scripts/tone-out/<ts>/retired-tones.json and prints a verdict table.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getToken, decodeJwt } from "../packages/core/dist/index.mjs";
import { oneTurn } from "./_probe-chat.mjs";

/** [model id, tone, upstream claim] — the tone must equal getToneForModel(model). */
const CASES = [
  ["quick", "Gpt_Quick", "retired per 9fd9d36"],
  ["think-deeper", "Gpt_Reasoning", "retired per 9fd9d36"],
  ["gpt-5.2-quick", "Gpt_5_2_Quick", "retired per 9fd9d36"],
  ["gpt-5.3-quick", "Gpt_5_3_Quick", "retired per 9fd9d36"],
  ["magic", "magic", "control: known good"],
  ["gpt-5.5-quick", "Gpt_5_5_Chat", "replacement for the Quick family"],
  ["Definitely_Not_A_Real_Tone_XYZ", "Definitely_Not_A_Real_Tone_XYZ", "control: invalid, must error"],
];

const TS = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = join(process.cwd(), "scripts", "tone-out", TS);
mkdirSync(OUT, { recursive: true });

const token = await getToken();
const claims = decodeJwt(token);
const results = [];

for (const [model, tone, note] of CASES) {
  console.log(`[probe] ${model} -> ${tone} (${note})`);
  const r = await oneTurn({
    token,
    claims,
    agentId: null,
    tone,
    timeoutMs: 60000,
    text: "Reply with exactly the single word: pong",
  });
  const text = (r.fullText ?? "").trim();
  const row = {
    model,
    tone,
    note,
    chars: text.length,
    ok: text.length > 0,
    error: r.error ?? null,
    text: text.slice(0, 200),
  };
  results.push(row);
  console.log(`  ${row.ok ? "ALIVE" : "DEAD "} chars=${row.chars} origin=${String(r.contentOrigin)} ${r.error ? ` error=${r.error}` : ""}`);
  await new Promise((res) => setTimeout(res, 1500)); // gentle spacing; never concurrent (F13)
}

writeFileSync(join(OUT, "retired-tones.json"), JSON.stringify(results, null, 2));

const controlInvalid = results.find((r) => r.tone === "Definitely_Not_A_Real_Tone_XYZ");
const harnessBlind = controlInvalid?.ok === true;

console.log("");
if (harnessBlind) {
  console.log("VERDICT: INCONCLUSIVE — the control tone returned content, so this run cannot see a rejection. Repeat later.");
} else {
  const dead = results.filter((r) => !r.ok && r.tone !== "Definitely_Not_A_Real_Tone_XYZ").map((r) => r.tone);
  const alive = results.filter((r) => r.ok).map((r) => r.tone);
  console.log(`ALIVE: ${alive.join(", ") || "none"}`);
  console.log(`DEAD : ${dead.join(", ") || "none"}`);
  console.log(`VERDICT: ${dead.length > 0 ? "upstream 9fd9d36 is confirmed — take the mapping" : "no retirement seen; do NOT change the mapping"}`);
}
console.log(`frames: ${OUT}`);