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
| `ambiguous` | deterministic logic has no high-confidence answer |

The critical category is `ambiguous`. It is the only category intended for a
local model. A tactical reasoner gets exactly the `ambiguous` cases — nothing
else — and "uncertain" is always a valid answer.

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
- `note` — provenance: which test fixture, hypothesis entry, or observed
  failure mode seeded the case.

The two fields answer different questions. `expected` records the input shape;
`expected_action` records the desired behavior. The mixed cases demonstrate
why: both are `mixed_tool_and_prose`, but one resolves to a tool and the other
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

## Rules

- No production changes to enable corpus work.
- No runtime local model until the corpus data justifies it.
- Mutable status lives in `NEXT.md`, not here.
