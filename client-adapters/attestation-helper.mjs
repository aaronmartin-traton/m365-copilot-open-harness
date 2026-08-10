import { createHash, createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { readFile } from "node:fs/promises";

const CLIENTS = new Set(["pi", "omp", "codex"]);
const TIMEOUT_MS = 5_000;

function deny(reason) {
  return { allowed: false, reason };
}

/**
 * The request-header proof that opts a chat request into the attestation gate:
 * HMAC-SHA256(secret, "attestation-v1\n" + client), hex. Configure it as a
 * static `X-M365-Attestation-Proof` header on the model provider alongside
 * `X-M365-Execution-Gate: attestation-v1` and `X-M365-Attestation-Client`.
 */
export function attestationProofHeader(client, secret = process.env.M365_ATTESTATION_SECRET) {
  if (!CLIENTS.has(client)) return deny("Unsupported attestation client");
  if (typeof secret !== "string" || secret.trim().length === 0) return deny("Attestation secret is not configured");
  return createHmac("sha256", secret.trim()).update(`attestation-v1\n${client}`, "utf8").digest("hex");
}

function isLoopbackHost(hostname) {
  if (hostname === "localhost") return true;
  const family = isIP(hostname);
  if (family === 6) return hostname === "::1" || hostname.startsWith("::ffff:127.");
  if (family === 4) return hostname.startsWith("127.");
  return false;
}

/** Ask the local proxy to consume approval for one exact emitted command. */
export async function attestCommand({
  client,
  toolCallId,
  command,
  proxyUrl = process.env.M365_ATTESTATION_URL,
  secret = process.env.M365_ATTESTATION_SECRET,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  nonce = randomBytes(24).toString("base64url"),
} = {}) {
  if (!CLIENTS.has(client)) return deny("Unsupported attestation client");
  if (typeof toolCallId !== "string" || toolCallId.length === 0) return deny("Missing tool-call id");
  if (typeof command !== "string") return deny("Missing bash command");
  if (typeof proxyUrl !== "string" || typeof secret !== "string" || secret.trim().length === 0) {
    return deny("Attestation proxy URL or secret is not configured");
  }
  secret = secret.trim();

  let endpoint;
  try {
    endpoint = new URL("/v1/attestations", proxyUrl);
  } catch {
    return deny("Attestation proxy URL is invalid");
  }
  if (endpoint.protocol !== "http:" || !isLoopbackHost(endpoint.hostname)) {
    return deny("Attestation proxy must use loopback HTTP");
  }

  const ts = Math.floor(now() / 1_000);
  const payload = {
    client,
    tool: "bash",
    tool_call_id: toolCallId,
    command_sha256: createHash("sha256").update(command, "utf8").digest("hex"),
    ts,
    nonce,
  };
  const signature = createHmac("sha256", secret).update([
    payload.client,
    payload.tool,
    payload.tool_call_id,
    payload.command_sha256,
    payload.ts,
    payload.nonce,
  ].join("\n"), "utf8").digest("hex");

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-M365-Attestation-Sig": signature,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await response.json().catch(() => null);
    return response.ok && body?.decision === "allow"
      ? { allowed: true }
      : deny("Attestation proxy denied the command");
  } catch {
    return deny("Attestation proxy is unavailable");
  }
}
export async function runCodexHook(event, options) {
  if (!event || typeof event !== "object" || typeof event.tool_name !== "string") {
    return { decision: "block", reason: "Invalid Codex hook input" };
  }
  if (event.tool_name !== "Bash") return { decision: "approve" };
  const result = await attestCommand({
    ...options,
    client: "codex",
    toolCallId: event.tool_use_id,
    command: event.tool_input?.command,
  });
  return result.allowed ? { decision: "approve" } : { decision: "block", reason: result.reason };
}

if (process.argv.includes("--codex")) {
  const input = await readFile(0, "utf8");
  try {
    process.stdout.write(`${JSON.stringify(await runCodexHook(JSON.parse(input)))}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify({ decision: "block", reason: "Invalid Codex hook input" })}\n`);
  }
}

// Print the static X-M365-Attestation-Proof header value for a client, for
// wiring into the harness provider config alongside the gate headers.
// Usage: bun client-adapters/attestation-helper.mjs --proof pi
if (process.argv.includes("--proof")) {
  const idx = process.argv.indexOf("--proof");
  const client = process.argv[idx + 1];
  const proof = attestationProofHeader(client);
  if (typeof proof === "string") {
    process.stdout.write(`X-M365-Attestation-Proof: ${proof}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(proof)}\n`);
    process.exitCode = 1;
  }
}
