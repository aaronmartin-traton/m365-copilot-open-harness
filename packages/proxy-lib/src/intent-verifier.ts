/**
 * Fail-closed intent verifier — production boundary for the 8H policy.
 *
 * Sits between the deterministic tool-path parse and tool execution. The parse's
 * tool-shaped result is NOT executed directly: it is passed to a local verifier
 * (frozen p4-minimal prompt, C0 framing) and execution proceeds only on a
 * verifier EXECUTE. Timeout / HTTP error / network error / invalid output /
 * model-mismatch -> TEXT, never EXECUTE (8H policy invariant: no deterministic
 * branch may authorize execution).
 *
 * Default ON. Disabled only by the explicit opt-out `M365_INTENT_VERIFIER=0`
 * (wins over every endpoint/model override). When inactive, `getIntentVerifier()`
 * returns null and the tool path is byte-identical to current behavior.
 *
 * Spec reference: experiments/tool-decision/execution-intent/
 *   integration-plan-10a.md + fail-closed-policy-8h.json + prompts/p4-minimal.txt
 */

import { createHash } from "node:crypto";
import { createLogger } from "@m365-copilot/core";

const log = createLogger("intent-verifier");

// ---------------------------------------------------------------------------
// Frozen verifier prompt (content-identical to the experiment artifact;
// line endings normalized to LF so the identity guard is checkout-portable;
// guarded by a drift test in intent-verifier.test.ts).
// ---------------------------------------------------------------------------
/**
 * Content-identical to experiments/tool-decision/execution-intent/prompts/p4-minimal.txt
 * (logical text equal to the artifact; trailing newline canonicalized to LF —
 * git may check the file out CRLF or LF depending on autocrlf). The drift guard
 * test compares this constant against the artifact file, normalizing both sides.
 */
export const INTENT_VERIFIER_PROMPT =
  "Classify whether command/tool-shaped content in this assistant response is intended to be executed now. EXECUTE = perform it now. TEXT = show/discuss it without performing it. UNCERTAIN = insufficient evidence. Return exactly one token: EXECUTE, TEXT, or UNCERTAIN.\n";

type IntentDecision = "EXECUTE" | "TEXT";
type IntentCache = "hit" | "miss" | "shared";

/**
 * Closed set of verifier error conditions. The retry decision switches on
 * this structurally instead of comparing raw strings.
 */
type VerifierError =
  | "timeout"
  | "network"
  | "model-mismatch"
  | "invalid"
  | `HTTP ${number}`;

/** The per-check outcome. `raw` is the verbatim verifier token (or null on error). */
interface IntentCheck {
  decision: IntentDecision;
  raw: string | null;
  cache: IntentCache;
  latencyMs: number;
  error: VerifierError | null;
  reasoningChars: number;
}

export interface IntentVerifier {
  check(plannerText: string): Promise<IntentCheck>;
}

const POLICY_VERSION = "8h";

const VOCAB = new Set(["EXECUTE", "TEXT", "UNCERTAIN"]);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const sha256 = (s: string) => createHash("sha256").update(s, "utf-8").digest("hex");

/** One verifier HTTP attempt's raw result before the 8H arbitration table. */
interface RawAttempt {
  /** Verbatim token from the model (null on HTTP/network/model-mismatch). */
  token: string | null;
  reasoningChars: number;
  error: VerifierError | null;
}

/** Retryable error classes (structural switch on the closed union). */
const RETRYABLE_ERRORS = new Set<VerifierError>(["HTTP 500", "HTTP 503", "network"]);

/** True when a verifier attempt authorizes execution (only literal EXECUTE). */
function authorizes(attempt: RawAttempt | null): boolean {
  return (
    attempt !== null &&
    attempt.error === null &&
    attempt.token !== null &&
    attempt.token.trim().toUpperCase() === "EXECUTE"
  );
}

// ---------------------------------------------------------------------------
// singleton / env gate
// ---------------------------------------------------------------------------
let singleton: IntentVerifier | null = null;

/** True when the verifier is active. Default ON; disabled only by the
 * explicit opt-out `M365_INTENT_VERIFIER=0`, which wins over every
 * endpoint/model override. `M365_INTENT_VERIFIER=1` and endpoint-set alone
 * (no explicit 0) remain valid explicit activations. */
function verifierEnabled(): boolean {
  return process.env.M365_INTENT_VERIFIER !== "0";
}

