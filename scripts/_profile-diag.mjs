// Minimal diagnostic: launch the persistent M365 profile, report page state,
// navigate, and hold the browser open. Purpose: see WHY the page closes.
import { getBrowserProfileDir } from "../packages/core/dist/index.mjs";
const pwMod = await import("../packages/core/node_modules/playwright/index.js");
const chromium = pwMod.chromium ?? pwMod.default?.chromium;

const profileDir = getBrowserProfileDir();
console.log("[diag] profileDir:", profileDir);

let context;
try {
  context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    timeout: 60_000,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  console.log("[diag] context launched OK");
} catch (e) {
  console.error("[diag] LAUNCH FAILED:", e.message.split("\n")[0]);
  process.exit(1);
}

context.on("close", () => console.log("[diag] !! CONTEXT CLOSED"));
const pages = context.pages();
console.log("[diag] existing pages:", pages.length);
for (const p of pages) {
  console.log("[diag]   page url:", p.url(), "| closed:", p.isClosed());
}
const page = pages[0] ?? (await context.newPage());
console.log("[diag] using page, isClosed:", page.isClosed());
page.on("close", () => console.log("[diag] !! PAGE CLOSED"));

try {
  console.log("[diag] goto chat...");
  await page.goto("https://m365.cloud.microsoft/chat/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3000);
  console.log("[diag] post-goto url:", page.url(), "| closed:", page.isClosed());
} catch (e) {
  console.error("[diag] GOTO/WAIT ERR:", e.message.split("\n")[0]);
  console.error("[diag] full:", e.message);
}

console.log("[diag] holding browser open — press Ctrl+C or close window to end");
await new Promise(() => {});
