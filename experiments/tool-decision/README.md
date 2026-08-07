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
- `expected` — one taxonomy class; for `ambiguous` cases the note explains the
  tension.
- `note` — provenance: which test fixture, hypothesis entry, or observed
  failure mode seeded the case.

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
logic and produce a coverage table:

| classification | cases | deterministic success |
|---|---|---|
| valid_tool | 30 | 30 |
| confabulation | 20 | 20 |
| hallucination | 20 | 19 |
| remote artifact | 15 | 15 |
| mixed output | 20 | 18 |
| ambiguous | 25 | — |

The rows that are not fully deterministic define the remaining problem. If
deterministic handling already solves most of the corpus, there is no local
model to add yet.

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
