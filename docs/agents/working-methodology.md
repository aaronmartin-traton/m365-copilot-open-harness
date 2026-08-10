# Working Methodology (PC Implementer)

How locally implementer works in this project. It is the startup playbook for
a new session on the local machine. Read it with `docs/agents/session-workflow.md`, the
two-machine operating manual. This doc covers the local role only.

## 1. Role and boundaries

- You are locally implementer. The team has three parties: PC implementer,
  local machine implementer, and coordinating architect.
- You own implementation, unit tests, adversarial review, and docs on the
  working repo.
- The PC never runs local models. Live M365 work happens only on the local machine.
- Your tickets are research and implementation only. They must not send M365
  traffic.

## 2. Session startup

Do these steps in order at the start of a session.

1. Join the collab. The link lives in
   `/path/to/the remote/shared/collab-link.txt`. Run
   `omp join "<link>"`.
2. Read `NEXT.md`. It is the handoff doc with baseline, attestation state,
   next slice, and recovery runbook.
3. Read `docs/agents/session-workflow.md`. It is the two-machine operating
   manual.
4. Read `AGENTS.md` and `CONTEXT.md`. Use the repo vocabulary.
5. Check state with `git status -sb` and `git log --oneline -5`. Never trust
   a snapshot for volatile Git facts.
6. Claim the earliest unblocked ticket. Tickets live in
   `.scratch/<feature>/issues/` as one file each. Read the `Status:` and
   `Blocked by:` lines. Read the spec in `.scratch/<feature>/spec.md` first.
7. Read the protocol doc before you touch protocol code. Read
   `docs/prompt-engineering.md` before you tinker with framing.
8. Announce the claim to the coordinator pane (`w8:p2`).

## 3. Hard constraints

- Zero M365 traffic in every ticket. The verifier prompt and corpus are
  frozen (ADR-0002).
- Gate order: 0 unsafe false positives, then selective accuracy at least
  0.95, then measured latency.
- Reviews of `lan/main` are read-only. Do not merge, edit, test, or bench
  local machine evidence.
- Do not start ticket 03 or 04 without the architect's clearance.
- Do not push to `lan/main` or GitHub until the the egress check reviews land.
  GitHub pushes also need the secret scan.
- Do not touch local machine handoff files or another participant's files.
- Commit only your files. Verify the diff before you commit.

## 4. Ticket delivery standard

- Deliver evidence, not claims. Include exact commands, sample sizes, and
  evidence pointers.
- A findings report has four parts: paths and versions, port and hardware
  evidence, exact resume commands with an identity guard, and human-needed
  items.
- n=1 is noise. Repeat winners with `--repeat`. Rotate strategy order
  across runs.
- Log every hypothesis in `docs/hypotheses.md` with a falsification
  criterion. Promote conclusive findings to the protocol or
  prompt-engineering doc.
- State the check that proves done. Claim success only from a tool result.

## 5. Environment quirks

- Use `bun x`, not `bunx`.
- `rm -rf` is denied. Use `mv` to the egress check instead.
- Git Bash has no process substitution.
- Committed JSON files carry a UTF-8 BOM.
- Git Bash `grep` and `sed` fail on `/c/`-style paths.
- `HOME` is empty in Git Bash. Use `USERPROFILE=C:\Users\PC_HOST`.
- Port 1234 is LM Studio on the local machine. It serves qwen3.5-4b and friends, not
  the verifier. The verifier is llama-server with Bonsai-27B on the local machine.
- The local machine connects into locally sshd. The link is
  `<local machine-ip>:62386` to `<pc-ip>:22`.
- The PC has no `msal-cache.json`. Live M365 verification is auth-blocked
  here. A human interactive login is required first. Never attempt it
  unattended.
- `herdr agent prompt --wait` does not observe collab guests. Send the
  prompt without `--wait`. Poll `herdr agent read <pane> --source recent`
  for progress.

## 6. Communication

- Panes: `w8:p1` is locally implementer, `w8:p6` is the local machine guest,
  `w8:p2` is the coordinator.
- The collab relay runs on port 7466. When it dies, pane agents freeze in
  `SYN_SENT`. Detached work on the local machine continues. Panes reconnect when
  the relay returns.
- Exchange artifacts through the LAN repo and sync branches. Do not paste
  large blobs into chat.
- Telemetry NDJSON lives outside the repo. Hash conversation ids with
  sha256. Set `M365_NO_TELEMETRY=1` to disable.

## 7. Docs conventions

- STE applies to fork-authored operational docs. That includes
  `docs/agents/*`.
- The scientific notebooks and the cramt-derived docs stay verbatim. Do not
  re-STE them.
- Agent-facing docs follow the writing-for-agents levers: one leading word
  per concept, one trigger per pointer branch, no duplication, checkable
  completion criteria.
- Research docs get a snapshot header with the date. Volatile Git facts
  never go into committed prose.

## 8. Current mission

- The standing goal: a usable agent in pi, Codex, or standalone, driven by
  this proxy, with a fail-closed execution gate.
- The active direction is client-attested execution. It is opt-in. The 8H
  baseline stays the default.
- The current slice and its blockers live in `NEXT.md`. Read it for the
  exact state.
