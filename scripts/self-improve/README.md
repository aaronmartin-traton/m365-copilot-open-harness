# self-improve — let the model improve this harness

The repo already has the two halves: an objective score (`scripts/bench`,
pass/fail verifiers, "best becomes a number") and a log (`docs/hypotheses.md`).
What was missing is the loop between them — propose a change to the harness,
apply it somewhere disposable, re-score it, and **keep it only if the number
went up**.

That is hill-climbing on an objective function, applied to the harness itself.

```sh
bun run proxy 4141                       # in one shell
bun scripts/self-improve/run.mjs --base-url http://localhost:4141/v1 \
  --iterations 4 --repeat 3
```

Output lands in `scripts/self-improve/out/<timestamp>/` as `report.md` and
`best.patch`.

## What it may change

Only the prompt-shaping and tool-parsing surfaces, where a regression shows up
in the score rather than in someone's session:

```
packages/core/src/fenced.ts
packages/core/src/tools.ts
packages/core/src/session.ts
packages/core/src/agent.ts
scripts/bench/prompts/
```

## Safety rails

These are the point of the tool, not decoration:

- **Your working tree is never edited.** Every candidate is applied to a throwaway
  copy in a temp dir, scored there, and written out as a patch. You apply it
  yourself, after reading it.
- **A patch touching `.git`, `auth.ts`, `packages/proxy`, `.env` or
  `node_modules` is refused outright** — checked against the patch *body* too, so
  smuggling `rm -rf .git` inside an otherwise-legal file does not get through.
- **Never commits, never pushes, never reads the token cache.**
- **One long M365 thread for the whole run**, never a thread per iteration.
  AGENTS.md is explicit that *conversations started* is what burns the quota
  budget; a fresh thread per experiment is the expensive mistake.
- **Model-generated shell never touches your host.** Scoring runs the same
  `--network none` Docker sandbox the bench uses.
- **Bounded**: `--iterations` (4), `--repeat` (1), and a `--min-delta` below which
  a difference is not treated as a win.

## Read the caveats in the report

`repeat=1` means a couple of points is noise. The bench is a small task set, so
a gain there is not a gain in general. And this tool *ranks* changes — it does not
vouch for them. Apply a patch only after reading it.

## Why it is not fully autonomous

Because the honest bottleneck is not proposing changes, it is **verifying** them.
The bench is small, so a proposal can win on it and lose in the world. Until the
bench is broad enough to mean something, the loop's value is in producing ranked,
readable patches for a human — not in merging them unattended.
