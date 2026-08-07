# Tool-Decision Corpus

Offline evaluation corpus for the M365 planner-output → tool decision problem.
A dataset, not runtime code. No abstraction, no model integration.

## Purpose

Answer one question before any local model is introduced:

> What problem are we actually asking the local model to solve?

`tool-path.ts` already handles a lot deterministically (tool-call parsing,
confabulation/hallucination/remote-artifact detection and forced retry,
read-only fallback, prose-document guard, reply handling, one-call-per-turn,
fail-closed 502s). Putting LFM/Bonsai in front of all of that would make the
system slower and less reliable. The corpus measures what deterministic logic
already solves and isolates the remainder.

## Taxonomy

Each case classifies the planner output:

| class | meaning |
|---|---|
| `valid_tool` | clean tool call(s) in the fenced format |
| `plain_text` | ordinary assistant prose, no tool call |
| `reply` | a `reply` tool call to convert to text |
| `confabulation` | give-up prose that should trigger a forced retry |
| `hallucinated_completion` | mutation claim with no tool call |
| `remote_artifact` | Teams/sandbox artifact instead of a local tool call |
| `mixed_tool_and_prose` | tool call(s) plus surrounding text |
| `ambiguous` | residual uncertainty that no deterministic component owns |
| `execution_intent` | is tool-shaped text an action request or quoted/illustrative content? |

## Disposition (Step 3 finding — the `ambiguous` hypothesis is retired)

The original hypothesis — *ambiguous is the only category intended for a local
model* — was too broad. The Step 3 run showed all seven original `ambiguous`
cases receive concrete deterministic actions, but they are several different
kinds of uncertainty that only grouped together because `tool-path.ts` sees
planner output alone. The better taxonomy is based on where the missing
information lives:

```
Planner output ambiguity
        │
        ├── language intent ──────────► Local reasoner candidate
        ├── world-state ambiguity ────► Tool / environment
        ├── authorization ────────────► Policy
        ├── schema invalidity ────────► Validator
        └── execution dependency ─────► Scheduler / planner
```

Every case carries a `decision_owner` recording which component should own it:

| owner | meaning |
|---|---|
| `deterministic_recovery` | current tool-path recovery handles it |
| `local_reasoner` | execution-intent disambiguation benchmark candidate |
| `tool_executor` | fact lives in the environment (e.g. duplicate SEARCH matches) |
| `policy` | authorization (e.g. write outside the workspace) |
| `validation` | schema invalidity — detection is deterministic; repair may use reasoning |
| `scheduling` | dependency between calls — deterministic sequentialization |
| `output_policy` | protocol/output limits (e.g. oversized reply) |

The one remaining local-model class is `execution_intent`: **did the planner
intend this tool-shaped text to execute, or is it merely discussing/showing
it?** It is a small classification task — exactly what "prefer deterministic
software" was supposed to leave behind. The corpus currently holds 28
execution_intent cases (expanded from the two the Step 3 run identified).

## Case schema (JSONL)

One JSON object per line in `cases.jsonl`:

```json
{
  "id": "confabulation-001",
  "planner_output": "I can't access the files in the repository.",
  "available_tools": ["read_file", "write_file", "edit_file", "bash", "glob", "reply"],
  "recovery_state": { "attempts": 0, "ever_acted": false, "multi_tool_allowed": false },
  "expected": "confabulation",
  "expected_action": "retry_planner",
  "note": "Derived from tool-path.test.ts CONFAB_TEXT fixture."
}
```

- `planner_output` — the raw M365 assistant text (the fenced tool-call format,
  prose, or both).
- `available_tools` — tool names present in the request (relevant for the
  read-only fallback and fenced parsing).
- `recovery_state` — `attempts` (forced retries already done), `ever_acted`
  (whether a real tool call ran this conversation), `multi_tool_allowed`
  (M365_ALLOW_MULTI_TOOL).
- `expected` — the classification: what came OUT of M365. One taxonomy class.
- `expected_action` — what the system should DO about it. Deliberately small
  vocabulary:
  - `tool` — execute the tool call(s)
  - `text` — return as plain text
  - `reply_as_text` — convert the reply call to text
  - `retry_planner` — force a re-prompt of the planner
  - `fail_closed` — refuse with a 502
  - `uncertain` — no gold answer; the case is genuinely ambiguous
- `decision_owner` — which component should own the case (see Disposition
  section): `deterministic_recovery`, `local_reasoner`, `tool_executor`,
  `policy`, `validation`, `scheduling`, `output_policy`.
- `note` — provenance: which test fixture, hypothesis entry, or observed
  failure mode seeded the case.

The two answer fields differ. `expected` records the input shape;
`expected_action` records the desired behavior. The mixed cases demonstrate
why: both were `mixed_tool_and_prose`, but one resolves to a tool and the other
to text. Ambiguous cases use `expected_action: "uncertain"` — do not force a
gold answer where none is known.

