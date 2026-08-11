# Session Workflow Report

How this project actually runs across two machines. Read this before starting
any session. It is the operating manual for locally ↔ local machine collaboration
established 2026-08-09.

## 1. Machine roles — the project is two machines

| Machine | Role | Owns |
|---|---|---|
| **PC** (this box, `/path/to/m365-copilot-proxy`) | Implementation, tests, adversarial review, docs | The working repo, the the remote remote, the panes |
| **Laptop** (`/path/to/local machine/m365-copilot-proxy`) | The **only** live-M365 machine | MSAL auth cache, llama-server verifier (Bonsai GGUF), M365 live probes |

**Hard rules:**

- The PC **never runs local models** (user rule 2026-08-10). All verifier /
  local-model work happens on the local machine.
- Live M365 verification happens only on the local machine. The PC is auth-blocked
  (no cache, no recorded login; the telemetry that looked like live traffic
  is unit-test pollution — traced 2026-08-10, see
  `docs/agents/m365-auth-workflow.md`). The interactive-login workflow
  exists; a human must complete it before locally can run live. The token
  cache is `oid`-keyed; a fresh login does not clear account throttling.
- The local machine's M365 auth cache:
  `~/.config/opencode-m365/msal-cache.json`.
- The verifier on the local machine: llama-server (build b10321), Bonsai-27B-Q1_0.gguf,
  `--alias bonsai-27b-q1 --seed 42 -ngl 99 -c 8192`, port 1234.

## 2. Sync & branching — the the remote

- **the remote remote**: `user@lan-host:/path/to/the remote/shared/m365-copilot-proxy.git` (SSH). The local machine's `origin` points at the same bare repo over SSH.
- **Push model**: work is committed on the local machine, pushed to a **sync feature
  branch** (`sync/<topic>-<date>`), never `lan/main` and never GitHub directly.
- **LAN main the egress check**: still in force — do NOT push to `lan/main` or GitHub
  until `review/local machine-preparation` and `review/lan-bakeoff-disposition` are
  reviewed. GitHub pushes additionally need the secret scan + pre-push hook.
- **Laptop pull**: `git fetch origin sync/<branch> && git merge --no-edit
  origin/sync/<branch>`.
- **Laptop-local edits survive merges**: `docs/hypotheses.md`, the logprob
  ticket, the lightweight-no-local-model spec, and a local machine-only section in
  AGENTS.md. The local machine re-applies the AGENTS.md section after each merge via
  the skip-worktree dance (`git update-index --skip-worktree AGENTS.md`).
  Never delete or revert these on the local machine — they live only on the local machine.

## 3. Panes & collab — how the machines talk

- **Panes**: `w8:p1` (PC implementer), `w8:p6` (local machine guest). Both join the
  same collab session (`om0CJryZNpniTGFaEkuJwA`) through a relay on port 7466.
- **Communication**: `herdr agent prompt <pane> "<text>"` delivers a message to
  the pane agent. The collab session lets one session steer both panes.
- **Quirk**: `herdr agent prompt --wait` and `--until` **do not observe state
  changes for collab guests** — they stall/timeout even when the agent
  received the prompt and is working. Send the prompt without `--wait`, then
  poll `herdr agent read <pane> --source recent --format text` to watch
  progress. Confirm delivery by reading the pane's recent output (the agent
  echoes what it is doing).
- **Relay failure**: when port 7466 dies, pane agents freeze (their `omp join`
  retries in SYN_SENT). Detached work on the local machine **continues** — the pane is
  only the UI. The panes auto-reconnect when the relay host comes back. The
  recovery runbook is in NEXT.md under *Laptop / pane recovery runbook*.
- `herdr agent get <pane>` shows `revision` — bumping = progress. Both panes
  idle at rest.

## 4. Verification ladder — every change, in order

1. `bun run build` (tsdown, all packages — tests import from `dist/`, so build
   first).
2. `bun run test` (Vitest — **not** bare `bun test`). Current baseline:
   ~289 passed / 3 skipped, 30 files.
3. Package typecheck: `bun x tsc --noEmit -p packages/<pkg>/tsconfig.json`.
   (handler.ts has 2 pre-existing errors — do not "fix" them casually.)
4. `bun scripts/secret-scan.mjs --commits <range>` at both egress points
   (commit and push). Output MUST read `secret-scan: clean`.
5. Conventional Commits (`fix:`, `feat:`, `docs:`, `chore:`, `build:`). No
   `Co-Authored-By`.
6. Push only to the sync branch.

**Project code rules**: ESM with `.js`-suffixed relative imports; Zod for
boundary validation; `createLogger` not `console.log` in library code; **no
inline `as {…}` casts** — use `instanceof` or schema parse; small focused
files; no dead shims or aliases after a change.

## 5. Live M365 discipline — the thread budget

- **Budget: 12 new threads/hour.** Evidence: overnight sweep at
  `CELL_COOLDOWN=120`s (≈18/hr) ran zero-throttle all night; the user
  suggested 10; 12 was chosen as the compromise. The user later authorized
  exceeding it for deletion traffic (pruning is not chat threads).
- **Spacing: ≥3 minutes between fresh conversations.** Never fire concurrent
  requests; never loop fresh conversations back-to-back.
- **Hard stop**: at the first empty-503 / at-limit response, stop live work.
  A fresh login does **not** clear thread throttling (`oid`-keyed).
