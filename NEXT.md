# NEXT.md — M365 Copilot Proxy
> Snapshot as of 2026-08-14. The latest dated session entry below supersedes
> earlier carry-over plans where they conflict.

**Start a new session here:** read
`docs/agents/working-methodology.md` (startup sequence + operating rules +
current mission), then `docs/agents/session-workflow.md` (operating manual),
then `CONTEXT.md` (vocabulary).

## 2026-08-11 session carry-over (live M365 investigation)

Big finding: **custom-instructions is a proven, no-approval, durable injection
channel** — saved instructions apply to raw agent-less WS turns by default (the
`add_custom_instructions` flag is NOT required). Write via the CDP
Settings→Personalization textarea using the **native value-setter +
input/change events** (React); `tab.fill('')` or synthetic `new Event('input')`
alone leave Save disabled (silent no-op — first A1 save and clear both failed
this way). See `docs/research/2026-08-11-m365-injection-ideation.md` (the
ADHD+GLM cross-check) and `docs/agents/m365-ui-investigation.md` (runbook).

- **User wants a possible Copilot plan upgrade** — the durable-memory slot
  (injection idea 2) is license-gated on Basic; if the plan is upgraded to one
  with Copilot Memory authoring enabled, re-test H8.14 (mailbox write → recall)
  — the memory channel could become viable.
- **Injection ladder (ticket 02, ready-for-agent):** primary channel is now
  textarea custom-instructions (proven). Memory-plugin + Graph/Mail channels
  dropped (dead on Basic). Build the `set_custom_instruction` helper + the
  `system_fingerprint: steered/unsteered` contract.
- **Agent/App store** has more to explore (parked): "Create agent" self-service
  surface + per-app Add/Install gates live in detail views, not the browse
  view. Next session can resume at the store tab.
- Browser processes all ended cleanly (m365-cdp exit-13 was the browser-close +
  `await new Promise(()=>{})` unsettled-await script bug — benign; CDP 9222
  DOWN now). Note: `_profile-cdp.mjs`'s hold-promise should handle context-close
  for a clean exit next time.

## 2026-08-11 — history scrub (PII audit + rewrite)

PII audit found personal identifiers and machine topology in the working
tree and in git history (corporate email in commit metadata + docs, machine
usernames, LAN IPs/paths, a session ID). Fixed in two passes:

- **Tree scrub:** 20 edits across 10 files (docs + scratch tickets) —
  genericized emails, usernames, machine paths, the LAN remote URL, and
  internal IPs. Committed.
- **History rewrite:** two `git-filter-repo` passes (mailmap for the
  corporate-email identity + replace-text for content strings). All 11
  target strings verified at 0 hits across all refs. Identities now: the
  upstream author (public upstream) + the GitHub no-reply address only.
- **Published:** `origin/main` + `origin/feat/fenced-shell-routing`
  force-pushed. GitHub may still serve pre-rewrite SHAs by direct URL until
  GC (accepted — let GitHub GC purge them).

**Carry-over:**

- Backup of the full pre-rewrite history:
  `../m365-copilot-proxy-pre-rewrite.bundle` (relative to the repo).
- Rewrite rules kept for re-runs: `.git/filter-mailmap`,
  `.git/filter-replace.txt`.
- **the remote + clones are still pre-rewrite.** Reconcile next session
  (local machine: fetch origin, rebase local work, re-scrub local doc copies; do
  NOT merge stale LAN branches into GitHub-bound work).
- The rewrite changed every fork-internal commit SHA. SHA references in the
  evidence docs (hypotheses.md, overnight-log.md, .scratch tickets, research
  digest) now point at pre-rewrite commits — reconcile opportunistically.
- Keep docs PII-free going forward: no machine usernames, corporate emails,
  internal IPs, or personal session IDs in committed prose.

## Next session plan

1. ~~**Auth into M365 on this PC**~~ DONE 2026-08-10 — interactive login
   completed (playwright path; run under `node` on this PC, see
   `docs/agents/m365-auth-workflow.md` → *PC environment notes*);
   `msal-cache.json` present.
