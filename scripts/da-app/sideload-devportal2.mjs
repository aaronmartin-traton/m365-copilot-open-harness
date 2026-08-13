// Continue the Developer Portal sideload: the package validates ("No issues found");
// now commit Import, open the app, and Preview-in-Copilot to install it for the user.
// Session comes from the persistent browser profile (`getBrowserProfileDir()`).
// Screenshot-heavy + adaptive.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getBrowserProfileDir } from "../../packages/core/dist/index.mjs";

const OUT = join(process.cwd(), "scripts", "da-app", "gui-out");
mkdirSync(OUT, { recursive: true });
const ZIP = join(process.cwd(), "scripts", "da-app", "sentinel-agent.zip");

const ROOT = process.cwd();
const pwMod = await import("../../packages/core/node_modules/playwright/index.js");
const chromium = pwMod.chromium ?? pwMod.default?.chromium;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const shot = async (page, n) => { await page.screenshot({ path: join(OUT, n + ".png") }).catch(() => {}); console.log(`[shot] ${n}`); };
const dump = async (page, n) => { const t = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || "").catch(() => ""); writeFileSync(join(OUT, n + ".txt"), `URL: ${page.url()}\n\n${t}`); return t; };
const clickBtn = async (page, re, timeout = 6000) => {
  for (const cand of [page.getByRole("button", { name: re }), page.getByText(re)]) {
    const loc = cand.last();
    try { await loc.waitFor({ state: "visible", timeout }); await loc.click(); return true; } catch {}
  }
  return false;
};

// Launch the persistent profile — already logged in from the msal cache / profile.
// Keep it visible so interactive re-login can happen if the profile is signed out.
const context = await chromium.launchPersistentContext(getBrowserProfileDir(), {
  headless: false,
  timeout: 60_000,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  userAgent: UA,
  viewport: { width: 1400, height: 900 },
});
const page = context.pages()[0] ?? (await context.newPage());

async function login() {
  // Authenticate IN this existing context (no second launch — a second
  // launchPersistentContext on the same profile dir = "existing browser session"
  // lock). The user completes sign-in in this window; we wait for the URL to
  // leave the Microsoft login tenant.
  console.log("[c] login required — complete sign-in in the open window");
  console.log("[c] waiting for auth redirect back to dev.teams...");
  try {
    await page.waitForURL((u) => !/login\.microsoftonline|oauth2|signin/i.test(u.toString()), { timeout: 180_000 });
  } catch {
    // Timed out waiting for the redirect — user may be stuck; report the URL.
    console.log("[c] auth wait timeout, current url:", page.url());
  }
  console.log("[c] post-auth url:", page.url());
  await page.waitForTimeout(3000);
}

try {
  await page.goto("https://dev.teams.microsoft.com/apps", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(5000);
  if (/login\.microsoftonline|oauth2|signin|\/login/i.test(page.url())) { console.log("[c] login..."); await login(); await page.waitForTimeout(6000); }
  await shot(page, "c-01-apps");

  // Fresh import: click Import app, set file, wait for validation, click confirm Import.
  await clickBtn(page, /^Import app$|Import an existing app|^Import$/i, 8000);
  await page.waitForTimeout(1500);
  try { const fi = page.locator('input[type="file"]').first(); if (await fi.count()) await fi.setInputFiles(ZIP); } catch (e) { console.log("[c] file err", e.message); }
  await page.waitForTimeout(3000);
  await dump(page, "c-02-validated");
  // Click the dialog's confirm Import (last "Import" button on screen).
  const confirmed = await clickBtn(page, /^Import$/i, 8000);
  console.log("[c] confirm Import clicked:", confirmed);
  await page.waitForTimeout(6000);
  await shot(page, "c-03-after-import");
  const t3 = await dump(page, "c-03-after-import");

  // Open the imported app (by name).
  await clickBtn(page, /Sentinel Probe|Sentinel Native Action Probe/i, 8000);
  await page.waitForTimeout(4000);
  await shot(page, "c-04-app");
  await dump(page, "c-04-app");

  // Preview in Copilot / Teams to install it for this user.
  let previewed = await clickBtn(page, /Preview in Copilot/i, 6000);
  if (!previewed) previewed = await clickBtn(page, /Preview in Teams|^Preview$/i, 6000);
  console.log("[c] preview clicked:", previewed);
  await page.waitForTimeout(9000);
  // Handle a possible new tab (preview may open Copilot/Teams in a popup).
  const pages = context.pages();
  const active = pages[pages.length - 1];
  await active.waitForTimeout(4000).catch(() => {});
  await shot(active, "c-05-preview");
  const t5 = await dump(active, "c-05-preview");
  // Accept any "Add"/"Open"/consent to finish install.
  await clickBtn(active, /^Add$|^Open$|^Add for me$|Continue|Allow/i, 6000).catch(() => {});
  await active.waitForTimeout(6000).catch(() => {});
  await shot(active, "c-06-installed");
  await dump(active, "c-06-installed");

  const gated = /isn'?t available|not allowed|contact your admin|don'?t have permission|blocked by your organization|custom apps.*not/i.test(t3 + t5);
  console.log(`\n[c] === SUMMARY === confirmed=${confirmed} previewed=${previewed} gated=${gated} pages=${pages.length}`);
} catch (e) { console.log("[c] ERR", e.message); await shot(page, "c-99-error"); }
await context.close();
