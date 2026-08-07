# Architecture Roadmap

## Phase 1: Analyze — Done
We analyzed `handler.ts`. We found responsibilities to extract. We made extraction principles.

## Phase 2: Extract Responsibilities — Done (2026-08-07)

**Extractions completed (10 modules from handler.ts):**
1. Context Compiler — message formatting (`context-compiler.ts`)
2. Usage Builder — usage/telemetry formatting (`usage-builder.ts`)
3. Response Helpers — response construction (`response-helpers.ts`)
4. Local Response Helpers — local response handling (`local-response-helpers.ts`)
5. SessionPool — session lifecycle (`session-pool.ts`)
6. Output Ceiling — output length check (`output-ceiling.ts`)
7. Force Prompts — forced-retry prompts (`force-prompts.ts`)
8. Image Renderer — image rendering (`image-renderer.ts`)
9. Tool Path — tool-call parsing, recovery, safety, reply handling, one-call-per-turn (`tool-path.ts`)
10. Response Renderer — JSON + early-flushed SSE rendering (`response-renderer.ts`)

**Extraction phase is CLOSED.** The remaining handler is cohesive orchestration
(request setup, message compilation, the buffered retry loop, response rendering).
Do not resume extraction unless a future concrete requirement exposes a new
boundary. Mutable counts and status live in `NEXT.md`, not here.

## Phase 3: Characterization — Done (2026-08-07)
- `tool-path.ts`: normal path + recovery loop characterized (17 direct tests).
- `response-renderer.ts`: JSON + SSE contracts characterized (14 direct tests).
- `context-compiler.ts`: characterized (3 tests).
- Baseline: 205 pass / 3 live-gated skipped; proxy-lib TypeScript clean.
- Mutable test counts live in `NEXT.md`.

## Phase 4: Baseline + First Local-Model Experiment Design — In Progress
- One source of truth: `NEXT.md`.
- Offline tool-decision corpus: `experiments/tool-decision/`.
- Measure deterministic coverage of the corpus before involving any model.
- Test local models only on the narrow `ambiguous` category, offline, with
  "uncertain" as a valid answer. No runtime local reasoner until the corpus
  data justifies it.
