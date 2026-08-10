import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ParsedToolCall } from "@m365-copilot/core";
import {
  getAttestationGate,
  handleAttestationRequest,
  requestedAttestationClient,
  resetAttestationGate,
  type AttestationRequest,
} from "./attestation.js";

const SECRET = "test-attestation-secret";

function bashCall(id: string, command: string): ParsedToolCall {
  return {
    id,
    type: "function",
    function: { name: "bash", arguments: JSON.stringify({ command }) },
  };
}

function request(id: string, command: string, nonce = "nonce-with-at-least-16-chars"): AttestationRequest {
  return {
    client: "pi",
    tool: "bash",
    tool_call_id: id,
    command_sha256: createHash("sha256").update(command, "utf8").digest("hex"),
    ts: Math.floor(Date.now() / 1_000),
    nonce,
  };
}

function signature(input: AttestationRequest): string {
  return createHmac("sha256", SECRET).update([
    input.client,
    input.tool,
    input.tool_call_id,
    input.command_sha256,
    input.ts,
    input.nonce,
  ].join("\n"), "utf8").digest("hex");
}

function proof(client = "pi", secret = SECRET): string {
  return createHmac("sha256", secret).update(`attestation-v1\n${client}`, "utf8").digest("hex");
}

beforeEach(() => {
  process.env.M365_CLIENT_ATTESTATION = "1";
  process.env.M365_ATTESTATION_SECRET = SECRET;
  resetAttestationGate();
});

afterEach(() => {
  delete process.env.M365_CLIENT_ATTESTATION;
  delete process.env.M365_ATTESTATION_SECRET;
  resetAttestationGate();
});

describe("client attestation gate", () => {
  it("requires explicit config, a known client, and proof of the secret", () => {
    expect(requestedAttestationClient("attestation-v1", "pi", proof())).toBe("pi");
    expect(requestedAttestationClient("attestation-v1", "pi", undefined)).toBeUndefined();
    expect(requestedAttestationClient("attestation-v1", "pi", proof("codex"))).toBeUndefined();
    expect(requestedAttestationClient("attestation-v1", "pi", createHmac("sha256", "wrong").update("attestation-v1\npi", "utf8").digest("hex"))).toBeUndefined();
    expect(requestedAttestationClient("attestation-v1", "unknown", proof())).toBeUndefined();
    expect(requestedAttestationClient("other", "pi", proof())).toBeUndefined();
    delete process.env.M365_ATTESTATION_SECRET;
    resetAttestationGate();
    expect(getAttestationGate()).toBeNull();
  });

  it("authorizes one exact command and accepts one result", () => {
    const gate = getAttestationGate()!;
    const call = bashCall("call_1", "echo safe");
    expect(gate.register("pi", call)).toBe(true);
    const input = request(call.id, "echo safe");
    expect(handleAttestationRequest(input, signature(input), true).status).toBe(200);
    expect(gate.acceptToolResult(call.id, "pi")).toBe(true);
    expect(gate.acceptToolResult(call.id, "pi")).toBe(false);
  });

  it("rejects replay, a command mismatch, and a result without approval", () => {
    const gate = getAttestationGate()!;
    const call = bashCall("call_2", "echo safe");
    expect(gate.register("pi", call)).toBe(true);
    const mismatch = request(call.id, "echo unsafe");
    expect(gate.attest(mismatch, signature(mismatch))).toBe(false);
    expect(gate.acceptToolResult(call.id, "pi")).toBe(false);

    const input = request(call.id, "echo safe", "second-nonce-with-16-chars");
    expect(handleAttestationRequest(input, signature(input), true).status).toBe(200);
    expect(handleAttestationRequest(input, signature(input), true).status).toBe(403);
  });

  it("rejects expired approvals and unsupported tool shapes", () => {
    const gate = getAttestationGate()!;
    const call = bashCall("call_3", "echo safe");
    expect(gate.register("pi", call)).toBe(true);
    const input = request(call.id, "echo safe");
    input.ts -= 61;
    expect(gate.attest(input, signature(input))).toBe(false);
    expect(gate.acceptToolResult(call.id, "pi")).toBe(false);
    expect(gate.register("pi", {
      ...call,
      id: "call_4",
      function: { name: "read", arguments: "{}" },
    })).toBe(false);
  });

  it("denies a tool result for an id that was never registered", () => {
    const gate = getAttestationGate()!;
    expect(gate.acceptToolResult("fabricated-id", "pi")).toBe(false);
    expect(gate.authorized("fabricated-id", "pi")).toBe(false);
    expect(gate.hasCandidate("fabricated-id")).toBe(false);
  });

  it("prunes terminal candidates so the capacity cap does not wedge registration", () => {
    const gate = getAttestationGate()!;
    for (let i = 0; i < 1000; i++) {
      expect(gate.register("pi", bashCall(`bulk_${i}`, "echo x"))).toBe(true);
    }
    expect(gate.register("pi", bashCall("bulk_1000", "echo x"))).toBe(false); // cap reached
    // Consume + accept one candidate (terminal), then registration succeeds again.
    const consumed = request("bulk_0", "echo x", "nonce-prune-capacity-01");
    expect(handleAttestationRequest(consumed, signature(consumed), true).status).toBe(200);
    expect(gate.acceptToolResult("bulk_0", "pi")).toBe(true);
    expect(gate.register("pi", bashCall("bulk_1001", "echo x"))).toBe(true);
  });

  it("hides the control endpoint from non-loopback peers", () => {
    expect(handleAttestationRequest(null, undefined, false).status).toBe(404);
    expect(handleAttestationRequest(null, undefined, true).status).toBe(400);
  });
});
