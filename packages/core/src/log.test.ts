import { afterEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { redact } from "./log.js";

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

describe("redact", () => {
  it("removes access_token from a WebSocket URL", () => {
    // Composed at runtime so the repository never contains a JWT-shaped literal
    // (scripts/secret-scan.mjs blocks those, correctly).
    const jwt = [
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
      "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    ].join(".");
    const line = `wss://substrate.office.com/m365Copilot/Chathub/oid@tid?chatsessionid=abc&access_token=${jwt}&variants=x`;

    const out = redact(line);

    expect(out).toContain("access_token=[REDACTED]");
    expect(out).not.toContain(jwt);
    expect(out).not.toContain("eyJ");
  });

  it("removes refresh_token values", () => {
    expect(redact("refresh_token=0.AAAA-secret&scope=openid")).toBe("refresh_token=[REDACTED]&scope=openid");
  });

  it("removes Authorization Bearer and bare Bearer credentials", () => {
    expect(redact("Authorization: Bearer sk-live-123")).toBe("Authorization: Bearer [REDACTED]");
    expect(redact("sent Bearer sk-live-123 to the server")).toBe("sent Bearer [REDACTED] to the server");
  });

  it("removes a bare JWT", () => {
    const bare = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "abcDEF123"].join(".");

    expect(redact(`token is ${bare} here`)).toBe("token is [REDACTED_JWT] here");
  });

  it("leaves ordinary text untouched", () => {
    const text = 'Chat turn 1: model=gpt-5, text="hello world", tokens=42';

    expect(redact(text)).toBe(text);
  });

  it("does not throw on malformed input", () => {
    for (const input of ["", "eyJ", "token=", "Bearer", "Authorization: Bearer", "eyJ.a.b", "\uD800", "{{{"]) {
      expect(() => redact(input)).not.toThrow();
      expect(typeof redact(input)).toBe("string");
    }
  });
});
