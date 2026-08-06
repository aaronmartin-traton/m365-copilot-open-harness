#!/usr/bin/env node
import { runCoworkProbe } from "../packages/core/dist/index.mjs";

const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) {
  console.error("Usage: M365_COWORK_RUNTIME_HOST=<tenant-runtime-host> bun scripts/cowork-probe.mjs <prompt>");
  process.exit(2);
}

try {
  const result = await runCoworkProbe(prompt);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
