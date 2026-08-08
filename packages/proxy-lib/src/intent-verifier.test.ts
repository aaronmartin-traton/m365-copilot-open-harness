import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getIntentVerifier,
  resetIntentVerifier,
  INTENT_VERIFIER_PROMPT,
  type IntentVerifier,
} from "./intent-verifier.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPT_FILE = join(
  HERE,
  "..",
  "..",
  "..",
  "experiments",
  "tool-decision",
  "execution-intent",
  "prompts",
  "p4-minimal.txt",
);

/** Fresh env per test: enable the gate and point it somewhere local. */
function enableGate(): void {
  process.env.M365_INTENT_VERIFIER = "1";
  process.env.M365_INTENT_VERIFIER_ENDPOINT = "http://verifier.test/v1/chat/completions";
  process.env.M365_INTENT_VERIFIER_MODEL = "bonsai-27b-q1";
  process.env.M365_INTENT_VERIFIER_RETRY_BACKOFF_MS = "1";
}

function disableGate(): void {
  delete process.env.M365_INTENT_VERIFIER;
  delete process.env.M365_INTENT_VERIFIER_ENDPOINT;
  delete process.env.M365_INTENT_VERIFIER_MODEL;
  delete process.env.M365_INTENT_VERIFIER_TIMEOUT_MS;
  delete process.env.M365_INTENT_VERIFIER_MAX_TOKENS;
  delete process.env.M365_INTENT_VERIFIER_RETRY_BACKOFF_MS;
}

/** Stub the global fetch. `handler` returns a Response or throws. */
function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit) => handler(String(url), init)),
  );
}

