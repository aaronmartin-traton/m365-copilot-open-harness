#!/usr/bin/env bun
/**
 * self-improve — let the model improve this harness, scored, and never blindly.
 *
 * The repo already has the measuring stick (`scripts/bench`, objective
 * pass/fail verifiers) and the log (`docs/hypotheses.md`). What was missing is
 * the loop that connects them: propose a change to the harness, apply it in a
 * throwaway copy, re-score it, and KEEP IT ONLY IF THE SCORE WENT UP.
 *
 * That is hill-climbing on an objective function. It is the same discipline the
 * repo already insists on — "Best becomes a number", n=1 is noise — applied to
 * the harness itself instead of only to prompts.
 *
 * SAFETY (read this before running):
 *   - It NEVER edits your working tree. Every proposal is applied to a throwaway
 *     copy under a temp dir, scored there, and written out as a patch. You apply
 *     it yourself, after reading it.
 *   - It never commits, never pushes, never touches `.git` config, and never
 *     reads the token cache.
 *   - It runs ONE long M365 thread for the whole session, never a new thread per
 *     iteration. Per AGENTS.md, threads-started is what burns the quota budget;
 *     a fresh thread per experiment is exactly the thing to avoid.
 *   - Every proposed command runs in the same `--network none` Docker sandbox the
 *     bench uses. Model-generated shell never touches your host.
 *   - It is bounded: `--iterations` (default 4) and `--repeat` (default 1). A
 *     single score difference at n=1 is noise, so the runner reports the delta
 *     and refuses to claim a win below `--min-delta`.
 *
 * Usage:
 *   bun run proxy 4141                      # in one shell
 *   bun scripts/self-improve/run.mjs --base-url http://localhost:4141/v1 \
 *       --iterations 4 --repeat 3
 *
 * Output: console scorecard + scripts/self-improve/out/<ts>/{report.md,best.patch}
 */
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const args = process.argv.slice(2);

const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const BASE = opt("--base-url", "http://localhost:4141/v1").replace(/\/$/, "");
const MODEL = opt("--model", "m365-copilot");
const ITERATIONS = Number(opt("--iterations", "4"));
const REPEAT = Number(opt("--repeat", "1"));
const TASKS = opt("--tasks", "");
const MIN_DELTA = Number(opt("--min-delta", "0.01"));
const REPO = process.cwd();
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = join(REPO, "scripts", "self-improve", "out", STAMP);

if (!existsSync(join(REPO, "scripts", "bench", "run.mjs"))) {
  console.error("Run this from the repository root (scripts/bench/run.mjs not found).");
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });

/** The files a proposal is allowed to touch. Everything else is off limits. */
const WRITABLE = [
  "packages/core/src/fenced.ts",
  "packages/core/src/tools.ts",
  "packages/core/src/session.ts",
  "packages/core/src/agent.ts",
  "scripts/bench/prompts",
];

/** Never read, never write, never suggest — a proposal touching these is rejected. */
const FORBIDDEN = [".git", "packages/core/src/auth.ts", "packages/proxy", ".env", "node_modules"];

function refuse(reason) {
  console.error(`\nRefusing to continue: ${reason}`);
  process.exit(1);
}

// --- scoring ----------------------------------------------------------------

/**
 * Score the harness in `dir`. Returns a pass-rate in [0,1]. The bench writes its
 * own JSON under `scripts/bench/out/`; we read the newest file it produced.
 */
