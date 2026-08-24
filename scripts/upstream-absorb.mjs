#!/usr/bin/env bun
/**
 * upstream-absorb.mjs — declared-ownership fork gate. See .gitattributes.
 *
 * Fetches upstream, lists commits not yet recorded in
 * docs/upstream-manifest.json, flags any that touch OWNED (merge=ours)
 * paths, and exits non-zero when review work is outstanding.
 *
 * Usage:
 *   bun scripts/upstream-absorb.mjs           # gate + human-readable worklist
 *   bun scripts/upstream-absorb.mjs --json    # machine-readable output
 *
 * Exit codes: 0 = nothing pending, 1 = pending/unreviewed commits, 2 = setup error.
 */
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UPSTREAM_URL = "https://github.com/cramt/m365-copilot-proxy.git";
const MANIFEST = path.join(ROOT, "docs", "upstream-manifest.json");
const ATTRS = path.join(ROOT, ".gitattributes");

const jsonOut = process.argv.includes("--json");
const sh = (cmd) => execSync(cmd, { cwd: ROOT, encoding: "utf8" }).trim();

function die(code, msg) {
  if (jsonOut) console.log(JSON.stringify({ ok: false, error: msg }));
  else console.error(`error: ${msg}`);
  process.exit(code);
}

// --- setup ---------------------------------------------------------------

try {
  sh(`git config merge.ours.driver true`); // needed by .gitattributes merge=ours
} catch {
  /* read-only checkout: .gitattributes will error at merge time, not now */
}

let hasRemote = false;
try {
  hasRemote = sh("git remote get-url upstream") === UPSTREAM_URL;
} catch {
  hasRemote = false;
}
if (!hasRemote) {
  try {
    sh(`git remote add upstream ${UPSTREAM_URL}`);
  } catch (e) {
    die(2, `cannot add upstream remote: ${e.message}`);
  }
}
try {
  sh("git fetch upstream --quiet");
} catch (e) {
  die(2, `cannot fetch upstream: ${e.message}`);
}

// --- owned-path globs from .gitattributes --------------------------------

const ownedGlobs = existsSync(ATTRS)
  ? readFileSync(ATTRS, "utf8")
      .split("\n")
      .filter((l) => l.includes("merge=ours"))
      .map((l) => l.trim().split(/\s+/)[0])
      .filter(Boolean)
      // Escape regex metacharacters first (literal dots etc.), then translate
      // gitattributes globs via a sentinel so ** → .* survives the * pass.
      .map((g) =>
        g
          .replace(/[.+^${}()|[\]\\?]/g, "\\$&")
          .replace(/\*\*/g, "\u0000")
          .replace(/\*/g, "[^/]*")
          .replace(/\u0000/g, ".*"),
      )
  : [];

const touchesOwned = (paths) =>
  paths.some((p) => ownedGlobs.some((g) => new RegExp(`^${g}$`).test(p)));

// --- manifest ------------------------------------------------------------

if (!existsSync(MANIFEST)) die(2, `missing ${MANIFEST}`);
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const recorded = new Map(manifest.entries.map((e) => [e.sha, e]));

const REVIEWED = new Set(["taken", "rejected", "superseded", "skipped", "bulk-reviewed"]);

// --- classify the unreviewed range ----------------------------------------

let base;
try {
  base = sh("git merge-base HEAD upstream/main");
} catch (e) {
  die(2, `cannot compute merge-base with upstream/main: ${e.message}`);
}

const log = sh(
  `git log --format=%H%x09%s ${base}..upstream/main`,
);
const upstreamCommits = log
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [sha, ...rest] = line.split("\t");
    return { sha, subject: rest.join("\t") };
  });

const pending = [];
for (const c of upstreamCommits) {
  const entry = recorded.get(c.sha);
  if (entry && REVIEWED.has(entry.status)) continue;
  let files = [];
  try {
    files = sh(`git show --name-only --format= ${c.sha}`).split("\n").filter(Boolean);
  } catch {
    files = [];
  }
  pending.push({
    ...c,
    status: entry ? entry.status : "unrecorded",
    files,
    ownedRisk: touchesOwned(files),
  });
}

// --- report ----------------------------------------------------------------

const result = {
  ok: pending.length === 0,
  upstreamRemote: UPSTREAM_URL,
  reviewedCount: manifest.entries.filter((e) => REVIEWED.has(e.status)).length,
  pendingCount: pending.length,
  pending: pending.map(({ sha, subject, status, ownedRisk }) => ({ sha, subject, status, ownedRisk })),
};

if (jsonOut) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`upstream absorption gate — .gitattributes policy`);
  console.log(`manifest: ${result.reviewedCount} reviewed entries`);
  if (pending.length === 0) {
    console.log(`OK — no unreviewed upstream commits.`);
    process.exit(0);
  }
  console.log(`PENDING — ${pending.length} commit(s) need a disposition:\n`);
  for (const p of result.pending) {
    const flag = p.ownedRisk ? "  [TOUCHES OWNED PATH]" : "";
    console.log(`  ${p.sha.slice(0, 9)}  (${p.status})${flag}`);
    console.log(`    ${p.subject}`);
    console.log(`    review: git show ${p.sha}`);
  }
  console.log(`\nRecord dispositions in docs/upstream-manifest.json, then re-run.`);
  process.exit(1);
}
