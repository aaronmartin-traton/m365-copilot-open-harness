// H-NATIVE-1 GUI sideload + trigger. Logs in as the M365 user, tries to upload the
// declarative-agent app package (sentinel-agent.zip) via Teams "Upload a custom app",
// then opens the agent in Copilot and asks for the sentinel — watching whether
// Microsoft's orchestrator makes the outbound call (scripts/sentinel-hits.log).
//
// Screenshot-heavy + graceful: a single run either completes the flow or leaves
// enough diagnostics (screenshots + page text) to see exactly where it's gated.
//
// Usage: CHROMIUM_PATH=<path to chrome.exe> node scripts/da-app/sideload-gui.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getBrowserProfileDir } from "../../packages/core/dist/index.mjs";

const OUT = join(process.cwd(), "scripts", "da-app", "gui-out");
mkdirSync(OUT, { recursive: true });
const ZIP = join(process.cwd(), "scripts", "da-app", "sentinel-agent.zip");

const ROOT = process.cwd();
const pwMod = await import("../../packages/core/node_modules/playwright/index.js");
const chromium = pwMod.chromium ?? pwMod.default?.chromium;

const shot = async (page, name) => { await page.screenshot({ path: join(OUT, name + ".png"), fullPage: false }).catch(() => {}); console.log(`[shot] ${name}`); };
const dump = async (page, name) => { const t = await page.evaluate(() => document.body?.innerText?.slice(0, 1500) || "").catch(() => ""); writeFileSync(join(OUT, name + ".txt"), `URL: ${page.url()}\n\n${t}`); return t; };

// Launch the persistent profile — already logged in from the msal cache / profile.
// Keep it visible so interactive re-login can happen if the profile is signed out.
const context = await chromium.launchPersistentContext(getBrowserProfileDir(), {
  headless: false,
  timeout: 60_000,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = context.pages()[0] ?? (await context.newPage());

async function login() {
  // Authenticate IN this existing context (no second launch — a second
  // launchPersistentContext on the same profile dir = "existing browser session"
  // lock). The user completes sign-in in this window; we wait for the URL to
  // leave the Microsoft login tenant.
  console.log("[da] login required — complete sign-in in the open window");
  console.log("[da] waiting for auth redirect back to m365.cloud...");
  try {
    await page.waitForURL((u) => !/login\.microsoftonline|oauth2|signin/i.test(u.toString()), { timeout: 180_000 });
  } catch {
    // Timed out waiting for the redirect — user may be stuck; report the URL.
    console.log("[da] auth wait timeout, current url:", page.url());
  }
  console.log("[da] post-auth url:", page.url());
  await page.waitForTimeout(3000);
}

async function clickByText(re, timeout = 6000) {
  const loc = page.getByText(re).first();
  try { await loc.waitFor({ state: "visible", timeout }); await loc.click(); return true; } catch { return false; }
}

try {
  // 1) Establish SSO via Copilot, then go to Teams apps.
  console.log("[da] login via m365 copilot...");
  await page.goto("https://m365.cloud.microsoft/chat/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  if (/login\.microsoftonline|oauth2|signin|\/login/i.test(page.url())) { await login(); }
  await page.waitForTimeout(5000);
  console.log("[da] post-login url:", page.url());
  await shot(page, "01-copilot");

  // 2) Navigate to Teams web apps → Manage your apps → Upload a custom app.
  console.log("[da] navigating to Teams apps...");
  await page.goto("https://teams.microsoft.com/v2/apps", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(8000);
  if (/login\.microsoftonline|oauth2|signin/i.test(page.url())) { await login(); await page.waitForTimeout(6000); }
  await shot(page, "02-teams-apps");
  const appsText = await dump(page, "02-teams-apps");
  console.log("[da] teams apps url:", page.url());

  // Look for "Manage your apps" then "Upload"
  const foundManage = await clickByText(/Manage your apps/i, 8000);
  console.log("[da] clicked 'Manage your apps':", foundManage);
  await page.waitForTimeout(4000);
  await shot(page, "03-manage");
  await dump(page, "03-manage");

  const foundUpload = await clickByText(/Upload an app|Upload a custom app|Upload custom app/i, 8000);
  console.log("[da] clicked 'Upload an app':", foundUpload);
  await page.waitForTimeout(3000);
  await shot(page, "04-upload-dialog");
  const upText = await dump(page, "04-upload-dialog");

  // Detect whether custom-app upload is available at all (gate signal).
  const gated = /isn'?t available|not allowed|contact your admin|don'?t have permission|upload.*disabled/i.test(appsText + upText);
  console.log("[da] custom-app upload appears GATED:", gated);

  // Try to set the file on any file input present (the "Upload a custom app" chooser).
  let uploaded = false;
  try {
    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.count()) {
      await fileInput.setInputFiles(ZIP);
      uploaded = true;
      console.log("[da] set zip on file input");
      await page.waitForTimeout(6000);
      await shot(page, "05-after-upload");
      await dump(page, "05-after-upload");
    } else {
      // Some flows need an explicit "Upload a custom app" sub-button that triggers a filechooser.
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 6000 }).catch(() => null),
        clickByText(/Upload a custom app|Upload custom app|Submit a custom app/i, 5000),
      ]);
      if (chooser) { await chooser.setInputFiles(ZIP); uploaded = true; console.log("[da] filechooser accepted zip"); await page.waitForTimeout(6000); await shot(page, "05-after-upload"); await dump(page, "05-after-upload"); }
    }
  } catch (e) { console.log("[da] upload attempt error:", e.message); }
  console.log("[da] uploaded:", uploaded);

  // If an "Add" / "Open" appears after upload, click it to install the agent.
  await clickByText(/^Add$|^Open$|Add to a team|Add for me/i, 6000).catch(() => {});
  await page.waitForTimeout(4000);
  await shot(page, "06-final");
  await dump(page, "06-final");

  console.log(`\n[da] === SUMMARY === gated=${gated} uploaded=${uploaded}`);
} catch (e) {
  console.log("[da] ERR", e.message);
  await shot(page, "99-error");
}
await context.close();
