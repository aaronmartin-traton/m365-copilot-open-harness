// Launch the persistent M365 profile WITH a CDP debug port so the omp browser
// tool can attach to the live tabs. Holds the browser open.
// Usage: CHROMIUM_PATH=... node scripts/_profile-cdp.mjs [port]
import { getBrowserProfileDir } from "../packages/core/dist/index.mjs";
const pwMod = await import("../packages/core/node_modules/playwright/index.js");
const chromium = pwMod.chromium ?? pwMod.default?.chromium;

const PORT = process.argv[2] ?? "9222";
const profileDir = getBrowserProfileDir();
console.log("[cdp] profileDir:", profileDir, "port:", PORT);

let context;
try {
  context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    timeout: 60_000,
    executablePath: process.env.CHROMIUM_PATH,
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--remote-debugging-port=${PORT}`],
  });
  console.log("[cdp] context launched, CDP on port", PORT);
} catch (e) {
  console.error("[cdp] LAUNCH FAILED:", e.message.split("\n")[0]);
  process.exit(1);
}

context.on("close", () => console.log("[cdp] !! CONTEXT CLOSED"));
console.log("[cdp] holding browser open — Ctrl+C / close window to end");
await new Promise(() => {});
