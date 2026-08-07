# Continuation Prompt

Current project state and next actions live in **`NEXT.md`** — read that file first.

## Current State (as of 2026-08-07 night)

- Characterization phase complete: tool-path.ts (17 tests), response-renderer.ts (14 tests), context-compiler.ts (3 tests).
- Baseline: 205 tests pass / 3 live-gated skipped; proxy-lib TypeScript clean.
- Handler extraction is CLOSED (cohesive orchestration at 342 lines).
- Next phase: local tactical reasoner investigation via an offline tool-decision corpus (`experiments/tool-decision/`). No LM Studio, no runtime local model yet.

## Working Rules

- Preserve existing behavior; earn every abstraction; extract from existing code.
- Prefer deterministic software; characterize before changing.
- Mutable status belongs in `NEXT.md`, not architecture docs.
