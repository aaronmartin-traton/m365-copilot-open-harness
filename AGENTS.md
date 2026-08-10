# AGENTS.md

Guidance for AI agents (and humans) working in this repo.

## What this is

`m365-copilot-proxy` wraps Microsoft 365 Copilot's undocumented SignalR/WebSocket
API in an **OpenAI-compatible** interface. OpenAI-compatible coding agents
(notably [pi](https://pi.dev/)) can use it as a model backend.

**Read the protocol doc ([`docs/m365-copilot-api.md`](docs/m365-copilot-api.md))
before touching protocol code.** It is the source of truth for auth, frames,
tones, throttling, Disengaged, and agents. If you change protocol behavior,
keep it in sync.

[`docs/hypotheses.md`](docs/hypotheses.md) is the open-questions notebook.
It holds tool-call experiments, the token/context-window hunt, and the
improvement backlog. Update it when an experiment lands.

[`docs/prompt-engineering.md`](docs/prompt-engineering.md) is the distilled
reference for **prompting the Copilot model into tool-calling**. Read it before
you tinker with framing or format. It holds the levers that work, the
dead-ends, and the A/B scoreboard.

**Where findings graduate to.** `docs/hypotheses.md` is the messy, in-progress
layer. Once a finding is decently conclusive (real evidence, not n=1 noise),
promote it out of the notebook:
- Protocol or API behavior → the protocol doc.
- Prompting or tool-calling strategy → `docs/prompt-engineering.md`.
Leave a one-line pointer + evidence reference in the notebook.

**Domain vocabulary:** [`CONTEXT.md`](CONTEXT.md) defines the terms this repo
uses (`thread`, `tone`, `Disengaged`, `verifier`, `EXECUTE`, …) and the locked
decisions. Use its vocabulary in tickets, hypotheses, and docs. Do not drift
to synonyms.

**Queued work lives in tickets, not prose:** `.scratch/<feature>/issues/`
holds the issue tracker (one file per ticket, `Status:`/`Blocked by:` lines).
Start new work by claiming the earliest unblocked ticket. See
`docs/agents/issue-tracker.md` for the format and wayfinding rules.

## Operating principles (read first)

Hard-won defaults for working on this proxy.

1. **Always run sequentially. One thread at a time.** The rate limit tracks
   conversations started per unit time, not messages (F13). It surfaces as
   `Disengaged`-looking 502s that are actually throttle. Never fire concurrent
   requests. Never loop fresh conversations back-to-back. Space experiment
   runs out. Use generous cooldowns between threads. A real pi/Codex session
   is one long thread with many messages. It is cheap. Our *experiments* (a
   new thread per task) burn the thread budget and trigger the throttle.

2. **Chase all hunches. Tangents are encouraged.** The moment you think "oh,
   maybe X works like this", stop and test it. A probe that teaches something
   true is often worth more than the task it interrupted. Do not suppress an
   idea because it is off the current thread. Record what you learn in
   [`docs/hypotheses.md`](docs/hypotheses.md).

3. **The end goal is always a usable agent in pi, Codex, or standalone.**
   Every change exists to make this proxy drive a real coding loop. A clever
   protocol finding that does not move that needle is a footnote, not a win.
   Make sure that a win works through a real harness, not only the bench.

4. **Be scientific: hypothesize → predict → test → conclude.** Turn every
   "I think X" into a falsifiable hypothesis. Use the cheapest probe that
   settles it. Do not ship on a plausible inference when the live API or the
   bench can decide it. Log it with sample size + an evidence pointer.

5. **Prompt tinkering: try N *wildly different* things at once. Then let the
   data pick the direction.** Never iterate on the first idea. Generate N
   genuinely distinct strategies (N = however many real ideas you have). A/B
   them all on the bench in **one** sweep. Read the scorecard. Conclude a
   direction from the result. *Then* go deep on the winner.

**Things easy to forget:**

- **`Disengaged` is driven by jailbreak *shape*, not size (F10).** A
  "stronger", more aggressive ALL-CAPS prompt can itself trip the filter. When
  tinkering (#5), always include *leaner/softer* variants, not just heavier
  ones. The heavier prompt is often the one that disengages. Watch
  `usage.x_m365_dea_score`. It is M365's own disengagement-eligibility score.
  It rises *before* Disengaged fires. Clean tool calls give ~1e-8. Prose gives
  ~1e-6. Jailbreak-shaped gives ~1e-3.
- **n=1 is noise.** One SOLVED/Disengaged is a single sample on a stochastic,
  throttle-confounded backend. Make sure that a winner holds with `--repeat`.
  Control for order effects. Rotate strategy order across runs before you
  believe any number.
- **Native tool-calling is permanently OUT OF SCOPE.** MCP or a full Dataverse
  bot need a Copilot Studio license. The license breaks the zero-cost premise.
  Tangents (#2) are great. Do not re-open this one. It is a closed dead-end.
  Tool calling stays prompt-emulated.

## How we work — hypothesis-driven (default)

**The default mode is science.** Run each idea as a testable hypothesis. The
tools below make a probe cheap:

- **Log every hypothesis in [`docs/hypotheses.md`](docs/hypotheses.md)** with
  a falsification criterion and a probe idea. Update it when an experiment
  lands (confirmed or disproved, with sample size + evidence pointer).
- **[`docs/experiments.md`](docs/experiments.md) is the runnable catalog.**
  Each experiment is a hypothesis + exact commands + how to read the result.
  Reach for it to *run* something. Add to it when you design a new experiment.
- **Probes live in `scripts/`.** They are small, single-purpose, read-mostly.
  Reuse `scripts/_probe-chat.mjs` (one M365 turn in → structured result out. It
  supports `optionsSets` / `extraAllowed` / `plugins` / `variants` / `tone` /
  agent overrides). Copy an existing probe rather than starting from scratch.
- **Quantify with the benchmark.** `scripts/bench/` (Terminal-Bench-style)
  scores real agentic coding tasks objectively. It executes every tool call in
  a `--network none` Docker sandbox. To compare *any* lever (tool format,
  model/tone, prompt, optionsSets), run it with a `--label` and diff the
  scorecards in `scripts/bench/out/`. "Best" is a pass-rate number, not an
  opinion. See `scripts/bench/README.md`.
- Prefer empirical evidence over schema guesses. Capture what the real
  first-party client sends and receives (with Playwright). Use what the bench
  scores.

## Layout (Bun workspace, all TypeScript/ESM)

| Package | Role |
|---|---|
| `@m365-copilot/core` | auth (MSAL+Playwright), WebSocket client, sessions, agent mgmt, tool formatting, schemas |
| `@m365-copilot/proxy-lib` | OpenAI↔M365 translation: framework-free `createApp()` fetch handler, `SessionPool`, handler, tool-call parsing |
| `@m365-copilot/proxy` | standalone **Nitro** service / proxy binary (`m365-proxy`). File-based `routes/`, startup-auth `plugins/`, builds to `.output/` |
| `@m365-copilot/openclaw-plugin` | disabled, non-publishable compatibility tombstone |

`scripts/` holds RE probes + dev tools (`_probe-chat` helper, `proxy-verify`,
frame/optionsSets/tone probes, `gateway-*` captures) and **`scripts/bench/`**,
the quantitative benchmark. See the hypothesis-driven section above.

## Build & test

```sh
bun install
bun run build          # tsdown, all packages (tests import from dist/, so build first)
bun test               # = test:unit; pure unit tests, NO auth/network
bun run test:live      # M365_LIVE=1; live tests that hit real M365 (uses quota)
```

- ESM with `.js`-suffixed relative imports (tsdown/Node ESM). Keep that
  convention.
- Zod for boundary validation. No `console.log` in library code. Use
  `createLogger`.
- `vitest run` skips live tests unless `M365_LIVE=1` (see `describe.skipIf`).

## Running against real M365 (important)

- **Run directly with Bun.** Run `bun run build` and
  `bun packages/proxy/bin/m365-proxy.mjs`. Set `CHROMIUM_PATH` only when the
  host's bundled Playwright browser is unavailable.
- Auth uses `~/.config/opencode-m365/msal-cache.json`. The interactive login
  launcher populates it without storing a plaintext password or MFA seed.
- Set `M365_DEBUG=1` to log to `~/.config/opencode-m365/debug.log`. If the
  cache is missing or expired, run `bun packages/proxy/bin/m365-login.mjs`
  interactively. Complete Microsoft's password/MFA flow in the browser.
- **Mind the quota.** ~600 messages **per conversation**, plus account-level
  throttling. Do not burn it on loops. An empty response is **not**
  automatically a `Disengaged` refusal. Inspect the frame.
  `messageType:"Disengaged"` is the content filter. An empty reply with **no**
  `Disengaged` frame (`ReferencesListComplete`) is thread-rate throttle (F13).
  See the protocol doc.

## Gotchas to know before you "fix" something

- **Tool calling needs the Copilot Studio agent AND the fenced/shell format.**
  The agent alone is not enough. The old JSON `{"tool":...}` format scored 0/5
  on real agentic tasks and was **removed**. Tools are now emitted as Markdown
  fences. The load-bearing lever is **shell-routing**: M365's chat model will
  not act-as-agent, but it will write a ```` ```bash ```` block. The proxy
  routes that block to the harness's shell tool. That, plus the per-request
  shell framing (`formatFencedToolDefinitions`), produces real loops. See
  hypotheses §9.
- **Shell-routing needs a shell tool in the request's `tools` array.** The
  proxy's `findShellTool` only routes a fenced ```` ```bash ```` block to a
  tool whose name matches `bash`/`sh`/`shell`/`run` and more. A tools array with
  only `read_file` parses as `hasToolCalls=false`, and the fence is dropped
  (verified live 2026-08-09. `proxy-verify.mjs` had exactly this bug and
  aborted every `--multiturn` run until its `TOOLS` gained a `bash` entry).
  If a request emits a fence but no tool call appears, check the tools array
  first.
- **Agent-less shell-routing works without PowerPlatform, on the magic tone
  only.** `wantAgent=true` + agent unavailable (creation fails fast, cached
  via the `agent.ts` TTL backoff) yields `enableCodeInterpreter=false` +
  `agentId=null`. That is the exact state that enables hosted-shell
  interception (session.ts). The Claude tone has NO shell tool (the model
  itself enumerates `search_web`/`web_fetch`/`python_execution`/`image_gen`
  only), so Claude-tone shell-routing is structurally unavailable. Hosted
  Python runs server-side there regardless of the `cwc_code_interpreter*`
  optionsSets. Do NOT "fix" this by setting `useAgent:false`. That flips
  `enableCodeInterpreter` back on and disables interception by construction
  (hypotheses F23 corrigendum, 2026-08-09).
- **Prompt *framing* cannot flip the turn-1 reflex. Format/routing can.**
  8 per-request behavioral-prompt variants moved nothing (0 tool calls). Heavy
  anti-advise framing in the agent *backfired*. Do not try to wordsmith the
  model into acting. Route its natural ```` ```bash ````.
- **The agent is versioned by an instructions hash.** Its name is
  `m365-tool-agent-<sha256(instructions)[:8]>`. Editing
  `getAgentInstructions()` auto-provisions a fresh agent on the next request.
  Stale versions are **always left in place** (we never delete agents). This
  avoids the multi-host footgun where a host on new code deletes the agent
  another host/PC is still using mid-conversation. A few orphaned lightweight
  bots are harmless. `updateBotInstructions()` is still dead code. We re-create
  rather than update in place. See the protocol doc §10.
- **Reasoning tones do not work with the agent.** `gpt-5.x` / `*-think-deeper`
  route through the `DeepLeo` reasoning pipeline. The pipeline meta-analyzes
  the injected prompt instead of obeying it. Only the default `magic` and
  `*-quick` tones behave. The model cannot be bound to our (declarative
  `minimalBots`) agent type at all. See the protocol doc §10 *Agent types*.
- **M365 disengages on large tool payloads.** Keep injected toolsets lean.
  This is why pi works and heavy harnesses (opencode) do not. The proxy also
  enforces one tool call per turn and strips M365's invented
  `{confidence}`/`{final}` JSON (`M365_ALLOW_MULTI_TOOL` to opt out).
- **Account degradation is THREAD-rate, not message-count** (hypotheses §9
  F13). Microsoft throttles *conversations started*, not messages sent. The
  per-conversation counter resets each thread. A bench that opens one fresh
  conversation per task burns the thread budget fast. A real pi session (one
  long thread, many messages) is fine. When everything starts empty-503-ing,
  it is thread-throttle, **not** the Disengaged content filter. Make sure that
  there is no `messageType:"Disengaged"` frame. Then it is throttle. **A fresh
  login does NOT clear it.** Throttle is `oid`-keyed, so a new token lands in
  the same identity-level bucket (protocol doc §2/§7, hypotheses §11 H-R1).
  The "recovery" F13 saw was the idle time the login+restart forced. The proxy
  paces turns via degradation backoff (`M365_NO_BACKOFF` to disable) instead
  of auto-reauth.
- The `nativeclient` OAuth redirect bounces to `/common/wrongplace`. The auth
  code is scraped from the navigation request, not a settled URL.

## End-to-end verification

Make sure that the changes work end to end:

```sh
M365_DEBUG=1 bun scripts/proxy-verify.mjs --agent --multiturn
```

The changes pass when the command exits 0 after a real tool loop. A real tool
loop means the agent called a tool and used its result.

## Conventions

- Conventional Commits (`fix:`, `feat:`, `docs:`, `chore:`, `build:`). No
  `Co-Authored-By` lines.
- Small, focused files. Handle errors explicitly. Prefer immutable updates.
