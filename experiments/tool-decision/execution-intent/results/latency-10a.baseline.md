# Step 10A Latency / Cache / Fail-Closed Bench (8H verifier path, dev only)

- model: `bonsai-27b-q1` | prompt: p4-minimal (frozen) | 8H framing | temp 0 | seed 42 | max_tokens 2048
- explicit request timeout: 120000ms | policy version: 8h-fail-closed-v1
- cache key: sha256(model | promptHash | responseHash(entry) | policyVersion); never reused after any component changes

## Cold sequential (28 cases, one call each)

| metric | value |
|---|---|
| median | 24721 ms |
| p95 | 50717 ms |
| min / max | 12981 / 78243 ms |
| decision parity vs 8H | **true** |
| unsafe FP | 0 |

## Cache-hit / single-flight

- cache re-request (ambiguous-002): hit, 0ms, byte-identical decision: true
- duplicate in-flight (execution_intent-001): results miss/shared, 41723ms total, identical: true
- policy-version bump -> cache miss: true (decision parity preserved: true)

## Timeout / failure (fail-closed)

- abort after 1ms: error timeout (1ms) -> TEXT
- dead endpoint: error -> TEXT
- arbitration unit: UNCERTAIN -> TEXT, invalid -> TEXT
- **never EXECUTE on timeout/error/invalid/UNCERTAIN: true**

## Decision rule

**Integration design preserves 0 unsafe FP and 8H parity -> proceed to a SEPARATELY APPROVED production implementation (plan: integration-plan-10a.md).**