/**
 * Lazy process-wide singleton. Reads env on first call. Returns null while the
 * gate is off — callers then keep current (unverified) behavior.
 */
export function getIntentVerifier(): IntentVerifier | null {
  if (!verifierEnabled()) return null;
  singleton ??= new BonsaiIntentVerifier();
  return singleton;
}

/** Drop the cached singleton so the next call re-reads env (test hook). */
export function resetIntentVerifier(): void {
  singleton = null;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
/** What we persist for a decision (stored on successful, non-error checks). */
interface CachedEntry {
  decision: IntentDecision;
  raw: string | null;
  reasoningChars: number;
}

const CACHE_CAP = 1000;
const DEFAULT_ENDPOINT = "http://127.0.0.1:1234/v1/chat/completions";
const DEFAULT_MODEL = "bonsai-27b-q1";

/**
 * Parse the optional `M365_INTENT_VERIFIER_TEMPLATE_KWARGS` env var (a JSON
 * object forwarded as `chat_template_kwargs`). Unset/empty -> undefined (no
 * kwargs, request unchanged). Invalid JSON throws at construction — a loud
 * config error, never silently ignored and never fail-closed-as-UNCERTAIN.
 */
function parseTemplateKwargs(raw: string | undefined): Record<string, unknown> | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(
      `intent-verifier: M365_INTENT_VERIFIER_TEMPLATE_KWARGS is not valid JSON: ${value}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `intent-verifier: M365_INTENT_VERIFIER_TEMPLATE_KWARGS must be a JSON object, got: ${value}`,
    );
  }
  return parsed as Record<string, unknown>;
}

class BonsaiIntentVerifier implements IntentVerifier {
  private readonly endpoint: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly retryBackoffMs: number;
  private readonly templateKwargs: Record<string, unknown> | undefined;
  private readonly kwargsHash: string;
  private readonly promptHash: string;

  /** LRU decision cache: full cache-key -> entry. Cap 1000 entries. */
  private readonly cache = new Map<string, CachedEntry>();

  /** in-flight full-key -> Promise (single-flight). */
  private readonly inflight = new Map<string, Promise<IntentCheck>>();

  /** global concurrency cap 1: serialized fetch executions. */
  private chain: Promise<void> = Promise.resolve();

  constructor() {
    const env = process.env;
    this.endpoint = (env.M365_INTENT_VERIFIER_ENDPOINT || "").trim() || DEFAULT_ENDPOINT;
    this.model = (env.M365_INTENT_VERIFIER_MODEL || "").trim() || DEFAULT_MODEL;
    this.maxTokens = Math.max(1, Number(env.M365_INTENT_VERIFIER_MAX_TOKENS) || 2048);
    this.timeoutMs = Math.max(1, Number(env.M365_INTENT_VERIFIER_TIMEOUT_MS) || 120000);
    this.retryBackoffMs = Math.max(0, Number(env.M365_INTENT_VERIFIER_RETRY_BACKOFF_MS) || 15000);
    this.templateKwargs = parseTemplateKwargs(env.M365_INTENT_VERIFIER_TEMPLATE_KWARGS);
    this.kwargsHash = sha256(JSON.stringify(this.templateKwargs ?? null));
    this.promptHash = sha256(INTENT_VERIFIER_PROMPT);
  }

  /** full key: sha256(model|promptHash|kwargsHash|responseHash|policyVersion) */
  private fullKey(responseHash: string): string {
    return sha256(`${this.model}|${this.promptHash}|${this.kwargsHash}|${responseHash}|${POLICY_VERSION}`);
  }

  private cacheSet(key: string, entry: CachedEntry): void {
    if (this.cache.size >= CACHE_CAP) {
      // LRU: Map keeps insertion order; drop the oldest.
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, entry);
  }

  /** Full observability record per check (decision-H binding: model identity,
   * hashes, cache, decision, latency, error, reasoning chars). Emitted inside
   * check() where all the fields live. */
  private record(check: IntentCheck, responseHash: string): IntentCheck {
    log.info(
      `intent-verifier: model=${this.model} policyVersion=${POLICY_VERSION} ` +
        `promptHash=${this.promptHash} responseHash=${responseHash} ` +
        `cache=${check.cache} decision=${check.decision} latencyMs=${check.latencyMs} ` +
        `error=${check.error ?? "null"} reasoningChars=${check.reasoningChars} ` +
        `ts=${new Date().toISOString()}`,
    );
    return check;
  }

  async check(plannerText: string): Promise<IntentCheck> {
    const t0 = Date.now();
    const responseHash = sha256(plannerText);
    const key = this.fullKey(responseHash);

    // cache hit
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached); // LRU touch
      return this.record(
        {
          decision: cached.decision,
          raw: cached.raw,
          cache: "hit",
          latencyMs: Date.now() - t0,
          error: null,
          reasoningChars: cached.reasoningChars,
        },
        responseHash,
      );
    }

    // single-flight: identical in-flight request -> share its result
    const flying = this.inflight.get(key);
    if (flying) {
      const base = await flying;
      return this.record(
        { ...base, cache: "shared" as const, latencyMs: Date.now() - t0 },
        responseHash,
      );
    }

    const run = this.runSerialized(plannerText, t0);
    this.inflight.set(key, run);
    try {
      const out = await run;
      if (out.error === null) {
        this.cacheSet(key, {
          decision: out.decision,
          raw: out.raw,
          reasoningChars: out.reasoningChars,
        });
      }
      return this.record(out, responseHash);
    } finally {
      this.inflight.delete(key);
    }
  }

  /** Serialize every verifier fetch behind a global chain (cap 1). */
  private runSerialized(plannerText: string, t0: number): Promise<IntentCheck> {
    const run = this.chain.then(() => this.internalVerify(plannerText, t0, 0));
    // keep the chain alive past this task's own failure
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** One fetch attempt with its own AbortSignal timeout. */
  private async attempt(plannerText: string): Promise<RawAttempt> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: INTENT_VERIFIER_PROMPT },
            { role: "user", content: `Assistant response:\n${plannerText}` },
          ],
          temperature: 0,
          seed: 42,
          max_tokens: this.maxTokens,
          ...(this.templateKwargs ? { chat_template_kwargs: this.templateKwargs } : {}),
        }),
        signal: controller.signal,
      });
      if (resp.status === 500 || resp.status === 503) {
        return { token: null, reasoningChars: 0, error: `HTTP ${resp.status}` };
      }
      if (!resp.ok) {
        return { token: null, reasoningChars: 0, error: `HTTP ${resp.status}` };
      }
      const j = (await resp.json()) as {
        model?: unknown;
        choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
      };
      if (j.model !== undefined && j.model !== null && String(j.model) !== this.model) {
        return { token: null, reasoningChars: 0, error: "model-mismatch" };
      }
      const msg = j.choices?.[0]?.message;
      const token = msg?.content ?? null;
      if (token === null) {
        return { token: null, reasoningChars: msg?.reasoning_content?.length ?? 0, error: "invalid" };
      }
      return {
        token,
        reasoningChars: msg?.reasoning_content?.length ?? 0,
        error: null,
      };
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      return { token: null, reasoningChars: 0, error: aborted ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Retry loop (500/503/network, max 2, backoff) within the overall deadline. */
  private async internalVerify(
    plannerText: string,
    t0: number,
    attempt: number,
  ): Promise<IntentCheck> {
    const t = Date.now();
    if (t - t0 >= this.timeoutMs) {
      return this.finish(null, "timeout", t0, "miss");
    }
    const a = await this.attempt(plannerText);
    const retryable = a.error !== null && RETRYABLE_ERRORS.has(a.error);
    if (retryable && attempt < 2 && Date.now() - t0 < this.timeoutMs) {
      await new Promise((r) => setTimeout(r, this.retryBackoffMs * (attempt + 1)));
      return this.internalVerify(plannerText, t0, attempt + 1);
    }
    return this.finish(a, a.error, t0, "miss");
  }

  /** Build the final check from a raw attempt (8H arbitration: only EXECUTE -> EXECUTE). */
  private finish(
    attempt: RawAttempt | null,
    error: VerifierError | null,
    t0: number,
    cache: IntentCache,
  ): IntentCheck {
    const decision: IntentDecision = authorizes(attempt) ? "EXECUTE" : "TEXT";
    return {
      decision,
      raw: attempt?.token ?? null,
      cache,
      latencyMs: Date.now() - t0,
      error,
      reasoningChars: attempt?.reasoningChars ?? 0,
    };
  }
}
