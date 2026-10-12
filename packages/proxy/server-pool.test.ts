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
  it("reaps by default when nothing is configured", async () => {
    delete process.env.M365_WEB_PRUNE_PROVEN;
    delete process.env.M365_SESSION_TTL_MINUTES;
    vi.resetModules();
    const module = await import("./server-pool.js");
    await expect(module.runReaper()).resolves.toEqual({ pruned: 0, failed: 0 });
    expect(module.reaperHealth()).toMatchObject({ disabled: false, pruned: 0, failed: 0 });
    expect(module.reaperHealth().lastRunAt).toEqual(expect.any(Number));
  }, 15_000);

  it("is switched off by M365_WEB_PRUNE_PROVEN=0", async () => {
    process.env.M365_WEB_PRUNE_PROVEN = "0";
    process.env.M365_SESSION_TTL_MINUTES = "0";
    vi.resetModules();
    const module = await import("./server-pool.js");
    await expect(module.runReaper()).resolves.toEqual({ pruned: 0, failed: 0 });
    expect(module.reaperHealth()).toMatchObject({ disabled: true, pruned: 0, failed: 0 });
  }, 15_000);

  it("stays enabled while a zero TTL keeps it from deleting anything", async () => {
    // The two switches are independent: `0` TTL means "nothing is idle enough",
    // which is not the same as "the reaper is switched off".
    process.env.M365_WEB_PRUNE_PROVEN = "1";
    process.env.M365_SESSION_TTL_MINUTES = "0";
    vi.resetModules();
    const module = await import("./server-pool.js");
    await expect(module.runReaper()).resolves.toEqual({ pruned: 0, failed: 0 });
    expect(module.reaperHealth()).toMatchObject({ disabled: false, pruned: 0, failed: 0 });
  }, 15_000);
});
