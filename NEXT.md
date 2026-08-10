# NEXT.md — M365 Copilot Proxy
> Snapshot as of 2026-08-09.

## Current baseline

- The **8H fail-closed verifier** remains the approved production baseline.
  Only an `EXECUTE` verdict may authorize execution. The default is on unless
  `M365_INTENT_VERIFIER=0`.
- Safety is proven on the frozen held-out corpus. Latency remains the
  architectural constraint.
- Use `git status -sb`, `git branch -vv`, and `git worktree list` for all
  current checkout, branch, and push state. Do not rely on this snapshot for
  volatile Git facts.

## Verifier-latency bake-off

- Ticket 01 rejected the Bonsai-27B thinking-off logprob scorer. Its
  tokenizer-aware variants produced unsafe false positives.
- Ticket 02 added the `chat_template_kwargs` contract to the verifier request.
- Ticket 03 screened direct-answer candidates on DEV only and closed
  **rejected**. Five candidates produced an unsafe false positive on
  `ambiguous-002`; Ministral-3-3B avoided unsafe output but failed selective
  accuracy. The existing Qwen3.5-4B evidence also fails accuracy.
- No candidate was frozen. Ticket 04, the one-time held-out gate, is
  ineligible and MUST NOT run.
- Evidence: `experiments/tool-decision/execution-intent/results/03-dev-screen/`,
  `docs/hypotheses.md` §§18–24, and
  `.scratch/verifier-latency-bakeoff/issues/`.

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
