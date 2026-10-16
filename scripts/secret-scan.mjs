#!/usr/bin/env bun
/**
 * secret-scan.mjs — pre-push secret guard for m365-copilot-open-harness.
 *
 * Scans for high-signal secret patterns in:
 *   --all        the working tree (skips .git, node_modules, build outputs)
 *   --commits R  added lines in the git diff of range R (e.g. old..new)
 *   (default)    the pre-push hook protocol: reads "<local ref> <local sha>
 *                <remote ref> <remote sha>" lines from stdin and scans each
 *                pushed range (remote_sha..local_sha).
 *
 * Exit 0 = clean, 1 = matches found (block the push), 2 = usage/scan error.
 *
 * The repo is PUBLIC — a secret is exposed the moment a push lands, so this
 * must run BEFORE the push, at every egress point
 * (install it with `bun scripts/install-hooks.mjs`).
 * GitHub Actions (.github/workflows/secret-scan.yml) is belt-and-braces AFTER
 * the fact, never the gate.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", ".output", ".nitro", ".commandcode",
  ".autonomous", "result", ".github",
]);

const SKIP_FILES = new Set([
  "bun.lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
]);

// High-signal patterns. Values of known API keys are caught by name;
// generic long secrets by shape. Bearer is included — the repo's own docs
// use "Bearer" only in prose examples; a real token in code will trip it.
const PATTERNS = [
  [/sk-[A-Za-z0-9]{20,}/, "OpenAI-style API key"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/, "GitHub token"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/-----BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY-----/, "private key block"],
  [/Bearer [A-Za-z0-9._\-]{20,}/, "bearer token"],
  [/\b(FREE_POOL_API_KEY|FREEPOOL_API_KEY|STEPFUN_API_KEY|XKIRO_API_KEY|QODER_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY|GITHUB_TOKEN)\s*[:=]\s*["']?[^"'\s]{16,}/, "API key env assignment with value"],
  [/\b(client_secret|api[_-]?secret|password|passwd)\s*[:=]\s*["'][^"']{8,}["']/, "secret/password assignment (verify: may be a placeholder)"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, "JWT"],
];

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (st.isFile() && !SKIP_FILES.has(entry)) out.push(p);
  }
}

function scanLines(lines, pathLabel, findings) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const [re, kind] of PATTERNS) {
      if (re.test(line)) {
        findings.push(`${pathLabel}:${i + 1}: [${kind}] ${line.trim().slice(0, 160)}`);
        break; // one finding per line keeps output readable
      }
    }
  }
}

function scanTree() {
  const findings = [];
  const files = [];
  walk(ROOT, files);
  for (const f of files) {
    let content;
    try { content = readFileSync(f, "utf8"); } catch { continue; }
    scanLines(content.split(/\r?\n/), relative(ROOT, f), findings);
  }
  return findings;
}

function scanRange(range) {
  const findings = [];
  let diff;
  try {
    diff = execFileSync("git", ["diff", "--no-color", "--text", range], {
      cwd: ROOT, maxBuffer: 512 * 1024 * 1024, encoding: "utf8",
    });
  } catch (e) {
    // range may fail if a ref is missing (new branch) — fall back to show
    try {
      diff = execFileSync("git", ["show", "--no-color", "--text", "--format=", range.split("..").pop()], {
        cwd: ROOT, maxBuffer: 512 * 1024 * 1024, encoding: "utf8",
      });
    } catch {
      process.stderr.write(`secret-scan: could not diff range '${range}'\n`);
      process.exit(2);
    }
  }
  let file = null;
  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith("+++ ")) { file = raw.slice(4).trim(); continue; }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      if (file && file !== "/dev/null") scanLines([raw.slice(1)], file, findings);
    }
  }
  return findings;
}

function parseHookStdin() {
  const lines = readFileSync(0, "utf8").split(/\r?\n/).filter(Boolean);
  const ranges = [];
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length >= 4) {
      const [, localSha, , remoteSha] = parts;
      if (remoteSha === "0000000000000000000000000000000000000000") {
        ranges.push(`${localSha}^..${localSha}`);
      } else {
        ranges.push(`${remoteSha}..${localSha}`);
      }
    }
  }
  return ranges;
}

const args = process.argv.slice(2);
let findings = [];

if (args.includes("--all")) {
  findings = scanTree();
} else if (args.includes("--commits")) {
  const idx = args.indexOf("--commits");
  findings = scanRange(args[idx + 1] ?? "");
} else {
  for (const range of parseHookStdin()) {
    findings = findings.concat(scanRange(range));
  }
}

if (findings.length > 0) {
  process.stderr.write("secret-scan: BLOCKED — possible secret(s) found:\n");
  for (const f of findings) process.stderr.write(`  ${f}\n`);
  process.stderr.write("Remove them from the diff/tree before pushing (public repo!).\n");
  process.exit(1);
}
process.stdout.write("secret-scan: clean\n");
