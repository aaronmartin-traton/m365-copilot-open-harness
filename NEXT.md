# NEXT.md — M365 Copilot Proxy
> Snapshot as of 2026-08-11.

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
