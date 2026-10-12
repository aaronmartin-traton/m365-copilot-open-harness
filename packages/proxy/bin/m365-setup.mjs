#!/usr/bin/env bun
/**
 * One command to get from a fresh clone to a working proxy.
 *
 *   bun run setup          # install, build, check the prerequisites, sign in
 *   bun run setup -- --backend openai
 *   bun run setup -- --check-only
 *
 * It only ever reads the environment and writes the token cache; nothing here
 * needs administrator rights, and no browser profile other than the proxy's own
 * dedicated directory is touched.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  browserExecutable,
  discoverOpenAiModels,
  getBrowserProfileDir,
  getTokenSilent,
  openAiApiKey,
  openAiBaseUrl,
  openAiModelNames,
  openAiRequiresKey,
} from "@m365-copilot/core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const args = process.argv.slice(2);

const backend = valueOf("--backend") ?? process.env.PROVIDER ?? "m365";

const checkOnly = args.includes("--check-only");

function valueOf(flag) {
  const index = args.indexOf(flag);

  return index >= 0 ? args[index + 1] : undefined;
}

function heading(text) {
  console.log(`\n${text}\n${"-".repeat(text.length)}`);
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });

  if (result.status !== 0) process.exit(result.status ?? 1);
}

const problems = [];

heading("Checking prerequisites");

if (checkOnly) {
  console.log("Prerequisites:");
} else {
  console.log("Installing dependencies and building...");

  run("bun", ["install"]);
  run("bun", ["run", "build"]);
  console.log("Installed and built.");
}

heading("Sign-in method");

if (backend === "openai") {
  const key = openAiApiKey();

  if (openAiRequiresKey() && key === null) {
    problems.push("PROVIDER=openai needs OPENAI_API_KEY set.");
    console.log("  x OPENAI_API_KEY is not set");
  } else {
    console.log(`  ok endpoint ${openAiBaseUrl()}${key === null ? " (no key required)" : " (key set)"}`);
  }

  const discovered = await discoverOpenAiModels();

  if (discovered !== null && discovered.length > 0) {
    console.log(`  ok the server serves: ${discovered.join(", ")}`);
    console.log(`    Set OPENAI_MODELS=${discovered.join(",")} to pin this list on /v1/models.`);
  } else {
    console.log(`  ok advertising: ${openAiModelNames().join(", ")}`);
  }
} else if (backend === "chatgpt-web") {
  console.log("  ! the chatgpt-web lane is DEPRECATED and superseded by PROVIDER=openai.");
  console.log("    It drives a chatgpt.com session and cannot honour the requested model.");
} else if (backend !== "m365") {
  problems.push(`Unknown PROVIDER "${backend}". Expected m365, openai or chatgpt-web.`);
  console.log(`  x unknown backend "${backend}"`);
} else {
  try {
    browserExecutable();
    console.log("  ok a Chromium or Edge executable for sign-in");
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
    console.log("  x no browser found for sign-in");
  }

  console.log(`  ok browser profile: ${getBrowserProfileDir()} (the proxy's own directory)`);

  const cached = checkOnly ? null : await getTokenSilent().catch(() => null);

  if (cached) {
    console.log("  ok already signed in");
  } else if (checkOnly) {
    console.log("  ? not signed in yet - run `bun run setup` to sign in");
  } else {
    console.log("\nOpening your browser to sign in with Microsoft...");
    run("bun", ["packages/proxy/bin/m365-login.mjs"]);
  }
}


if (problems.length > 0) {
  console.error(`\nSetup found ${problems.length} problem(s):`);

  for (const problem of problems) console.error(`  - ${problem}`);

  process.exit(1);
}

if (checkOnly) {
  console.log("\nAll checks passed.");

  process.exit(0);
}

heading("Ready");

const qualifier = backend === "m365" ? "" : `   (PROVIDER=${backend})`;

console.log(`Start the proxy with:  bun run proxy${qualifier}`);

console.log("Then point your agent at:  http://127.0.0.1:4141/v1");

console.log("Models available at:      curl -s http://127.0.0.1:4141/v1/models");

