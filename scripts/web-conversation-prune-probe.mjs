import { randomUUID } from "node:crypto";
import playwright from "../packages/core/node_modules/playwright/index.js";
const { chromium } = playwright;
import { getBrowserProfileDir, M365WebConversationClient } from "../packages/core/dist/index.mjs";

const marker = `m365-prune-disposable-${randomUUID()}`;
const profileDir = getBrowserProfileDir();
const executablePath = process.env.CHROMIUM_PATH || undefined;
let context;

function stage(name) {
  console.error(`[probe] ${name}`);
}

function findConversation(value) {
  if (!value || typeof value !== "object") return null;
  const isUuid = (candidate) => typeof candidate === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate);
  if (Array.isArray(value)) {
    for (const item of value) { const found = findConversation(item); if (found) return found; }
    return null;
  }
  if (isUuid(value.conversationId) && (typeof value.title === "string" || typeof value.name === "string" || typeof value.text === "string")) return value.conversationId;
  for (const child of Object.values(value)) { const found = findConversation(child); if (found) return found; }
  return null;
}

try {
  stage(`launching browser headless=${process.env.M365_WEB_HEADLESS !== "0"}${executablePath ? ` via ${executablePath}` : " via Playwright default"}`);
  context = await chromium.launchPersistentContext(profileDir, {
    headless: process.env.M365_WEB_HEADLESS !== "0",
    timeout: 30_000,
    ...(executablePath ? { executablePath } : {}),
  });
  const page = context.pages()[0] ?? await context.newPage();
  stage("opening M365 chat");
  await page.goto("https://m365.cloud.microsoft/chat/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(5_000);
  stage(`opened ${new URL(page.url()).hostname}`);
  if (/login\.microsoftonline\.com/i.test(page.url())) throw new Error("M365 web session unavailable; refusing interactive login");

  stage("finding composer");
  const composer = page.locator('div[contenteditable="true"]:visible, textarea:visible, [role="textbox"]:visible').first();
  await composer.waitFor({ state: "visible", timeout: 30_000 });
  const navigationBodies = [];
  page.on("response", async (response) => {
    if (!response.url().includes("/chat")) return;
    try { navigationBodies.push(await response.json()); } catch {}
  });
  await composer.fill(`Reply with the exact marker ${marker}`);
  await page.keyboard.press("Enter");
  stage("waiting for disposable conversation");

  let candidate = null;
  for (let attempt = 0; attempt < 30 && !candidate; attempt++) {
    await page.waitForTimeout(1_000);
    for (const body of navigationBodies) candidate = findConversation(body) || candidate;
  }
  if (!candidate) throw new Error("Could not identify the disposable conversation from M365 navigation responses");

  // The deletion adapter opens its own persistent context. Release the profile lock
  // before invoking it; otherwise Chromium can wait indefinitely on the profile lock.
  await context.close();
  context = undefined;
  stage("deleting exactly one disposable conversation");
  const client = new M365WebConversationClient({ profileDir });
  await client.deleteConversation({ conversationId: candidate });
  console.log(JSON.stringify({ ok: true, conversationId: `${candidate.slice(0, 8)}...${candidate.slice(-4)}`, marker }, null, 2));
} finally {
  await context?.close();
}
