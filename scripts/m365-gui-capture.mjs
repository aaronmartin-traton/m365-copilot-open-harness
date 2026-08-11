// Capture what Microsoft's OWN M365 Copilot web client sends/receives over the
// substrate Chathub WebSocket — to VERIFY our Disengage model with eyes-on and to
// diff the GUI's request payload (optionsSets / variants / agent / tone) against
// ours. Uses the msal/persistent-profile auth path (no password/MFA in this
// script); the msal cache + persistent Playwright profile keep the session logged in.
//
// Usage: CHROMIUM_PATH=<path to chrome.exe> node scripts/m365-gui-capture.mjs ["task text"]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getBrowserProfileDir } from "../packages/core/dist/index.mjs";

const OUT = join(process.cwd(), "scripts", "gui-capture-out");
mkdirSync(OUT, { recursive: true });

const ROOT = process.cwd();
const pwMod = await import("../packages/core/node_modules/playwright/index.js");
const chromium = pwMod.chromium ?? pwMod.default?.chromium;

const TASK = process.argv[2] || "Edit config.json so the port is 8080 instead of 3000. Leave every other field unchanged.";
const RS = "\x1e";

// Launch the persistent profile — already logged in from the msal cache / profile.
// headless:true would work too but the persistent profile is validated headful;
// keep it visible so interactive re-login can happen if the profile is signed out.
const context = await chromium.launchPersistentContext(getBrowserProfileDir(), {
  headless: false,
  timeout: 60_000,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = context.pages()[0] ?? (await context.newPage());

const frames = [];
let chathubUrl = null, sawDisengaged = false, firstChatPayload = null, botText = "";

page.on("websocket", (ws) => {
  const u = ws.url();
  if (!/Chathub|substrate\.office\.com/i.test(u)) return;
  chathubUrl = u;
  console.log(`[ws] OPEN ${u.slice(0, 150)}`);
  const handle = (dir) => (data) => {
    const payload = typeof data === "string" ? data : (data?.payload ?? "");
    for (const f of String(payload).split(RS)) {
      if (!f) continue;
      let p; try { p = JSON.parse(f); } catch { continue; }
      frames.push({ dir, p });
      if (dir === "send" && p.type === 4 && p.target === "chat" && !firstChatPayload) {
        firstChatPayload = p; console.log("[ws] captured GUI outbound chat payload");
      }
      const s = JSON.stringify(p);
      if (/"messageType":"Disengaged"|Conversation disengaged/.test(s)) { sawDisengaged = true; console.log("[ws] !! DISENGAGED"); }
      const m = s.match(/"text":"((?:[^"\\]|\\.){0,160})/); if (dir === "recv" && m && m[1].length > botText.length) botText = m[1];
    }
  };
  ws.on("framesent", handle("send"));
  ws.on("framereceived", handle("recv"));
});

async function login() {
  // Authenticate IN this existing context (no second launch — a second
  // launchPersistentContext on the same profile dir is what caused the
  // "existing browser session" lock). The user completes sign-in in this
  // window; we wait for the URL to leave the Microsoft login tenant.
  console.log("[gui] login required — complete sign-in in the open window");
  console.log("[gui] waiting for auth redirect back to m365.cloud...");
  try {
    await page.waitForURL((u) => !/login\.microsoftonline|oauth2|signin/i.test(u.toString()), { timeout: 180_000 });
  } catch {
    // Timed out waiting for the redirect — user may be stuck; report the URL.
    console.log("[gui] auth wait timeout, current url:", page.url());
  }
  console.log("[gui] post-auth url:", page.url());
  await page.waitForTimeout(3000);
}

try {
  console.log("[gui] navigating to M365 Copilot chat...");
  await page.goto("https://m365.cloud.microsoft/chat/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  if (/login\.microsoftonline|oauth2|signin|\/login/i.test(page.url())) { console.log("[gui] login..."); await login(); }
  await page.waitForTimeout(6000);
  console.log("[gui] url:", page.url());
  await page.screenshot({ path: join(OUT, "after-login.png"), fullPage: false }).catch(() => {});

  // Find the chat composer — try common shapes.
  const sels = ['div[contenteditable="true"]:visible', 'textarea:visible', '[role="textbox"]:visible'];
  let box = null;
  for (const s of sels) { const loc = page.locator(s).first(); if (await loc.count().catch(() => 0)) { box = loc; console.log("[gui] composer:", s); break; } }
  if (box) {
    await box.click().catch(() => {});
    await page.keyboard.type(TASK, { delay: 8 });
    await page.waitForTimeout(600);
    await page.keyboard.press("Enter");
    console.log("[gui] message sent; waiting for response/WS...");
    await page.waitForTimeout(22000);
  } else {
    console.log("[gui] NO composer found — capturing page text for diagnosis");
    const txt = await page.evaluate(() => document.body.innerText.slice(0, 800)).catch(() => "");
    console.log(txt);
  }
  await page.screenshot({ path: join(OUT, "after-send.png"), fullPage: false }).catch(() => {});
} catch (e) { console.log("[gui] ERR", e.message); }

writeFileSync(join(OUT, "frames.json"), JSON.stringify({ chathubUrl, sawDisengaged, frameCount: frames.length, firstChatPayload, frames: frames.slice(0, 60) }, null, 2));
console.log(`\n[gui] === RESULT === chathub=${chathubUrl ? "yes" : "NO"} disengaged=${sawDisengaged} frames=${frames.length} botText="${botText.slice(0, 80)}"`);
if (chathubUrl) {
  try { const q = new URL(chathubUrl.replace(/^wss/, "https")).searchParams; console.log("[gui] WS query keys:", [...q.keys()].join(",")); console.log("[gui] variants:", q.get("variants")); } catch {}
}
if (firstChatPayload) {
  const a = firstChatPayload.arguments?.[0] ?? {};
  console.log("[gui] optionsSets:", JSON.stringify(a.optionsSets));
  console.log("[gui] threadLevelGptId:", JSON.stringify(a.threadLevelGptId), "gpts:", JSON.stringify(a.gpts));
  console.log("[gui] plugins:", JSON.stringify(a.plugins), "tone:", a.tone, "source:", a.source);
  console.log("[gui] allowedMessageTypes:", JSON.stringify(a.allowedMessageTypes));
}

// M365_KEEP_OPEN=1 keeps the persistent-profile browser alive for an interactive
// investigation session (frames keep collecting on the WS listener). The process
// stays up until the user closes the browser window (context 'close' event) or
// sends SIGINT. Default: close after capture (one-shot probe behaviour).
if (process.env.M365_KEEP_OPEN === "1") {
  console.log("[gui] M365_KEEP_OPEN=1 — keeping browser open for investigation; close the window to end.");
  await new Promise((resolve) => {
    context.on("close", resolve);
    // Safety net: also exit if the page itself navigates away / dies.
    page.on("close", () => resolve());
  });
}
await context.close();