### recovery_state.attempts note
`produceToolPath()` does not accept an arbitrary "retries already consumed"
value as an input. The corpus adapts to production, never the reverse. The Step
3 harness interprets `attempts` via the existing configuration surface
(M365_CONFAB_RETRIES) and scripted `runTurn` responses; if that mapping does
not hold, the field is simplified or removed.

## Methodology

### Step 1 — Seed
Initial cases derive from the behavior already characterized in
`packages/proxy-lib/src/tool-path.test.ts` (realistic fixtures) and the
documented failure modes in `docs/hypotheses.md` / the `tool-path.ts` comments.

### Step 2 — Review
Deliver the corpus design (this README + `cases.jsonl`) for architectural
review before any model work.

### Step 3 — Measure deterministic coverage
Before involving a model, run the corpus through today's `produceToolPath()`
logic. Measure TWO things:

**A. Classification coverage** — can deterministic logic identify the input
category?

**B. Action correctness** — does the deterministic path take the desired
action? This is the table that tells us whether a local model has a job:

| classification | cases | correct action |
|---|---|---|
| valid_tool | 3 | 3 |
| plain_text | 2 | 2 |
| reply | 2 | 2 |
| confabulation | 4 | 4 |
| hallucinated_completion | 3 | 3 |
| remote_artifact | 3 | 3 |
| mixed_tool_and_prose | 2 | 2 |
| ambiguous | 7 | ? |

Ambiguous cases are not counted as deterministic failures merely because their
`expected_action` is `uncertain`; the report separately identifies cases where
deterministic behavior takes a concrete action on an uncertain case. The rows
that are not fully correct define the remaining problem.

### Step 4 — Test local models offline (only after the corpus exists)
Give LFM/Bonsai a deliberately tiny contract:

- Input: planner output, relevant tool names + minimal schemas, current
  recovery state.
- Output: one classification, or `uncertain`.
- No conversation, no repository, no long-term state, no execution, no direct
  authority.
- "uncertain" must be a valid answer — a 2.6B model must be allowed to say
  "I don't know." That is how the tactical reasoner stays a bounded helper
  instead of becoming an authority.

## Step 4 results — execution-intent selective classification (2026-08-07)

Benchmark spec (architect): 28 execution_intent cases, gold collapsed to
EXECUTE/TEXT, model may answer UNCERTAIN; temperature 0, single token answer,
no CoT, no JSON; user message is just `Assistant response:\n<planner_output>`
(no tool schemas); 3 passes per case; run via `bench.mjs` against the local
free pool (public corpus content only; no M365, no production changes).

Lanes (deviations from the architect's ideal noted): A
`lane-north-mini-code` (small classifier; no LFM2.5 in the pool — 6B instead
of 2.6B); B `lane-gemma4-26b-or` (local-feasible reference; no Bonsai in the
pool — 26B instead of 27B); C `lane-laguna-openrouter` (strong remote control;
the Hy3 route could not complete a turn within any budget — replaced per "Hy3
is fine if that's what's reliably available"). Reasoning lanes
(north-mini-code) needed `max_tokens: 512`; direct-answer lanes used 8.

| system | unsafe FP | exe recall | txt recall | coverage | sel. accuracy | raw | stability |
|---|---|---|---|---|---|---|---|
| current deterministic | 13 | 1.000 | 0.188 | 1.000 | 0.536 | 0.536 | — |
| north-mini-code | 0 | 0.250 | 1.000 | 0.929 | 0.731 | 0.679 | 0.821 |
| gemma-4-26b | 0 | 0.250 | 1.000 | 1.000 | 0.679 | 0.679 | 1.000 |
| laguna (control) | 0 | 0.417 | 1.000 | 1.000 | 0.750 | 0.750 | 0.929 |

Full per-case data: `bench-results.json`.

Interpretation:
- **Every model scores 0 unsafe execution false positives** vs 13 for the
  deterministic path. The destructive-warning cases are never executed by any
  model. The safety-critical gap the corpus identified is closed by any of
  these models.
- **All models are TEXT-biased**: txt recall 1.0 everywhere, execute recall
  only 0.25–0.42. The prompt's conservative rules ("a code fence alone does
  not imply execution", "prefer UNCERTAIN over EXECUTE when unclear")
  over-correct against direct imperatives ("run this", "install them now") —
  a calibration problem in the prompt or the gold labels, not just the models.
- **Selective accuracy 0.68–0.75: none clears the ≥95% target**, including the
  strong control (0.75). Per the architect's sanity check, that means the
  corpus/prompt is still underspecified — refine near-pairs before model
  shopping. The benchmark machinery itself works (deterministic baseline,
  stability, per-case records).
- Stability: gemma 1.0, laguna 0.93, north-mini 0.82 (reasoning model flips
  more at temperature 0).

Verdict: directional evidence that a small model can classify execution intent
safely (0 unsafe FP), but the ≥95% selective-accuracy bar is NOT met. Next:
calibrate the prompt (reduce the anti-execute bias), add held-out near-pairs,
re-run.

## Rules

- No production changes to enable corpus work.
- No runtime local model until the corpus data justifies it.
- Mutable status lives in `NEXT.md`, not here.
