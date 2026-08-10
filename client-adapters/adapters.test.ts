import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piAttestationGate from "./pi-attestation-gate.js";
import ompAttestationGate from "./omp-attestation-gate.js";

type GateResult = { block: true; reason: string } | undefined;
type GateEvent = {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
};
type GateContext = {
  hasUI: boolean;
  ui: { confirm(title: string, message: string): Promise<boolean> };
};
type GateHandler = (event: GateEvent, ctx: GateContext) => Promise<GateResult>;

interface GateAPI {
  on(event: "tool_call", handler: GateHandler): void;
}

const event: GateEvent = { toolName: "bash", toolCallId: "call_adapter", input: { command: "echo safe" } };

beforeEach(() => {
  process.env.M365_ATTESTATION_URL = "http://127.0.0.1:8787";
  process.env.M365_ATTESTATION_SECRET = "adapter-wrapper-secret";
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ decision: "allow" }), { status: 200 })));
});

afterEach(() => {
  delete process.env.M365_ATTESTATION_URL;
  delete process.env.M365_ATTESTATION_SECRET;
  vi.unstubAllGlobals();
});

describe("attestation hook wrappers", () => {
  it("blocks pi without a UI and attests after a confirmation", async () => {
    let handler: GateHandler | undefined;
    piAttestationGate({ on: (_name: "tool_call", listener: GateHandler) => { handler = listener; } } satisfies GateAPI);
    expect(await handler!(event, { hasUI: false, ui: { confirm: async () => true } })).toEqual({
      block: true,
      reason: "Cannot confirm command without a UI",
    });
    expect(await handler!(event, { hasUI: true, ui: { confirm: async () => true } })).toBeUndefined();
  });

  it("blocks OMP on a declined confirmation", async () => {
    let handler: GateHandler | undefined;
    ompAttestationGate({ on: (_name: "tool_call", listener: GateHandler) => { handler = listener; } } satisfies GateAPI);
    expect(await handler!(event, { hasUI: true, ui: { confirm: async () => false } })).toEqual({
      block: true,
      reason: "User denied command",
    });
  });
});
