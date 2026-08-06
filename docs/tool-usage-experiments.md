# M365 Copilot tool-use experiments

Observed behavior of `m365/gpt-5.6-think-deeper` when OMP exposes local tools through `m365-copilot-proxy`. Primary evidence is OMP session `<session-id>`, run on Windows in `/path/to/work-repo` on 2026-07-29, plus live proxy diagnostics from the same day.

The transcript records both the command requested by the model and the command actually executed by the harness. This matters because OMP may rewrite commands through `rtk`, while the proxy routes fenced Bash through Git Bash on Windows.

## What worked

### Repository access was real

The first M365 turn ran:

```sh
pwd && git rev-parse --show-toplevel && git status --short --branch
```

It correctly established the working directory, repository root, branch, and unrelated modified files. The answer cited the tool result rather than claiming access from prompt context.

### Focused reads produced a source-grounded answer

After narrowing scope, bounded `sed` ranges and exact-symbol searches in `bfsh.c`, `bfsh_ah.c`, and two system tests established that:

- `up_bfshBrakeHold_U08s == 10` activates Hill Hold;
- `up_bfshBrakeHold_U08s == 14` activates AutoHold and leaves Hill Hold disabled;
- `vp_holdEnReqStartup_U08s` changes only Hill Hold startup state;
- Hill Hold writes are guarded by `enabled_B == TRUE`.

The final follow-up answer correctly treated `up_bfshBrakeHold_U08s` as the top-level selector instead of inferring behavior from parameter names.

### Multi-turn local execution stayed coherent

The proxy converted M365 hosted command intent into local OMP calls, returned actual tool results to the same conversation, and allowed further reads. Independent OMP and Codex smoke tests previously returned `LOCAL_PROXY_TOOL_4C8E2A71` through the local bridge.

## Mistakes in the analyzed OMP session

### 1. It forgot the proven local working directory

After `pwd` had proved `/path/to/work-repo`, the model repeatedly emitted:

```sh
cd /mnt/data 2>/dev/null || true
```

It also probed `/workspace`. `/mnt/data` is Microsoft's hosted interpreter directory; it is not the local Windows OMP workspace.

Impact: two no-op turns, one explicit missing-directory error, and unnecessary uncertainty after the environment had already been established.

Rule: the first successful local `pwd` is authoritative. Do not switch to `/mnt/data` unless the current local tool result explicitly reports it.

### 2. It ran an unbounded repository-wide search

A broad search for `autohold`, `hill hold`, and `key cycle` ran for about 91 seconds, traversed generated/build artifacts and cached merge-request data, returned heavily truncated output, and ended with a broken-pipe panic after `head` closed the pipe.

Impact: high latency, context pollution, irrelevant matches, and partial failure hidden behind a nominally successful tool result.

Better sequence:

1. Search exact parameter names.
2. Scope to the relevant feature directory and tests.
3. Read bounded source sections around matches.
4. Expand only if those sections do not establish behavior.

### 3. It suppressed useful errors

Combining speculative `cd`, `2>/dev/null`, and `|| true` made “wrong path,” “missing command,” and “no matches” look like a clean empty result.

Rule: preserve stderr and exit status while establishing the environment. Suppression is appropriate only after a failure mode is understood.

### 4. It repeated a disproven hypothesis

The model returned to `/mnt/data` several times after local `pwd` had again printed the Windows repository root. This was not error recovery; it discarded established state.

The prompt should repeat this invariant on every tool-enabled continuation:

```text
Local harness: Windows + Git Bash.
Use the OMP working directory and relative repository paths.
/mnt/data and /workspace are hosted environments, not local paths.
```

### 5. It loaded a mismatched skill

The model loaded `get-input-data`, which is designed for RTDB signal-producer tracing. The task was parameter dispatch and startup behavior in BFSH source and tests. The final answer claimed it “used” the skill, but did not follow that skill's signal-provenance workflow.

Rule: loading a skill is not evidence of using it. Mention a skill only when its workflow materially determines the result.

### 6. It allowed one huge tool result to dominate context

The broad search added unrelated domains, generated files, cached API results, and truncated lines. Useful matches existed, but the signal-to-noise ratio was poor.

Rule: bound output at the source with exact paths and symbols; do not generate an enormous stream and rely on downstream truncation.

### 7. First-answer latency exceeded eight minutes

The first substantive answer recorded about 500 seconds of model duration after a 91-second broad search and several no-op probes. The focused follow-up completed in about 24 seconds. This does not prove one cause, but large tool-result context and unnecessary turns are the strongest correlates.

## Proxy-overload investigation

During the later failure report:

