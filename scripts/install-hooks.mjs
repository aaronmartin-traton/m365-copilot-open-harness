#!/usr/bin/env bun
/**
 * install-hooks.mjs — installs the secret-scan pre-push hook into a clone.
 * Run it on the clone (egress to GitHub) AND on the clone
 * (egress to the the remote):
 *     bun scripts/install-hooks.mjs
 * Safe to re-run; the hook is rewritten from the committed template with
 * the repo's absolute path baked in.
 */
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");
const GIT_DIR = execFileSync("git", ["rev-parse", "--git-dir"], { cwd: ROOT, encoding: "utf8" }).trim();
const HOOKS_DIR = join(GIT_DIR, "hooks");
const TEMPLATE = join(ROOT, "scripts", "hooks", "pre-push");
const TARGET = join(HOOKS_DIR, "pre-push");

try { mkdirSync(HOOKS_DIR, { recursive: true }); } catch {} // already exists is fine
let template = readFileSync(TEMPLATE, "utf8");
template = template.replaceAll("__REPO_ROOT__", ROOT.replaceAll("\\", "/"));
writeFileSync(TARGET, template);
chmodSync(TARGET, 0o755);
console.log(`installed pre-push hook at ${TARGET}`);
