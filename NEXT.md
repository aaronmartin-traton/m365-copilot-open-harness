# NEXT.md - M365 Copilot Proxy

## Current State (2026-08-07)

**Repository:** https://github.com/asmartin-ai/m365-copilot-proxy

**Branch:** main (tracks `origin/main` on GitHub)
**Status:** Clean working directory
**Remote:** GitHub `origin`; the stale internal GitLab remote was removed 2026-08-07.

## Completed Work

### Extractions from handler.ts (10 total)
1. Context Compiler → `context-compiler.ts`
2. Usage Builder → `usage-builder.ts`
3. Response Helpers → `response-helpers.ts`
4. Local Response Helpers → `local-response-helpers.ts`
5. SessionPool → `session-pool.ts`
6. Output Ceiling → `output-ceiling.ts`
7. Force Prompts → `force-prompts.ts`
8. Image Renderer → `image-renderer.ts`
9. Tool Path → `tool-path.ts` (produce() tool branch: parse, confab retry, read-only fallback, prose-document guard, reply handling, one-call-per-turn)
10. Response Renderer → `response-renderer.ts` (JSON + early-flushed SSE stream, `Produced` type)

**Handler.ts reduced:** ~1065 → 342 lines (723+ lines extracted)

### Baseline Repair
The committed baseline did not typecheck (missing `log`/`ChatBody` declarations in handler.ts, corrupted re-exports in index.ts/responses.ts/pruning.ts/tests, broken `minutes` in session-pool.ts, missing `types: ["node"]`). All repaired; `tsc --noEmit` clean across proxy-lib. Committed as the first session commit on 2026-08-07.

### Environment Repair
- `node_modules` was corrupted (bun store not hoisted). Fixed with `bun install --linker=hoisted --force --ignore-scripts`.
- The `prepare` script (`nitro prepare`) in `packages/proxy` fails during `bun install` when its deps are missing — use `--ignore-scripts` for installs, then run `nitro prepare` manually if needed.

### Architect-Guided Loop (2026-08-07)
Tencent Hy3 (OrcaRouter) ran as read-only systems engineer in a herdr pane (`hy3arch`, pane `w12:p2`), giving verdicts on each extraction:
- Iteration 1: SKIP runBuffered extraction (core orchestration, bloated interface)
- Iteration 2: EXTRACT tool-path (done, 538→423)
- Iteration 3: EXTRACT combined JSON+SSE renderer (done, 423→342)
- Iteration 4: implemented + verified (174 tests pass)
- Iteration 5: STOP — handler.ts declared cohesive at 342 lines

## Next Actions

### Characterization Phase Complete (2026-08-07)
- `tool-path.ts`: 17 characterization tests — normal path (7) + recovery loop (10: confabulation, hallucinated completion, remote artifact, precedence, fail-closed 502s). See `tool-path.test.ts`.
- `response-renderer.ts`: 14 characterization tests — non-stream JSON (3) + streaming SSE (10) + fully-buffered finalization (1). See `response-renderer.test.ts`.
- `context-compiler.ts`: 3 characterization tests (pre-existing).
- **Current baseline: 205 pass / 3 live-gated skipped. proxy-lib TypeScript clean.**
- No live M365 verification for these slices (not performed — M365 backend unavailable 2026-08-07 night).

### Extraction Phase Closed
- Architect verdict (2026-08-07): handler.ts is cohesive orchestration at 342 lines. No further extractions unless a future concrete requirement exposes a new boundary.
- Remaining blocks (request setup ~40 lines, message compilation ~30 lines, runBuffered ~155 lines) are too small or too core to extract.
- runBuffered stays by design: the retry loop IS the orchestration.

### Next Phase: Local Tactical Reasoner Investigation
- Do NOT integrate LM Studio yet, and do not introduce a local reasoner at runtime.
- Create the offline decision corpus: `experiments/tool-decision/README.md` + `cases.jsonl` (schema + taxonomy + seeded cases derived from the characterized behaviors).
- Measure deterministic coverage of the corpus through today's tool-path logic BEFORE involving any model.
- Only after the corpus exists and is reviewed: test LFM/Bonsai offline on the narrow `ambiguous` category only, with "uncertain" as a valid answer.
- Deliver the corpus design for architectural review before any model integration.