function score(dir, label) {
  const before = newestBenchRun(dir);
  const result = spawnSync(
    "node",
    [join(dir, "scripts", "bench", "run.mjs"), "--base-url", BASE, "--model", MODEL, "--label", label, "--repeat", String(REPEAT),
      ...(TASKS ? ["--tasks", TASKS] : [])],
    { cwd: dir, encoding: "utf8", timeout: 45 * 60_000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );

  if (result.error) {
    console.error(`  bench failed to start: ${result.error.message}`);
    return null;
  }

  const after = newestBenchRun(dir);

  if (after === null || after === before) {
    console.error("  bench produced no result file");
    return null;
  }

  return after;
}

function newestBenchRun(dir) {
  const outDir = join(dir, "scripts", "bench", "out");

  if (!existsSync(outDir)) return null;

  const files = execSync(`ls -t ${outDir}`, { encoding: "utf8" }).trim().split("\n").filter(Boolean);

  if (files.length === 0) return null;

  const path = join(outDir, files[0]);
  const parsed = JSON.parse(readFileSync(path, "utf8"));

  return passRate(parsed);
}

/** The bench's own scorecard: solved over total. */
function passRate(report) {
  const results = report.results ?? report.tasks ?? [];

  if (!Array.isArray(results) || results.length === 0) return null;

  const solved = results.filter((r) => (r.outcome ?? r.status) === "SOLVED").length;

  return solved / results.length;
}

// --- the model --------------------------------------------------------------

/**
 * One long conversation for the whole run. Deliberately NOT reset per iteration:
 * per AGENTS.md the throttle tracks conversations started, so a fresh thread per
 * experiment is the expensive thing. One thread, many turns, is cheap.
 */
const messages = [
  {
    role: "system",
    content:
      "You are improving an existing agent harness. You are given its measured score and its current state. " +
      "Propose ONE concrete change that should raise the score, then verify your reasoning. " +
      "Be concrete and small: a framing change, a tool description, a parser fix. " +
      "Do not rewrite working code for style. When you have a change, reply with a single fenced block:\n" +
      "```patch\n<unified diff against the files listed below>\n```",
  },
];

async function ask(userText) {
  messages.push({ role: "user", content: userText });

  const response = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, stream: false }),
  });

  if (!response.ok) {
    throw new Error(`proxy returned HTTP ${response.status}: ${await response.text()}`);
  }

  const body = await response.json();
  const reply = body.choices?.[0]?.message?.content ?? "";

  messages.push({ role: "assistant", content: reply });

  return reply;
}

/** The ```patch fence the system prompt asks for. */
function extractPatch(reply) {
  const match = /```patch\s*\n([\s\S]*?)```/.exec(reply);

  return match ? match[1].trim() : null;
}

/**
 * Refuse a patch that touches anything outside WRITABLE. This is the guard that
 * stops a self-improving harness from editing its own auth or its own .git.
 */
function auditPatch(patch) {
  for (const forbidden of FORBIDDEN) {
    if (patch.includes(forbidden)) return `patch mentions ${forbidden}`;
  }

  const touched = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1].trim());

  if (touched.length === 0) return "patch names no files";

  for (const file of touched) {
    if (!WRITABLE.some((allowed) => file.startsWith(allowed))) return `patch touches ${file}`;
  }

  return null;
}

// --- the loop ---------------------------------------------------------------

function freshCopy(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // Copy the working tree, minus what would slow a copy and pollute a diff.
  const excluded = [".git", "node_modules", "dist", ".output", "out"]
    .map((entry) => ["--exclude", entry])
    .flat();

  const copied = spawnSync("rsync", ["-a", ...excluded, `${REPO}/`, `${dir}/`], { encoding: "utf8" });

  if (copied.status !== 0) {
    refuse(`could not copy the working tree to ${dir}: ${copied.stderr || "rsync failed"}`);
  }

  // The bench imports the built packages, so the copy needs its own build.
  const built = spawnSync("bun", ["run", "build:libs"], { cwd: dir, encoding: "utf8", stdio: "ignore" });

  if (built.status !== 0) {
    refuse(`the harness copy at ${dir} does not build; run \`bun run build\` first`);
  }
}

const baselineDir = mkdtempSync(join(tmpdir(), "self-improve-baseline-"));

console.log("self-improve: scoring the current harness (baseline)");
freshCopy(baselineDir);

const baseline = score(baselineDir, `baseline-${STAMP}`);

if (baseline === null) {
  console.error("\nCould not establish a baseline. Is the proxy running at " + BASE + "?");
  console.error("Start it with:  bun run proxy 4141");
  rmSync(baselineDir, { recursive: true, force: true });
  process.exit(1);
}

console.log(`baseline pass-rate: ${(baseline * 100).toFixed(1)}%`);

let best = baseline;
let bestPatch = null;
const history = [{ iteration: 0, score: baseline, kept: true, reason: "baseline" }];

