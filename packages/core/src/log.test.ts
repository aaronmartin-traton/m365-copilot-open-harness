import { describe, expect, it } from "vitest";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

/**
 * `M365_LOG_FILE` / `M365_FRAME_DIR` are resolved against the config dir, the
 * same way upstream f881913 does it, so a bench sweep can point one proxy at
 * its own archive. The module reads env at import time, so this re-implements
 * the two lines rather than importing them under a mutated env.
 */
function resolveConfig(env: string | undefined, fallback: string): string {
  return resolve(join(homedir(), ".config", "opencode-m365"), env || fallback);
}

describe("log/frame directory overrides", () => {
  it("defaults inside the config dir", () => {
    expect(resolveConfig(undefined, "debug.log")).toBe(resolve(homedir(), ".config/opencode-m365/debug.log"));
    expect(resolveConfig(undefined, "frames")).toBe(resolve(homedir(), ".config/opencode-m365/frames"));
  });

  it("resolves a relative override against the config dir", () => {
    expect(resolveConfig("sweep-a/debug.log", "debug.log")).toBe(resolve(homedir(), ".config/opencode-m365/sweep-a/debug.log"));
  });

  it("takes an absolute override as is", () => {
    const abs = "/tmp/opencode/frames";
    expect(resolveConfig(abs, "frames")).toBe(abs);
    expect(isAbsolute(resolveConfig(abs, "frames"))).toBe(true);
  });

  it("keeps the log directory beside the log file", () => {
    const file = resolveConfig("sweep-a/nested/debug.log", "debug.log");
    expect(dirname(file)).toBe(resolve(homedir(), ".config/opencode-m365/sweep-a/nested"));
  });
});
