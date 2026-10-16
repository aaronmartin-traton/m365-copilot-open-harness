import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { resolvePiBoltBinary } from "./pi-bolt.js";
import { DEFAULT_PROVIDER_ID, writeM365ProviderConfig } from "./provider.js";
import { PiBoltSupervisor, type SupervisorEvent, type SupervisorOptions } from "./supervisor.js";

/**
 * End-to-end coverage for the supervisor: a real child process is spawned and
 * driven over the RPC framing Pi and Pi-Bolt share. The child is the protocol
 * stand-in rather than a model, so the assertions are about the harness's
 * process handling and event mapping, which is what can break.
 */

const STUB_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "testing",
  "stub-pi-bolt.mjs",
);

const SCRATCH = mkdtempSync(path.join(tmpdir(), "m365-harness-"));

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

function stubSupervisor(options: SupervisorOptions = {}): PiBoltSupervisor {
  return new PiBoltSupervisor({
    command: process.execPath,
    commandArgs: [STUB_PATH],
    cwd: SCRATCH,
    defaultTimeoutMs: 20_000,
    ...options,
  });
}

function recordEvents(instance: PiBoltSupervisor): SupervisorEvent[] {
  const events: SupervisorEvent[] = [];

  instance.onEvent((event) => {
    events.push(event);
  });

  return events;
}

function textOf(events: readonly SupervisorEvent[]): string {
  return events.flatMap((event) => (event.kind === "text" ? [event.delta] : [])).join("");
}

describe("PiBoltSupervisor", () => {
  it("streams a turn from the model stand-in and settles", async () => {
    const instance = stubSupervisor();
    const events = recordEvents(instance);
    const started = instance.start();

    const settled = instance.waitForSettled();

    instance.prompt("hello harness");
    await settled;
    await instance.stop();

    expect(started.args).toContain("--mode");
    expect(started.args).toContain("rpc");
    expect(started.args).toContain("--no-session");
    expect(textOf(events)).toBe("stub-reply:hello harness");
    expect(
      events.some((event) => event.kind === "record" && event.record.type === "tool_start"),
    ).toBe(true);
    expect(events.at(-1)).toEqual({ kind: "exit", code: 0 });
    expect(instance.running).toBe(false);
  });

  it("reports the model reply back through a single runTurn call", async () => {
    const instance = stubSupervisor();
    const text = await instance.runTurn("one shot");

    expect(text).toBe("stub-reply:one shot");
    expect(instance.running).toBe(false);
  });

  // This exercises the harness's own turn timeout against the platform clock,
  // so a genuine delay is the behaviour under test and fake timers cannot
  // stand in for it.
  it("times out when the model never settles", async () => {
    const instance = stubSupervisor();

    instance.start();

    const settled = instance.waitForSettled(300);

    instance.prompt("hang");
    await expect(settled).rejects.toThrow(/did not settle/);
    await instance.stop();

    expect(instance.running).toBe(false);
  });
});

describe("resolvePiBoltBinary", () => {
  it("prefers an explicit path, then PI_BOLT_BIN", () => {
    const previous = process.env.PI_BOLT_BIN;

    try {
      expect(resolvePiBoltBinary("C:/tools/pi-bolt.exe").source).toBe("explicit");

      process.env.PI_BOLT_BIN = "C:/tools/from-env.exe";

      expect(resolvePiBoltBinary()).toEqual({
        command: "C:/tools/from-env.exe",
        source: "env",
      });
    } finally {
      if (previous === undefined) {
        delete process.env.PI_BOLT_BIN;
      } else {
        process.env.PI_BOLT_BIN = previous;
      }
    }
  });
});

describe("writeM365ProviderConfig", () => {
  it("merges the M365 provider, keeps other providers, and is idempotent", () => {
    const configPath = path.join(SCRATCH, "pi-agent", "models.json");
    const baseUrl = "http://127.0.0.1:4141/v1";

    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          providers: { "other-local": { baseUrl: "http://127.0.0.1:1234/v1" } },
          lastChangelogVersion: "0.84.3",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const first = writeM365ProviderConfig({ configPath, baseUrl });

    expect(first.written).toBe(true);
    expect(first.providerId).toBe(DEFAULT_PROVIDER_ID);
    expect(first.models).toContain("m365-copilot");

    const written = JSON.parse(readFileSync(configPath, "utf8"));

    expect(Object.keys(written.providers).sort()).toEqual([DEFAULT_PROVIDER_ID, "other-local"]);
    expect(written.providers[DEFAULT_PROVIDER_ID]).toEqual({
      baseUrl,
      api: "openai-completions",
      apiKey: "m365-local-proxy",
      models: first.models.map((id) => ({ id, contextWindow: 32000 })),
    });
    expect(written.providers["other-local"].baseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(written.lastChangelogVersion).toBe("0.84.3");

    const second = writeM365ProviderConfig({ configPath, baseUrl });

    expect(second.written).toBe(false);
  });
});
