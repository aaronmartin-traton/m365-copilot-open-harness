# NEXT.md — M365 Copilot Proxy

> Snapshot as of 2026-08-08.

## Session handoff

The execution-intent experiment loop ran Steps 4A–10A to a clean stopping
point (all pushed to `origin/main`). The approved safety policy is the **8H
fail-closed design** (verifier-authority: only Bonsai may authorize EXECUTE).
The 9H positive-evidence override was rejected (leaves `execution_intent-010`
unresolved by design).

**2026-08-09 updates (PC `main` in sync with `lan/main`; GitHub `origin`
untouched):**

- **Held-out evaluation completed and integrated** (ticket 03): merged
  production arbitration, n=32, 0 unsafe FP, selAcc 0.969, exeRec 0.938,
  txtRec 1.0, cov/stbl 1.0, med 24.7 s / p95 35.9 s. Evidence + results
  (`results/heldout-8h.{json,md}`) merged at `lan/main` `1a5175e`. Tickets
  01–04 of `execution-intent-verifier` all resolved; queue complete.
- **User directives (loop paused)**: M365 reauth available (keep request
  volume low); prune M365 conversations created by this autonomous run
  (evidence first; pre-existing untouched); OneDrive/grounding work
  (H8.11/H8.12) deferred until proxy proven; two read-only turns AUTHORIZED
  (usage-endpoint-hunt v2, admin-portal dig — zero chat threads).
- **Laptop implementer channel CHANGED**: herdr pane `w8:p4` no longer hosts
  the omp agent — its stale TUI was killed (PID 1152) during LiteLLM
  recovery and relaunch attempts failed on mangled pane input. The local machine
  implementer session file
  (`~/.omp/agent/sessions/--K--Projects-m365-copilot-proxy--/2026-08-09T05-43-25-942Z_*.jsonl`)
  is intact and resumable. A fresh empty pane `w8:p5` was split for a
  relaunch; its spawned omp exited and the pane is a clean shell. Restore
  the implementer via `herdr agent start <name> --kind omp --pane w8:p5`
  after re-selecting the model (localmodel lane now = PC free-pool
  `127.0.0.1:8788`, key env `FREE_POOL_API_KEY`; fresh omp processes only —
  stale processes fail `No API key found`).
- **Prune + read-only runs NOT yet executed** (local machine implementer was down):
  the authorized conversation prune, usage-endpoint-hunt v2, and admin-portal
  dig remain pending — see `.autonomous/DEFERRED.md` for the exact plans and
  `.autonomous/PROGRESS.md` / `REPORT.md` for the audit trail (all three
  gitignored by design).

- **Verifier default-on shipped**: `verifierEnabled()` = enabled
  unless `M365_INTENT_VERIFIER=0`; explicit `=0` wins over all overrides.
  Ticket `execution-intent-verifier/02-default-on` resolved.
- **Live validation resolved** (ticket 01, local machine commits): corrected cache
  semantics — cache key `sha256(model|promptHash|responseHash|policyVersion)`,
  byte-identical response text required, process-lifetime LRU (cap 1000);
  recovery EXECUTE (`cmd /c echo …`) proven end-to-end.
- **Held-out evaluator shipped**: 0 unsafe FP,
  selAcc 0.969, exeRec 0.938, txtRec 1.0, cov 1.0, stbl 1.0, 15/16 pairs,
  med 24.7s / p95 35.9s. Ticket 03 ready-for-agent.
- **Latency dispositioned** (ticket 04): candidates 2/3/4 rejected offline
  (input-timing impossible / frozen-policy / hardware+M365-gated); candidate 1
  (KV-reuse) measured-and-rejected on local machine. Resolved: no offline latency win.
- **EOL portability fixed**: `INTENT_VERIFIER_PROMPT` canonical
  LF; drift test normalizes both sides; LF/CRLF regression test.
- **8 ticket preflights delivered to local machine implementer (read-only), all
  DEFERRED pending execution authorization** — see `Where the loop stands` +
  `Preflight backlog` below. No M365/edit/fetch/push by locally architect.

## Preflight backlog (2026-08-08, all local machine-validated, DEFERRED)

