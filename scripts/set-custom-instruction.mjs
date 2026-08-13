// Write the M365 "Custom instructions" textarea through CDP (ticket 02).
//
// The persistent profile browser is held open on a debug port by
// _profile-cdp.mjs; this script attaches, opens the settings page, writes the
// React-controlled textarea via the NATIVE value setter + input/change events
// (bare fill() and a synthetic 'input' alone leave Save disabled — silent
// no-op), clicks Save, then RE-READS the value to prove the write landed.
//
// usage: node scripts/set-custom-instruction.mjs --payload <text> [--port 9222]
// exit 0 = write + save + re-read matched; exit 1 = failure (message on stderr).
//
// Selectors may need live tuning on the local machine (the Settings→Personalization
// DOM changes); the ticket Comments record the last-verified selectors.

import { readFileSync } from "node:fs";

const pwMod = await import("../packages/core/node_modules/playwright/index.js");
const chromium = pwMod.chromium ?? pwMod.default?.chromium;

const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const payload = argValue("--payload") ?? (() => {
  const f = argValue("--payload-file");
  return f ? readFileSync(f, "utf8") : undefined;
})();
const port = argValue("--port") ?? "9222";
const settingsUrl = process.env.M365_SETTINGS_URL ?? "https://m365.cloud.microsoft/chat/settings";

if (!payload) {
  console.error("usage: node scripts/set-custom-instruction.mjs --payload <text> [--port N]");
  process.exitCode = 2;
} else {
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);

    const context = browser.contexts()[0];
    if (!context) {
      console.error("[set-custom-instruction] no browser context");
      process.exitCode = 1;
    } else {
      const page = await context.newPage();
      try {
        await page.goto(settingsUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
        // The custom-instructions textarea lives under Settings → Personalization.
        // Tried in order: labelled textarea near "Custom instructions", then any
        // textarea whose aria-label mentions instructions/personalization.
        const textarea = await page
          .getByLabel(/custom instructions/i)
          .or(page.locator('textarea[aria-label*="instruction" i]'))
          .or(page.locator("textarea").filter({ has: page.locator("text=/custom instructions/i") }))
          .first()
          .waitFor({ timeout: 20_000 })
          .catch(() => null);
        if (!textarea) {
          console.error("[set-custom-instruction] custom-instructions textarea not found on the settings page");
          process.exitCode = 1;
        } else {
          await textarea.evaluate((el, value) => {
            const proto = Object.getPrototypeOf(el);
            const desc = Object.getOwnPropertyDescriptor(proto, "value");
            if (desc && typeof desc.set === "function") desc.set.call(el, value);
            else el.value = value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }, payload);

          // React enables Save only after a real value change; click it once enabled.
          const save = page.getByRole("button", { name: /save/i }).last();
          await save.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
          const enabled = await save.isEnabled().catch(() => false);
          if (!enabled) {
            console.error("[set-custom-instruction] Save button stayed disabled after value write");
            process.exitCode = 1;
          } else {
            await save.click();
            await page.waitForTimeout(800);

            const reRead = await textarea.inputValue().catch(() => null);
            if (reRead === payload) {
              console.log(`[set-custom-instruction] OK — write + save verified (${payload.length} chars)`);
              process.exitCode = 0;
            } else {
              console.error(`[set-custom-instruction] re-read mismatch: expected ${payload.length} chars, got ${reRead?.length ?? -1}`);
              process.exitCode = 1;
            }
          }
        }
      } finally {
        await page.close().catch(() => {});
      }
    }
  } catch (err) {
    console.error(`[set-custom-instruction] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
  }
}
