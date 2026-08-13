// H-NATIVE-1 sideload attempt #2: Teams Developer Portal (dev.teams.microsoft.com)
// is more automation-friendly than Teams v2 and can import an app package + preview
// it in Copilot. Uses a real desktop UA (Teams v2 reset our headless client); the
// logged-in session persists in the persistent browser profile (`getBrowserProfileDir()`).
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

const shot = async (page, name) => { await page.screenshot({ path: join(OUT, name + ".png") }).catch(() => {}); console.log(`[shot] ${name}`); };
const dump = async (page, name) => { const t = await page.evaluate(() => document.body?.innerText?.slice(0, 1800) || "").catch(() => ""); writeFileSync(join(OUT, name + ".txt"), `URL: ${page.url()}\n\n${t}`); return t; };

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
  console.log("[dp] login required — complete sign-in in the open window");
  console.log("[dp] waiting for auth redirect back to dev.teams...");
  try {
    await page.waitForURL((u) => !/login\.microsoftonline|oauth2|signin/i.test(u.toString()), { timeout: 180_000 });
  } catch {
    // Timed out waiting for the redirect — user may be stuck; report the URL.
    console.log("[dp] auth wait timeout, current url:", page.url());
  }
  console.log("[dp] post-auth url:", page.url());
  await page.waitForTimeout(3000);
}

async function clickByText(re, timeout = 6000) {
  const loc = page.getByRole("button", { name: re }).first();
  try { await loc.waitFor({ state: "visible", timeout }); await loc.click(); return true; } catch {}
  const t = page.getByText(re).first();
  try { await t.waitFor({ state: "visible", timeout: 3000 }); await t.click(); return true; } catch { return false; }
}

try {
  console.log("[dp] opening Teams Developer Portal apps...");
  const resp = await page.goto("https://dev.teams.microsoft.com/apps", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(e => { console.log("[dp] goto err:", e.message); return null; });
  await page.waitForTimeout(4000);
  if (/login\.microsoftonline|oauth2|signin|\/login/i.test(page.url())) { console.log("[dp] login..."); await login(); await page.waitForTimeout(6000); }
  console.log("[dp] url:", page.url(), "status:", resp?.status());
  await shot(page, "dp-01-apps");
  const t1 = await dump(page, "dp-01-apps");

  // Import an app package.
  const importClicked = await clickByText(/Import app|Import an existing app|Import/i, 8000);
  console.log("[dp] Import clicked:", importClicked);
  await page.waitForTimeout(1500);
  let uploaded = false;
  try {
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 6000 }).catch(() => null),
      (async () => { const fi = page.locator('input[type="file"]').first(); if (await fi.count()) { await fi.setInputFiles(ZIP); uploaded = true; } })(),
    ]);
    if (chooser && !uploaded) { await chooser.setInputFiles(ZIP); uploaded = true; }
  } catch (e) { console.log("[dp] import file err:", e.message); }
  console.log("[dp] uploaded:", uploaded);
  await page.waitForTimeout(6000);
  await shot(page, "dp-02-imported");
  const t2 = await dump(page, "dp-02-imported");

  // Try "Preview in Teams"/"Preview in Copilot" to install for the user.
  const preview = await clickByText(/Preview in Copilot|Preview in Teams|Preview/i, 8000);
  console.log("[dp] Preview clicked:", preview);
  await page.waitForTimeout(8000);
  await shot(page, "dp-03-preview");
  await dump(page, "dp-03-preview");

  const gated = /isn'?t available|not allowed|contact your admin|don'?t have permission|blocked by your organization/i.test(t1 + t2);
  console.log(`\n[dp] === SUMMARY === importClicked=${importClicked} uploaded=${uploaded} preview=${preview} gated=${gated}`);
} catch (e) { console.log("[dp] ERR", e.message); await shot(page, "dp-99-error"); }
await context.close();
