# AGENTS.md

Guidance for agents (and humans) working in `m365-copilot-proxy`.

## What this is

A reverse-engineered, **OpenAI-compatible proxy** over Microsoft 365 Copilot's
undocumented SignalR/WebSocket API, so OpenAI-compatible coding agents (pi,
Codex, the bench) can use M365 as a model backend. It is not a normal SDK
wrapper: it targets a live, undocumented, throttled API.

- Protocol source of truth: [`docs/m365-copilot-api.md`](docs/m365-copilot-api.md).
  Read it before touching protocol code, and keep it in sync.
- Vocabulary and locked decisions: [`CONTEXT.md`](CONTEXT.md). Use its terms
  (`thread`, `tone`, `Disengaged`, `fenced format`, `shell-routing`, …); do not
  drift to synonyms.

## Operating principles

1. **Sequential.** One M365 thread at a time. Throttle tracks conversations
   *started*, not messages (F13), and masquerades as `Disengaged`. Never fire
   concurrent or back-to-back fresh threads. A real pi session (one long
   thread) is cheap; a new thread per experiment is what burns the budget.
2. **Scientific.** Hypothesize → predict → test → conclude. Log each result in
   [`docs/hypotheses.md`](docs/hypotheses.md) with sample size and an evidence
   pointer. n=1 is noise — confirm winners with `--repeat`.
3. **Empirical.** Runnable experiments are in
   [`docs/experiments.md`](docs/experiments.md); one-off probes live in
   `scripts/`; the objective score is `scripts/bench/`. Prompting levers are in
   [`docs/prompt-engineering.md`](docs/prompt-engineering.md).
4. **End goal: a usable agent in pi, Codex, or standalone.** A finding that
   does not move that needle is a footnote, not a win.

## Hard-won gotchas

- **Tool calling is prompt-emulated and fenced.** The model writes a
  ```` ```bash ```` (or ```` ```powershell ````) block; the proxy routes it to a
  harness tool whose name matches. One call per turn. The JSON `{"tool":...}`
  format is dead (scored 0/5, removed).
- **Shell-routing needs a shell tool in the request's `tools` array.** No
  matching tool → `hasToolCalls=false` and the fence is dropped.
- **Keep injected toolsets lean.** M365 disengages on large tool payloads.
- **`Disengaged` is jailbreak *shape*, not size (F10).** Leaner/softer prompts
  trip it less than heavier ones. Watch `usage.x_m365_dea_score` — clean tool
  calls ~1e-8, prose ~1e-6, jailbreak-shaped ~1e-3.
- **Throttle ≠ Disengaged.** An empty reply with **no** `messageType:
  "Disengaged"` frame is thread-rate throttle (F13); a fresh login does not
  clear it (it is `oid`-keyed). The proxy paces turns via degradation backoff.
- **Native tool-calling is permanently out of scope.** MCP / a full Dataverse
  bot needs a Copilot Studio license, which breaks the zero-cost premise.

## Layout

| Package | Role |
|---|---|
| `@m365-copilot/core` | auth (MSAL + Playwright), WebSocket client, sessions, agent mgmt, tool formatting, schemas, the `ModelProvider` seam |
| `@m365-copilot/proxy-lib` | OpenAI↔backend translation, `SessionPool`, handler, tool-call parsing |
| `@m365-copilot/chatgpt-web` | opt-in browser-driven ChatGPT backend (`PROVIDER=chatgpt-web`) |
| `@m365-copilot/proxy` | standalone Nitro service / `m365-proxy` binary |
| `@m365-copilot/openclaw-plugin` | private, not published (disabled OpenClaw tombstone) |

## Fork policy

This repo is a declared-ownership fork. `.gitattributes` (`merge=ours`) marks the
paths this fork owns, and `docs/upstream-manifest.json` records how each upstream
commit was absorbed; `bun scripts/upstream-absorb.mjs` lists what still needs
review.

## Build & test

```sh
bun install
bun run build        # tsdown, all packages (tests import from dist/, so build first)
bun run test:unit    # build + vitest. Use THIS, not bare `bun test` (Bun's runner cannot run this suite)
bun run typecheck    # tsc --noEmit per package (tsdown does not typecheck)
```

`bun run lint` (`oxlint packages`) is a CI gate: the vendored anti-slop plugin
must stay at zero findings in the code this fork owns
(`tools/oxlint/anti-slop/UPSTREAM.md`).

Conventions: ESM with `.js`-suffixed relative imports; Zod at boundaries;
`createLogger` (not `console.log`) in library code; Conventional Commits
(`fix:`, `feat:`, `docs:`, `chore:`, `build:`), no `Co-Authored-By`.

## Running against real M365

- Run with Bun: `bun run build && bun packages/proxy/bin/m365-proxy.mjs`. Set
  `CHROMIUM_PATH` only when the bundled Playwright browser is unavailable.
- Auth uses `~/.config/opencode-m365/msal-cache.json`. If it is missing or
  expired, run `bun packages/proxy/bin/m365-login.mjs` interactively and finish
  Microsoft's password/MFA flow in the browser.
- Set `M365_DEBUG=1` to log to `~/.config/opencode-m365/debug.log`. Mind the
  quota (~600 messages per conversation, plus account-level throttle).

## Queued work

Tickets live in `.scratch/<feature>/issues/` (one file each, with `Status:` and
`Blocked by:` lines); the feature spec is `.scratch/<feature>/spec.md`. The
tracker is a local working aid: `.scratch/` is gitignored and deliberately not
published. Claim the earliest unblocked ticket.
