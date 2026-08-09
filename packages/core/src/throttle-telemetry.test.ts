import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  emitThrottleEvent,
  getThrottleEventCounts,
  hashConversationId,
  resetThrottleEventCounts,
  type ThrottleEvent,
} from "./throttle-telemetry.js";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "throttle-telemetry-"));
  process.env.M365_THROTTLE_TELEMETRY_FILE = join(dir, "throttle-telemetry.ndjson");
  delete process.env.M365_NO_TELEMETRY;
  resetThrottleEventCounts();
});

afterEach(() => {
  delete process.env.M365_THROTTLE_TELEMETRY_FILE;
  delete process.env.M365_NO_TELEMETRY;
  resetThrottleEventCounts();
  rmSync(dir, { recursive: true, force: true });
});

const fileLines = (): string[] => {
  const p = process.env.M365_THROTTLE_TELEMETRY_FILE!;
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean) : [];
};

describe("throttle telemetry — NDJSON emission", () => {
  it("appends one NDJSON line per event to the configured file", () => {
    emitThrottleEvent({ ts: "t1", event: "empty-throttle", convIdHash: "abc" });
    emitThrottleEvent({ ts: "t2", event: "at-limit", current: 600, max: 600 });
    const lines = fileLines();
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]) as ThrottleEvent;
    expect(first.event).toBe("empty-throttle");
    expect(first.convIdHash).toBe("abc");
    expect(first.ts).toBe("t1");
  });

  it("every event type serializes and counts", () => {
    const events: ThrottleEvent[] = [
      { ts: "1", event: "empty-throttle", convIdHash: "h" },
      { ts: "2", event: "backoff-enter", level: 1, backoffUntil: 999 },
      { ts: "3", event: "backoff-exit", level: 1, durationMs: 90_000 },
      { ts: "4", event: "disengaged", framing: "softened", retryOutcome: "softened-retry" },
      { ts: "5", event: "at-limit", current: 600, max: 600 },
    ];
    for (const e of events) emitThrottleEvent(e);
    const counts = getThrottleEventCounts();
    expect(counts).toEqual({
      "empty-throttle": 1,
      "backoff-enter": 1,
      "backoff-exit": 1,
      disengaged: 1,
      "at-limit": 1,
    });
  });

  it("M365_NO_TELEMETRY=1 disables file writes but events still count", () => {
    process.env.M365_NO_TELEMETRY = "1";
    emitThrottleEvent({ ts: "t", event: "at-limit", current: 1, max: 1 });
    expect(fileLines()).toHaveLength(0);
    expect(getThrottleEventCounts()["at-limit"]).toBe(1);
  });

  it("hashes a conversation id and never emits a raw id", () => {
    const hash = hashConversationId("secret-conv-123");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("secret-conv-123");
    // Stable for the same input.
    expect(hash).toBe(hashConversationId("secret-conv-123"));
    emitThrottleEvent({ ts: "t", event: "empty-throttle", convIdHash: hash });
    const raw = readFileSync(process.env.M365_THROTTLE_TELEMETRY_FILE!, "utf8");
    expect(raw).not.toContain("secret-conv-123");
    expect(raw).toContain(hash);
  });

  it("a write failure never throws to the caller", () => {
    // Point the file into a path that cannot be created (a file where a dir is needed).
    process.env.M365_THROTTLE_TELEMETRY_FILE = join(dir, "sub", "throttle-telemetry.ndjson");
    // Pre-create a FILE named 'sub' so mkdirSync(sub) fails (ENOTDIR).
    writeFileSync(join(dir, "sub"), "i-am-a-file");
    expect(() => emitThrottleEvent({ ts: "t", event: "at-limit" })).not.toThrow();
  });
});

describe("throttle telemetry — backoff wiring via noteRequestOutcome", () => {
  beforeEach(() => {
    // The default backoff controller is a module-level singleton created on
    // first import, so re-import auth-recovery fresh under test env. The
    // telemetry module is imported fresh too so the asserted counts belong to
    // the same instance graph the controller writes to. (Module-loading
    // boundary test — the singleton reads env at import time.)
    process.env.M365_BACKOFF_STATE_FILE = join(dir, "backoff-state.json");
    process.env.M365_BACKOFF_WINDOW_MS = "60000";
    process.env.M365_BACKOFF_THRESHOLD = "3";
    delete process.env.M365_NO_BACKOFF;
    delete process.env.M365_NO_AUTO_REAUTH;
    vi.resetModules();
  });

  async function fresh() {
    const { noteRequestOutcome } = await import("./auth-recovery.js");
    const telemetry = await import("./throttle-telemetry.js");
    return { noteRequestOutcome, counts: () => telemetry.getThrottleEventCounts() };
  }

  it("empty-throttle fires on noteRequestOutcome(true) even with backoff disabled", async () => {
    const { noteRequestOutcome, counts } = await fresh();
    noteRequestOutcome(true, "conv-1");
    expect(counts()["empty-throttle"]).toBe(1);
    const line = JSON.parse(fileLines()[0]) as ThrottleEvent;
    expect(line.event).toBe("empty-throttle");
    expect(line.convIdHash).toBe(hashConversationId("conv-1"));
  });

  it("backoff-enter fires once the distinct-conversation threshold is met", async () => {
    const { noteRequestOutcome, counts } = await fresh();
    noteRequestOutcome(true, "conv-a");
    noteRequestOutcome(true, "conv-b");
    expect(counts()["backoff-enter"]).toBe(0);
    noteRequestOutcome(true, "conv-c"); // 3 distinct empties → threshold met
    expect(counts()["backoff-enter"]).toBe(1);
    expect(counts()["empty-throttle"]).toBe(3);
    const enter = fileLines()
      .map((l) => JSON.parse(l) as ThrottleEvent)
      .find((e) => e.event === "backoff-enter")!;
    expect(enter.level).toBe(1);
    expect(enter.backoffUntil).toBeGreaterThan(Date.now());
  });

  it("backoff-exit fires with measured duration on a clean response", async () => {
    const { noteRequestOutcome, counts } = await fresh();
    noteRequestOutcome(true, "conv-a");
    noteRequestOutcome(true, "conv-b");
    noteRequestOutcome(true, "conv-c"); // enter
    expect(counts()["backoff-exit"]).toBe(0);
    noteRequestOutcome(false, "conv-a"); // clean response lifts backoff
    const exit = fileLines()
      .map((l) => JSON.parse(l) as ThrottleEvent)
      .find((e) => e.event === "backoff-exit");
    expect(exit).toBeDefined();
    expect(exit!.durationMs).toBeGreaterThanOrEqual(0);
    expect(counts()["backoff-exit"]).toBe(1);
  });
});
