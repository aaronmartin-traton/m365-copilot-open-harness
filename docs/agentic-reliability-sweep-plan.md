# Agentic reliability sweep plan

## Goal

Measure whether the M365 model reliably performs real multi-file coding work through the proxy's prompt-emulated tools, without mistaking one stochastic success or refusal for a durable result.

## Safety and rate limits

- Run one M365 conversation at a time.
- Use one long-lived OMP conversation for each sweep cell; do not issue concurrent turns.
- Use generous cooldowns between fresh conversations.
- Use only throwaway fixtures under a temporary directory.
- Do not retry a `Disengaged`, empty upstream response, or throttle result in the same cell.
- Preserve redacted diagnostics only; never record tokens, cookies, browser headers, or raw conversation IDs.

## Cells

### A. Prompt-shape control

1. Soft ordinary coding request: inspect three fixture files, change two files, run verification.
2. Equivalent request with explicit tool-call/multi-tool language.
3. Equivalent request with POSIX shell guidance.

The successful temporary run establishes C as the initial candidate. A and B remain controls for guardrail-shape comparison.

### B. Task diversity

Run each prompt shape against:

1. multi-file text/config edit;
2. code-writing task with a focused checker;
3. read-edit-verify task requiring a real mutation.

Each cell records first-tool latency, tool-call count, files changed, verification result, finish outcome, and any `Disengaged`/empty response.

### C. Confirmation

- Repeat the candidate prompt shape at least twice in fresh conversations.
- Rotate cell order across repetitions to reduce order effects.
- Compare pass rate, not a single transcript.
- Stop the sweep on account-level empty/throttle symptoms and wait for recovery.

## Success criteria

A candidate is provisionally reliable when it completes at least two repetitions of each task family, makes the requested real file changes, and passes the fixture checker without touching outside the temporary directory. Any guardrail or shell-runtime mismatch is recorded as a separate failure class.

## Side work

- Keep a deterministic fixture checker beside each temporary task.
- Run the local parser, handler, session-gate, and reaper tests before and after live cells.
- Record conclusions in `docs/hypotheses.md` only with sample size and redacted evidence.
- Remove temporary fixture files, OMP session directories, proxy state, and test panes after each bounded run.

### D. Minimal harness comparison

Use two harnesses with the same temporary fixture and prompt:

- **Pi-style harness:** the minimal read/write/edit/bash loop already exercised through OMP. Capture structured tool events, tool arguments, tool results, turn boundaries, and final fixture verification. This is the primary control because it exposes the proxy's native OpenAI-compatible tool-call boundary directly.
- **Aider:** test as an OpenAI-compatible scripted client using `aider --model openai/<model>` and `--message`/`--message-file`, with `--no-git`, `--yes`, and controlled edit format. Aider's normal workflow is its own diff/shell application protocol, not native OpenAI function calling, so treat it as a client/edit-format comparison rather than an equivalent tool harness. Official references: https://aider.chat/docs/llms/openai-compat.html and https://aider.chat/docs/scripting.html.

For each harness record whether the model emitted a structured tool event, whether the harness executed it, the number of files changed, checker status, and whether any work was claimed without a tool result. Do not compare raw completion prose as success evidence.

### E. Harness implementation side work

1. Keep the fixture and checker harness-neutral.
2. Add a Pi runner that writes one JSONL event record per request/tool result.
3. Add an Aider runner using `--message-file`, disabled auto-commits, and a throwaway working directory.
4. Normalize both outputs into the same scorecard: `tool_calls`, `tool_results`, `files_changed`, `verification`, `guardrail`, `upstream_error`, and elapsed time.
5. Run the harnesses sequentially; never mix their conversations or reuse a failed fresh thread.

## Current live validation

Before the sweep, perform one approved disposable OMP prune/resume proof: create one isolated OMP conversation, capture its managed M365 conversation ID from redacted diagnostics, prune that exact ID once, resume the same OMP session, and require a new M365 conversation with a full first remote turn. Do not use an existing user conversation.