/** A Response carrying a single invocable verifier token (echoes requested model). */
function tokenResponse(token: string, reasoning = ""): Response {
  // Echo the model the verifier requested so the identity guard passes.
  return new Response(
    JSON.stringify({
      model: process.env.M365_INTENT_VERIFIER_MODEL || "bonsai-27b-q1",
      choices: [{ message: { content: token, reasoning_content: reasoning } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const fetchMock = () => vi.mocked(globalThis.fetch);

describe("intent verifier — env gate", () => {
  beforeEach(() => disableGate());
  afterEach(() => {
    disableGate();
    resetIntentVerifier();
    vi.unstubAllGlobals();
  });

  it("returns null when the gate is off", () => {
    expect(getIntentVerifier()).toBeNull();
  });

  it("activates on M365_INTENT_VERIFIER=1", () => {
    enableGate();
    expect(getIntentVerifier()).not.toBeNull();
  });

  it("activates when an endpoint override is set", () => {
    process.env.M365_INTENT_VERIFIER_ENDPOINT = "http://verifier.test/v1/chat/completions";
    expect(getIntentVerifier()).not.toBeNull();
  });
});

describe("intent-verifier — arbitration table (stub fetch)", () => {
  beforeEach(() => {
    enableGate();
    resetIntentVerifier();
  });
  afterEach(() => {
    disableGate();
    resetIntentVerifier();
    vi.unstubAllGlobals();
  });

  it("EXECUTE -> decision EXECUTE", async () => {
    stubFetch(() => tokenResponse("EXECUTE"));
    const v = getIntentVerifier()!;
    const r = await v.check("run it now");
    expect(r.decision).toBe("EXECUTE");
    expect(r.error).toBeNull();
    expect(r.raw).toBe("EXECUTE");
  });

  it("TEXT -> decision TEXT", async () => {
    stubFetch(() => tokenResponse("TEXT"));
    const r = await getIntentVerifier()!.check("just explain");
    expect(r.decision).toBe("TEXT");
    expect(r.raw).toBe("TEXT");
  });

  it("UNCERTAIN -> TEXT (arbitration)", async () => {
    stubFetch(() => tokenResponse("UNCERTAIN"));
    const r = await getIntentVerifier()!.check("maybe?");
    expect(r.decision).toBe("TEXT");
  });

  it("invalid output (non-vocab token) -> TEXT", async () => {
    stubFetch(() => tokenResponse("cheeseburger"));
    const r = await getIntentVerifier()!.check("gibberish");
    expect(r.decision).toBe("TEXT");
    expect(r.error).toBeNull();
  });

  it("HTTP 500 -> retry(2) -> error -> TEXT", async () => {
    let calls = 0;
    stubFetch(async () => {
      calls++;
      return new Response("boom", { status: 500 });
    });
    const r = await getIntentVerifier()!.check("retry me");
    expect(calls).toBe(3); // initial + 2 retries
    expect(r.decision).toBe("TEXT");
    expect(r.error).toBe("HTTP 500");
  });

  it("timeout -> TEXT with error 'timeout'", async () => {
    process.env.M365_INTENT_VERIFIER_TIMEOUT_MS = "30";
    resetIntentVerifier();
    stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const r = await getIntentVerifier()!.check("hang forever");
    expect(r.decision).toBe("TEXT");
    expect(r.error).toBe("timeout");
  });

  it("model-mismatch -> TEXT", async () => {
    stubFetch(() =>
      new Response(JSON.stringify({ model: "SOMETHING_ELSE", choices: [{ message: { content: "EXECUTE" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const r = await getIntentVerifier()!.check("identity");
    expect(r.decision).toBe("TEXT");
    expect(r.error).toBe("model-mismatch");
  });
});

describe("intent-verifier — cache", () => {
  beforeEach(() => {
    enableGate();
    resetIntentVerifier();
  });
  afterEach(() => {
    disableGate();
    resetIntentVerifier();
    vi.unstubAllGlobals();
  });

  it("second identical call is a hit with one fetch", async () => {
    const fetches = vi.fn().mockReturnValue(tokenResponse("EXECUTE"));
    vi.stubGlobal("fetch", fetches);
    const v = getIntentVerifier()!;
    const first = await v.check("the same plan");
    const second = await v.check("the same plan");
    expect(first.cache).toBe("miss");
    expect(second.cache).toBe("hit");
    expect(fetches).toHaveBeenCalledTimes(1);
  });

  it("two concurrent identical calls -> one fetch, second shared", async () => {
    const fetches = vi.fn().mockReturnValue(tokenResponse("EXECUTE"));
    vi.stubGlobal("fetch", fetches);
    const v = getIntentVerifier()!;
    const [a, b] = await Promise.all([v.check("concurrent"), v.check("concurrent")]);
    expect(a.cache).toBe("miss");
    expect(b.cache).toBe("shared");
    expect(a.decision).toBe("EXECUTE");
    expect(b.decision).toBe("EXECUTE");
    expect(fetches).toHaveBeenCalledTimes(1);
  });

  it("LRU eviction at 1000 entries", async () => {
    const fetches = vi.fn().mockImplementation(() => tokenResponse("TEXT"));
    vi.stubGlobal("fetch", fetches);
    const v = getIntentVerifier()!;
    // 1001 distinct planner texts -> 1001 entries, first evicted
    for (let i = 0; i < 1001; i++) await v.check(`uniquetext-${i}`);
    expect(fetches).toHaveBeenCalledTimes(1001);
    // the first text's entry was evicted: re-checking it is a miss + a new fetch
    const recheck = await v.check("uniquetext-0");
    expect(recheck.cache).toBe("miss");
    expect(fetches).toHaveBeenCalledTimes(1002);
  }, 30000);

  it("drift: changed planner text -> miss, never stale", async () => {
    let calls = 0;
    stubFetch(() => {
      calls++;
      return tokenResponse(calls === 1 ? "EXECUTE" : "TEXT");
    });
    const v = getIntentVerifier()!;
    const a = await v.check("original plan");
    const b = await v.check("original plan"); // hit
    const c = await v.check("changed plan"); // drift -> miss
    expect(a.cache).toBe("miss");
    expect(b.cache).toBe("hit");
    expect(c.cache).toBe("miss");
    expect(c.decision).toBe("TEXT");
    expect(calls).toBe(2);
  });
});

describe("intent-verifier — concurrency & prompt guard", () => {
  beforeEach(() => {
    enableGate();
    resetIntentVerifier();
  });
  afterEach(() => {
    disableGate();
    resetIntentVerifier();
    vi.unstubAllGlobals();
  });

  it("concurrency cap 1: two distinct texts never overlap fetches", async () => {
    let active = 0;
    let maxActive = 0;
    stubFetch(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return tokenResponse("TEXT");
    });
    const v = getIntentVerifier()!;
    await Promise.all([v.check("plan A"), v.check("plan B")]);
    expect(maxActive).toBe(1);
  });

  it("embedded prompt is byte-identical to the frozen artifact", () => {
    const onDisk = readFileSync(PROMPT_FILE, "utf-8");
    expect(INTENT_VERIFIER_PROMPT).toBe(onDisk);
  });
});