| Ticket | Status | Key findings |
|---|---|---|
| `capability-expansion/01-code-interpreter` | approved-with-notes | H8.1 already shipped (agent-less `cwc_*` set); H8.2 delta = agent `gptCapabilities.codeInterpreter:true` + instructions-marker bump (name-hash gotcha) |
| `capability-expansion/04-model-selection` | validated | H8.6 shipped; H8.7 rides per-request `clientOverrides.capabilities` (not createBot); H8.8 = `oneTurn` `extraAllowed` (zero delta) |
| `capability-expansion/05-grounding-multimodal` | validated | 4 levers; H8.10 upload flow already built in `images.ts`; H8.11/H8.12 need a real tenant file |
| `m365-live-probes/01-disengaged-calibration` | validated | DEA caveat: `dea_violation` flat ~1e-8, absent at threshold → rung-index threshold, not a dial |
| `m365-live-probes/02-tool-compliance-repeat` | validated | core-direct = verifier-bypass (raw model compliance); needs order-rotation wrapper; repeat 2 (20 threads) fits |
| `m365-live-probes/03-usage-endpoint-hunt-v2` | validated | v2 = v1 + browser headers + in-script redaction (v1 writes raw 800-char bodies); 0 M365 threads |
| `m365-live-probes/04-inputmethod-experiment` | validated | needs `oneTurn` inputMethod/experienceType param delta; 3×2 core matrix, 12 threads |
| `m365-live-probes/05-tone-comparison` | validated | harness hardcodes tone (`:151`) → needs `--model` argv; agent vs agent-less path split; DeepLeo confounder |
| `m365-live-probes/06-transfer-token-probe` | validated | token constructible (`base64 FullConversation`); `oneTurn` closed → extraParams/extraMessageFields delta; token_sha256-only redaction |
| `m365-live-probes/07-admin-portal-dig` | validated | admin access likely DENIED (token `roles: []`); `loadSecrets` TOTP path is dead (0 hits src+dist); persistent browser profile is the live auth |
| `m365-live-probes/08-run-green-probes` | validated | 4-probe session ~13–14 threads; redaction needed in `token-candidates.json` + `raw-frames.ndjson` (not sent.json); tool-compliance deferred per ticket 02 |

**Laptop-implementer channel**: herdr pane `w8:p4` (omp collab session,
cwd `/path/to/m365-copilot-proxy`, HEAD = PC `main`); prompt via
`herdr agent prompt w8:p4` (returns `agent_prompt_stalled` on idle panes —
delivery still succeeds; poll with `herdr agent read w8:p4`).
**2026-08-09: STALE — pane w8:p4 is now a bare shell; see the channel
CHANGED note above for the resumable session file and relaunch recipe.**

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
- **10A verifier is now IMPLEMENTED and DEFAULT-ON.** `packages/proxy-lib/src/
  intent-verifier.ts` gates tool execution on the local verifier's EXECUTE
  unless `M365_INTENT_VERIFIER=0` (explicit opt-out wins over all overrides).

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

The queued work now lives as tickets in `.scratch/` (see
`docs/agents/issue-tracker.md` for the format). The `execution-intent-verifier`
feature tracks the 8H production path:

- `.scratch/execution-intent-verifier/issues/01-live-validation.md` —
  **RESOLVED** (2026-08-08, local machine evidence merged): corrected cache
  semantics + recovery EXECUTE proven.
- `.scratch/execution-intent-verifier/issues/02-default-on.md` —
  **RESOLVED**: default now ON (`verifierEnabled()` unless
  `M365_INTENT_VERIFIER=0`).
- `.scratch/execution-intent-verifier/issues/03-held-out-eval.md` —
  **ready-for-agent**: evaluator + evidence merged (0 unsafe FP, selAcc
  0.969); acceptance open for the hypotheses.md log line.
- `.scratch/execution-intent-verifier/issues/04-latency-engineering.md` —
  **RESOLVED**: no offline latency win (candidates 2/3/4 dispositioned,
  KV-reuse measured-and-rejected).

Live probe backlog: `.scratch/m365-live-probes/` and capability probes:
`.scratch/capability-expansion/` (all need a rested M365 on the local machine).

**2026-08-09 research landed** — local models on 8 GB Blackwell:
`docs/research/2026-08-09-local-models-8gb-blackwell.md` (STE, adversarially
reviewed: `docs/research/notes/judge-review.md`; six lane notes under
`docs/research/notes/`). Architecture verdict: keep; local models fit only at
the verifier endpoint and a degraded-mode fallback route. New queues (all
zero-M365 unless noted):

- `.scratch/verifier-latency-bakeoff/` — 4 tickets (logprob-scorer probe →
  template-kwargs contract → dev screen + freeze → single held-out gate).
  Supersedes the latency angle of `execution-intent-verifier/04` with
  candidates that ticket never covered (direct-answer models, thinking-off).
- `.scratch/fallback-lane-telemetry/` — 1 ticket, passive throttle telemetry
  (zero extra M365 traffic); decision gate for the fallback-lane option.
- `.scratch/m365-live-probes/issues/09-custom-instructions-probe.md` —
  ready-for-human; STANDBY until the user's local machine reconnect + multi-omp
  session is up, then needs explicit execution authorization.

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