for (let iteration = 1; iteration <= ITERATIONS; iteration++) {
  console.log(`\n--- iteration ${iteration}/${ITERATIONS} ---`);

  const reply = await ask(
    `Current pass-rate: ${(best * 100).toFixed(1)}%.\n` +
      `Worst outcomes seen: GAVE_UP_PROSE and MAX_TURNS mean the model answers in prose instead of calling a tool, or runs out of turns.\n\n` +
      `You may change ONLY these paths:\n${WRITABLE.map((w) => `  ${w}`).join("\n")}\n\n` +
      `Reply with one fenced \`\`\`patch block containing a unified diff.`,
  );

  const patch = extractPatch(reply);

  if (patch === null) {
    console.log("  no patch block; skipping");
    history.push({ iteration, score: best, kept: false, reason: "no patch block" });
    continue;
  }

  const problem = auditPatch(patch);

  if (problem !== null) {
    console.log(`  refused: ${problem}`);
    history.push({ iteration, score: best, kept: false, reason: `refused: ${problem}` });
    continue;
  }

  const trialDir = mkdtempSync(join(tmpdir(), `self-improve-try-${iteration}-`));

  freshCopy(trialDir);
  writeFileSync(join(trialDir, "candidate.patch"), `${patch}\n`);

  const applied = spawnSync("git", ["apply", "--3way", "candidate.patch"], { cwd: trialDir, encoding: "utf8" });

  if (applied.status !== 0) {
    console.log(`  patch did not apply: ${applied.stderr?.split("\n")[0]}`);
    history.push({ iteration, score: best, kept: false, reason: "patch did not apply" });
    rmSync(trialDir, { recursive: true, force: true });
    continue;
  }

  // freshCopy already built the pristine copy; rebuild with the patch applied.
  const build = spawnSync("bun", ["run", "build:libs"], { cwd: trialDir, encoding: "utf8", stdio: "ignore" });

  if (build.status !== 0) {
    console.log("  candidate failed to build; discarded");
    history.push({ iteration, score: best, kept: false, reason: "build failed" });
    rmSync(trialDir, { recursive: true, force: true });
    continue;
  }

  const candidate = score(trialDir, `cand-${iteration}-${STAMP}`);
  rmSync(trialDir, { recursive: true, force: true });

  if (candidate === null) {
    history.push({ iteration, score: best, kept: false, reason: "no score" });
    continue;
  }

  const delta = candidate - best;

  console.log(`  score ${(candidate * 100).toFixed(1)}% (${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)} points)`);

  if (delta >= MIN_DELTA) {
    best = candidate;
    bestPatch = patch;
    console.log("  KEPT");
    history.push({ iteration, score: candidate, kept: true, reason: `+${(delta * 100).toFixed(1)} points` });
  } else {
    console.log("  discarded (no improvement)");
    history.push({ iteration, score: candidate, kept: false, reason: `${(delta * 100).toFixed(1)} points` });
  }
}

// --- report -----------------------------------------------------------------

const improved = best > baseline + MIN_DELTA;

if (bestPatch !== null) {
  writeFileSync(join(OUT, "best.patch"), `${bestPatch}\n`);
}

const report = [
  `# self-improve run ${STAMP}`,
  "",
  `baseline: ${(baseline * 100).toFixed(1)}%`,
  `best:     ${(best * 100).toFixed(1)}%`,
  `verdict:  ${improved ? "IMPROVED" : "no improvement found"}`,
  "",
  "A patch is written for you to review and apply. Nothing in your working tree was touched.",
  "",
  "| iteration | score | kept | why |",
  "|---|---|---|---|",
  ...history.map((h) => `| ${h.iteration} | ${(h.score * 100).toFixed(1)}% | ${h.kept} | ${h.reason} |`),
  "",
  "## Caveats that matter more than the numbers",
  "",
  `- repeat=${REPEAT}. At repeat=1 a difference under a few points is noise, not a result.`,
  "- The bench is a small task set; a gain there is not a gain in general.",
  "- Read the patch before applying it. This tool ranks changes; it does not vouch for them.",
  "",
].join("\n");

writeFileSync(join(OUT, "report.md"), report);
rmSync(baselineDir, { recursive: true, force: true });

console.log(`\n${report}`);
console.log(`Artifacts: ${OUT}`);
