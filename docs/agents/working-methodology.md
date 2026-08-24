# Working Methodology

How this project starts and runs a session. Read this file first. It gives
the startup sequence, the operating rules, and the current mission. The
deeper operating manual is `docs/agents/session-workflow.md`.

## 1. Session startup sequence

Do these steps in order. They take about 15 minutes.

1. Read `NEXT.md`. It holds the current baseline, the next slice, and the
   standing verification rules.
2. Read this file (`docs/agents/working-methodology.md`).
3. Read `docs/agents/session-workflow.md`. It is the operating manual.
4. Read `CONTEXT.md`. It defines the domain vocabulary. Use its terms.
   Do not drift to synonyms.
5. Check the git state. Run `git status -sb`, `git branch -vv`, and
   `git worktree list`. Never trust a doc snapshot for these facts.
6. Check the collab panes. Run `herdr agent list`. The local machine implementer
   is `w8:p6` (bottom-left). The PC implementer is `w8:p1`.
7. Claim the earliest unblocked ticket in `.scratch/<feature>/issues/`.
   Read `docs/agents/issue-tracker.md` for the ticket format.

## 2. Operating principles

These rules come from hard-won experience. Follow them.

- **Run sequentially. One M365 thread at a time.** The rate limit tracks
  conversations started, not messages (F13). Never fire concurrent
  requests. Never loop fresh conversations back-to-back. Space runs out.
- **Chase all hunches.** The moment you think "maybe X works like this",
  stop and test it. Record what you learn in `docs/hypotheses.md`.
- **Keep the end goal in view.** Every change must make a usable agent in
  pi, Codex, or standalone. A finding that does not move that needle is a
  footnote.
- **Be scientific.** Turn every "I think X" into a falsifiable hypothesis.
  Use the cheapest probe that settles it. Log sample size and evidence.
- **n=1 is noise.** One SOLVED or Disengaged is a single sample on a
  stochastic, throttle-confounded backend. Confirm winners with
  `--repeat`. Control for order effects.
- **Try N wildly different variants.** Never iterate on the first idea.
  A/B them all in one sweep. Read the scorecard. Then go deep on the
  winner.

## 3. The verifier bake-off (current mission)

This is the active work stream. The contract is frozen. Do not bend it.

### Gate order

1. Zero unsafe false positives.
2. Selective accuracy at least 0.95.
3. Then latency.

### Screen rules

- Screen new candidates on the 28-case DEV corpus first.
- Freeze exactly ONE candidate before the held-out gate.
- Run the single 32-case held-out run once.
- Never retry a rejected candidate on held-out.
- Run `validate-split.mjs` before any new screen.
- Identity-guard the echoed `model` field on every response.
- Screen models one local server at a time.
- Keep GGUF weights and local hash manifests out of Git.

### Current state (2026-08-10)

- Ticket 03 closed **rejected**. Five candidates produced an unsafe false
  positive on `ambiguous-002`. Ministral-3-3B cleared safety but failed
  accuracy (selAcc 0.607). No candidate was frozen.
- Ticket 04 (held-out) is **ineligible** and must NOT run.
- The **8H fail-closed** verifier remains the approved baseline.
- Next slice: a genuinely different latency direction, retaining the
  fail-closed contract and the DEV gate order.
- M365 probes, including custom-instructions, are **standby-only**. They
  need explicit user authorization. Keep all M365 work sequential and
  thread-conserving.

## 4. Machine roles and coordination

| Machine | Role | Owns |
|---|---|---|
| **PC** | Implementation, tests, adversarial review, docs | Working repo, the remote remote, panes |
| **Laptop** | The **only** live-M365 machine | MSAL auth cache, local tool-caller models, live probes. GPU: RTX PRO 1000 Blackwell Laptop, **8151 MiB** |

**Hard rules:**

- The PC **never runs local models** (user rule 2026-08-10). All verifier
  and local-model work happens on the local machine.
- Live M365 verification happens **only** on the local machine. The PC is
  auth-blocked; it can authenticate via the documented interactive login
  when a human is present (`docs/agents/m365-auth-workflow.md`).
- The old Bonsai-27B verifier is RETIRED from the runtime (simplify-tool-path
  pivot). The local machine's LM Studio / llama-server now earmarks small
  tool-caller models for the repair-pass plan:
  `docs/research/notes/local machine-small-toolcaller-2026-08.md`.

### Sync and review refs

- Push work to a **sync feature branch** (`sync/<topic>-<date>`), never
  `lan/main`, never GitHub directly.
- `review/local machine-preparation` and `review/lan-bakeoff-disposition` isolate
  the local machine's broader history pending review. Review them before any
  merge or GitHub push.
- GitHub pushes additionally need the secret scan and the pre-push hook.

### Herdr quirks

- `herdr agent prompt --wait` and `--until` **do not observe state changes
  for collab guests**. They stall or time out even when the agent received
  the prompt.
- Send the prompt without `--wait`. Confirm delivery with
  `herdr pane read <pane> --source recent-unwrapped --lines 30`.
- `herdr pane wait-output` can match old scrollback. Verify with a fresh
  pane read.

## 5. Verification ladder — every change, in order

1. `bun run build` (tsdown, all packages — tests import from `dist/`).
2. `bun run test` (Vitest — **not** bare `bun test`).
3. Package typecheck: `bun x tsc --noEmit -p packages/<pkg>/tsconfig.json`.
   (handler.ts has 2 pre-existing errors — do not "fix" them casually.)
4. `bun scripts/secret-scan.mjs --commits <range>` at both egress points
   (commit and push). Output MUST read `secret-scan: clean`.
5. Conventional Commits (`fix:`, `feat:`, `docs:`, `chore:`, `build:`).
   No `Co-Authored-By` lines.
6. Push only to the sync branch.

**Project code rules**: ESM with `.js`-suffixed relative imports; Zod for
boundary validation; `createLogger` not `console.log` in library code; no
inline `as {…}` casts — use `instanceof` or schema parse; small focused
files; no dead shims or aliases after a change.

## 6. Docs and evidence policy

- **Work lives in tickets, not prose.** `.scratch/<feature>/issues/` holds
  one file per ticket with `Status:` and `Blocked by:` lines.
- **Log every hypothesis** in `docs/hypotheses.md` with a falsification
  criterion and a probe idea. Update it when the experiment lands.
- **Promote conclusive findings.** Protocol behavior goes to
  `docs/m365-copilot-api.md`. Prompting strategy goes to
  `docs/prompt-engineering.md`. Leave a one-line pointer in the notebook.
- **STE (ASD-STE100) applies** to AGENTS.md, NEXT.md, CONTEXT.md, and
  `docs/agents/*`. Evidence verbatim (`docs/hypotheses.md`,
  `docs/experiments.md`, `.scratch` tickets) is NOT STE'd.
- **No derivable volatile facts in committed prose.** Never write commit
  SHAs, branch tips, worktree paths, or push status into committed docs.
  Git is the single source of truth for those.
- **Wrap up every session**: append to the harvest run log, refresh
  `NEXT.md`, and give a safe-to-clear verdict.

## 7. Standby-only actions (require explicit authorization)

| Action | Status |
|---|---|
| M365 live probes (incl. custom-instructions) | Standby — explicit authorization required |
| Local model uninstall / deletion | Standby — needs an explicit user-approved deletion list |
| Merge LAN history into PC main | Blocked — review refs not yet reviewed |
| GitHub push | Blocked — LAN the egress check + secret scan + pre-push hook |
