// H-NATIVE-1 end-to-end (headful under Xvfb so heavy SPAs render):
// 1) Developer Portal → Preview in Teams → complete the install ("Add") dialog.
// 2) M365 Copilot chat → open the "Sentinel Probe" agent → ask for the sentinel.
// Oracle: scripts/sentinel-hits.log gains a Microsoft-originated GET /sentinel, and
// the reply contains the sentinel value. Screenshot-heavy + adaptive.
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getBrowserProfileDir } from "../../packages/core/dist/index.mjs";

const OUT = join(process.cwd(), "scripts", "da-app", "gui-out");
mkdirSync(OUT, { recursive: true });
const HITLOG = join(process.cwd(), "scripts", "sentinel-hits.log");
const SENTINEL = readFileSync(join(process.cwd(), "scripts", "sentinel-value.txt"), "utf8").trim();
const APP_ID = "5e27c1a0-7b3d-4f2a-9c11-a1b2c3d4e5f6";
const ROOT = process.cwd();
const pwMod = await import("../../packages/core/node_modules/playwright/index.js");
const chromium = pwMod.chromium ?? pwMod.default?.chromium;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const hitCount = () => { try { return readFileSync(HITLOG, "utf8").split("\n").filter(l => /\/sentinel\b/.test(l) && !/openapi/.test(l)).length; } catch { return 0; } };
const shot = async (p, n) => { await p.screenshot({ path: join(OUT, n + ".png") }).catch(() => {}); console.log(`[shot] ${n}`); };
const dump = async (p, n) => { const t = await p.evaluate(() => document.body?.innerText?.slice(0, 2500) || "").catch(() => ""); writeFileSync(join(OUT, n + ".txt"), `URL: ${p.url()}\n\n${t}`); return t; };
const click = async (p, re, timeout = 6000) => {
  for (const c of [p.getByRole("button", { name: re }), p.getByRole("menuitem", { name: re }), p.getByRole("link", { name: re }), p.getByText(re)]) {
    const loc = c.first();
    try { await loc.waitFor({ state: "visible", timeout }); await loc.click(); return true; } catch {}
  }
  return false;
};
const login = async (page) => {
  // Authenticate IN this existing context (no second launch — a second
  // launchPersistentContext on the same profile dir = "existing browser session"
  // lock). The user completes sign-in in this window; we wait for the URL to
  // leave the Microsoft login tenant.
  console.log("[e2e] login required — complete sign-in in the open window");
  console.log("[e2e] waiting for auth redirect back to m365.cloud...");
  try {
    await page.waitForURL((u) => !/login\.microsoftonline|oauth2|signin/i.test(u.toString()), { timeout: 180_000 });
  } catch {
    // Timed out waiting for the redirect — user may be stuck; report the URL.
    console.log("[e2e] auth wait timeout, current url:", page.url());
  }
  console.log("[e2e] post-auth url:", page.url());
  await page.waitForTimeout(3000);
};

const before = hitCount();
console.log(`[e2e] sentinel /sentinel hits before: ${before}  (sentinel=${SENTINEL})`);

// Launch the persistent profile — already logged in from the msal cache / profile.
// Keep it visible so interactive re-login can happen if the profile is signed out.
const context = await chromium.launchPersistentContext(getBrowserProfileDir(), {
  headless: false,
  timeout: 60_000,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  userAgent: UA,
  viewport: { width: 1440, height: 900 },
});
const page = context.pages()[0] ?? (await context.newPage());

try {
  // --- 1) Install via Developer Portal preview ---
  console.log("[e2e] developer portal dashboard...");
  await page.goto(`https://dev.teams.microsoft.com/apps/${APP_ID}/dashboard`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(5000);
  if (/login\.microsoftonline|oauth2|signin/i.test(page.url())) { await login(page); await page.waitForTimeout(6000); }
  await shot(page, "e-01-dashboard");

  await click(page, /Preview in Teams|Preview in Copilot|^Preview$/i, 10000);
  console.log("[e2e] preview clicked; waiting for Teams install to render...");
  await page.waitForTimeout(12000);
  // Preview may be same tab or a popup.
  let teams = context.pages()[context.pages().length - 1];
  await teams.waitForTimeout(8000).catch(() => {});
  await shot(teams, "e-02-teams-install");
  await dump(teams, "e-02-teams-install");
  // Complete the install dialog.
  const added = await click(teams, /^Add$|^Open$|^Add for me$|Install|Continue/i, 12000);
  console.log("[e2e] install confirm clicked:", added);
  await teams.waitForTimeout(9000);
  await shot(teams, "e-03-installed");
  await dump(teams, "e-03-installed");

  // --- 2) Trigger in Copilot ---
  console.log("[e2e] opening Copilot chat...");
  const cop = await context.newPage();
  await cop.goto("https://m365.cloud.microsoft/chat/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await cop.waitForTimeout(9000);
  if (/login\.microsoftonline|oauth2|signin/i.test(cop.url())) { await login(cop); await cop.waitForTimeout(8000); }
  await shot(cop, "e-04-copilot");

  // Select the Sentinel Probe agent (right rail / agent flyout).
  const openedAgent = await click(cop, /Sentinel Probe/i, 10000);
  console.log("[e2e] agent 'Sentinel Probe' opened:", openedAgent);
  await cop.waitForTimeout(5000);
  await shot(cop, "e-05-agent");
  await dump(cop, "e-05-agent");

  // Optional: pick "Think Deeper" model if a model picker is present.
  await click(cop, /Think Deeper/i, 4000).catch(() => {});

  // Type the question into the composer.
  const composerSels = ['div[contenteditable="true"]', 'textarea', '[role="textbox"]'];
  let box = null;
  for (const s of composerSels) { const l = cop.locator(`${s}:visible`).first(); if (await l.count().catch(() => 0)) { box = l; break; } }
  if (box) {
    await box.click().catch(() => {});
    await cop.keyboard.type("What is the magic sentinel token? Use your getMagicSentinel action and report the exact value.", { delay: 6 });
    await cop.waitForTimeout(500);
    await cop.keyboard.press("Enter");
    console.log("[e2e] question sent; waiting for the agent to call the action...");
    await cop.waitForTimeout(35000);
    await shot(cop, "e-06-answer");
    const ans = await dump(cop, "e-06-answer");
    console.log("[e2e] reply contains sentinel value:", ans.includes(SENTINEL));
  } else {
    console.log("[e2e] no composer found");
    await dump(cop, "e-06-no-composer");
  }

  const after = hitCount();
  console.log(`\n[e2e] === RESULT === sentinel /sentinel hits: before=${before} after=${after}  DELTA=${after - before}`);
  console.log(after > before ? "🎉 MICROSOFT'S ORCHESTRATOR CALLED OUR ENDPOINT — native action fired" : "❌ no outbound call to our endpoint observed");
} catch (e) { console.log("[e2e] ERR", e.message); await shot(page, "e-99-error"); }
await context.close();
console.log(`[e2e] final /sentinel hits: ${hitCount()}`);
