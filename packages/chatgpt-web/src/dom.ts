/**
 * Reading a turn out of the ChatGPT Web DOM.
 *
 * Selectors here are ChatGPT's, not ours, and the UI changes without notice.
 * Two rules keep that survivable:
 *
 * 1. Bind on ChatGPT's LOGICAL turn identity (`data-turn-key`), never on a
 *    display position. History virtualization renumbers what is on screen, so
 *    "the last turn" is not an identity and silently binds to the wrong answer.
 * 2. Fail explicitly when the DOM is not in a shape we understand. A missing
 *    turn or an interleaved user turn throws; it never falls back to "read
 *    whatever text is visible".
 *
 * Selector provenance: the attribute names below are taken from DOM captured
 * off a real ChatGPT Web session (see tests/fixtures/).
 */

import type { Locator, Page } from "playwright";

/** Assistant prose. ChatGPT tags the rendered markdown block with this. */
const ASSISTANT_MESSAGE = '[data-markdown-text-style="assistant-message"]';

/** One rendered exchange. */
const TURN = "[data-turn-key]";

/** Present the moment ChatGPT accepts a submission. */
const TURN_STARTED = "[data-chatgpt-agent-turn-start]";

/**
 * Send/stop controls. Rendered once the turn is no longer producing.
 */
const TURN_CONTROLS = ".turn-action-controls";

/**
 * Set by ChatGPT on the assistant block while it is still generating, and
 * removed when generation settles. Verified against captured turns: a
 * streaming capture carries this attribute, a completed one does not. The
 * controls appear in both, so they alone cannot decide completion.
 */
const ANIMATED = "[data-markdown-animated]";

/** A submitted user message. */
const USER_BUBBLE = "[data-user-message-bubble]";

/** The composer. Present only in a signed-in session. */
const COMPOSER = "#prompt-textarea";

const POLL_INTERVAL_MS = 100;

/** The DOM state captured immediately before a submission. */
export interface SubmissionBaseline {
  /** Logical ids of every turn already on the page. */
  turnKeys: string[];
  /** How many user bubbles were already rendered. */
  userBubbles: number;
}

export interface TurnSnapshot {
  turnKey: string;
  /** Assistant text so far. Grows as the turn streams. */
  text: string;
  /** True once the turn has stopped producing. */
  finished: boolean;
}

/** Raised when the page is not in a shape this adapter can read honestly. */
export class ChatGptDomError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatGptDomError";
  }
}

async function attrValues(locator: Locator, attribute: string): Promise<string[]> {
  return locator.evaluateAll(
    (nodes, attr) => nodes.map((node) => node.getAttribute(attr) ?? ""),
    attribute,
  );
}

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);

  return promise;
};

/** True when the page is a signed-in ChatGPT conversation (composer present). */
export async function isSignedIn(page: Page): Promise<boolean> {
  return (await page.locator(COMPOSER).count()) > 0;
}

/** True when an anti-bot interstitial is being served instead of the app. */
export async function isChallengePage(page: Page): Promise<boolean> {
  return /just a moment|attention required|checking your browser/i.test(await page.title());
}

export async function captureBaseline(page: Page): Promise<SubmissionBaseline> {
  return {
    turnKeys: (await attrValues(page.locator(TURN), "data-turn-key")).filter(Boolean),
    userBubbles: await page.locator(USER_BUBBLE).count(),
  };
}

/**
 * The prompt that belongs to one specific turn container.
 *
 * Scoped to the turn, never page-global. ChatGPT usually nests the user bubble
 * inside the turn container, but a submit can also render it as its own
 * container directly above the answer — so the preceding new container is
 * checked too. Returns "" when the turn cannot be attributed to a prompt,
 * which never matches a real submission.
 */
async function promptForTurn(
  page: Page,
  turnKey: string,
  newTurnKeys: string[],
): Promise<string> {
  const own = page.locator(`${TURN}[data-turn-key="${turnKey}"] ${USER_BUBBLE}`);

  if ((await own.count()) > 0) return (await own.first().innerText()).trim();

  const position = newTurnKeys.indexOf(turnKey);
  const preceding = position > 0 ? newTurnKeys[position - 1] : undefined;

  if (preceding !== undefined) {
    const bubble = page
      .locator(`${TURN}[data-turn-key="${preceding}"] ${USER_BUBBLE}`)
      .first();

    if ((await bubble.count()) > 0) return (await bubble.innerText()).trim();
  }

  return "";
}

/**
 * Wait for the assistant turn that answers our submission and return its
 * logical id.
 *
 * Every candidate is attributed to a prompt on its own terms, and only a
 * candidate whose prompt IS the one we submitted may be bound. A page-global
 * check is not enough: when a stranger's exchange renders above ours, the last
 * bubble on the page is still ours while the first *new* answer turn is theirs.
 * Binding that one returns their answer as ours.
 *
 * Throws when the deadline passes. Honours `signal`, so a disconnected client
 * does not hold a browser — and an upstream concurrency slot — until the
 * deadline.
 */
export async function waitForAssistantTurn(
  page: Page,
  baseline: SubmissionBaseline,
  deadlineMs: number,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const known = new Set(baseline.turnKeys);
  const wanted = prompt.trim();
  const expiry = Date.now() + deadlineMs;

  while (Date.now() < expiry) {
    if (signal?.aborted) {
      throw Object.assign(new Error("Aborted while waiting for the ChatGPT turn"), {
        name: "AbortError",
      });
    }

    const turnKeys = (await attrValues(page.locator(TURN), "data-turn-key")).filter(
      (key) => key && !known.has(key),
    );

    for (const turnKey of turnKeys) {
      const started = await page
        .locator(`${TURN}[data-turn-key="${turnKey}"]`)
        .locator(TURN_STARTED)
        .count();

      if (started === 0) continue;

      if ((await promptForTurn(page, turnKey, turnKeys)) === wanted) return turnKey;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new ChatGptDomError(`No assistant turn appeared within ${deadlineMs}ms`);
}

/** Read one turn's current assistant text and completion state. */
export async function readTurn(page: Page, turnKey: string): Promise<TurnSnapshot> {
  const turn = page.locator(`${TURN}[data-turn-key="${turnKey}"]`);

  if ((await turn.count()) === 0) {
    throw new ChatGptDomError(`Turn ${turnKey} is no longer in the DOM`);
  }

  const messages = turn.locator(ASSISTANT_MESSAGE);
  const parts: string[] = [];

  for (let i = 0; i < (await messages.count()); i++) {
    const text = await messages.nth(i).innerText();

    if (text) parts.push(text);
  }

  return {
    turnKey,
    text: parts.join("\n\n"),
    // Finished means the turn stopped producing: controls rendered AND the
    // animated marker gone. Either signal alone is wrong — controls are
    // present mid-stream too, and an Activity turn has neither.
    finished:
      (await turn.locator(TURN_CONTROLS).count()) > 0
      && (await turn.locator(ANIMATED).count()) === 0,
  };
}
