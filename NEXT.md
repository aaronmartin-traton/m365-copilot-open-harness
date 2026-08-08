# NEXT.md — M365 Copilot Proxy

> Snapshot as of 2026-08-07.

## Session handoff

The execution-intent experiment loop ran Steps 4A–10A to a clean stopping
point (all pushed to `origin/main`). The approved safety policy is the **8H
fail-closed design** (verifier-authority: only Bonsai may authorize EXECUTE).
The 9H positive-evidence override was rejected (leaves `execution_intent-010`
unresolved by design). No held-out inference has been authorized.

## Findings to preserve

- Deterministic-only execution-intent handling: 13 unsafe execution false
  positives.
- Bonsai-only C0/P4 (5E): 0 unsafe FPs, 0.857 selective accuracy, 100%
  coverage/stability, ~27 s median verifier latency.
- 8H fail-closed: 0 unsafe FPs, 0.893 selective accuracy, 100%
  coverage/stability, ~24.7 s median; all 13 deterministic unsafe cases
  corrected by the verifier.
- 9H +positive-evidence override: 0 unsafe FPs, 0.964 selective accuracy
  (overrides recovered -018/-019), rejected because `execution_intent-010`
  ("you can run this if…") is deliberately excluded from frozen positive
  evidence.
- 10A latency readiness (8H verifier path, dev only): cold median 24.6 s /
  p95 42.1 s / min 12.8 s / max 78.0 s; cache-hit 0 ms byte-identical;
  single-flight dedup verified; fail-closed verified for timeout/error/
  invalid/UNCERTAIN (never EXECUTE). Decision rule: **proceed to a separately
  approved production implementation** (integration plan committed:
  `experiments/tool-decision/execution-intent/integration-plan-10a.md`).
- **The remaining architectural constraint is latency, not safety.** The
  verifier is too slow for an unqualified request-path gate without caching,
  pipelining, bounded concurrency, or a faster verifier approach.

## Where the loop stands

- Steps 4A (split freeze), 4B (prompt calibration), 4C (corpus-gate trip),
  4D (context ablation), 5E (capacity control), 5F (confidence probe),
  7H (hybrid, rejected), 8H (fail-closed, APPROVED baseline), 9H (override,
  rejected), 10A (latency readiness) — all committed, verified, pushed.
- Approved policy artifact: `experiments/tool-decision/execution-intent/
  fail-closed-policy-8h.json` + `run-fail-closed-8h.mjs`.
- Frozen contract + semantics: `execution-intent/README.md` (covered =
  EXECUTE|TEXT; UNCERTAIN abstention; INVALID separate).
- heldout.json (32 cases, 16 near-pairs) remains model-unseen; validator
  enforces the split.

## Next actions (need a decision — user or architect)

1. **Production integration of the 8H verifier** — separately approved
   (per 10A decision rule). Plan exists (`integration-plan-10a.md`);
   implementation is a real production change (proxy wiring, caching,
   single-flight, timeout, observability) and MUST be scoped as its own
   reviewed step. Latency engineering vs non-LLM verifier is the open
   alternative.
2. **Held-out evaluation** — remains unauthorized. Only after the
   architecture/verifier question settles.
3. **Architect channel**: ChatGPT architect hit rate limits and was parked;
   Command Code (herdr pane `w12:pE`, gpt-5.6-luna, session
   0c9d16a0-8cf4-4162-8784-3d54a5563e78) served as architect for the 5E–10A
   stretch. Consultation briefs: `.commandcode/architect-consult-00{1..5}.md`
   (gitignored). Consult-005 ends with the 10A production-integration
   directive.

## Verification & running (standing constraints)

- Verification = `bun run test:unit` (build + vitest — NOT plain `bun test`;
  bun's runner lacks vi.mock/resetModules) + `tsc --noEmit -p
  packages/proxy-lib/tsconfig.json` + `bun
  experiments/tool-decision/execution-intent/validate-split.mjs`. Baseline:
  205 pass / 3 live-gated skip.
- Secret guard: `scripts/secret-scan.mjs` + pre-push hook (install:
  `bun scripts/install-hooks.mjs`) at both egress points; GitHub Actions
  scan on top. Repo is PUBLIC.
- Live M365 verification: not performed (backend unavailable); harness
  exists on the local machine (herdr pane) for when it is.

## Operational footguns (learned 2026-08-07)

- **LM Studio silently serves the currently-loaded model for unknown model
  ids** → wrong-model data, no error. Identity-guard the echoed `model`
  field (bench-local.mjs does).
- **Small GGUFs reason by default** under LM Studio chat templates
  (qwen3.5-4b, lfm2.5-2.6b, qwythos-9b) despite "non-thinking default"
  claims → 8-token contract starves them; `reasoning_content` separated
  since v0.3.9; budget ≥2048 tokens.
- **llama.cpp on the local machine (b10321, CUDA 13.3, sm_120)**: Bonsai 27B 1-bit
  (`bonsai-27b-q1`, Q1_0) runs at ~24–27 s/call median, ~5 GiB, ngl 99,
  ctx 8192. logprobs available (`top_logprobs:8`).
- **Corpus cases carry NO user/request text** (4C gate) — the planner-output
  fixtures were built without conversation turns. Any user-turn-based
  condition needs a separate corpus-building project.
- Research notes: `/path/to/local-models/RESEARCH-2026-08-07-small-models-8gb-blackwell.md`
  + `RESEARCH-2026-08-07-nanbeige-minicpm-candidates.md` (copies in
  `/path/to/the remote/shared\`).

## Repository state

Use `git status -sb`, `git branch -vv`, and `git worktree list` as the
source of truth for current branch, push, and worktree state. This handoff
intentionally does not record volatile commit or worktree identifiers.