- `/health` returned `{ "status": "ok" }`;
- the Bun process had not crashed or restarted;
- working set was about 107 MB and private memory about 391 MB;
- the image-work Herdr OMP agent was idle;
- a minimal GPT-5.6 request returned `upstream_empty_response` with `3/600` throttle metadata;
- the same failure remained after restarting the proxy.

Conclusion: the local proxy was healthy. The failure matches documented Microsoft account-level/thread-rate degradation: empty responses at a low per-conversation count. Restarting or obtaining a fresh token does not change the identity (`oid`) throttle bucket. Restarting also clears in-memory degradation history, which can delay the automatic backoff trigger.

Recovery:

1. Stop creating new conversations.
2. Leave the account idle for roughly 15 minutes.
3. Do not reauthenticate merely to clear throttling.
4. Retry one minimal request after the lull.
5. Resume experiments sequentially, preferably in one long conversation.

## Recommended GPT-5.6 tool framing

```text
You are using a LOCAL Windows harness through Git Bash.
The current working directory is supplied by OMP.
Use relative paths unless a tool result proves another root.
Do not use /mnt/data or /workspace.
Do not hide path or command errors while diagnosing.
Search exact symbols in the smallest relevant directory, then read bounded ranges.
One tool call per turn; inspect its real result before choosing the next call.
Never claim a file is missing or empty until a tool result proves it.
```

## Proxy improvements worth testing

1. Repeat local-workspace framing on every tool continuation.
2. Detect `/mnt/data` or `/workspace` in intercepted intent and inject a local-workspace correction.
3. Label results with both requested and harness-executed commands when rewriting occurs.
4. Treat panic/broken-pipe text as partial failure even if the pipeline exits zero.
5. Warn or retry narrowly when tool output exceeds a configured bound.
6. Persist degradation timestamps across proxy restarts.
7. Serialize upstream requests per account and add an admission-rate limiter. `sums001/Windows-Copilot-API` independently uses both controls for consumer Copilot; the mechanism is applicable even though its backend and throttle model differ.

## Suggested experiments after recovery

Use unfakeable, small fixtures and one established conversation:

| Case | Required evidence |
|---|---|
| Working directory | `pwd`, repository root, and branch agree |
| Exact read | Unique sentinel returned after a real tool result |
| Missing path | Actual local error; no switch to `/mnt/data` |
| Narrow search | Exact symbol and bounded source location |
| Error recovery | One local `pwd`/listing, then corrected relative path |
| Multi-step read | Three small files, one call per observed state |

Do not launch many fresh conversations back-to-back. Fresh-thread rate is the scarce resource; local turns inside one existing conversation are cheaper and more representative.

## Status

- Local proxy process: healthy.
- Local tool bridge: previously verified through OMP and Codex.
- Microsoft upstream remained degraded after a measured 15-minute idle window: the reused diagnostic conversation returned empty at `6/600`, and one fresh nonce conversation returned empty at `3/600`.
- Additional fixture experiments are deferred until a longer idle recovery window completes; further probes would worsen the thread-rate condition.
- A later sequential recovery smoke against `gpt-5.6-think-deeper` returned exact `M365_RECOVERY_OK` in 16 seconds with one conversation message and `Gpt_5_6_Reasoning`. Resume live work one request at a time; the throttle was temporary, not a local proxy defect.
- The recovered provider also completed an OMP local-tool loop: M365 emitted one fenced `bash` call, OMP ran it in the real Windows workspace, returned `M365_OMP_TOOL_TRACE_OK`, and M365 consumed that result before replying with the same exact sentinel. The two upstream turns completed sequentially in about 20 seconds.

## Herdr multi-file agent smoke (July 29)

- OMP pane, `m365/gpt-5.6-think-deeper`: edited two TypeScript files, created `NOTES.md`, and passed `OMP_MULTI_FILE_OK`. It made one stale `/mnt/data` probe after the edits, but recovered and verified the real Windows fixture.
- Codex pane, M365 Responses profile: read the fixture, edited two TypeScript files, created `OPERATIONS.md`, and passed `CODEX_MULTI_FILE_OK`. `workspace-write` first hit the existing Windows sandbox `CreateProcessAsUserW failed: 1312`; an isolated fixture retry with `danger-full-access` completed.
- Codex exposed two proxy compatibility defects during the run: the custom `model_catalog_json` lacked newly required metadata, so the invalid override was removed; and fenced scalar headers reached Codex as strings (`"false"` instead of boolean). The parser now coerces declared boolean/number/integer headers, validates required fields, and accepts hyphenated tool names. Unit regression coverage was added.
- Codex still logs a non-fatal model-refresh warning because its catalog fetch expects a Codex metadata envelope while `/v1/models` is the standard OpenAI `{object:"list",data:[...]}` shape. It falls back to configured model metadata and completed the task; fix this before calling Codex handoff polished.
