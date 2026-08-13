// Create a REAL (full, Dataverse-backed) Copilot Studio agent via the UI, capture
// its cdsBotId + the gateway create/publish calls, so we can then test whether a
// full bot is reachable over the BizChat WebSocket (the decisive MCP question).
//
// Captures every gateway POST/PUT body + screenshots each step so the flow can be
// debugged/iterated. Uses the msal/persistent-profile auth path (no password/MFA
// in this script). Usage: CHROMIUM_PATH=<path to chrome.exe> node scripts/create-full-bot.mjs
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { getBrowserProfileDir } from "../packages/core/dist/index.mjs";

const OUT = join(process.cwd(), "scripts", "create-full-bot-out");
mkdirSync(OUT, { recursive: true });
const NAME = `mcp-fullbot-${Date.now().toString(36)}`;

const ROOT = process.cwd();
const pwMod = await import("../packages/core/node_modules/playwright/index.js");
const chromium = pwMod.chromium ?? pwMod.default?.chromium;

// Launch the persistent profile — already logged in from the msal cache / profile.
// Keep it visible so interactive re-login can happen if the profile is signed out.
const context = await chromium.launchPersistentContext(getBrowserProfileDir(), {
  headless: false,
  timeout: 60_000,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = context.pages()[0] ?? (await context.newPage());
page.setDefaultTimeout(45000);

const gwLog = join(OUT, "gateway-calls.ndjson");
const seenBotIds = new Set();
page.on("request", (req) => {
  const u = req.url();
  if (!/island\.powerapps\.com|dynamics\.com\/api\/data/i.test(u)) return;
  const m = req.method();
  if (m === "POST" || m === "PUT" || m === "PATCH") {
    let body = ""; try { body = req.postData() || ""; } catch {}
    appendFileSync(gwLog, JSON.stringify({ t: Date.now(), method: m, url: u.split("?")[0], body: body.slice(0, 4000) }) + "\n");
  }
});
page.on("response", async (res) => {
  const u = res.url();
  if (!/island\.powerapps\.com.*\/bots\b|\/bots\?|botprovisioning|createbot/i.test(u)) return;
  try { const t = await res.text(); const ids = [...t.matchAll(/"(?:cdsBotId|botId|id)"\s*:\s*"([0-9a-f-]{36})"/gi)].map(x => x[1]); ids.forEach(i => seenBotIds.add(i)); } catch {}
});

const shot = async (n) => { try { await page.screenshot({ path: join(OUT, `${n}.png`) }); writeFileSync(join(OUT, `${n}.url.txt`), page.url()); } catch {} };

async function login() {
  // Authenticate IN this existing context (no second launch — a second
  // launchPersistentContext on the same profile dir = "existing browser session"
  // lock). The user completes sign-in in this window; we wait for the URL to
  // leave the Microsoft login tenant.
  console.log("[cf] login required — complete sign-in in the open window");
  console.log("[cf] waiting for auth redirect back to copilotstudio...");
  try {
    await page.waitForURL((u) => !/login\.microsoftonline|oauth2|signin/i.test(u.toString()), { timeout: 180_000 });
  } catch {
    // Timed out waiting for the redirect — user may be stuck; report the URL.
    console.log("[cf] auth wait timeout, current url:", page.url());
  }
  console.log("[cf] post-auth url:", page.url());
  await page.waitForTimeout(3000);
}

async function tryClick(rx, label) {
  for (const loc of [page.getByRole("button", { name: rx }), page.getByRole("link", { name: rx }), page.locator(`text=${rx}`)]) {
    try { const el = loc.first(); if (await el.count()) { await el.click({ timeout: 6000 }); console.log(`[cf] clicked ${label}`); return true; } } catch {}
  }
  return false;
}

try {
  console.log(`[cf] creating agent: ${NAME}`);
  await page.goto("https://copilotstudio.microsoft.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  if (/login\.microsoftonline|\/oauth2|signin/i.test(page.url())) { console.log("[cf] login..."); await login(); }
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(6000);
  await shot("01-home");
  console.log("[cf] home:", page.url());

  // Enter the create flow
  if (!(await tryClick(/new agent/i, "New agent"))) {
    if (!(await tryClick(/create/i, "Create"))) { await page.goto(page.url().replace(/\/home.*/, "") + "/agents/new", { waitUntil: "domcontentloaded" }).catch(()=>{}); }
  }
  await page.waitForTimeout(5000); await shot("02-create-entry");

  // Many tenants open a conversational builder; look for "Skip to configure" / "Configure"
  await tryClick(/skip to configure|configure|skip/i, "skip-to-configure");
  await page.waitForTimeout(4000); await shot("03-configure");

  // Fill a name if there's a name field
  for (const sel of ['input[aria-label*="name" i]', 'input[placeholder*="name" i]', 'input[type="text"]']) {
    try { const el = page.locator(`${sel}:visible`).first(); if (await el.count()) { await el.fill(NAME); console.log(`[cf] filled name via ${sel}`); break; } } catch {}
  }
  await page.waitForTimeout(1500); await shot("04-named");

  // Create / Save
  await tryClick(/^create$|^save$|create agent/i, "create/save");
  await page.waitForTimeout(12000); await shot("05-after-create");
  console.log("[cf] post-create url:", page.url());

  // botId often in the URL: .../bots/{guid}/... or .../agents/{guid}
  const urlId = page.url().match(/(?:bots|agents)\/([0-9a-f-]{36})/i)?.[1];
  if (urlId) seenBotIds.add(urlId);

  await page.waitForTimeout(3000);
} catch (e) { console.log("[cf] error:", e.message); await shot("99-error"); }
finally {
  writeFileSync(join(OUT, "bot-ids.json"), JSON.stringify([...seenBotIds], null, 2));
  console.log(`\n[cf] === RESULT ===`);
  console.log(`[cf] captured bot ids: ${[...seenBotIds].join(", ") || "(none — inspect screenshots)"}`);
  console.log(`[cf] name: ${NAME}`);
  console.log(`[cf] gateway POST/PUT bodies → ${gwLog}`);
  console.log(`[cf] screenshots → ${OUT}`);
  await context.close();
}
