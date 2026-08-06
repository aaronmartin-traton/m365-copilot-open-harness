import { afterEach, describe, expect, it, vi } from "vitest";

const saved = {
  proven: process.env.M365_WEB_PRUNE_PROVEN,
  ttl: process.env.M365_SESSION_TTL_MINUTES,
};

afterEach(() => {
  if (saved.proven === undefined) delete process.env.M365_WEB_PRUNE_PROVEN;
  else process.env.M365_WEB_PRUNE_PROVEN = saved.proven;
  if (saved.ttl === undefined) delete process.env.M365_SESSION_TTL_MINUTES;
  else process.env.M365_SESSION_TTL_MINUTES = saved.ttl;
  vi.resetModules();
});

describe("automatic reaper process wiring", () => {
  it("stays fail-closed until browser proof is enabled", async () => {
    delete process.env.M365_WEB_PRUNE_PROVEN;
    process.env.M365_SESSION_TTL_MINUTES = "0";
    vi.resetModules();
    const module = await import("./server-pool.ts");
    await expect(module.runReaper()).resolves.toEqual({ pruned: 0, failed: 0 });
    expect(module.reaperHealth()).toMatchObject({ disabled: true, pruned: 0, failed: 0 });
  }, 15_000);

  it("runs the shared pool reaper when browser proof is enabled", async () => {
    process.env.M365_WEB_PRUNE_PROVEN = "1";
    process.env.M365_SESSION_TTL_MINUTES = "0";
    vi.resetModules();
    const module = await import("./server-pool.ts");
    await expect(module.runReaper()).resolves.toEqual({ pruned: 0, failed: 0 });
    expect(module.reaperHealth()).toMatchObject({ disabled: false, pruned: 0, failed: 0 });
    expect(module.reaperHealth().lastRunAt).toEqual(expect.any(Number));
  });
});
