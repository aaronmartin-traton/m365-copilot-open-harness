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

### No Further Extractions
- Architect verdict (2026-08-07): handler.ts is cohesive orchestration at 342 lines.
- Remaining blocks (request setup ~40 lines, message compilation ~30 lines, runBuffered ~155 lines) are too small or too core to extract.
- runBuffered stays by design: the retry loop IS the orchestration.

### Test Coverage
- Add unit tests for `tool-path.ts` (feed scripted buffered turns, assert parse/retry/fallback/doc-guard/reply/one-call-per-turn outcomes). Highest-value gap.
- Add unit tests for `response-renderer.ts` (feed a fake produce(), assert chunk sequence for JSON/SSE/error/tools paths).
- Only `context-compiler.test.ts` covers an extracted module directly.

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
