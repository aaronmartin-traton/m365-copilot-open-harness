/**
 * The ChatGPT Web backend, driven through a real browser against a local
 * server that speaks ChatGPT's DOM conventions.
 *
 * This is the end-to-end check that the backend is a real `ModelProvider`:
 * a real Chromium loads a real page, types into a real composer, and the
 * proxy's turn contract (live deltas, stopReason, usage telemetry) is
 * observed from the outside. No ChatGPT account is involved — the origin is
 * injected, which is the same seam production uses to point at chatgpt.com.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import { ChatGptWebProvider, type ChatGptWebOptions } from "./index.js";
import { CHATGPT_WEB_MODELS } from "./models.js";
import { chromiumExecutable } from "../tests/chromium.js";

/**
 * Timers below are page-side, not test-side: they stand in for ChatGPT's own
 * async DOM rendering, which the adapter polls. Deterministic time control
 * cannot drive them — the code under test reads the DOM on a real clock, so
 * the delays have to be real.
 */

/**
 * A page that behaves like ChatGPT: a composer that accepts Enter, and on
 * submit renders the user bubble then the assistant turn — streaming, with the
 * animated marker present until generation settles.
 */
const FAKE_CHAT_PAGE = `<!doctype html>
<html><body>
<textarea id="prompt-textarea"></textarea>
<div id="turns"></div>
<script>
document.getElementById("prompt-textarea").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  const prompt = event.target.value;
  event.target.value = "";
  const turns = document.getElementById("turns");
  const user = document.createElement("div");
  user.setAttribute("data-turn-key", "u-" + Math.random());
  user.innerHTML = '<div data-user-message-bubble="true"><div>' + prompt + '</div></div>';
  turns.appendChild(user);
  setTimeout(() => {
    const turn = document.createElement("div");
    turn.setAttribute("data-turn-key", "a-fixed-answer-key");
    turn.innerHTML = '<span data-chatgpt-agent-turn-start></span>' +
      '<div data-markdown-animated data-markdown-text-style="assistant-message"></div>' +
      '<div class="turn-action-controls"><button>Copy</button></div>';
    turns.appendChild(turn);
    const msg = turn.querySelector('[data-markdown-text-style="assistant-message"]');
    let step = 0;
    const chunks = ["Let", " me check", " that for you."];
    const tick = setInterval(() => {
      step += 1;
      if (step <= chunks.length) {
        msg.textContent = chunks.slice(0, step).join("");
        return;
      }
      clearInterval(tick);
      msg.removeAttribute("data-markdown-animated");
    }, 60);
  }, 40);
});
</script>
</body></html>`;

let server: Server | undefined;

let browser: Browser | undefined;

afterEach(async () => {
  await browser?.close();
  browser = undefined;
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
    server = undefined;
  });
});

async function startFakeChat(): Promise<string> {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(FAKE_CHAT_PAGE);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server!.address();
  // SAFETY: `listen` resolved, so the server holds a TCP address, not null.
  const { port } = address as AddressInfo;

  return `http://127.0.0.1:${port}`;
}

/** Point a provider at the local fake ChatGPT, driving a real browser. */
function fakeChatOptions(origin: string): ChatGptWebOptions {
  const executablePath = chromiumExecutable();
  const options: ChatGptWebOptions = { origin, headless: true, turnDeadlineMs: 20_000 };

  if (!executablePath) return options;

  options.launchPersistentContext = async (dir, launchOptions) => {
    const { chromium } = await import("playwright");

    return chromium.launchPersistentContext(dir, {
      executablePath,
      headless: true,
      ...launchOptions,
    });
  };

  return options;
}

describe("ChatGptWebProvider", () => {
  it("identifies itself so usage keys and owned_by are unambiguous", () => {
    const provider = new ChatGptWebProvider({ browser: undefined });
    expect(provider.id).toBe("chatgpt-web");
    expect(provider.supportsTools("chatgpt-web/sol-high")).toBe(true);
  });

  it("advertises only models the picker documents, with their context windows", () => {
    const provider = new ChatGptWebProvider({});
    const listed = provider.listModels();
    expect(listed).toEqual(Object.keys(CHATGPT_WEB_MODELS));
    expect(listed).toContain("chatgpt-web/sol-high");
    expect(CHATGPT_WEB_MODELS["chatgpt-web/pro"].contextWindow).toBe(270_000);
  });

  it("describes a known model by its picker label and an unknown one verbatim", () => {
    const provider = new ChatGptWebProvider({});
    expect(provider.describeModel("chatgpt-web/luna")).toBe("GPT-5.6 Luna (Web)");
    expect(provider.describeModel("chatgpt-web/nonexistent")).toBe("chatgpt-web/nonexistent");
  });

  it("declines to retry a refusal rather than burning quota on one", () => {
    const provider = new ChatGptWebProvider({});
    // No known framing flips a ChatGPT refusal, so recovery is a fail-fast.
    expect(provider.recoverFromRefusal()).toBeNull();
    expect(provider.refusalHint).toContain("ChatGPT Web");
  });

  it("has no remote tool machinery to refresh", async () => {
    const provider = new ChatGptWebProvider({});
    await expect(provider.refreshTools()).resolves.toBe(false);
  });

  it("refuses image inputs rather than silently dropping them", async () => {
    const provider = new ChatGptWebProvider({});
    await expect(
      provider.run("describe this", "chatgpt-web/luna", undefined, false, [
        { referenceUrls: ["https://example.test/a.png"] },
      ]),
    ).rejects.toThrow(/does not accept image inputs/);
  });

  it("streams a real turn out of a real browser and reports it as completed", async () => {
    const origin = await startFakeChat();
    const provider = new ChatGptWebProvider(fakeChatOptions(origin));

    const turn = await provider.run("say something", "chatgpt-web/luna");

    // Live deltas, not one blob: the handler forwards each chunk as it lands.
    const deltas: string[] = [];

    for await (const delta of turn) deltas.push(delta);

    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toBe("Let me check that for you.");
    expect(turn.fullText).toBe("Let me check that for you.");
    expect(turn.stopReason).toBe("completed");
    expect(turn.hasContent).toBe(true);
    expect(turn.throttle).toBeNull();
    expect(turn.turnCount).toBe(1);

    // Telemetry namespaced for this backend, under `x_chatgpt_web_*`.
    expect(turn.usage?.turn_key).toBe("a-fixed-answer-key");
    expect(turn.usage?.requested_model).toBe("chatgpt-web/luna");

    await provider.close();
  }, 40_000);

  it("counts turns and rotates the conversation without losing the id", async () => {
    const origin = await startFakeChat();
    const provider = new ChatGptWebProvider(fakeChatOptions(origin));
    const sessionId = provider.sessionId;

    const first = await provider.run("one", "chatgpt-web/luna");

    for await (const _ of first) { /* drain */ }

    expect(provider.turnCount).toBe(1);

    provider.newConversation();
    expect(provider.turnCount).toBe(0);
    // The transport id is stable across rotation so the session store can
    // restore this conversation after a restart.
    expect(provider.sessionId).toBe(sessionId);

    await provider.close();
  }, 40_000);
});
