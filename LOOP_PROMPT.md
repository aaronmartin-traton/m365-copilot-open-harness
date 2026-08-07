# Loop Prompt: Iterative Handler.ts Extraction

You are continuing iterative refactoring of m365-copilot-proxy. 

## Mission
Extract cohesive responsibilities from handler.ts (currently ~538 lines) into focused modules, following the engineering rules in docs/development/ENGINEERING_RULES.md.

## Per-Iteration Cycle

### 1. ASSESS
Read handler.ts and identify ONE cohesive responsibility that can be extracted:
- Must be a self-contained concern (not tangled across the file)
- Must preserve existing behavior exactly
- Must earn its existence (solves a real problem)

### 2. EXTRACT
- Create new module in packages/proxy/src/
- Move the responsibility with minimal changes
- Update imports in handler.ts
- Ensure handler.ts reduces in line count

### 3. VERIFY
- Run `bun test` - all tests must pass
- Run `bun run build` - must compile cleanly
- Verify behavior preserved (no functional changes)

### 4. DOCUMENT
- Update docs/architecture/COMPONENT_REFERENCE.md if new module added
- Update NEXT.md with extraction completed
- Commit: `git commit -am "extract: <responsibility> from handler.ts"`

### 5. REPORT
Output this status block:
```
ITERATION N: <responsibility extracted>
- Lines removed from handler.ts: X
- New module: <module-name.ts>
- Tests: PASS/FAIL
- Build: PASS/FAIL
- Remaining handler.ts lines: Y
- Next candidate: <responsibility> OR "handler.ts sufficiently cohesive"
```

## Constraints
- One extraction per iteration (small commits rule)
- No speculative abstractions - extract only what exists
- Interface before implementation (define the contract the extraction fulfills)
- Preserve behavior (run tests after each change)

## Stop Conditions
Stop when ANY of these are true:
- handler.ts is ~300 lines AND all responsibilities are cohesive
- No more extractions can be identified that earn their existence
- Tests fail and root cause isn't obvious in 1 iteration

## Autonomy
You have full autonomy to continue iterations. Do not ask permission between iterations. Only stop for:
- Test failures you cannot resolve in one iteration
- Ambiguous extraction candidates (ask which of 2+ options)
- Stop condition reached

Begin with iteration 1.
