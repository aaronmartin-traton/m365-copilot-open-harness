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
  /** True iff a candidate exists for the id (any state). */
  hasCandidate(toolCallId: string): boolean;
  /** Non-mutating: would acceptToolResult succeed for this id right now? */
  authorized(toolCallId: string, client: AttestationClient | undefined): boolean;
  /** Consume approval for a tool result; false when not AUTHORIZED/unknown. */
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

  /** Drop expired and terminal candidates so a long-lived process stays under CAPACITY. */
  private pruneCandidates(now: number): void {
    if (this.candidates.size < CAPACITY) return;
    for (const [id, candidate] of this.candidates) {
      if (candidate.expiresAt <= now || candidate.state === "RESULT_ACCEPTED") {
        this.candidates.delete(id);
      }
    }
  }

  register(client: AttestationClient, call: ParsedToolCall): boolean {
    const command = commandFor(call);
    if (command === null) return false;
    const now = Date.now();
    this.pruneNonces(now);
    this.pruneCandidates(now);
    if (this.candidates.size >= CAPACITY || this.candidates.has(call.id)) return false;
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
    // Signature before nonce: never reveal whether a nonce was seen.
    if (!validSignature(this.secret, request, signature)) return false;
    if (Math.abs(now - request.ts * 1_000) > TTL_MS) return false;
    if (this.nonces.has(request.nonce)) return false;
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

  hasCandidate(toolCallId: string): boolean {
    return this.candidates.has(toolCallId);
  }

  authorized(toolCallId: string, client: AttestationClient | undefined): boolean {
    const candidate = this.candidates.get(toolCallId);
    if (!candidate) return false;
    const now = Date.now();
    return candidate.expiresAt > now && candidate.client === client && candidate.state === "AUTHORIZED";
  }

  acceptToolResult(toolCallId: string, client: AttestationClient | undefined): boolean {
    // A tool result is accepted ONLY when a matching AUTHORIZED candidate
    // exists. Unknown or never-emitted ids are denied (fail closed) — callers
    // that went through the 8H verifier path never registered a candidate, so
    // the handler must consult the pool's emitted-ids instead (see handler).
    const candidate = this.candidates.get(toolCallId);
    if (!candidate) return false;
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

/**
 * Resolve the attested-execution client from request headers. The gate is
 * honored ONLY when the caller proves knowledge of the shared secret: the
 * `X-M365-Attestation-Proof` header must be HMAC-SHA256(secret, gate + "\n" +
 * client). Without proof, the headers are ignored and the request stays on the
 * 8H verifier path — a bare header cannot strip the fail-closed gate.
 */
export function requestedAttestationClient(
  executionGate: string | undefined,
  client: string | undefined,
  proof: string | undefined,
): AttestationClient | undefined {
  if (executionGate !== "attestation-v1") return undefined;
  if (!client || !(CLIENTS as readonly string[]).includes(client)) return undefined;
  const secret = getAttestationSecret();
  if (!secret || !proof) return undefined;
  const expected = createHmac("sha256", secret).update(`attestation-v1\n${client}`, "utf8").digest();
  const actual = Buffer.from(proof, "hex");
  if (actual.length !== expected.length) return undefined;
  try {
    if (!timingSafeEqual(actual, expected)) return undefined;
  } catch {
    return undefined;
  }
  return client as AttestationClient;
}

/** The configured shared secret, or undefined when the gate is off. */
function getAttestationSecret(): string | undefined {
  return process.env.M365_CLIENT_ATTESTATION === "1"
    ? process.env.M365_ATTESTATION_SECRET?.trim()
    : undefined;
}

export function resetAttestationGate(): void {
  singleton = null;
}
