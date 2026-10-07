import { afterEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * `M365_LOG_FILE` / `M365_FRAME_DIR` are read at import time, so each
 * case re-imports the real module under a mutated env and restores it
 * after. Asserting against a re-implementation of the two `resolve`
 * lines would pass even if log.ts resolved against `cwd()`.
 */
async function loadLogModule(env: Record<string, string | undefined>) {
  const previous = {
    M365_LOG_FILE: process.env.M365_LOG_FILE,
    M365_FRAME_DIR: process.env.M365_FRAME_DIR,
  };

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  vi.resetModules();

  const mod = await import("./log.js");

  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  return mod;
}

const CONFIG = join(homedir(), ".config", "opencode-m365");

describe("log/frame directory overrides", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("defaults inside the config dir", async () => {
    const log = await loadLogModule({});

    expect(log.LOG_PATH).toBe(resolve(CONFIG, "debug.log"));
    expect(log.FRAME_DIR).toBe(resolve(CONFIG, "frames"));
  });

  it("resolves a relative override against the config dir", async () => {
    const log = await loadLogModule({ M365_LOG_FILE: "sweep-a/debug.log", M365_FRAME_DIR: "sweep-a/frames" });

    expect(log.LOG_PATH).toBe(resolve(CONFIG, "sweep-a/debug.log"));
    expect(log.FRAME_DIR).toBe(resolve(CONFIG, "sweep-a/frames"));
  });

  it("takes an absolute override as is", async () => {
    const abs = "/tmp/opencode/frames";
    const log = await loadLogModule({ M365_FRAME_DIR: abs });

    expect(log.FRAME_DIR).toBe(abs);
  });
});
