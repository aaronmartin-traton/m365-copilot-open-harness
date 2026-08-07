import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionPool } from "./session-pool.js";
import { ChatCompletionRequest } from "./schemas.js";
import { SessionStateStore } from "./session-store.js";

const dirs: string[] = [];

function pool() {
  const dir = mkdtempSync(join(tmpdir(), "m365-handler-session-"));
  dirs.push(dir);
  return new SessionPool({}, {
    stateStore: new SessionStateStore(join(dir, "sessions.json")),
  });
}

function messages(input: unknown) {
  return ChatCompletionRequest.parse({ messages: input }).messages;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SessionPool identity", () => {
  it("does not merge unkeyed clients with identical first prompts", () => {
    const sessions = pool();
    const prompt = messages([{ role: "user", content: "hello" }]);
    const first = sessions.resolve(prompt);
    const second = sessions.resolve(prompt);

    expect(first.session.conversationId).not.toBe(second.session.conversationId);
    expect(sessions.diagnostics().persistedSessions).toBe(0);
  });

  it("reuses and persists an explicit client session key", () => {
    const sessions = pool();
    const prompt = messages([{ role: "user", content: "hello" }]);
    const first = sessions.resolve(prompt, "client-thread-1");
    sessions.markSent(first, 1);
    const second = sessions.resolve(prompt, "client-thread-1");

    expect(second.session.conversationId).toBe(first.session.conversationId);
    expect(sessions.diagnostics().persistedSessions).toBe(1);
  });

  it("links an unkeyed tool result through the unique tool call id", () => {
    const sessions = pool();
    const first = sessions.resolve(messages([{ role: "user", content: "inspect files" }]));
    sessions.registerToolCalls(first, [{ id: "call_unique_1" }]);

    const followUp = messages([
      { role: "user", content: "inspect files" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_unique_1",
          type: "function",
          function: { name: "bash", arguments: '{"command":"pwd"}' },
        }],
      },
      { role: "tool", tool_call_id: "call_unique_1", name: "bash", content: "C:/fixture" },
    ]);

    expect(sessions.resolve(followUp).session.conversationId).toBe(first.session.conversationId);
  });

  it("rotates a session when the transcript shrinks and resets sent position", () => {
    const sessions = pool();
    const state = sessions.resolve(messages([
      { role: "user", content: "one" },
      { role: "assistant", content: "answer" },
    ]), "thread-shrink");
    const originalConversation = state.session.conversationId;
    sessions.markSent(state, 2);
    const rotated = sessions.resolve(messages([{ role: "user", content: "new task" }]), "thread-shrink");
    expect(rotated.session.conversationId).not.toBe(originalConversation);
    expect(rotated.session.turnCount).toBe(0);
    sessions.markSent(rotated, 1);
    expect(sessions.diagnostics().persistedSessions).toBe(1);
  });

  it("removes stale linked tool calls during in-memory eviction", () => {
    const sessions = pool();
    const first = sessions.resolve(messages([{ role: "user", content: "inspect" }]));
    sessions.registerToolCalls(first, [{ id: "stale-call" }]);
    const clock = vi.spyOn(Date, "now");
    const current = Date.now();
    clock.mockReturnValue(current + 31 * 60_000);
    try {
      const unrelated = sessions.resolve(messages([{ role: "user", content: "other" }]));
      const followUp = messages([{
        role: "assistant",
        content: null,
        tool_calls: [{ id: "stale-call", type: "function", function: { name: "bash", arguments: "{}" } }],
      }]);
      expect(sessions.resolve(followUp).session.conversationId).not.toBe(first.session.conversationId);
      expect(unrelated.session.conversationId).not.toBe(first.session.conversationId);
    } finally {
      clock.mockRestore();
    }
  });
  it("removes local state and aliases only after remote deletion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m365-handler-prune-"));
    dirs.push(dir);
    const stateStore = new SessionStateStore(join(dir, "sessions.json"));
    const deleted: Array<{ sessionId: string; conversationId: string }> = [];
    const sessions = new SessionPool({}, {
      stateStore,
      remotePruner: async (ids) => { deleted.push(ids); },
    });
    const state = sessions.resolve(messages([{ role: "user", content: "owned" }]), "prune-me");
    sessions.markSent(state, 1);
    sessions.bindResponseId("resp-prune", sessions.managedKeyForSessionKey("prune-me"));
    const result = await sessions.prune({ sessionKey: "prune-me" });
    expect(result).toEqual({ deleted: true, conversationId: state.session.conversationId });
    expect(deleted).toEqual([{ sessionId: state.session.sessionId, conversationId: state.session.conversationId }]);
    expect(stateStore.size).toBe(0);
    expect(stateStore.lookupResponseId("resp-prune")).toBeUndefined();
  });

  it("retains state and schedules the exact retry delay after remote failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m365-handler-prune-fail-"));
    dirs.push(dir);
    const stateStore = new SessionStateStore(join(dir, "sessions.json"));
    let now = 1_000_000;
    const sessions = new SessionPool({}, {
      stateStore,
      now: () => now,
      pruneRetryMs: 15 * 60_000,
      remotePruner: async () => { throw new Error("browser failed"); },
    });
    const state = sessions.resolve(messages([{ role: "user", content: "owned" }]), "retry-me");
    sessions.markSent(state, 1);
    await expect(sessions.prune({ sessionKey: "retry-me" })).rejects.toThrow("browser failed");
    const persisted = stateStore.get(sessions.managedKeyForSessionKey("retry-me"));
    expect(persisted?.conversationId).toBe(state.session.conversationId);
    expect(persisted?.nextPruneAttemptAt).toBe(now + 15 * 60_000);
  });

  it("reaps due persisted records only after remote success", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m365-handler-reap-"));
    dirs.push(dir);
    const stateStore = new SessionStateStore(join(dir, "sessions.json"));
    let now = 2_000_000;
    const remote: string[] = [];
    const sessions = new SessionPool({}, {
      stateStore,
      now: () => now,
      remotePruner: async ({ conversationId }) => { remote.push(conversationId); },
    });
    const state = sessions.resolve(messages([{ role: "user", content: "idle" }]), "idle-key");
    sessions.markSent(state, 1);
    const previousTtl = process.env.M365_SESSION_TTL_MINUTES;
    process.env.M365_SESSION_TTL_MINUTES = "180";
    try {
      now += 180 * 60_000;
      await expect(sessions.reapIdle()).resolves.toEqual({ pruned: 1, failed: 0 });
    } finally {
      if (previousTtl === undefined) delete process.env.M365_SESSION_TTL_MINUTES;
      else process.env.M365_SESSION_TTL_MINUTES = previousTtl;
    }
    expect(remote).toEqual([state.session.conversationId]);
    expect(stateStore.size).toBe(0);
  });
  it("blocks a same-key turn behind a queued prune", async () => {
    let resolveRemote!: () => void;
    let remoteDone = false;
    const sessions = new SessionPool({}, {
      remotePruner: async () => await new Promise<void>((resolve) => { resolveRemote = () => { remoteDone = true; resolve(); }; }),
    });
    const state = sessions.resolve(messages([{ role: "user", content: "owned" }]), "queued-prune");
    sessions.markSent(state, 1);
    const release = await sessions.acquire(messages([{ role: "user", content: "owned" }]), "queued-prune");
    const prune = sessions.prune({ sessionKey: "queued-prune" });
    const turn = sessions.acquire(messages([{ role: "user", content: "next" }]), "queued-prune").then((done) => {
      expect(remoteDone).toBe(true);
      done();
    });
    release();
    await Promise.resolve();
    expect(remoteDone).toBe(false);
    resolveRemote();
    await Promise.all([prune, turn]);
  });
 });