2. ~~**Verify auth**~~ DONE — `M365_DEBUG=1 bun scripts/proxy-verify.mjs
   --agent --multiturn` passed end to end (real tool loop; 8H verifier on
   LM Studio with `M365_INTENT_VERIFIER_MODEL=bonsai-27b`).
3. **Live tests** — attestation-gate end-to-end smoke (register →
   AUTHORIZED → tool result accepted) incl. the proof-header re-verification
   the local machine smoke predates — STILL PENDING, local machine task.
4. ~~**Implementation**~~ DONE — ponytail item 6 (CdpClient → playwright)
   landed; review-triage items 1–2 fixed; tickets closed.

## PC environment facts (2026-08-10)

- Browser-driving bins (login) run under **`node`**; playwright's connection
  layer (pipe + connectOverCDP) times out under Bun 1.3.14 on this box.
  The proxy itself runs under Bun.
- LM Studio serves the frozen 8H verifier: `bonsai-27b` loaded; proxy runs
  need `M365_INTENT_VERIFIER_MODEL=bonsai-27b` (LM Studio echoes the loaded
  id, so the default `bonsai-27b-q1` trips the identity guard).
- Nested `@m365-copilot/*/dist` copies deleted 2026-08-11 (stale copies had
  shadowed the workspace links). Resolution now goes through the root
  workspace symlinks (`node_modules/@m365-copilot/*` → `packages/*`); no
  refresh step after `bun run build`.
- Unit-test evidence pollution the egress checkd to
  `~/.config/opencode-m365/the egress check-2026-08-10/`.
- **Bun 1.3.14 lacks `console.createTask`** (Node has it). Nitro's internal
  `callHook(...).catch(...)` callers then return `undefined` for zero or
  sync hooks, crashing the process on ANY request error. Fixed in
  `packages/proxy/plugins/error-hook.ts` (async no-op hooks). Do not remove
  the async keywords — a sync no-op re-introduces the crash under Bun.
- Detached `(cmd … &)` subshells kill `bun` on Windows instantly (empty
  log, exit 7). Use the bash tool's background mode or run foreground.
- `taskkill //PID` fails in git-bash on this box; use
  `powershell -Command "Stop-Process -Id <pid> -Force"`.
- The harness policy denies force-push through the bash tool
  (`tools.approval.bash`); a human must run `git push --force-with-lease`
  or lift the policy. Normal pushes are unaffected.

**STE status:** All operational docs pass under pragmatic STE (2026-08-09).
The scientific notebooks (`docs/hypotheses.md`, `docs/experiments.md`,
`docs/overnight-log.md`) and the `.scratch/*` tickets and specs keep their
evidence verbatim. They are out of scope for this pass. The
writing-for-agents levers apply to AGENTS.md (2026-08-10).
`docs/agents/working-methodology.md` is locally implementer startup playbook.

## Current baseline

- The **8H fail-closed verifier** remains the approved production baseline.
  Only an `EXECUTE` verdict can authorize execution. The default is on unless
  `M365_INTENT_VERIFIER=0`.
- Safety is proven on the frozen held-out corpus. Latency remains the
  architectural constraint.
- **Client-attested execution** is the chosen low-latency direction. It is
  opt-in (`M365_CLIENT_ATTESTATION=1` + request headers). It never replaces
  the 8H baseline. See `.scratch/client-attested-execution/spec.md` and
  tickets `01-attestation-gate.md` / `02-reference-adapters.md`.
- Use `git status -sb`, `git branch -vv`, and `git worktree list` for all
  current checkout, branch, and push state. Do not rely on this snapshot for
  volatile Git facts.

## Verifier-latency bake-off

- Ticket 01 rejected the Bonsai-27B thinking-off logprob scorer. Its
  tokenizer-aware variants produced unsafe false positives.
- Ticket 02 added the `chat_template_kwargs` contract to the verifier request.
- Ticket 03 screened direct-answer candidates on DEV only and closed
  **rejected**. Five candidates produced an unsafe false positive on
  `ambiguous-002`. Ministral-3-3B avoided unsafe output but failed selective
  accuracy. The existing Qwen3.5-4B evidence also fails accuracy.
- No candidate was frozen. Ticket 04, the one-time held-out gate, is
  ineligible and MUST NOT run.
