# Integration Plan — 10A: fail-closed intent verifier production boundary

Status: IMPLEMENTED (2026-08-08, commit `9e71c7b`). The fail-closed intent
verifier gate is live but opt-in: `M365_INTENT_VERIFIER=1` (or an endpoint
override) activates it; default OFF keeps existing deployments byte-identical.
See `packages/proxy-lib/src/intent-verifier.ts`.

## Production boundary

```
tool-path parse -> fail-closed intent verifier -> tool execution
    verifier timeout/error/invalid -> TEXT, never EXECUTE
    cache hit -> immediate decision
    duplicate in-flight request -> shared verifier result
```

The 8H fail-closed policy is the ONLY approved classification policy (9H
override rejected; directive-010). The verifier sits between the deterministic
`produceToolPath()` parse and tool execution: the parse's tool-shaped result is
NOT executed directly; it is passed to the intent verifier (local Bonsai, frozen
p4-minimal, C0 framing), and execution proceeds only on verifier EXECUTE.

## Wiring (where it would live)

- Parse: existing `parseToolCalls` / `produceToolPath` boundary (unchanged).
- Verifier: new module beside `tool-path.ts` in proxy-lib (NOT added yet —
  separately approved). Input: planner text + tool defs. Output:
  `{ decision: "EXECUTE" | "TEXT", raw, latencyMs, cache: "hit"|"miss"|"shared" }`.
- Execution: existing tool executor, gated on `decision === "EXECUTE"`.

## Required spec items

### 1. Explicit request timeout
- Per-request timeout: **120 s** (configurable; Bonsai cold median ~24.7 s,
  p95 ~44-48 s, so 120 s = ~2.5x p95). Abort via `AbortSignal.timeout`.
- On timeout: fail-closed `TEXT`, never EXECUTE; error surfaced to observability.

### 2. Bounded concurrency
- Max 1 in-flight verifier call per unique cache key (single-flight).
- Global verifier concurrency cap: **1** (sequential) in the default
  configuration — the local GPU serves one request at a time; raising it only
  queues. A pool of >1 is only meaningful with multiple engines.

### 3. Cache eviction / size limits
- Cache key: `sha256(model | promptHash | responseHash(entry) | policyVersion)`.
- Size cap: **1000 entries** (LRU eviction). Bonsai is deterministic at
  temp 0/seed 42, so identical prompts within a session hit; 1000 covers a
  long session's distinct planner texts.
- Staleness: any key-component change (model, prompt file, policy version)
  misses; stored `responseHash` is compared at lookup for drift detection —
  a mismatch is logged and treated as a miss (never serve a stale decision).

### 4. Observability fields
Per verifier call: `model`, `policyVersion`, `promptHash`, `responseHash`,
`cache` (hit|miss|shared), `decision`, `latencyMs`, `error` (null | timeout |
HTTP | network | model-mismatch), `reasoningChars`, `ts`.

### 5. Fail-closed behavior (frozen)
- verifier timeout / HTTP error / network error / invalid output / UNCERTAIN
  -> `TEXT`, never EXECUTE. (Latency bench phase D confirms.)
- Model-identity mismatch (served model != requested) -> error -> TEXT.
- No deterministic branch may return EXECUTE (8H policy invariant).

## Latency budget decision inputs

- Cold median/p95 from `results/latency-10a.json`.
- Cache-hit latency (expected ~0 ms) and single-flight savings (phase C).
- Latency cost driver is the Bonsai call itself (~25 s median). Options if the
  budget is not met: (a) latency engineering (speculative loading, KV reuse,
  smaller context), (b) non-LLM verifier (the 9H positive-evidence detector is
  deterministic and ~free, but by itself cannot recover -010-class cases).

## Out of scope (frozen)

- No held-out inference. No model changes (Bonsai 27B Q1_0 frozen).
- No production code changes in this step; this plan requires separate approval.
