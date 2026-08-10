export interface AttestationOptions {
  client?: "pi" | "omp" | "codex";
  toolCallId?: string;
  command?: string;
  proxyUrl?: string;
  secret?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  nonce?: string;
}

export type AttestationResult =
  | { allowed: true }
  | { allowed: false; reason: string };

export function attestationProofHeader(client: string, secret?: string): string | { allowed: false; reason: string };
export function attestCommand(options?: AttestationOptions): Promise<AttestationResult>;
export function runCodexHook(event: unknown, options?: AttestationOptions): Promise<
  { decision: "approve" } | { decision: "block"; reason: string }
>;