- **Empty ≠ Disengaged**: an empty reply with **no** `messageType:
  "Disengaged"` frame (`ReferencesListComplete`) is thread-rate throttle.
  Only `messageType: "Disengaged"` is the content filter. Always inspect the
  frame.
- One long thread (many messages) is cheap; a new thread per task burns the
  budget. Real harness sessions > experiments.
- Canonical end-to-end check (local machine):
  `M365_DEBUG=1 bun scripts/proxy-verify.mjs --agent --multiturn`.
  **The bash tool MUST be in `TOOLS`** or fences parse as `hasToolCalls=false`
  and the check reports a false failure.

## 6. Execution safety stack

- **8H fail-closed verifier is the production default.** On unless
  `M365_INTENT_VERIFIER=0`. Only an `EXECUTE` verdict authorizes execution.
- **Client-attested execution is opt-in** (`M365_CLIENT_ATTESTATION=1` +
  `M365_ATTESTATION_SECRET`). It never replaces 8H.
  - Gate: `POST /v1/attestations` (loopback-only), payload `{client, tool,
    tool_call_id, command_sha256, ts, nonce}`, signature
    `X-M365-Attestation-Sig` = HMAC-SHA256 over the payload lines. Single use,
    60 s expiry, registry caps at 1000 with rolling prune.
  - **Proof header required since 2026-08-09 hardening**: a bare
    `X-M365-Execution-Gate` header alone is ignored. All three headers must
    match: `X-M365-Execution-Gate: attestation-v1`,
    `X-M365-Attestation-Client: pi|omp|codex`, and
    `X-M365-Attestation-Proof: HMAC(secret, "attestation-v1\n"+client)` hex
    (`bun client-adapters/attestation-helper.mjs --proof <client>`).
  - Fail-closed: never-emitted tool_call_ids get 409; pool-emitted 8H ids
    still pass (`pool.knowsToolCallId`); two-pass validation so a 409 doesn't
    burn earlier candidates.
  - Full wire contract: `docs/m365-copilot-api.md` §11. Adapter setup:
    `client-adapters/README.md`.
- **Tool-calling shape**: `useAgent:true` is load-bearing (agent-less
  shell-routing — `useAgent:false` kills interception by construction). The
  magic tone + fenced ```` ```bash ```` routing is the working path; Claude
  tones have no shell tool and hosted Python runs server-side regardless of
  option sets — do not retry them for shell-routing.

## 7. Adversarial review gate

Security-critical surfaces get an adversarial review before they are
considered done. The reviewers are spawned subagents (DS V4 / free-pool
lanes, not GPT-5.6 Terra) run against the committed code.

| Surface | Reviewer | Result |
|---|---|---|
| Images route | `ImagesRouteAdversarialReview` | No blockers; fixes landed |
| Attestation gate | `AttestationAdversarialReview` | No blockers; found the real bypass (bare headers + fabricated ids) — fixed |
| Telemetry/kwargs | `TelemetryKwargsReview` | No blockers; 5 SHOULD-FIXes landed |

**Pattern**: implement → unit-test → commit → spawn adversarial reviewer →
triage findings → fix SHOULD-FIXes → add regression tests → commit → push.
A finding that "the code contradicts its spec" is the highest-value outcome —
hunt for it.

## 8. Docs policy

- **STE (ASD-STE100) applies only to fork-authored operational docs.**
  In scope: AGENTS.md, NEXT.md, CONTEXT.md, `docs/agents/*`, client-adapters
  READMEs, `.scratch` specs.
- **NOT STE'd** (user override — do not re-STE): cramt-derived docs
  (`README.md`, `docs/m365-copilot-api.md`) and evidence verbatim
  (`docs/hypotheses.md`, `docs/experiments.md`, `docs/overnight-log.md`,
  `.scratch` tickets).
- Where findings graduate: protocol behavior → `docs/m365-copilot-api.md`;
  prompting strategy → `docs/prompt-engineering.md`; open questions →
  `docs/hypotheses.md` (leave a one-line pointer when promoting).
- Work lives in tickets, not prose: `.scratch/<feature>/spec.md` +
  `.scratch/<feature>/issues/<NN>-<slug>.md`, `Status:` line near the top,
  `Blocked by:` lines, `## Comments` appended at the bottom.

## 9. Delegation rules

- Read-only research → `scout` agents. Implement-and-test → `task` agents.
  Never outsource the top-level plan.
- Subagents must use DS V4 / free-pool lanes (the keelcode lane 404'd once —
  retry, don't relitigate).
- Concurrency cap 7; tasks skip validation mid-flight (run build/test once at
  the end yourself).
- Carry the full contract in each task prompt — subagents never see this
  conversation.

## 10. Current state pointers

- Startup sequence + operating rules + current mission:
  `docs/agents/working-methodology.md` (read it first).
- Repo state: `git status -sb`, `git branch -vv`, `git worktree list` — never
  trust a snapshot for volatile Git facts.
- Handoff doc: `NEXT.md` (baseline, attestation state, images route, next
  slice, recovery runbook, standing verification).
- Upstream digest: `docs/research/2026-08-10-cramt-upstream-digest.md` — 12
  items, items 1–4 verified already-implemented, item 11 skipped
  (openclaw-plugin is a deliberate tombstone per AGENTS.md).
- Backlog tickets: `.scratch/capability-expansion/issues/07-m365-builtin-tools-feature.md`
  (M365 built-in tools as proxy tools), `.scratch/lightweight-no-local-model/`
  (same binary, `M365_INTENT_VERIFIER=0` + `M365_LIGHTWEIGHT=1` guardrail).
