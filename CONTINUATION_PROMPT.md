# Continuation Prompt

Current project state and next actions live in **`NEXT.md`** — read that file first.

## Current State (as of 2026-08-13 simplify-tool-path)

- `simplify-tool-path` branch (commit `71bc21a`): `produceToolPath()` reduced to a
  pure translator; deleted the in-turn recovery loop + 8H intent verifier +
  client attestation gate + confab/hallucination retry + read-only fallback +
  fail-closed 502. `intent-verifier.ts` / `attestation.ts` / `force-prompts.ts`
  preserved as research artifacts (no runtime callers).
- Tool-path test suite: 23 tests (11 translation + 12 contract); response-renderer
  17 tests; context-compiler 3 tests.
- Baseline: 341 tests pass / 3 skipped; proxy-lib TypeScript clean.
- Handler extraction remains CLOSED (cohesive orchestration).
- See `NEXT.md` for live status and `.scratch/simplify-tool-path/` for the
  pivot spec + tickets.

## Working Rules

- Preserve existing behavior; earn every abstraction; extract from existing code.
- Prefer deterministic software; characterize before changing.
- Mutable status belongs in `NEXT.md`, not architecture docs.
