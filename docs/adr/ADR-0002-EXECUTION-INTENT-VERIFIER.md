# ADR-0002 — Execution-Intent Verifier (fail-closed)

**Date:** 2026-08-08
**Status:** Superseded (2026-08-13 simplify-tool-path pivot)

> **Superseded by architecture pivot.** The execution-intent verifier gate is
> **removed from the runtime path** — the proxy is now a pure translator
> (`tool-path.ts` no longer imports or calls `intent-verifier.ts`). The
> `intent-verifier.ts` module (below) and its frozen 8H corpus are preserved
> as **research artifacts** under `packages/proxy-lib/src/`, no longer
> exercised by production code. Execution-intent / authorization policy now
> belongs to the consuming harness, not the translator. The boundary decision
> is recorded in the local ticket tracker (not published).

## Decision

Tool execution through the M365 proxy is gated on a local execution-intent
verifier. Only a literal verifier `EXECUTE` verdict authorizes executing a
tool call; every other outcome — `TEXT`, `UNCERTAIN`, invalid answer, model
mismatch, timeout, or error — resolves to returning the model's raw text.

The verifier is **on by default**. The explicit opt-out
`M365_INTENT_VERIFIER=0` disables it and wins over every endpoint/model
override; `M365_INTENT_VERIFIER=1` or an endpoint override remain explicit
activations (ticket 02).

## Why fail-closed

Deterministic-only handling produced 13 unsafe execution false positives on
the frozen corpus (docs/hypotheses.md §9, 5E/8H rows). Bonsai-only C0/P4 and
the 8H hybrid corrected all of them at 0 unsafe FP / 0.893 selective
accuracy / 100% coverage-stability. The 9H positive-evidence override was
rejected — it deliberately leaves `execution_intent-010` unresolved.

## Contract

- Verifier decides one of `EXECUTE` | `TEXT` | `UNCERTAIN` for a tool
  decision (frozen semantics in
  `experiments/tool-decision/execution-intent/README.md`).
- Only literal `EXECUTE` authorizes tool execution.
- Single-flight; global concurrency cap 1; 120 s deadline; 500/503/network
  retry ×2.
- Cache key `(model | promptHash | responseHash | policyVersion)`; a DRIFT
  probe never serves from a stale prefix key.
- Corpus/splits/prompts frozen; verifier never validates its own held-out set.

## Implementation

`packages/proxy-lib/src/intent-verifier.ts` (`getIntentVerifier()`),
wired into the tool path after the one-call-per-turn gate, before
`registerToolCalls`; non-EXECUTE → raw text. `INTENT_VERIFIER_PROMPT` is
logically identical to `prompts/p4-minimal.txt` (trailing newline
canonicalized to LF so the identity guard is portable across CRLF/LF
checkouts; content preserved).

## Open alternatives

1. Live validation against real M365 threads (cache hit/miss, no throttle
   interaction).
2. ~~Default-on flip after live validation~~ — **done** (ticket 02:
   default-on with `M365_INTENT_VERIFIER=0` opt-out).
3. Latency engineering (caching, pipelining, a faster verifier) — the
   remaining architectural constraint is latency, not safety.