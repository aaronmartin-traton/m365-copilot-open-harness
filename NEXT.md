# NEXT.md — M365 Copilot Proxy
> Current state. Only live work belongs here; shipped history is in Git and the
> `.scratch/` tickets, which carry their own evidence.

**Start a new session here:** read
`docs/agents/working-methodology.md` (startup sequence + operating rules +
current mission), then `docs/agents/session-workflow.md` (operating manual),
then `CONTEXT.md` (vocabulary).

## Open work

All three are **human-gated** — they need a live M365 window or an interactive
browser, so no autonomous session can close them.

1. **Small tool-caller bake-off + repair bench**
   (`.scratch/small-toolcaller/issues/01-repair-pass.md`, items 1 and 4). The
   offline work landed; what remains is picking the model on frozen fixtures and
   benching `M365_TOOL_REPAIR=1` against the
   `simplify-tool-path-2026-08-14T04-19-13` scorecard.
2. **Retired-tone probe** (`scripts/tone-retirement-probe.mjs`, 7 tones, 1
   message each, sequential). Upstream claims M365 now rejects `Gpt_Quick`,
   `Gpt_Reasoning` and the `Gpt_5_x_Quick` family. We are not taking that
   mapping on their word — our own probe recorded `Gpt_5_6_Chat` as registered
   but dead. Run the probe, then decide (`.scratch/upstream-absorb/issues/02`
   item 3).
3. **ChatGPT Web live lane** (`.scratch/chatgpt-web-backend/issues/03`). Sign in
   headed into `CHATGPT_WEB_PROFILE`, sanity-check selectors against live DOM,
   then `bench --label chatgpt-web-01`. Account-action risk is real — read the
   ticket's notes first.

**Unblocked, whenever someone wants it:** the `relay` / `relay_batch` framing
A/B on the bench, before any default is changed (`.scratch/upstream-absorb/issues/02`
item 8).

**Filed, awaiting review:** `.scratch/agent-lessons/issues/01` (AGENTS.md must
warn about the `merge.ours.driver` data-loss hazard) and `02` (lint has a ~301
baseline and is not a gate).

## Repo state

- `main` is current and green: 448 unit tests, `bun run typecheck` clean on all
  four packages, root `tsc --noEmit` clean, upstream absorb gate `OK`.
- `feat/tool-repair`, `feat/chatgpt-web-backend`, `fix/merge-driver-scope` and
  `feat/upstream-ports` are all merged into `main` and can be deleted.
- `main` is 24 commits ahead of `origin/main` — not pushed. Force-push needs a
  human (see PC environment facts).
- The throttle gate stays open pending real-use data; the nine August events
  were stress-test artifacts.

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
- Normal code verification: `bun run build`, `bun run test:unit`, and
  `bun run typecheck`. Live M365 verification uses quota and needs explicit
  approval.
- `bun run lint` is not a gate: ~301 pre-existing findings. Lint the files you
  touched (`bunx oxlint <paths>`). See `.scratch/agent-lessons/issues/02`.
- The repository is public. Run the secret scan and preserve the pre-push
  hook at each egress point.
 