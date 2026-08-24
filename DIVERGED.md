# .gitattributes — declared-ownership fork policy

This fork tracks upstream [`cramt/m365-copilot-proxy`](https://github.com/cramt/m365-copilot-proxy).
This file declares which paths are **OURS** (merge never takes upstream's
version) and which are **SHARED** (upstream changes merge normally and are
welcome). It exists so an upstream wave costs one bounded review instead of a
full re-audit.

## The three pieces

| Piece | File | Role |
|---|---|---|
| Ownership | `.gitattributes` (this file) + `.gitattributes` | what wins a merge |
| Ledger | `docs/upstream-manifest.json` | disposition of every upstream commit |
| Gate | `scripts/upstream-absorb.mjs` | fails when unreviewed upstream commits exist |

## Absorbing an upstream wave

```sh
bun scripts/upstream-absorb.mjs            # fetch + classify + gate + worklist
git show <sha>                             # review each PENDING commit
# edit docs/upstream-manifest.json: pending -> taken/rejected/superseded/skipped
git merge upstream/main                    # owned paths auto-resolve to ours
bun run build && bun run test:unit         # validation gate — required
```

The `merge=ours` driver needs a one-time local registration (the script does
this automatically, but you can also run it by hand):

```sh
git config merge.ours.driver true
```

## OWNED — ours wins (`merge=ours` in `.gitattributes`)

The tool-calling pipeline and the simplify-tool-path pivot live here.
Upstream changes to these paths are recorded in the manifest as
`rejected` (or `superseded` if we already contain an equivalent) and are NOT
merged.

- `packages/proxy-lib/src/tool-path.ts` + `tool-path.test.ts` +
  `tool-path.contract.test.ts` — deterministic text→OpenAI translation,
  one-call-per-turn, steering gate
- `packages/proxy-lib/src/handler.ts` + `handler.test.ts` +
  `handler-session.test.ts` — one-runTurn-per-request invariant, produce()
  data/render split, early-flush SSE
- `packages/core/src/fenced.ts` + `fenced.test.ts` — fence parse/format,
  shell-routing framing
- `packages/core/src/tools.ts` + `tools.test.ts` — toolset shaping,
  hallucinated-completion detector
- `packages/core/src/agent.ts`, `session.ts` + tests — agent provisioning
  (never-delete), optionsSets/hosted-shell interception state
- `packages/core/src/steering.ts` + test — ours alone (no upstream counterpart)
- `packages/core/src/throttle-telemetry.ts` + test — ours alone (F13 telemetry)
- `packages/core/src/auth-recovery.ts` + test — degradation backoff, our env
  surface (`M365_NO_BACKOFF`)
- `packages/proxy-lib/src/intent-verifier.*`, `attestation.*` — frozen
  research artifacts (removed from runtime on purpose; upstream deleted their
  equivalents — do not let a merge resurrect or delete them silently)
- `docs/**` — heavily rewritten; upstream doc commits don't apply
- `.scratch/**`, `scripts/bench/**` — local-only

## SHARED — take upstream

Everything else, notably: `packages/core/src/auth.ts`, `log.ts`,
`schemas.ts`, `copilot.ts`, `model.ts`, `images.ts`, `image.ts`;
`packages/proxy-lib/src/schemas.ts`, `images-generation.ts`,
`scheduler.ts`, `responses.ts`; `packages/proxy/bin/m365-login.mjs`.

These stay as close to upstream as practical. Local additions to shared files
(e.g. `developer` role normalization in both schema modules) came FROM
upstream and should continue to track it.

## History note

Our history was rewritten on 2026-08-11 (git-filter-repo). Patch-id
comparisons across that boundary are unreliable; the manifest records
dispositions explicitly instead of trusting `git cherry`.
