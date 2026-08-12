import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureSteered,
  getSteeringFingerprint,
  readSteeringState,
  recordChannelFailure,
  recordChannelPass,
  replayLastGood,
  STEERING_BREAKER_THRESHOLD,
  writeSteeringState,
} from "./steering.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "steering-test-"));
  process.env.M365_STEERING_FILE = join(dir, "steering.json");
  delete process.env.M365_STEERING_LIVE;
  delete process.env.M365_REPO_ROOT;
});

afterEach(() => {
  delete process.env.M365_STEERING_FILE;
  rmSync(dir, { recursive: true, force: true });
});

describe("steering state machine", () => {
  it("defaults to unsteered when no state file exists", () => {
    expect(readSteeringState().channel).toBeNull();
    expect(getSteeringFingerprint()).toBe("unsteered");
  });

  it("latches a channel on pass and reports the steered fingerprint", () => {
    const latched = recordChannelPass(readSteeringState(), "textarea", "be a coding agent", 1000);
    writeSteeringState(latched);

    const state = readSteeringState();
    expect(state.channel).toBe("textarea");
    expect(state.payload).toBe("be a coding agent");
    expect(state.lastVerifiedAt).toBe(1000);
    expect(getSteeringFingerprint(state)).toBe("steered:channel=textarea");
  });

  it("rehydration sled returns last-good config while the breaker is closed", () => {
    const latched = recordChannelPass(readSteeringState(), "textarea", "payload", 1000);
    expect(replayLastGood(latched)).toEqual({ channel: "textarea", payload: "payload" });
  });

  it("opens the breaker after N failures and flips back to unsteered", () => {
    let state = recordChannelPass(readSteeringState(), "textarea", "payload", 9999);
    for (let i = 0; i < STEERING_BREAKER_THRESHOLD; i++) {
      state = recordChannelFailure(state, "textarea", 10000 + i);
    }
    const breaker = state.breakers.textarea;
    expect(breaker.failures).toBe(STEERING_BREAKER_THRESHOLD);
    expect(breaker.open).toBe(true);
    expect(breaker.openedAt).not.toBeNull();
    // Even a previously latched channel reports unsteered while its breaker is open.
    expect(getSteeringFingerprint(state)).toBe("unsteered");
    expect(replayLastGood(state)).toBeNull();
  });

  it("a pass resets the breaker failure count", () => {
    let state = recordChannelFailure(readSteeringState(), "custom-instr", 1);
    state = recordChannelPass(state, "custom-instr", "p", 2);
    expect(state.breakers["custom-instr"]).toEqual({ failures: 0, open: false, openedAt: null });
  });

  it("normalizes a corrupt state file back to defaults", () => {
    writeFileSync(process.env.M365_STEERING_FILE!, "{not json", "utf8");
    const state = readSteeringState();
    expect(state.channel).toBeNull();
    expect(getSteeringFingerprint(state)).toBe("unsteered");
  });

  it("write → read round-trips breaker state", () => {
    const state = recordChannelFailure(readSteeringState(), "textarea", 42);
    writeSteeringState(state);
    const reread = readSteeringState();
    expect(reread.breakers.textarea.failures).toBe(1);
    expect(reread.lastAttemptAt).toBe(42);
  });
});

describe("ensureSteered (replay-only path, no M365_STEERING_LIVE)", () => {
  it("returns unsteered with no state", async () => {
    expect(await ensureSteered()).toBe("unsteered");
  });

  it("replays a latched channel without side effects", async () => {
    writeSteeringState(recordChannelPass(readSteeringState(), "textarea", "payload", Date.now()));
    expect(await ensureSteered()).toBe("steered:channel=textarea");
  });

  it("returns unsteered when the latched channel's breaker is open", async () => {
    let state = recordChannelPass(readSteeringState(), "textarea", "payload", Date.now());
    for (let i = 0; i < STEERING_BREAKER_THRESHOLD; i++) state = recordChannelFailure(state, "textarea", Date.now() + i);
    writeSteeringState(state);
    expect(await ensureSteered()).toBe("unsteered");
  });
});
