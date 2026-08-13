// Reverse-engineering dig: log into the real Copilot Studio web UI and capture
// every API call it makes, to discover (a) the endpoint that returns a full
// agent definition and (b) whether an agent can be bound to a model. Read-only
// — we only navigate and observe; we never save/publish anything.
// Usage: CHROMIUM_PATH=<path to chrome.exe> node scripts/studio-dig.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { getBrowserProfileDir } from "../packages/core/dist/index.mjs";

const OUT = join(process.cwd(), "scripts", "studio-dig-out");
mkdirSync(OUT, { recursive: true });

const cache = JSON.parse(readFileSync(join(homedir(), ".config", "opencode-m365", "agent-id.json"), "utf-8"));
const botId = cache.botId;

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

// --- network capture ---
const apiHits = new Set();
const modelHits = [];
const KW = /model|deployment|llm|gpt[-_]?[0-9]|reasoning|aiModel|tone|capabilit/i;
const isApi = (u) => /\/(api|copilotstudio|powerplatform|bots?|agents?|environments)\b/i.test(u) && !/\.(js|css|png|svg|woff2?|json\?v=|map)$/i.test(u);

page.on("response", async (res) => {
  const u = res.url();
  if (!isApi(u)) return;
  apiHits.add(`${res.request().method()} ${u.split("?")[0]}`);
  const ct = res.headers()["content-type"] || "";
  if (!ct.includes("json")) return;
  try {
    const body = await res.text();
    if (KW.test(body)) {
      modelHits.push({ url: u.split("?")[0], status: res.status(), snippet: body.slice(0, 0) });
      // pull just the model-ish key/value fragments
      const frags = [...body.matchAll(/"([^"]*(?:model|deployment|gpt[-_]?\d|reasoning|aiModel|tone)[^"]*)"\s*:\s*("[^"]{0,80}"|\[[^\]]{0,120}\]|[\w.-]{0,40})/gi)]
        .map((m) => `${m[1]} = ${m[2]}`);
      if (frags.length) modelHits.push({ url: u.split("?")[0], frags: [...new Set(frags)].slice(0, 25) });
    }
  } catch {}
});

async function login() {
  // Authenticate IN this existing context (no second launch — a second
  // launchPersistentContext on the same profile dir = "existing browser session"
  // lock). The user completes sign-in in this window; we wait for the URL to
  // leave the Microsoft login tenant.
  console.log("[dig] login required — complete sign-in in the open window");
  console.log("[dig] waiting for auth redirect back to copilotstudio...");
  try {
    await page.waitForURL((u) => !/login\.microsoftonline|oauth2|signin/i.test(u.toString()), { timeout: 180_000 });
  } catch {
    // Timed out waiting for the redirect — user may be stuck; report the URL.
    console.log("[dig] auth wait timeout, current url:", page.url());
  }
  console.log("[dig] post-auth url:", page.url());
  await page.waitForTimeout(3000);
}

const shot = async (n) => { try { await page.screenshot({ path: join(OUT, `${n}.png`), fullPage: true }); writeFileSync(join(OUT, `${n}.url.txt`), page.url()); } catch {} };

try {
  console.log("[dig] navigating to Copilot Studio...");
  await page.goto("https://copilotstudio.microsoft.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  if (/login\.microsoftonline|\/oauth2|signin/i.test(page.url())) {
    console.log("[dig] login form, driving AAD...");
    await login();
  }
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(5000);
  await shot("01-home");
  console.log("[dig] home url:", page.url());

  // Try to open our agent directly — capture the definition-load API calls.
  const envSeg = page.url().match(/environments\/([^/]+)/)?.[1];
  if (envSeg) {
    for (const path of [`/environments/${envSeg}/bots/${botId}/overview`, `/environments/${envSeg}/bots/${botId}/settings`, `/environments/${envSeg}/bots/${botId}/configuration`]) {
      console.log("[dig] nav", path);
      await page.goto(`https://copilotstudio.microsoft.com${path}`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 40000 }).catch(() => {});
      await page.waitForTimeout(4000);
      await shot(`02-${path.split("/").pop()}`);
    }
  }
  // Scan the rendered settings page for a model picker.
  const modelUi = await page.locator('text=/model|GPT|reasoning|deep/i').allInnerTexts().catch(() => []);
  writeFileSync(join(OUT, "model-ui-text.txt"), modelUi.join("\n"));
} catch (e) {
  console.log("[dig] error:", e.message);
  await shot("99-error");
} finally {
  writeFileSync(join(OUT, "api-endpoints.txt"), [...apiHits].sort().join("\n"));
  writeFileSync(join(OUT, "model-hits.json"), JSON.stringify(modelHits, null, 2));
  console.log(`\n[dig] ${apiHits.size} distinct API endpoints, ${modelHits.length} model-related responses`);
  console.log("[dig] model-ish fragments:");
    for (const h of modelHits.filter((m) => m.frags)) {
      console.log(`  --- ${h.url}`);
      for (const f of h.frags) console.log("    " + f);
    }
  await context.close();
}
