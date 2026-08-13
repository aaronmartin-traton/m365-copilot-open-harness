// Isolated login probe. The silent path never opens a browser; --force runs the
// interactive persistent-profile login (visible window, human completes sign-in;
// no password/MFA in this script).
// Usage: M365_DEBUG=1 node scripts/login-probe.mjs [--force]
process.env.M365_DEBUG = process.env.M365_DEBUG ?? "1";
process.env.M365_NO_INTERACTIVE = "1";

import { getTokenSilent, loginInteractive } from "../packages/core/dist/index.mjs";

const force = process.argv.includes("--force");

const silent = await getTokenSilent();
console.log(`[probe] silent token: ${silent ? `OK (${silent.length} chars)` : "null"}`);

if (silent && !force) {
  console.log("[probe] silent works — pass --force to exercise the interactive login anyway");
  process.exitCode = 0;
} else {
  console.log("[probe] running interactive persistent-profile login (complete sign-in in the open window)...");
  try {
    const token = await loginInteractive();
    console.log(`[probe] INTERACTIVE LOGIN OK — ${token.length} chars, starts ${token.slice(0, 12)}...`);
    process.exitCode = 0;
  } catch (e) {
    console.log(`[probe] INTERACTIVE LOGIN FAILED: ${e.message}`);
    process.exitCode = 2;
  }
}
