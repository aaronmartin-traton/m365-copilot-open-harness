# Domain Docs

How the engineering skills should consume this repo's domain documentation
when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — vocabulary + decisions. Single-context
  repo, no `CONTEXT-MAP.md`.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their
absence; don't suggest creating them upfront.

## File structure

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── ADR-0001-RUNTIME.md
│   └── ADR-0002-EXECUTION-INTENT-VERIFIER.md
├── docs/
│   ├── m365-copilot-api.md      ← protocol source of truth
│   ├── hypotheses.md            ← open-questions notebook
│   └── experiments.md           ← runnable catalog
└── packages/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor
proposal, a hypothesis, a test name), use the term as defined in
`CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either
you're inventing language the project doesn't use (reconsider) or there's a
real gap (note it).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than
silently overriding:

> _Contradicts ADR-0002 (execution-intent verifier) — but worth reopening
> because…_