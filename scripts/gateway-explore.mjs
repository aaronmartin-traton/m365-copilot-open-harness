// Borrow a live Island Gateway token from the authenticated Copilot Studio
// frontend, then probe whether the gateway sees OUR minimalBots agent and lets
// us read/write its components (the path to attaching an MCP tool).
//
// Usage: CHROMIUM_PATH=<path to chrome.exe> node scripts/gateway-explore.mjs
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getBrowserProfileDir } from "../packages/core/dist/index.mjs";

const OUT = join(process.cwd(), "scripts", "gateway-explore-out");
mkdirSync(OUT, { recursive: true });
const cache = JSON.parse(readFileSync(join(homedir(), ".config", "opencode-m365", "agent-id.json"), "utf8"));
const BOT_ID = cache.botId;
const TENANT = "00000000-0000-4000-8000-000000000000";
const ENV = `Default-${TENANT}`;
const GW = "https://powervamg.eu-il105.gateway.prod.island.powerapps.com";

const ROOT = process.cwd();
const pwMod = await import("../packages/core/node_modules/playwright/index.js");
const chromium = pwMod.chromium ?? pwMod.default?.chromium;

// Launch the persistent profile — already logged in from the token cache / profile.
// Keep it visible so interactive re-login can happen if the profile is signed out.
const context = await chromium.launchPersistentContext(getBrowserProfileDir(), {
  headless: false,
  timeout: 60_000,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = context.pages()[0] ?? (await context.newPage());

let gwToken = null;
let resolveToken;
const tokenReady = new Promise((r) => (resolveToken = r));
page.on("request", (req) => {
  if (gwToken) return;
  if (!/island\.powerapps\.com/i.test(req.url())) return;
  const a = req.headers()["authorization"];
  if (a) { gwToken = a.replace(/^Bearer\s+/i, ""); resolveToken(gwToken); }
});

async function login() {
  // Authenticate IN this existing context (no second launch — a second
  // launchPersistentContext on the same profile dir = "existing browser session"
  // lock). The user completes sign-in in this window; we wait for the URL to
  // leave the Microsoft login tenant.
  console.log("[gw] login required — complete sign-in in the open window");
  console.log("[gw] waiting for auth redirect back to copilotstudio...");
  try {
    await page.waitForURL((u) => !/login\.microsoftonline|oauth2|signin/i.test(u.toString()), { timeout: 180_000 });
  } catch {
    // Timed out waiting for the redirect — user may be stuck; report the URL.
    console.log("[gw] auth wait timeout, current url:", page.url());
  }
  console.log("[gw] post-auth url:", page.url());
  await page.waitForTimeout(3000);
}

const H = () => ({
  Authorization: `Bearer ${gwToken}`,
  "x-ms-client-tenant-id": TENANT,
  "x-cci-tenantid": TENANT,
  "x-cci-bapenvironmentid": ENV,
  "x-cci-cdsbotid": BOT_ID,
  "Content-Type": "application/json",
});
async function gw(method, path, body) {
  const res = await fetch(`${GW}${path}`, { method, headers: H(), ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, text };
}

try {
  await page.goto("https://copilotstudio.microsoft.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  if (/login\.microsoftonline|\/oauth2|signin/i.test(page.url())) { console.log("[gw] login..."); await login(); }
  console.log("[gw] waiting for a gateway token...");
  await Promise.race([tokenReady, page.waitForTimeout(45000)]);
  if (!gwToken) throw new Error("no gateway token captured");
  console.log(`[gw] got gateway token (len ${gwToken.length})`);
  writeFileSync(join(OUT, "gw-token.txt"), gwToken);

  // 1) Does the gateway know our bot?
  const route = await gw("GET", `/api/botmanagement/v1/environments/${ENV}/botroutinginfo?cdsBotId=${BOT_ID}`);
  console.log(`\n[1] botroutinginfo → ${route.status}\n    ${route.text.slice(0, 400)}`);
  writeFileSync(join(OUT, "botroutinginfo.json"), route.text);

  // 2) Read its components (POST = delta read per the API doc)
  const readBody = { componentEntityTags: [], publishMetadataAndDependencyValidation: false };
  const comps = await gw("POST", `/api/botmanagement/v1/environments/${ENV}/bots/${BOT_ID}/content/botcomponents`, readBody);
  console.log(`\n[2] read botcomponents → ${comps.status}\n    ${comps.text.slice(0, 600)}`);
  writeFileSync(join(OUT, "botcomponents-read.json"), comps.text);

  // 3) List all bots the gateway sees (to learn the right shape / confirm species)
  const list = await gw("GET", `/api/botmanagement/v1/environments/${ENV}/bots`);
  console.log(`\n[3] list bots → ${list.status}\n    ${list.text.slice(0, 500)}`);
  writeFileSync(join(OUT, "bots-list.json"), list.text);

  console.log(`\n[gw] outputs in ${OUT}`);
} catch (e) { console.log("[gw] error:", e.message); }
finally { await context.close(); }
