# CONTEXT.md

Domain vocabulary for the `m365-copilot-proxy` repo. Skills and issue tickets
name concepts with these terms. Do not drift to synonyms.

## What this repo is

An OpenAI-compatible **proxy** that wraps Microsoft 365 Copilot's undocumented
SignalR/WebSocket API. OpenAI-compatible coding agents (pi, Codex, standalone
bench) can use M365 as a model backend. It is a reverse-engineering project
against a live, undocumented, throttled API. It is not a normal SDK wrapper.

## Glossary

| Term | Meaning |
|---|---|
| **M365** | Microsoft 365 Copilot (the undocumented chat backend). |
| **proxy** | This repo's OpenAI-compatible translation layer (`proxy-lib` + `proxy`). |
| **thread** | One M365 conversation. Throttle tracks threads-started, not messages. |
| **tone** | The model selector sent in the chat payload (`magic`, `*-quick`, reasoning tones). `magic` is default. |
| **Disengaged** | M365's refusal signal (`messageType: "Disengaged"`). Driven by jailbreak *shape*, not size. Often masquerades as throttle. Watch `usage.x_m365_dea_score`. |
| **fenced format** | Tool-call output as Markdown fences (```` ```bash ```` blocks). The only sanctioned tool format. |
| **shell-routing** | The proxy routes fenced bash blocks to the harness's shell tool. The load-bearing lever that produces real agent loops. |
| **fenced agent** | The Copilot Studio agent (`m365-tool-agent-<hash[:8]>`) that emits fenced tools. |
| **verifier** | The execution-intent verifier (a small local model, e.g. `Bonsai`) that decides `EXECUTE` vs `TEXT` for a tool decision. Retired from the request path in the simplify-tool-path pivot; the module is kept as a research artifact (ADR-0002). |
| **EXECUTE** | Verifier verdict: the tool call is authorized to run. |
| **TEXT** | Verifier verdict: return the model's raw text instead of executing. |
| **8H fail-closed** | The fail-closed gate policy: only verifier `EXECUTE` authorizes tool execution; anything else (TEXT/UNCERTAIN/error/timeout) resolves to raw text. Retired from the runtime in the simplify-tool-path pivot (ADR-0002). |
| **optionsSets** | The server-side capability flags array in the chat payload. The agent-less lane turns on M365's hosted code interpreter and image generation (`CODE_INTERPRETER_OPTIONS_SETS`, `IMAGE_GEN_OPTIONS_SETS`, `M365_EXTRA_OPTIONSSETS`); the agent lane sends none. |
| **benchtop** | The quantitative benchmark (`scripts/bench/`): scores real agentic coding tasks in `--network none` sandboxes. |
| **backend** | The model backend a turn runs against. Chosen by `PROVIDER`: `m365` (default) or `chatgpt-web`. |
| **provider** | A backend's implementation of `ModelProvider` (`packages/core/src/provider.ts`). Owns its own refusal vocabulary, quota shape and telemetry, and maps them onto `ProviderTurn`. `ModelSession` is the M365 one; `ChatGptWebProvider` is the ChatGPT Web one. |
| **turn** | One assistant reply from one backend. For M365 this is one WebSocket exchange; on ChatGPT Web it is one submitted composer message bound to its DOM turn. |
| **turn key** | ChatGPT Web's logical id for a rendered exchange (`data-turn-key`). Bind on this, never on a display position — virtualized history renumbers what is on screen. |
| **ChatGPT Web lane** | The opt-in browser-driven backend: headed Chromium against a signed-in chatgpt.com profile, no API key. |

## Decisions

- **Native tool-calling is permanently OUT OF SCOPE.** MCP / a full Dataverse
  bot needs a Copilot Studio license, breaking the zero-cost premise. Tool
  calling stays prompt-emulated.
- **The 8H fail-closed policy was the approved safety baseline, but it is no
  longer on the request path.** Execution-intent and authorization policy belong
  to the consuming harness; `docs/adr/ADR-0002-EXECUTION-INTENT-VERIFIER.md` is
  superseded and the frozen corpus
  (`experiments/tool-decision/execution-intent/fail-closed-policy-8h.json`) is
  kept as research evidence.
- **JSON `{"tool":...}` tool format is dead.** Fenced + shell-routing is the
  only tool format (scored 0/5, removed).
- **A second backend is behind `ModelProvider`, not a fork.** `proxy-lib` speaks
  OpenAI in and OpenAI out; the backend sits behind one interface in
  `packages/core/src/provider.ts`. Anything needing a second backend extends
  that interface rather than forking the translation layer.
- **ChatGPT Web is opt-in and ToS-constrained.** `PROVIDER=chatgpt-web` only,
  never a default route, and headed — Cloudflare blocks headless Chromium. Use
  your own account; account action is a real possibility.

## Where things live

- Backlog and live probes: `.scratch/<feature>/issues/` — a local, gitignored
  ticket tracker, not published.
- Upstream fork policy: `.gitattributes` (`merge=ours` ownership) and
  `docs/upstream-manifest.json` (the upstream-absorption record).
- Domain decisions: `docs/adr/`.
- Protocol source of truth: `docs/m365-copilot-api.md`.
- Open-questions notebook: `docs/hypotheses.md`.
- Runnable catalog: `docs/experiments.md`.
- This repo has NO separate contexts — single-context (no `CONTEXT-MAP.md`).
