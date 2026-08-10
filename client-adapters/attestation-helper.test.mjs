import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { attestCommand, runCodexHook } from "./attestation-helper.mjs";

const SECRET = "adapter-test-secret";
const NOW = 1_786_263_011_000;
const NONCE = "adapter-nonce-with-16-chars";

function expectedSignature(payload) {
  return createHmac("sha256", SECRET).update([
    payload.client,
    payload.tool,
    payload.tool_call_id,
    payload.command_sha256,
    payload.ts,
    payload.nonce,
  ].join("\n"), "utf8").digest("hex");
}

describe("attestation helper", () => {
  it("binds the signature to the exact command", async () => {
    const fetchImpl = vi.fn(async (_url, _init) => new Response(JSON.stringify({ decision: "allow" }), { status: 200 }));
    const result = await attestCommand({
      client: "pi",
      toolCallId: "call_1",
      command: "echo safe",
      proxyUrl: "http://127.0.0.1:8787",
      secret: SECRET,
      fetchImpl,
      now: () => NOW,
      nonce: NONCE,
    });

    expect(result).toEqual({ allowed: true });
    const payload = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(payload).toEqual({
      client: "pi",
      tool: "bash",
      tool_call_id: "call_1",
      command_sha256: createHash("sha256").update("echo safe", "utf8").digest("hex"),
      ts: Math.floor(NOW / 1_000),
      nonce: NONCE,
    });
    expect(fetchImpl.mock.calls[0][1].headers["X-M365-Attestation-Sig"]).toBe(expectedSignature(payload));
  });

  it("fails closed before network access for a non-loopback proxy", async () => {
    const fetchImpl = vi.fn();
    const result = await attestCommand({
      client: "omp",
      toolCallId: "call_2",
      command: "echo safe",
      proxyUrl: "http://example.test:8787",
      secret: SECRET,
      fetchImpl,
    });

    expect(result.allowed).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns the Codex block decision when the proxy denies", async () => {
    const decision = await runCodexHook({
      tool_name: "Bash",
      tool_use_id: "call_3",
      tool_input: { command: "echo safe" },
    }, {
      proxyUrl: "http://127.0.0.1:8787",
      secret: SECRET,
      fetchImpl: async () => new Response(JSON.stringify({ decision: "deny" }), { status: 403 }),
    });

    expect(decision).toEqual({ decision: "block", reason: "Attestation proxy denied the command" });
  });

  it("blocks missing configuration, a network failure, and malformed Codex input", async () => {
    expect(await attestCommand({ client: "pi", toolCallId: "call_4", command: "echo safe" })).toMatchObject({
      allowed: false,
    });
    expect(await attestCommand({
      client: "pi",
      toolCallId: "call_5",
      command: "echo safe",
      proxyUrl: "http://127.0.0.1:8787",
      secret: SECRET,
      fetchImpl: async () => { throw new Error("offline"); },
    })).toEqual({ allowed: false, reason: "Attestation proxy is unavailable" });
    expect(await runCodexHook(null)).toEqual({ decision: "block", reason: "Invalid Codex hook input" });
  });
});
