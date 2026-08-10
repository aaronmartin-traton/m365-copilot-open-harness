import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import type { ParsedToolCall } from "@m365-copilot/core";

const CLIENTS = ["pi", "omp", "codex"] as const;
const TTL_MS = 60_000;
const CAPACITY = 1_000;

type CandidateState = "PENDING" | "AUTHORIZED" | "RESULT_ACCEPTED";
export type AttestationClient = (typeof CLIENTS)[number];

export const AttestationRequestSchema = z.object({
  client: z.enum(CLIENTS),
  tool: z.literal("bash"),
  tool_call_id: z.string().min(1),
  command_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  ts: z.number().int().nonnegative(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/),
});

export type AttestationRequest = z.infer<typeof AttestationRequestSchema>;

interface Candidate {
  client: AttestationClient;
  commandSha256: string;
  expiresAt: number;
  state: CandidateState;
}

export interface AttestationGate {
  register(client: AttestationClient, call: ParsedToolCall): boolean;
  attest(request: AttestationRequest, signature: string | undefined): boolean;
  acceptToolResult(toolCallId: string, client: AttestationClient | undefined): boolean;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function commandFor(call: ParsedToolCall): string | null {
  if (call.function.name !== "bash") return null;
  try {
    const args = JSON.parse(call.function.arguments) as { command?: unknown };
    return typeof args.command === "string" ? args.command : null;
  } catch {
    return null;
  }
}

function signaturePayload(request: AttestationRequest): string {
  return [
    request.client,
    request.tool,
    request.tool_call_id,
    request.command_sha256,
    request.ts,
    request.nonce,
  ].join("\n");
}

function validSignature(secret: string, request: AttestationRequest, supplied: string | undefined): boolean {
  if (!supplied || !/^[0-9a-f]{64}$/.test(supplied)) return false;
  const expected = createHmac("sha256", secret).update(signaturePayload(request), "utf8").digest();
  const actual = Buffer.from(supplied, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

class InMemoryAttestationGate implements AttestationGate {
  private readonly candidates = new Map<string, Candidate>();
  private readonly nonces = new Map<string, number>();

  constructor(private readonly secret: string) {}

  private pruneNonces(now: number): void {
    for (const [nonce, expiresAt] of this.nonces) {
      if (expiresAt <= now) this.nonces.delete(nonce);
    }
  }

  register(client: AttestationClient, call: ParsedToolCall): boolean {
    const command = commandFor(call);
    if (command === null) return false;
    const now = Date.now();
    this.pruneNonces(now);
    if (this.candidates.size >= CAPACITY || this.candidates.has(call.id)) return false;
    // ponytail: fixed 1,000-entry cap fails back to 8H; raise it only when a
    // real session exhausts it rather than evicting an authorization record.
    this.candidates.set(call.id, {
      client,
      commandSha256: sha256(command),
      expiresAt: now + TTL_MS,
      state: "PENDING",
    });
    return true;
  }

  attest(request: AttestationRequest, signature: string | undefined): boolean {
    const now = Date.now();
    this.pruneNonces(now);
    if (Math.abs(now - request.ts * 1_000) > TTL_MS) return false;
    if (this.nonces.has(request.nonce) || !validSignature(this.secret, request, signature)) return false;
    const candidate = this.candidates.get(request.tool_call_id);
    if (
      !candidate ||
      candidate.state !== "PENDING" ||
      candidate.expiresAt <= now ||
      candidate.client !== request.client ||
      candidate.commandSha256 !== request.command_sha256
    ) return false;
    this.nonces.set(request.nonce, now + TTL_MS);
    candidate.state = "AUTHORIZED";
    return true;
  }

  acceptToolResult(toolCallId: string, client: AttestationClient | undefined): boolean {
    const candidate = this.candidates.get(toolCallId);
    if (!candidate) return true;
    const now = Date.now();
    if (candidate.expiresAt <= now || candidate.client !== client || candidate.state !== "AUTHORIZED") return false;
    candidate.state = "RESULT_ACCEPTED";
    return true;
  }
}

let singleton: AttestationGate | null = null;


export function getAttestationGate(): AttestationGate | null {
  const secret = process.env.M365_CLIENT_ATTESTATION === "1"
    ? process.env.M365_ATTESTATION_SECRET?.trim()
    : undefined;
  if (!secret) return null;
  singleton ??= new InMemoryAttestationGate(secret);
  return singleton;
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Process the loopback control request after the server identifies its peer. */
export function handleAttestationRequest(
  body: unknown,
  signature: string | undefined,
  isLoopback: boolean,
): Response {
  if (!isLoopback) {
    return response(404, { error: { type: "not_found", message: "Not found" } });
  }
  const gate = getAttestationGate();
  if (!gate) return response(404, { error: { type: "not_found", message: "Not found" } });
  const parsed = AttestationRequestSchema.safeParse(body);
  if (!parsed.success) {
    return response(400, { error: { type: "invalid_request_error", message: parsed.error.message } });
  }
  if (!gate.attest(parsed.data, signature)) {
    return response(403, { error: { type: "attestation_denied", message: "Attestation denied" } });
  }
  return response(200, { decision: "allow" });
}

export function requestedAttestationClient(
  executionGate: string | undefined,
  client: string | undefined,
): AttestationClient | undefined {
  if (executionGate !== "attestation-v1") return undefined;
  return (CLIENTS as readonly string[]).includes(client ?? "") ? client as AttestationClient : undefined;
}

export function resetAttestationGate(): void {
  singleton = null;
}
