import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStateStore, type PersistedSessionState } from "./session-store.js";

const dirs: string[] = [];
const store = () => {
  const dir = mkdtempSync(join(tmpdir(), "m365-session-store-"));
  dirs.push(dir);
  return { dir, state: new SessionStateStore(join(dir, "state.json")) };
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const record = (overrides: Partial<PersistedSessionState> = {}): PersistedSessionState => ({
  sessionId: "session-1",
  conversationId: "conversation-1",
  turnCount: 4,
  sentMessageCount: 7,
  lastAccessedAt: Date.now(),
  restorable: true,
  nextPruneAttemptAt: null,
  ...overrides,
});

describe("SessionStateStore", () => {
  it("restores transport ids, positions, and managed metadata", () => {
    const { dir, state } = store();
    state.set("client-thread-1", record());

    const restored = new SessionStateStore(join(dir, "state.json")).get("client-thread-1");
    expect(restored).toEqual(record({ lastAccessedAt: expect.any(Number) }));
  });

  it("migrates readable version-1 records without discarding them", () => {
    const { dir } = store();
    const path = join(dir, "state.json");
    writeFileSync(path, JSON.stringify({
      version: 1,
      sessions: { legacy: {
        sessionId: "s", conversationId: "c", turnCount: 1, sentMessageCount: 2, lastAccessedAt: 10,
      } },
    }));

    const state = new SessionStateStore(path);
    expect(state.get("legacy")).toEqual({
      sessionId: "s", conversationId: "c", turnCount: 1, sentMessageCount: 2, lastAccessedAt: 10,
      restorable: true, nextPruneAttemptAt: null,
    });
  });

  it("keeps explicit records isolated and indexes response aliases", () => {
    const { state } = store();
    state.set("thread-a", record({ conversationId: "ca" }));
    state.set("thread-b", record({ conversationId: "cb" }));
    state.bindResponseId("response-a", "thread-a");

    expect(state.findByConversationId("cb")?.[0]).toBe("thread-b");
    expect(state.lookupResponseId("response-a")).toBe("thread-a");
    expect(state.size).toBe(2);
  });

  it("does not purge records based on construction or read time", () => {
    const { dir, state } = store();
    state.set("old", record({ lastAccessedAt: 1 }));
    const restored = new SessionStateStore(join(dir, "state.json"));
    expect(restored.get("old")).toBeDefined();
    expect(restored.size).toBe(1);
  });

  it("deletes a conversation and every response alias atomically", () => {
    const { state } = store();
    state.set("remove", record());
    state.bindResponseId("response-remove", "remove");
    state.deleteConversation("remove");
    expect(state.get("remove")).toBeUndefined();
    expect(state.lookupResponseId("response-remove")).toBeUndefined();
  });

  it("tolerates corrupt or unsupported files", () => {
    const { dir } = store();
    const path = join(dir, "state.json");
    writeFileSync(path, "{broken");
    expect(new SessionStateStore(path).size).toBe(0);
    writeFileSync(path, JSON.stringify({ version: 99, sessions: {} }));
    expect(new SessionStateStore(path).size).toBe(0);
  });

  it("does not throw when persistence path is unwritable", () => {
    const dir = mkdtempSync(join(tmpdir(), "m365-session-unwritable-"));
    dirs.push(dir);
    const state = new SessionStateStore(dir);
    expect(() => state.set("key", record())).not.toThrow();
  });
});
