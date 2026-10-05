/**
 * The DOM reader, proven against a real captured ChatGPT conversation.
 *
 * `tests/fixtures/chatgpt-power-*.html` are captures from a live ChatGPT Web
 * session (MIT, from miuuyy/codex-chatgpt-web), not hand-written markup: they
 * carry the attributes the real renderer emits. If ChatGPT changes its DOM,
 * these fail — which is the point. We cannot hit chatgpt.com from a test, so
 * captured markup plus a real browser is the strongest check available
 * without an account.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, afterEach } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import {
  captureBaseline,
  isChallengePage,
  isSignedIn,
  readTurn,
  waitForAssistantTurn,
  ChatGptDomError,
} from "./dom.js";
import { chromiumExecutable } from "../tests/chromium.js";

const FIXTURES = new URL("../tests/fixtures/", import.meta.url);

function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), "utf8");
}

let browser: Browser | undefined;

afterEach(async () => {
  await browser?.close();
  browser = undefined;
});

/**
 * Launch the browser the way the app does: `CHROMIUM_PATH` when set,
 * otherwise Playwright's bundled build. Resolved here because a host's
 * installed Playwright revision and its browser cache can disagree.
 */
async function openFixture(name: string): Promise<Page> {
  const executablePath = chromiumExecutable();
  browser = await chromium.launch(executablePath ? { executablePath } : {});
  const page = await browser.newPage();
  await page.setContent(fixture(name));

  return page;
}

const COMPLETE_TURN_KEY = "3357694b-c037-44b2-b3e4-9779d87f7a6d";

describe("ChatGPT Web DOM reader", () => {
  it("reads a completed turn: markdown in, plain prose out, controls mean done", async () => {
    const page = await openFixture("chatgpt-power-complete.html");

    const baseline = await captureBaseline(page);
    expect(baseline.turnKeys).toContain(COMPLETE_TURN_KEY);
    expect(baseline.userBubbles).toBe(1);

    const snapshot = await readTurn(page, COMPLETE_TURN_KEY);

    expect(snapshot.turnKey).toBe(COMPLETE_TURN_KEY);
    // Heading text must survive: the harness renders this reply as Markdown,
    // and `## How a Rainbow Begins` is load-bearing, not decoration.
    expect(snapshot.text).toContain("How a Rainbow Begins");
    expect(snapshot.text.length).toBeGreaterThan(400);
    // The capture is a completed turn: send/stop controls are present.
    expect(snapshot.finished).toBe(true);
  });

  it("treats a streaming capture as unfinished, so a poll keeps waiting", async () => {
    const page = await openFixture("chatgpt-power-streaming.html");

    const snapshot = await readTurn(page, COMPLETE_TURN_KEY);

    expect(snapshot.text.length).toBeGreaterThan(0);
    // Controls are already rendered mid-stream, but ChatGPT marks the assistant
    // block as still generating. Generation has not settled.
    expect(snapshot.finished).toBe(false);
  });

  it("binds a new turn by logical id, not by display position", async () => {
    const page = await openFixture("chatgpt-power-complete.html");
    const baseline = await captureBaseline(page);

    // A second exchange renders its user bubble and its answer as separate
    // turn containers, the user one first in document order.
    await page.locator("body").evaluate((node, html) => {
      node.insertAdjacentHTML("beforeend", html);
    }, `<div data-turn-key="second-user"><div data-user-message-bubble="true"><div>the prompt we sent</div></div></div>
      <div data-turn-key="second-turn-uuid"><span data-chatgpt-agent-turn-start></span>
      <div data-markdown-text-style="assistant-message">second answer</div>
      <div class="turn-action-controls"><button>Copy</button></div></div>`);

    const bound = await waitForAssistantTurn(page, baseline, 5_000, "the prompt we sent");

    // The pre-existing turn must not be re-bound just because it was last, and
    // the user-bubble container must not be bound as if it were the answer.
    expect(bound).toBe("second-turn-uuid");
  });

  it("refuses to bind when the newest user turn is not the prompt we submitted", async () => {
    const page = await openFixture("chatgpt-power-complete.html");
    const baseline = await captureBaseline(page);

    // Someone else's turn lands while ours is in flight.
    await page.locator("body").evaluate((node, html) => {
      node.insertAdjacentHTML("beforeend", html);
    }, `<div data-turn-key="stranger"><div data-user-message-bubble="true"><div>someone else's question</div></div></div>
      <div data-turn-key="stranger-answer"><span data-chatgpt-agent-turn-start></span>
      <div data-markdown-text-style="assistant-message">stranger answer</div>
      <div class="turn-action-controls"><button>Copy</button></div></div>`);

    // Binding to that would return another user's answer as ours.
    await expect(
      waitForAssistantTurn(page, baseline, 5_000, "the prompt we sent"),
    ).rejects.toThrow(ChatGptDomError);
  });

  it("times out explicitly instead of returning whatever text is on screen", async () => {
    const page = await openFixture("chatgpt-power-complete.html");
    const baseline = await captureBaseline(page);

    // Nothing new is submitted, so no new turn can appear.
    await expect(
      waitForAssistantTurn(page, baseline, 300, "the prompt we sent"),
    ).rejects.toThrow(/No assistant turn appeared/);
  });

  it("reports a missing composer and an anti-bot interstitial distinctly", async () => {
    const page = await openFixture("chatgpt-power-complete.html");
    // A captured conversation has no composer: not signed in.
    expect(await isSignedIn(page)).toBe(false);
    expect(await isChallengePage(page)).toBe(false);

    await page.setContent("<html><head><title>Just a moment...</title></head><body></body></html>");
    expect(await isChallengePage(page)).toBe(true);

    await page.setContent('<html><body><textarea id="prompt-textarea"></textarea></body></html>');
    expect(await isSignedIn(page)).toBe(true);
  });
});
