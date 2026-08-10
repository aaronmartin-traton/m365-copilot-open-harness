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
  it("requires explicit config and a known client selection", () => {
    expect(requestedAttestationClient("attestation-v1", "pi")).toBe("pi");
    expect(requestedAttestationClient("attestation-v1", "unknown")).toBeUndefined();
    expect(requestedAttestationClient("other", "pi")).toBeUndefined();
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

  it("hides the control endpoint from non-loopback peers", () => {
    expect(handleAttestationRequest(null, undefined, false).status).toBe(404);
    expect(handleAttestationRequest(null, undefined, true).status).toBe(400);
  });
});