### Step 3: Deterministic Coverage Measured (2026-08-07)
- Offline harness `experiments/tool-decision/run.mjs` ran all corpus cases through production `produceToolPath()` (no network/M365/LM). Full per-case data: `experiments/tool-decision/results.json`.
- **Classification coverage (table A): 26/26** on the deterministic classes — detection identifies every input category.
- **Disposition: the "ambiguous-only" hypothesis is retired.** The 7 original ambiguous cases were reclassified by `decision_owner` (deterministic_recovery / local_reasoner / tool_executor / policy / validation / scheduling / output_policy). Only ambiguous-002 + mixed-002 remained local-model candidates → the `execution_intent` class.
- **execution_intent corpus expanded to 28 cases** (10 adversarial categories: README snippets, explicit runs, explanatory code, "run this", "you can run this", install instructions, destructive warnings, log/doc quotes, action preambles, post-fence prose).
- **execution_intent measurement: 15/28 deterministic pass.** The 13 failures are all text-shaped cases (quotes, docs, warnings, advice) whose fences get executed as shell — including the two destructive-command warnings. Deterministic code cannot distinguish "show this command" from "run this command". This is the measured gap the local reasoner would fill.
- Corpus stands at 52 cases; next: offline LFM/Bonsai evaluation on execution_intent only, "uncertain" allowed.

### Step 4: Execution-Intent Benchmark Run (2026-08-07)
- `experiments/tool-decision/bench.mjs` ran the 28 execution_intent cases (3 passes each, temperature 0, exact architect prompt, planner output only) on three free-pool lanes: north-mini-code (small), gemma-4-26b (local ref), laguna (strong control).
- **Every model: 0 unsafe execution false positives** vs 13 for the deterministic path — the safety-critical gap is closed by any model.
- **Selective accuracy 0.68–0.75 — the ≥95% bar is NOT met** (even the strong control: 0.75), so per the architect's sanity check the corpus/prompt is underspecified. All models are TEXT-biased (execute recall 0.25–0.42) — the prompt's conservative rules over-correct against direct imperatives.
- Verdict: benchmark machinery works; directional safety win; needs prompt calibration + held-out near-pairs before model shopping. Full data: experiments/tool-decision/bench-results.json.

### Step 4b: Local LM Studio run (2026-08-07) — the architect's candidate fails, 9B local wins
- User clarified LM Studio was for testing LFM/Bonsai-class models locally (not Mimo/M3). Installed qwen3.5-4b + LFM2.5-2.6B Q4_K_M via `lms get`, wrote `bench-local.mjs` (same contract, 127.0.0.1:1234, temp 0, seed 42).
- **LFM2.5-2.6B (architect's pick): 2 stable unsafe execution FPs + 2 `<tool_call>` emissions instead of tokens — DISQUALIFIED on evidence.** raw 0.357 < deterministic 0.536.
- **qwythos-9b (Qwen3.5-9B FT, already local): 0 unsafe FP / 0 invalid / sel-acc 0.808 / raw 0.75 / stability 1.0 — beats the pool's laguna control, free, no network.** The tactical local reasoner works without new hardware or API keys.
- qwen3.5-4b: safe but overcautious (exe recall 0.167) + 2 budget-starvation invalids (9K reasoning chars).
- All three GGUFs reason by default in LM Studio → 8-token contract starves them; harness must read `reasoning_content` and budget ≥2048, or use thinking-disabled quants.
- Found + guarded an LM Studio footgun: unknown model ids silently serve the currently-loaded model.
- Committed with bench-local.mjs + bench-local-results.json + README 4b section.

### Push
- Session commits pushed to `origin/main` during wrapup (2026-08-07). Push-status is derivable from `git status -sb`; do not re-record here.

## Warnings / Caveats
- None

## Session Notes
- User ran cleanup commands manually (rm -rf CopilotAgent_Architecture_Docs)
- Destructive command policy blocked automated cleanup
- Used `ask` tool to get permission for destructive operations
- Architect session: herdr pane `w12:p2` (hy3arch, Tencent Hy3 · OrcaRouter, read-only charter)
- Autonomous run kickoff (2026-08-07): ChatGPT (phone chat) is the architect; loop = ask architect → read via ADB → implement (command-code pane `w12:p3`, laguna-s-2.1) → review → push → repeat. Next actions: characterization tests for tool-path.ts + response-renderer.ts.