- Evidence: `experiments/tool-decision/execution-intent/results/03-dev-screen/`,
  `docs/hypotheses.md` §§18–24, and
  `.scratch/verifier-latency-bakeoff/issues/`.

## Client-attested execution (opt-in, in progress)

The chosen direction solves the latency problem. The trusted local harness
(pi / OMP / Codex) attests one exact command before the proxy can execute it.
This replaces a slower local model making the same decision. The 8H baseline
stays the default. This path is explicitly opt-in.

- **Gate**: `POST /v1/attestations` (loopback-only). Payload:
  `{client, tool, tool_call_id, command_sha256, ts, nonce}`. Signature header
  `X-M365-Attestation-Sig` = HMAC-SHA256 over the payload lines. Single use,
  60 s expiry, registry caps at 1000 entries with rolling prune of
  expired/terminal candidates.
- **Enablers**: `M365_CLIENT_ATTESTATION=1` + shared `M365_ATTESTATION_SECRET`.
  Request headers `X-M365-Execution-Gate: attestation-v1`,
  `X-M365-Attestation-Client: pi|omp|codex`, AND
  `X-M365-Attestation-Proof: HMAC(secret, "attestation-v1\n"+client)` hex
  (generate with `bun client-adapters/attestation-helper.mjs --proof <client>`).
  Without proof the gate headers are ignored and the request stays on the 8H
  path. Adapter helper additionally needs
  `M365_ATTESTATION_URL=http://127.0.0.1:<port>`.
- **Adapters**: `client-adapters/` — `pi-attestation-gate.ts`,
  `omp-attestation-gate.ts`, `codex-hooks.json` (PreToolUse approve|block),
  `attestation-helper.mjs` (+ `--proof` CLI).
- **Implementation state**: tickets 01 (gate) and 02 (adapters) resolved,
  unit-tested. Committed on `main` and merged to the local machine. Adversarial
  review 2026-08-09 found no blockers; fixed two SHOULD-FIXes:
  proof-of-secret required to strip 8H (bare headers no longer opt in), and
  tool results with never-emitted ids are denied 409 (fail closed; pool-emitted
  8H ids still pass). Two-pass validation so a 409 does not burn earlier
  candidates.
- **Documentation**: the full wire contract (payload, HMAC construction, state
  machine, failure modes, worked example) is in `docs/m365-copilot-api.md` §11
  *Client-attested execution (opt-in)*. Adapter setup lives in
  `client-adapters/README.md` (cross-referenced, not duplicated).
- **Next**: manual end-to-end smoke test of the attestation loop (register →
  AUTHORIZED → tool result accepted) through a real harness. The PC is
  auth-blocked (no `msal-cache.json`, no recorded login; the telemetry that
  looked like live traffic is unit-test pollution — traced 2026-08-10,
  see `docs/agents/m365-auth-workflow.md`). A human must complete the
  interactive login to unblock live steps on the local machine. The local machine live-smoke
  passed 2026-08-09 before the proof-header change — the proof header must
  be re-verified live when the local machine is next available.

## New surface — `/v1/images/generations` (2026-08-09)

- OpenAI-compatible image generation backed by M365's GraphicArt path.
  `handleImageGeneration` in proxy-lib + Nitro route.
- Schema: prompt (trimmed, required), n (1–4, >4 rejected), size
  (gpt-image-1 set incl `auto`), response_format url|b64_json.
- Sized through the pool scheduler (`newConversation: true` per image) so
  image requests cannot exhaust the M365 thread budget; 503+Retry-After when
  saturated.
- Error map: quota 429, capacity/content 400, no_image 400, abort 499,
  missing url/base64 500, other 502.
- Adversarial review findings fixed: dead client-abort wiring (ServerResponse
  `close` only; same fix applied to the chat route), silent n-cap → schema
  rejection, whitespace prompts trimmed.
- Test count 287 passed / 3 skipped (was 254 at session start).

## Next slice

1. Select a genuinely different latency direction. It MUST retain the frozen
   fail-closed contract and the DEV gate order: zero unsafe false positives,
   selective accuracy at least 0.95, then latency.
2. Do not retry rejected candidates on held-out. Screen any new candidate on
   the 28-case DEV corpus first. Freeze one survivor before the single
   32-case held-out run.
