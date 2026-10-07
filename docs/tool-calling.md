# Tool Calling Contract

This proxy translates OpenAI-compatible tool calls to/from M365 Copilot. Because M365 doesn't natively support the OpenAI tool-calling protocol, we prompt-engineer it via a system prompt and enforce the contract at the proxy layer.

## Output Contract

Tool calls are **fenced** (Markdown code blocks) — the JSON `{"tool":...}` format
was removed (it scored 0/5 on real agentic tasks; see [hypotheses §9](./hypotheses.md)).
A tool call is a code fence whose info-string is the tool name:

```
` ``read_file
/etc/hostname
` ``
```

Per-tool shape: the fence info-string is the tool name, scalar args are `key: value`
header lines, one free-form arg is the fence body, and an `old`/`new` pair renders as an
aider-style `SEARCH/REPLACE` diff.

**Shell-routing (the load-bearing trick).** M365's chat model won't "act as an agent" on
demand but *will* reflexively write a ` ```bash ` block. When the toolset includes a shell
tool (`bash`/`shell`/`run`/`run_command`/… — any name), the proxy injects "do the whole step
by writing one ` ```bash ` block" framing and routes that block to the shell tool. This is
what turns 0/5 into real multi-turn loops. See [hypotheses §9 F12](./hypotheses.md).

**Hosted-intent fallback.** Some tenants can use M365 chat but cannot provision the
Copilot Studio agent because the legacy `minimalBots` environment host is unavailable.
On those tenants, M365 may announce an imminent hosted command in a `Progress` message
(`contentType:"Code"`, `hiddenText:"bash -lc …"`) before running it in `/mnt/data`.
For tool-enabled turns without an agent, the proxy now intercepts that intent, cancels
the hosted turn, and converts the command into the harness's local shell tool call. The
harness still owns execution, approvals, sandboxing, and tool results. This path is a
fallback for the missing-agent case; the normal declarative-agent path remains preferred.

## Enforcement

The contract is enforced at three layers:

### 1. System Prompt (packages/core/src/tools.ts)

`formatFencedToolDefinitions()` injects the contract into every tool-enabled request:
- "Performing the task with tools is your **PRIMARY JOB**. Answering the user in prose is, and always will be, SECONDARY."
- A fenced block is an **ACTION the runtime executes**, not an example/illustration.
- **Shell-first framing** when a shell tool is present: "do the whole step by writing ONE ` ```bash ` block" (heredocs to create, `sed` to edit, `cat`/`ls`/`grep` to inspect), plus **anti-confabulation** ("you've run nothing yet — never claim commands return no output; your FIRST output is a ` ```bash ` block"). This framing is what made it work through real pi (hypotheses §9 F14).
- "**Never claim success** (`✅`/`SUCCESS`/`Done`) unless a `<tool_response>` proving it already appears above" — M365 loves to declare victory before the build runs.
- "When you do give the final answer, **no preamble/sign-off**".

### 2. Copilot Studio Agent System Prompt (packages/core/src/agent.ts)

The most important layer: an auto-created Copilot Studio agent carries tool-calling
instructions in its **server-side** system prompt. Without the agent, M365 ignores the
per-request injection and answers in prose (or hallucinates). See
[m365-copilot-api.md](./m365-copilot-api.md) for why.

These instructions are baked in at agent-creation time and can't be cheaply updated in
place, so the agent is **versioned by name**: it's called `m365-tool-agent-<hash>`, where
`<hash>` is a short SHA-256 of the current instructions. Editing `getAgentInstructions()`
changes the hash, so the next request provisions a fresh agent; old versions are **never
deleted** (multi-host safety — a second proxy may still be using one). Hosts sharing a tenant
compute the same name for the same instructions and converge on one agent with no coordination.

### 3. Behaviour-hardening layer (packages/proxy-lib/src/handler.ts, tools.ts)

The model's output is scrubbed and steered at the proxy regardless of whether it obeyed
the prompt — the durable lever, since M365's chat-RLHF leaks through no matter how the
prompt is tuned. The layers, in handler order:

