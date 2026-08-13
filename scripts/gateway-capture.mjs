// Capture the Island Gateway URL + the TOKEN RESOURCE the real Copilot Studio
// frontend uses, by driving copilotstudio.microsoft.com and reading the
// Authorization header (decode JWT `aud`) off its gateway calls. Unblocks the
// MCP-tool path (we need to know which token to acquire + the gateway host).
//
// Usage: CHROMIUM_PATH=<path to chrome.exe> node scripts/gateway-capture.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getBrowserProfileDir } from "../packages/core/dist/index.mjs";

const OUT = join(process.cwd(), "scripts", "gateway-capture-out");
mkdirSync(OUT, { recursive: true });

const ROOT = process.cwd();
const pwMod = await import("../packages/core/node_modules/playwright/index.js");
const chromium = pwMod.chromium ?? pwMod.default?.chromium;

function jwtAud(auth) {
  try { const t = auth.replace(/^Bearer\s+/i, ""); const p = JSON.parse(Buffer.from(t.split(".")[1].replace(/-/g,"+").replace(/_/g,"/") + "==", "base64").toString()); return { aud: p.aud, appid: p.appid, scp: p.scp }; } catch { return null; }
}

// Launch the persistent profile — already logged in from the msal cache / profile.
// Keep it visible so interactive re-login can happen if the profile is signed out.
const context = await chromium.launchPersistentContext(getBrowserProfileDir(), {
  headless: false,
  timeout: 60_000,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = context.pages()[0] ?? (await context.newPage());

const gatewayCalls = new Map(); // url-path -> {method, aud, appid}
const interesting = /island\.powerapps\.com|powervamg|botmanagement|gateway\.prod/i;

page.on("request", (req) => {
  const u = req.url();
  if (!interesting.test(u)) return;
  const auth = req.headers()["authorization"];
  const key = req.method() + " " + u.split("?")[0];
  if (!gatewayCalls.has(key)) {
    gatewayCalls.set(key, { method: req.method(), url: u.split("?")[0], host: new URL(u).host, ...(auth ? { token: jwtAud(auth) } : { token: null }) });
    console.log(`[gw] ${key}\n     host=${new URL(u).host} aud=${auth ? JSON.stringify(jwtAud(auth)) : "(no auth hdr)"}`);
  }
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

try {
  console.log("[gw] navigating to Copilot Studio...");
  await page.goto("https://copilotstudio.microsoft.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  if (/login\.microsoftonline|\/oauth2|signin/i.test(page.url())) { console.log("[gw] login..."); await login(); }
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(6000);
  // Click into "Agents" to trigger more gateway calls
  for (const sel of ['text=/agents/i', 'text=/create/i']) {
    try { await page.locator(sel).first().click({ timeout: 5000 }); await page.waitForTimeout(5000); } catch {}
  }
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);
} catch (e) { console.log("[gw] err", e.message); }
finally {
  writeFileSync(join(OUT, "gateway-calls.json"), JSON.stringify([...gatewayCalls.values()], null, 2));
  const hosts = [...new Set([...gatewayCalls.values()].map(c => c.host))];
  const auds = [...new Set([...gatewayCalls.values()].map(c => c.token?.aud).filter(Boolean))];
  console.log(`\n[gw] === SUMMARY ===`);
  console.log(`[gw] gateway hosts: ${hosts.join(", ") || "(none captured)"}`);
  console.log(`[gw] token audiences: ${auds.join(", ") || "(none)"}`);
  console.log(`[gw] ${gatewayCalls.size} distinct gateway calls → ${join(OUT, "gateway-calls.json")}`);
  await context.close();
}