3. Review the broader local machine-preparation history on the LAN remote before
   merging it into locally branch or pushing it to GitHub. It includes work
   outside the bake-off evidence.
4. M365 live probes, including the custom-instructions probe, remain
   standby-only. They need explicit user authorization. Keep all M365 work
   sequential and thread-conserving.

## Laptop / pane recovery runbook (2026-08-09, collab relay outage)

The pane agents lost their collab link when the relay host died. Their
detached work (conversation pruner, `prune-results.json`) continued on the
local machine. When the panes reconnect:

1. Laptop (w8:p6): report pruner outcome — `prune-results.json` content,
   remaining session-store entries, port 1234 free, no stray chromium.
2. Laptop: **do NOT merge the stale LAN sync branches** — they carry
   pre-rewrite history (old PII strings). Their content (attestation gate +
   adapters, images route, proof-header security fix, telemetry fixes, STE
   docs, cramt digest, NEXT.md) is already in the rewritten `origin/main`.
   Instead: `git fetch origin`, rebase any local machine-local work onto
   `origin/main`, and re-scrub local machine working copies of the docs (the
   local machine's local files still contain the old machine paths/names). Preserve
   local machine-local edits (hypotheses.md, logprob ticket, lightweight spec,
   local machine AGENTS.md).
3. Laptop: re-verify attestation LIVE with the new proof header —
   `X-M365-Attestation-Proof` is now REQUIRED to opt into the gate. Positive
   (register → allow → result accepted) and negative (no proof → 8H stays on;
   fabricated id → 409) paths. Budget: 12 threads/hr cap, ≥3 min spacing,
   hard stop at first empty-503/at-limit.
4. PC (w8:p1): nothing pending — all work committed and pushed to the sync
   branch. STE pass done (cramt-derived docs excluded per user override).
5. GitHub `main` was force-pushed with rewritten history (2026-08-11 scrub —
   see the history-scrub section above). LAN refs are still pre-rewrite: do
   NOT merge them into GitHub-bound work until the local machine reconcile runs.
   Keep the secret scan + pre-push hook at every egress point.

## Standing verification and safety

- Preserve the frozen prompt, corpus, gold labels, policy, and split
  validator. Run `experiments/tool-decision/execution-intent/validate-split.mjs`
  before any new screen.
- Every local-model response MUST identity-guard the echoed model. Screen
  models one local server at a time. Keep GGUF weights and local hash manifests
  out of Git.
- Normal code verification: `bun run build`, `bun test`, and the applicable
  package typecheck. Live M365 verification uses quota and needs explicit
  approval.
- The repository is public. Run the secret scan and preserve the pre-push
  hook at each egress point.
 
## 2026-08-12 session wrap-up

Shipped on the local machine checkout:

- Steering injection ladder and honest-degrade fingerprint.
- Output-boundary attribution gate and drift guard.
- Nested distribution-shadow cleanup and dead-export removal.
- Resolved research-ticket status reconciliation.
- Persistent browser-profile migration for live probes; no plaintext
  password/MFA/TOTP automation remains in those scripts.
- Feature planning artifacts committed by feature.
- Verification: `bun run test:unit` passed 346 tests with 3 skipped.
- Authentication migration verification: all changed probe scripts passed
  `node --check`; silent login smoke passed with a cached token.

- Steering cleanup now exposes only the proven textarea channel. The former
  `custom-instr` fallback was removed because it never wrote its payload or
  passed it to the canary; old state files with that channel degrade to
  `unsteered`.

Laptop sanitized mirror:
- Fresh-history mirror remains private/local-only with no remote and no push.
- H8.1 code-interpreter live probe passed with the SHA-256 oracle.
- H8.2 declarative-agent probe remains unresolved because both Power Platform
  environment host candidates failed DNS resolution before the WebSocket turn.

Carry-over:

- The PC checkout is clean. Session work is on the LAN sync branch
  (`sync/session-2026-08-12`) for the local machine reconcile: fetch it, rebase
  local machine-local work, re-scrub local machine-local doc copies.
- Do not start more live M365 threads until the H8.2 DNS environment is
  resolvable. Keep live probes sequential and observe the thread cooldown.
- Attestation proof-header smoke: DONE on the local machine (see the addendum below).
  A local machine re-run is optional.

### 2026-08-12 addendum (late session, PC)

- **Attestation proof-header smoke: DONE on the local machine, ALL PASS.** See
  `.scratch/client-attested-execution/issues/01-attestation-gate.md` comments
  and `scripts/attestation-live-smoke.mjs`. The checks cover: allow, single-use
  replay deny, result accepted through a real M365 tool loop, fabricated id
  409, no-proof stays fail-closed on 8H. The local machine smoke is optional now.
- **Found + fixed a pre-existing crash: the proxy died on ANY request error
  under Bun** (a plain 404 killed the process). Nitro's internal
  `callHook(...).catch(...)` callers return `undefined` when zero hooks are
  registered. Under Bun even sync no-op hooks return `undefined` (no
  `console.createTask`), so the `.catch` threw inside the error path. The
  uncaughtException then exited the process. Fix:
  `packages/proxy/plugins/error-hook.ts` registers async no-op hooks for
  error/request/beforeResponse/afterResponse/close + an error logger.
  Verification: 404s return 404, `/health` and `/v1/models` return 200, the
  process survives repeated erroring requests. This is why live runs on the local machine
  had been flaky. The same fix applies to any Bun-hosted instance.
- Capture-path migration ticket reconciled: already shipped (persistent
  profile), status flipped to resolved with evidence.
- PC session work pushed to a sync branch on the the remote for the local machine
  reconcile. Secret scan clean at egress.

## 2026-08-14 session — simplify-tool-path merged

PR #1 merged the `simplify-tool-path` runtime pivot and Ticket #03
classification/doc-sync work into `main`.

- **Shipped:** `produceToolPath()` is a deterministic M365 text → OpenAI
  translator. In-turn confabulation/hallucination/remote-artifact retries,
  the local 8H intent-verifier gate, client-attestation gate, read-only
  fallback inference, semantic fail-closed 502, and orphaned
  `force-prompts.ts` are removed from the runtime path.
- **Preserved:** fenced tool parsing, prose-document protection, reply
  conversion, one-call-per-turn, and steering attribution.
- **Ticket #03:** 21 research tickets moved under
  `.scratch/research/issues/`; 9 pivot-conflicting tickets marked `wontfix`;
  7 product/protocol tickets remain in place.
- **Verification before merge:** `bun run build` green; `bun run test:unit`
  → 341 passed / 3 skipped; `tsc --noEmit -p packages/proxy-lib` clean.
- **Benchmark:** rerun clean on 2026-08-14 with Docker's Linux engine up.
  `scripts/bench/run.mjs --label simplify-tool-path --repeat 1` →
  **SOLVED 6/10 (60%)**, outcomes `SOLVED=6 GAVE_UP_PROSE=4`, avg
  tool-calls/task 1.4, **24 M365 messages, zero ERRORs**. Scorecard:
  `scripts/bench/out/simplify-tool-path-2026-08-14T04-19-13-654Z.json`.
  All 6 solves were real tool loops with objective verifier passes
  (fizzbuzz, fix-bug, find-needle, count-lines, ec-bugfix, ec-plain).
  The 4 failures are turn-1 canned refusals (`tools=0, msgs=1`) on the
  disengage-prone `edit-config`/`ec-*` family — the exact class the pivot
  deliberately unmasked by removing in-turn retries (§12.11 showed the old
  retry silently recovered these; the harness now owns retry policy).
  The earlier Docker-blocked run
  (`simplify-tool-path-2026-08-14T02-55-02-507Z.json`, `ERROR=10`,
  `M365 messages spent: 0`) stays on disk for audit but is NOT model
  evidence.
- **Worktree:** `main` is checked out. The only untracked file is the
  temporary `.scratch/_commit_msg.txt` and must be removed before the next
  commit. Use `git status -sb`, `git branch -vv`, and `git worktree list` for
  volatile Git state.
- **Next action:** none required for the pivot — the deferred benchmark is
  now delivered (clean 60% single run). A `--repeat 3` variance run is
  OPTIONAL: the bench has no cooldown, so 30 fresh back-to-back threads sit
  at the F13 thread-rate degradation onset (~120/hr vs ~128/hr onset), and
  there is no pre-pivot scorecard in `scripts/bench/out/` to compare it
  against. Only run it if a comparison target is wanted, on a rested
  account, with pacing. Local wrap-up commits (`58de0fe` and the NEXT.md
  update) are unpushed; pushing `origin/main` needs explicit user
  authorization.
- **Open PRs:** none known after PR #1 merge. Confirm with `gh pr list` when
  GitHub is reachable.

## 2026-08-14 post-benchmark code-review fix pass

Two-axis review (`reviewer` agents) of `git diff 050c010...HEAD` found and
fixed four defects introduced by the pivot; two gaps are acknowledged as
out-of-scope (rebuilding deleted coverage).

**Fixed:**
- `packages/proxy-lib/src/tool-path.ts` — removed a dead `jsonResponse` import left after the 502-detector deletion (the diff's mandated clean cutover).
- `packages/proxy-lib/src/handler.ts` — restored 2-space indent inside the `try` block (57-58) after the attestation block removal (no formatter in repo to catch it).
- `docs/tool-calling.md` — corrected the "preserved as research artifacts under `attestation.ts`" claim: `force-prompts.ts` was deleted outright; the confab/hallucination classifiers live in `@m365-copilot/core` `tools.ts`, not `attestation.ts`.
- `docs/m365-copilot-api.md` §11 — marked the attestation control plane *superseded from the runtime* and corrected the live-behavior claims (no 8H path on requests, no header forwarding / fail-closed 409 → research artifact only). AGENTS.md: protocol doc is source of truth and must track behavior.

**Acknowledged gap (not fixed):**
- `packages/proxy-lib/src/tool-path.contract.test.ts` has zero `M365_STEERING` coverage — the 4 steering-gate tests from the deleted `tool-path.test.ts` were not re-implemented. The steering code is kept and still wired (handler.ts), just unguarded. Out of scope per the pivot spec (it deleted the file as a whole); ticketed separately for a future pass. Ticket: `.scratch/simplify-tool-path/issues/02-contract-suite.md`.

**Verification after fixes:** `bun run build` green; `tsc --noEmit -p packages/proxy-lib` clean; `bun run test:unit` → 341 passed / 3 skipped (unchanged).

**Local commit** (docs + proxy-lib clean-up) is unpushed; pushing `origin/main` needs explicit user authorization. (SHA changes with each amend; the next session should read `git log --oneline -5` for the current tip.)

## Safe-to-clear verdict for 2026-08-14 session

✅ **Yes.** The merged pivot code is verified (build, 341 unit tests, tsc);
the deferred benchmark delivered a clean 60% single run with real tool loops;
the post-benchmark code review found 4 defects, all fixed and re-verified
(341 passed / 3 skipped); publish-prep audit is clean (push-range content +
identity + full-tree secret scan). No session-started process remains (the
proxy was stopped; the four `bun.exe` processes are pre-existing
google-workspace MCP infra). The unpushed local commits (`58de0fe`, `7e49e40`,
and the fix-pass commit) are a deliberate hold for user authorization, not
unfinished repository changes.

## 2026-08-14 session carry-over (Nemotron 3.5 Lightning research)

**What was done:**
- Corrected hardware specs across 6 research docs + hypotheses §17:
  local machine is the local machine (RTX PRO Blackwell 8 GB), not RTX 5060.
- Surveyed HuggingFace for Nemotron 3.5 Lightning variants: no smaller
  native sibling exists. Key find: **REAP-20B expert-pruned variant**
  (sleepyeldrazi, 128→77 experts, 19.87B total / 3B active, **11.5 GB
  IQ4_NL GGUF**). Full research note at
  `docs/research/notes/nemotron-3.5-lightning-variants.md`.
- Verified community reports (Reddit, NVIDIA forum, X): DSpark +15.6%/
  53% acceptance, ~65 tok/s on M5 Pro, 80/100 tool-eval vs Qwen3.6-35B's
  100/100, good agent execution but weak coding.
- ChatGPT consensus: REAP-20B ranked #1 for the fallback lane; full
  Lightning secondary.
- Linked the candidate into `.scratch/fallback-lane-telemetry/spec.md`.

**Carry-over:**
- Committed on `main`, pushed to `lan sync/nemotron-research-2026-08-14`.
  Secret scan clean. Not pushed to `origin/main`.
- Next step when local machine is available: download the REAP-20B IQ4_NL GGUF
  from `sleepyeldrazi/Nemotron-3.5-Lightning-30B-A3B-REAP-20B-LoRA-IQ4NL`
  and run against the Qwen3-Coder-30B-A3B baseline in the two-stage bake-off.
- No session-started processes remain (browser tab closed).

## 2026-08-19 — Toolchain migration
- Node deps: `bun install` refresh on the existing bun.lock (no package-lock.json present). Verify with `bun run test` if the suite is run.

## 2026-08-21 autonomous session — contract suite + research + hygiene

- **Contract-suite gap closed** (`b2c5295`): the `M365_STEERING`
  zero-coverage gap from the 2026-08-14 review is resolved in
  `packages/proxy-lib/src/tool-path.contract.test.ts` — 4 restored gate
  tests + multi-tool batch preservation, mixed reply+real-tool, and a
  genuine unterminated-fence fixture. Suite now 20 tests, all green.
  Supersedes the "acknowledged gap" note in the 2026-08-14 section above.
- **Full suite:** build green; `bun run test:unit` → **349 passed /
  3 skipped** (baseline was 341/3; delta = exactly the 8 new tests).
- **Research:** Nemotron note §7/§7.1 addendum (Qwen3.8-27B released and
  is a DeltaNet-hybrid, unsloth GGUF confirmed; official Muse Glimmer
  GGUF + DFlash drafter exist; REAP-20B unchanged alpha). Fallback-lane
  candidate table revised to four candidates; REAP download stays ON HOLD
  until the bake-off lane actually opens.
- **Repo hygiene:** local branches deleted (fully merged into the sync
  branch): `adopt-proxy-improvements`, `adopt-upstream-2026-08`,
  `feat/fenced-shell-routing` (origin copy untouched). Kept with reasons:
  `chore/session-wrapup-2026-08-07`, `review/*` LAN branches, local
  `main` — unverifiable merge status post-history-rewrite.
- **LAN sync:** `sync/nemotron-research-2026-08-14` pushed to `lan`
  (fast-forward through `3cbd653`), secret-scan clean. NOT pushed to
  `origin` — still requires explicit user authorization.
- **PC env fact:** use `bun x`, not `bunx` (no bunx shim on this box).
- **Telemetry status:** no `throttle-telemetry.ndjson` on the local machine; the
  fallback-lane decision gate has zero data. Needs real proxy usage.
- Run artifacts (charter, progress, deferred, icebox, report) are in the
  git-ignored `.autonomous/` directory on this machine only.

**Next actions:** (1) user authorization for origin push of the sync
branch; (2) local machine reconcile per the runbook above; (3) real proxy usage
so throttle telemetry accumulates; (4) optional fresh reviewer pass on
`eb86ca9^..HEAD` (the 2026-08-21 subagent pass timed out mid-review;
critical claims were verified directly instead).

## 2026-08-21 (later) — upstream drift audit + absorption plan

- Upstream `cramt/m365-copilot-proxy` measured: **93 commits ahead** of
  merge-base `19c35a1`. Fetched to local ref `upstream-scratch/main`.
- 3-scout audit verdict: the August adoption pass already absorbed nearly
  everything (auth interactive sign-in, race-timer, M365_LOG_STDOUT,
  backoff, never-delete-agents, Windows fences, Power Platform DNS fix —
  all SUPERSEDED). Worth taking: ~9 commits (developer-role normalization
  TAKE; streaming x2, hallucination patterns, code-interpreter opt-out,
  image-gen trio ADAPT). Details in
  `.scratch/upstream-absorb/issues/01-declared-ownership-fork.md`.
- Architecture decision ("declared-ownership fork", from a 5-frame/30-idea
  ideation): .gitattributes ownership list + docs/upstream-manifest.yaml
  ledger + scripts/upstream-absorb.mjs gate + .gitattributes merge=ours on
  owned paths. Ticket 01 has the full work items. Rejected: submodule/
  vendored-upstream, build-time AST rewrite, upstream history rewrite,
  union-FS overlays.
- Origin push of sync branch DONE this session (user authorized);
  origin/main still at 7e37d1b (11 behind our tip).

**Next actions:** execute ticket `.scratch/upstream-absorb/issues/01-declared-ownership-fork.md`; local machine reconcile; throttle-telemetry usage decision unchanged.

## 2026-08-21 (evening) — ticket 01 executed: declared-ownership fork live

- Shipped: `.gitattributes` (ownership policy), `.gitattributes` (merge=ours
  on owned paths), `scripts/upstream-absorb.mjs` (fetch+classify+gate,
  positive/negative tested), `docs/upstream-manifest.json` (all 93 upstream
  commits dispositioned: 16 superseded / 30 skipped / 1 rejected
  [`9c48bd3` CI-on-chat-path, F23 conflict] / 46 bulk-reviewed).
- **Zero cherry-picks needed**: every scout TAKE/ADAPT candidate verified
  already-present (developer role, streaming early-flush/incremental,
  hallucination patterns, image orientation/scheduler/quota). Ticket 01 has
  the corrected table. Scout lesson: verify abbreviated SHAs with
  `git cat-file -t` — 3 of 7 were tree objects.
- Validation: build green; suite 349 passed / 3 skipped (= baseline);
  gate exit 0.
- Upstream remote now configured: `upstream` → cramt/m365-copilot-proxy.

**Next actions unchanged:** local machine reconcile; throttle-telemetry usage
decision; future waves start with `bun scripts/upstream-absorb.mjs`.

## 2026-08-21 (night) — LAPTOP RECONCILE DONE (via collab agent on WHQPC)

- Laptop adopted rewritten history: checked out
  `sync/nemotron-research-2026-08-14` at origin (LAN) tip `8de7466`.
  Verified: build green, tests 349 passed / 3 skipped (= PC baseline).
- Laptop-only AGENTS.md section ("## Git workflow") grafted onto the new
  branch working copy; skip-worktree re-set. Backup:
  `~/m365-reconcile-backup/AGENTS.local machine-asof-2026-08-21.md`.
- Old local machine `main` untouched at `0f39a4e` (pre-rewrite archive until
  cleanup approved). Journal mod stashed (`pre-reconcile journal`), plus an
  AGENTS-section stash; both disposable after a soak period.
- Content check: old main's docs/hypotheses.md + .scratch/ are strict
  subsets of the new branch — nothing lost. Doc re-scrub satisfied by
  adoption (new branch carries the post-rewrite scrubbed copies).
- Coordination ran over Herdr collab (guest WHQPC, lane freepool
  deepseek-v4-flash); ssh outage mid-run forced an omp resume + /join
  replay — recovered cleanly.
- Telemetry note: local machine `~/.config/opencode-m365/throttle-telemetry.ndjson`
  holds 9 events — enough to open the fallback-lane decision gate if any
  are real throttle episodes (user call, see .scratch/fallback-lane-telemetry/spec.md).

**Unlocked:** `.autonomous/ICEBOX.md` branch-cleanup candidates
(`chore/session-wrapup-2026-08-07`, `review/lan-bakeoff-disposition`,
`review/local machine-preparation`) are now deletable pending user approval.
**Still open:** origin/main fast-forward decision; throttle-gate review;
ICEBOX deletions.

## 2026-08-21 (late night) — clone cleaned; absorb-gate regex fix

- Laptop local copy minimized under collab coordination: deleted pre-rewrite
  `main` (centrally archived as LAN `archive/main` = `351fcaa`, verified
  before deletion) and `backup/pre-m365-only-2026-08-12`; dropped the 3
  reconcile-era stashes (contents backed up / grafted); fetch --prune both
  remotes; `git gc --prune=now`. Kept: `image-upload` branch (UNMERGED,
  2 commits: interactive M365 tool bridge + confab F12.12 catch - dead-end
  experiment candidates, deletion deferred to user), and 2 ancient stashes.
- FreshReviewer pass on `eb86ca9^..HEAD`: correct overall; one latent bug
  FIXED - upstream-absorb.mjs glob→regex translation now escapes
  metacharacters and orders ** vs * via sentinel (deep-path patterns like
  `scripts/bench/**` matched only one level before). Unit-checked against 7
  path cases; gate exit 0.