- **Document guard** (`isProseDocument`): shell-routing turns *every* ` ```bash ` block into
  a tool call — so a model that ANSWERS with a markdown document full of code fences (e.g.
  "here's a simplified README") would get its own answer executed as shell. A response that
  looks like a document (≥4 fences, a markdown heading, or ≥300 chars surrounding prose) is
  returned as **text**, not executed. A single action is never reclassified. (hypotheses §9 F15.)
  **Opens-with-a-call overrides it:** a reply whose first fence is a real call to one of the
  request's tools is an *action* whatever follows it — the tail was written before the result
  existed — so the preamble decides (`looksLikeDocumentPreamble`). Judged as a whole, those
  tails made 34 of 42 guard verdicts discard a correct first action upstream (#33).
- **Self-written `<tool_response>` is a stop sequence** (`truncateAtFabricatedToolResponse`):
  M365's chat models do not stop at the call, they write the fence, then invent the result and
  act on it. When a real call precedes an invented `<tool_response>`/`<tool_result>`, only the
  head is parsed — otherwise the invented tail makes the turn look like a document and the
  guard throws the real action away (#31).
- **Partly-executed replies are corrected, not retried:** M365 keeps the WHOLE reply in its
  server-side history, so after a cut, a dropped batch, or a speculative tail the model
  believes its own fiction and reads the real result as stale. The turn that carries the real
  tool result opens with a one-line `executedOnlyFirstNote()` saying exactly what ran.
  Upstream: 9 of 56 Sonnet bench runs ended believing the invented tail before the note, 0 of
  70 after it.
- **Explicit throttle beats every guess** (`result.value: "Throttled"`): M365 says when the
  account is rate-limited, on a turn with no content frames. Checked before the content check,
  answered 429 `m365_throttled`, never retried, fed to the degradation backoff (#35).
- **No behavioral retry (simplify-tool-path pivot):** the proxy does **not** re-prompt on
  confabulation, hallucination, or remote-artifact prose. A buffered M365 turn is translated
  once; prose that lacks a tool call stays prose. Execution intent and retry policy belong to
  the consuming harness, not the translator. `looksLikeConfabulation` /
  `looksLikeHallucinatedCompletion` / `looksLikeRemoteArtifactCompletion` and `M365_NO_CONFAB_RETRY`
  were proxy-lib code paths before the pivot and are now removed from the runtime; the
  classifiers themselves still live in `@m365-copilot/core` (`tools.ts`, re-exported from the
  core index) as general M365-fence-parsing utilities. `force-prompts.ts` was deleted outright
  (`git rm`) and is not preserved anywhere; the retry-loop behavior is gone.
- **Tool-result labelling:** each `<tool_response>` is tagged with the command that produced
  it (`<tool_response tool="bash" command="ls -la">`) by correlating `tool_call_id` back to
  the call — so the model reads output in context (a listing vs file contents vs stdout)
  instead of e.g. misreading an `ls` result as an empty file. (hypotheses §9 F16.)
- **Mixed output:** when a response has tool calls AND extra text, the text is **stripped**;
  the client gets only `tool_calls` with `content: null` (stripped text is logged).
- **Invented JSON:** `parseToolCalls()` removes `{"confidence":N}`, **drops** a `{"final":…}`
  riding alongside tool calls (premature success), and **unwraps** a lone `{"final":"…"}`.
- **One call per turn:** keeps only the **first** tool call; M365 batches its whole plan into
  one response, running later steps on guessed state. Override with `M365_ALLOW_MULTI_TOOL`.
- **Fence parsing is tolerant of how the models actually write:** array/object params accept
  inline JSON *and* an indented YAML block under an empty `key:` line (upstream lost 44 of 47
  real-pi `edit` calls to the empty-block case, #50), and a fence ended by Claude Opus's native
  `</invoke>` / `</parameter>` markup parses whether or not the closing ``` follows.
- **Empty ≠ rate limit:** an empty reply is treated as throttling only when the throttle is
  **at-limit**; otherwise it fails fast after a couple of quick retries. Repeated empties
  across **distinct conversations** (the thread-rate-throttle signature) trigger **degradation
  backoff** — the proxy paces subsequent turns so the account self-heals. This replaced the
  old auto-reauth: a fresh login does **not** clear this throttle (`oid`-keyed — hypotheses
  §11 H-R1) and raised our detection profile. `M365_NO_BACKOFF` to disable.

> The JSON tool format and the few-shot block were **removed** this cycle (0/5 on real
> agentic tasks). Tool calling is fenced-only; behavioural framing lives in the per-request
> `<tools>` block, not a baked-in few-shot.
