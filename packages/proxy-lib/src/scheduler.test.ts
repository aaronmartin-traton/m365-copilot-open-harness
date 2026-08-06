import { describe, expect, it, vi } from "vitest";
import { RequestScheduler, SchedulerBusyError } from "./scheduler.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

describe("RequestScheduler", () => {
  it("serializes upstream work", async () => {
    const scheduler = new RequestScheduler({ maxConcurrency: 1, newThreadsPerMinute: 60000, newThreadBurst: 10 });
    const first = deferred<string>();
    const order: string[] = [];
    const a = scheduler.schedule({ newConversation: false }, async () => {
      order.push("a-start");
      const value = await first.promise;
      order.push("a-end");
      return value;
    });
    const b = scheduler.schedule({ newConversation: false }, async () => {
      order.push("b");
      return "b";
    });
    expect(order).toEqual(["a-start"]);
    first.resolve("a");
    await expect(a).resolves.toBe("a");
    await expect(b).resolves.toBe("b");
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });

  it("prioritizes continuation turns", async () => {
    const scheduler = new RequestScheduler({ maxConcurrency: 1, newThreadsPerMinute: 60000, newThreadBurst: 10 });
    const gate = deferred<void>();
    const order: string[] = [];
    const active = scheduler.schedule({ newConversation: false }, async () => { await gate.promise; });
    const fresh = scheduler.schedule({ newConversation: true }, async () => { order.push("fresh"); });
    const continuation = scheduler.schedule({ newConversation: false }, async () => { order.push("continuation"); });
    gate.resolve();
    await active;
    await Promise.all([fresh, continuation]);
    expect(order).toEqual(["continuation", "fresh"]);
  });
  it("runs maintenance while fresh work waits for a new-thread token", async () => {
    const scheduler = new RequestScheduler({ maxConcurrency: 1, newThreadsPerMinute: 0.001, newThreadBurst: 1 });
    const first = scheduler.schedule({ newConversation: true }, async () => "first");
    await first;
    const abort = new AbortController();
    const fresh = scheduler.schedule({ newConversation: true, signal: abort.signal }, async () => "fresh");
    const maintenance = scheduler.schedule({ newConversation: false, maintenance: true }, async () => "maintenance");
    await expect(maintenance).resolves.toBe("maintenance");
    expect(scheduler.stats().completed).toBe(2);
    abort.abort();
    await expect(fresh).rejects.toThrow("aborted");
  });

  it("rejects work beyond the queue bound", async () => {
    const scheduler = new RequestScheduler({ maxConcurrency: 1, maxQueueLength: 1, newThreadsPerMinute: 60000, newThreadBurst: 10 });
    const gate = deferred<void>();
    const active = scheduler.schedule({ newConversation: false }, async () => { await gate.promise; });
    const queued = scheduler.schedule({ newConversation: false }, async () => "queued");
    await expect(scheduler.schedule({ newConversation: false }, async () => "extra")).rejects.toBeInstanceOf(SchedulerBusyError);
    gate.resolve();
    await active;
    await queued;
  });

  it("removes aborted queued work", async () => {
    const scheduler = new RequestScheduler({ maxConcurrency: 1, newThreadsPerMinute: 60000, newThreadBurst: 10 });
    const gate = deferred<void>();
    const active = scheduler.schedule({ newConversation: false }, async () => { await gate.promise; });
    const ac = new AbortController();
    const queued = scheduler.schedule({ newConversation: false, signal: ac.signal }, async () => "never");
    ac.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(scheduler.stats().queued).toBe(0);
    gate.resolve();
    await active;
  });

  it("defers fresh work after burst exhaustion but lets continuations bypass it", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const scheduler = new RequestScheduler({
        maxConcurrency: 1, maxQueueLength: 4, newThreadsPerMinute: 60, newThreadBurst: 1, now: () => now,
      });
      const gate = deferred<void>();
      const active = scheduler.schedule({ newConversation: true }, async () => { await gate.promise; });
      const fresh = scheduler.schedule({ newConversation: true }, async () => "fresh");
      const continuation = scheduler.schedule({ newConversation: false }, async () => "continuation");
      gate.resolve();
      await active;
      await expect(continuation).resolves.toBe("continuation");
      now = 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(fresh).resolves.toBe("fresh");
    } finally {
      vi.useRealTimers();
    }
  });
  it("rejects immediately when the queue bound is zero", async () => {
    const scheduler = new RequestScheduler({ maxConcurrency: 1, maxQueueLength: 0, newThreadsPerMinute: 60, newThreadBurst: 1 });
    const gate = deferred<void>();
    const active = scheduler.schedule({ newConversation: false }, async () => { await gate.promise; });
    await expect(scheduler.schedule({ newConversation: false }, async () => "never")).rejects.toBeInstanceOf(SchedulerBusyError);
    gate.resolve();
    await active;
    expect(scheduler.stats().rejected).toBe(1);
  });

  it("accounts for rejected tasks and wait time", async () => {
    let now = 0;
    const scheduler = new RequestScheduler({ maxConcurrency: 1, newThreadsPerMinute: 60, newThreadBurst: 2, now: () => now });
    await expect(scheduler.schedule({ newConversation: false }, async () => "first")).resolves.toBe("first");
    now = 25;
    await expect(scheduler.schedule({ newConversation: false }, async () => Promise.reject(new Error("failed")))).rejects.toThrow("failed");
    const stats = scheduler.stats();
    expect(stats.active).toBe(0);
    expect(stats.completed).toBe(2);
    expect(stats.averageWaitMs).toBeGreaterThanOrEqual(0);
  });
});
