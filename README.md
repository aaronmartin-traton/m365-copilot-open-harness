# M365 Copilot Open Harness

An OpenAI-compatible HTTP proxy that wraps Microsoft 365 Copilot's undocumented
SignalR/WebSocket API, so OpenAI-compatible coding agents (Pi-Bolt, Codex, and other
`openai-completions` clients) can use an M365 Copilot subscription as a model
backend.

It is a reverse-engineering project, not a normal SDK wrapper. It drives a live,
undocumented, throttled API that Microsoft can change or cut off without notice.
There is no API key and no support contract: you sign in with your own Microsoft
account, and Microsoft's own rate limits and safety filters apply to everything
the proxy sends.

The protocol details we reverse-engineered are written down in
[`docs/m365-copilot-api.md`](docs/m365-copilot-api.md); the vocabulary and locked
decisions are in [`CONTEXT.md`](CONTEXT.md).

## What it is and what it is not

- It is a **translation layer**: OpenAI in, OpenAI out. It maps `chat/completions`,
  `responses`, `models`, and `images/generations` onto M365 Copilot turns.
- It is **not** the public Azure OpenAI API. It talks to the consumer "BizChat" /
  Office-web Copilot over a WebSocket, using a token it obtains by driving a real
  browser through Microsoft's sign-in.
- It is **not** officially supported or sanctioned by Microsoft. Because the API is
  undocumented and guarded, the proxy can be **throttled** or **disengaged** at any
  time (see [Known limitations](#known-limitations)).
- Tool calling is **prompt-emulated**, not native. M365 has no OpenAI tool-calling
  protocol; the proxy prompts the model into emitting fenced code blocks and parses
  those back into OpenAI `tool_calls` (see [Tool calling](#tool-calling)).

## Requirements

- **Bun** `1.4.0` (pinned by `packageManager` in the root `package.json`; CI uses
  `oven-sh/setup-bun` with `bun-version: 1.4.0`).
- **A Chromium or Microsoft Edge executable for sign-in.** Sign-in drives a visible
  browser over the Chrome DevTools Protocol; there is no bundled browser any more.
  Point `CHROMIUM_PATH` at an existing Chromium/Edge executable, or let the proxy find
  one in the usual Edge/Chrome/Chromium install locations and on `PATH`.
- **Playwright is only for the deprecated ChatGPT Web lane** (`PROVIDER=chatgpt-web`),
  the sole remaining Playwright user. The `openai` and `m365` lanes need no Playwright.
- **No browser at all for the `openai` lane.** Neither does a local one: point
  `OPENAI_BASE_URL` at LM Studio, llama.cpp, vLLM or Ollama's OpenAI shim and the
  proxy drives it unchanged.
- **A Microsoft 365 account with Copilot** that can complete interactive sign-in
  (password plus MFA in the browser window) — for the default `m365` lane only.
  For `PROVIDER=openai` you need an OpenAI API key instead, or nothing at all if
  you point `OPENAI_BASE_URL` at a local server.
- No `engines` field is declared in any package; the runtime is Bun (the launcher
  and login scripts carry a `#!/usr/bin/env bun` shebang).

## Install and run

The short version — one command installs, builds, checks what you are missing and
signs you in:

```sh
bun run setup          # install -> build -> prerequisites -> browser sign-in
bun run proxy          # start on http://127.0.0.1:4141
```

`bun run doctor` runs only the checks (safe, read-only, never opens a browser) if
you want to see what is missing before committing to a sign-in.

Driving it by hand instead:

```sh
bun install
bun run build                                   # builds every package with tsdown/Nitro
bun packages/proxy/bin/m365-proxy.mjs           # starts the proxy on http://127.0.0.1:4141
```

The launcher takes an optional port argument (`bun packages/proxy/bin/m365-proxy.mjs 8080`),
falling back to `$PORT`, then `4141`. The server binds `$HOST` (default `127.0.0.1`).
`bun run proxy` is a shortcut for the same launcher.

Drive that proxy from a second terminal with the console, which runs Pi-Bolt against
it (see [Web console](#web-console)). `bun run proxy` remains a separate long-running
process to start by hand:

```sh
bun run web
```

**Keep `HOST` on loopback.** The proxy has no authentication unless `M365_API_KEY` is
set, so binding it to a network address lets anyone who can reach the port spend the
signed-in account's quota and drive any tool the client offers. When the bound host is
not loopback the server logs a prominent warning at startup.

At startup the server authenticates once (`packages/proxy/plugins/auth.ts`): if the
token cannot be obtained, boot aborts rather than serving a half-broken process.

Point any OpenAI-compatible client at the base URL `http://127.0.0.1:4141/v1`. By
default there is **no API key check** — any non-empty `apiKey` value (for example
`dummy`) is accepted; the `Authorization` header is allowed by CORS but never
validated. Set `M365_API_KEY` to require a key on every `/v1/*` request (see
[Server authentication](#server-authentication--packagesproxyapi-keyts-packagesproxymiddlewareapi-keyts)).
Choose a model id from `GET /v1/models` (see [Models](#models)).

```sh
curl -s http://127.0.0.1:4141/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"m365-copilot","messages":[{"role":"user","content":"Say hello."}]}'
```

For tool-enabled clients, put the tools in the request's `tools` array — the proxy
routes the model's fenced blocks back to whichever tool names match (see
[Tool calling](#tool-calling)).

Other root scripts:

| Command | What it does |
|---|---|
| `bun run dev` | Nitro dev server on port 4141 (`nitro dev`) |
| `bun run proxy` | Starts the standalone M365 proxy on `127.0.0.1:4141` |
| `bun run build` | Builds all packages (`core`, `chatgpt-web`, `proxy-lib`, `harness`, `proxy`, `openclaw-plugin`) |
| `bun run build:libs` | Builds only the library packages the tests import from `dist/` |
| `bun run web` / `bun run web:dev` | Starts the Bun console on `127.0.0.1:4173` (plain, or with `--watch`) |
| `bun run harness:config` | Writes the `m365-copilot` provider into `~/.pi/agent/models.json` |
| `bun run test:unit` | Builds the libraries, then runs Vitest on the Bun runtime |
| `bun run test:e2e` | Same, restricted to the end-to-end suites in `packages/harness` and `apps/web` |
| `bun run test:live` | Same as `test:unit`, with `M365_LIVE=1` (hits the real API) |
| `bun run setup` / `bun run doctor` | Install + build + check prerequisites (+ sign in, + the M365 provider entry) |
| `bun run typecheck` | `tsc --noEmit` for `core`, `chatgpt-web`, `proxy-lib`, `harness`, `web`, `proxy` |
| `bun run lint` | `oxlint packages apps` (the anti-slop gate) |

## Web console

`apps/web` is a Bun HTTP + WebSocket console that runs the agent for you: it spawns
one `pi-bolt --mode rpc --no-session` process per session and streams that process's
JSONL events to the browser, so a turn arrives as it is produced rather than at the
end.

```sh
bun run web            # console on http://127.0.0.1:4173
```

`packages/harness` holds what the console and any other host share:
`resolvePiBoltBinary()` (explicit path, then `PI_BOLT_BIN`, then `pi-bolt` on `PATH`),
`PiBoltSupervisor` (process, framing and event mapping), and
`writeM365ProviderConfig()` (the `m365-copilot` provider entry in
`~/.pi/agent/models.json`, merged so every other provider survives). Pi-Bolt is the
only agent this project drives, and `install.ps1` installs it.

On Windows, `install.ps1` does the whole setup in one step — Bun, Pi-Bolt,
dependencies, build, and the M365 provider entry:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1 -CheckOnly   # report only
```

Notes carried over from the pi-gui fork — the desktop shell, and the
`PI_GUI_M365_PROXY_URL` bridge that points it at this proxy — are under
[`docs/pi-gui/`](docs/pi-gui/).

## Sign in

Authentication uses OAuth 2.0 authorization-code with PKCE against Microsoft's
`nativeclient` redirect, driven through a visible browser over the Chrome DevTools
Protocol. There is no MSAL and no Playwright: the proxy catches the authorization
code the sign-in page hands back and exchanges it with a plain token request. Your
password and MFA response are entered **only on Microsoft's sign-in page** — the
proxy never sees them.

```sh
bun packages/proxy/bin/m365-login.mjs
```

The login script authorises three scope sets in turn (Microsoft 365 Copilot, Power
Platform environment discovery, and Copilot Studio agent management) and saves the
tokens to the local token cache. After that you can start the proxy without a
`secrets.json` file. If the cache is missing or expired, run the login script again
and finish Microsoft's password/MFA flow in the browser window.

Token and browser state live under `~/.config/opencode-m365/`:

- `token-cache.json` — one refresh token plus per-scope access tokens, written mode
  `0600`. The refresh token rotates on every refresh.
- `browser-profile-cdp` — the persistent browser profile used for sign-in (and web
  conversation deletion); Microsoft's session cookies live here, so a repeat sign-in
  completes without asking again.

## Environment variables

Every variable below is read from the process environment. Defaults are the values
in the code when the variable is unset. Most of these are tuning knobs; the ones you
are likely to need are `PROVIDER`, `PORT`/`HOST`, `M365_API_KEY`, `CHROMIUM_PATH`, `M365_DEBUG`, and
the `M365_BACKOFF_*` family.

### Backend selection — `packages/proxy-lib/src/backends.ts`

| Variable | Default | Effect |
|---|---|---|
| `PROVIDER` | `m365` | Selects the backend: `m365` (the SignalR/WebSocket lane), `openai` (the OpenAI API, or any local OpenAI-compatible server), or `chatgpt-web` (**deprecated**). Any other value throws rather than silently falling back. |

### OpenAI and local-model lanes — `packages/core/src/openai.ts`

| Variable | Default | Effect |
|---|---|---|
| `OPENAI_API_KEY` | unset | The API key. Required against `api.openai.com`; a self-hosted endpoint may need none. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible `/v1` root — `http://localhost:1234/v1` for LM Studio, or a llama.cpp / vLLM / Ollama OpenAI shim. |
| `OPENAI_MODELS` | built-in list | Comma-separated ids to advertise on `/v1/models`. `bun run doctor` prints what the server actually serves. |
| `OPENAI_CONTEXT_WINDOW` | `1050000` | Context window advertised to harnesses. |
| `OPENAI_MAX_OUTPUT_TOKENS` | `1050000` | Output ceiling advertised to harnesses. |

### Server and launcher — `packages/proxy/bin/m365-proxy.mjs`

| Variable | Default | Effect |
|---|---|---|
| `PORT` | `4141` | Port when no CLI argument is given. The launcher copies it into `NITRO_PORT`. |
| `HOST` | `127.0.0.1` | Bind address; copied into `NITRO_HOST`. Keep it on loopback: the proxy has no authentication unless `M365_API_KEY` is set, and it warns at startup when the bound host is not loopback. |

### Server authentication — `packages/proxy/api-key.ts`, `packages/proxy/middleware/api-key.ts`

| Variable | Default | Effect |
|---|---|---|
| `M365_API_KEY` | unset (off) | When set, every `/v1/*` request must carry it as `Authorization: Bearer <key>` or `x-api-key: <key>`; a missing or wrong key returns `401` with an OpenAI-shaped error body. Unset, no key is required — the proxy must stay on loopback. |

### Auth and browser — `packages/core/src/auth.ts`, `packages/core/src/web-conversations.ts`

| Variable | Default | Effect |
|---|---|---|
| `M365_CACHE_FILE` | `~/.config/opencode-m365/token-cache.json` | Token cache location: one refresh token plus per-scope access tokens. |
| `M365_BROWSER_PROFILE` | `~/.config/opencode-m365/browser-profile-cdp` | Persistent browser profile for sign-in and web conversation deletion (driven over CDP). |
| `M365_ENABLE_INTERACTIVE_APPROVAL` | off | Set to `1` to allow prompting for interactive approval during auth. |
| `M365_NO_INTERACTIVE` | off | Set to `1` to forbid interactive prompts (for example in CI). |
| `CHROMIUM_PATH` | unset | Executable path for the sign-in and web-conversation browser. Set only when no Chromium/Edge is found automatically. |
| `M365_WEB_HEADLESS` | headless (anything except `0`) | Set to `0` to force a headed browser for web conversation deletion. |

### Logging and frame capture — `packages/core/src/log.ts`, `packages/core/src/session.ts`

| Variable | Default | Effect |
|---|---|---|
| `M365_DEBUG` | off | Enable debug logging. |
| `M365_TRACE` | off | Implies debug logging and disables payload truncation (full WS frames, prompts, responses). |
| `M365_LOG_STDOUT` | off | Also write log lines to stdout. |
| `M365_LOG_FILE` | `debug.log` | Log file name, resolved relative to `~/.config/opencode-m365/` (absolute paths used as-is). |
| `M365_FRAME_DIR` | `frames` | Directory for dumped frames, resolved relative to `~/.config/opencode-m365/`. |
| `M365_DUMP_FRAMES` | off | Write one `<requestId>.ndjson` per turn into `M365_FRAME_DIR`. |

### Sessions and conversations — `packages/proxy-lib/src/session-pool.ts`, `session-store.ts`, `packages/proxy/server-pool.ts`, `packages/core/src/session.ts`

| Variable | Default | Effect |
|---|---|---|
| `M365_SESSION_STATE_FILE` | `~/.config/opencode-m365/session-state.json` | Where conversation continuity is persisted across restarts. |
| `M365_SESSION_MEMORY_TTL_MS` | `1800000` (30 min) | Idle in-memory session TTL. |
| `M365_WEB_PRUNE_PROVEN` | unset (**reaper enabled**) | Set to `0` to disable automatic deletion of idle M365 threads. The Nitro route also runs the reaper on every `/health`, and a timer runs it every minute. |
| `M365_SESSION_TTL_MINUTES` | `10080` (7 days) | How long a thread may sit idle before it is deleted upstream. `0` disables reaping. Deletion is one-way. |
| `M365_PRUNE_TOKEN` | unset | Bearer token required by `POST /v1/conversations/prune`; while unset, that route returns `404`. |
| `M365_TEMPORARY_CHAT` | off | Set to `1` to send `disableMemory=1` (temporary chat, no server-side memory). |

### Request scheduler — `packages/proxy-lib/src/scheduler.ts`

| Variable | Default | Effect |
|---|---|---|
| `M365_MAX_UPSTREAM_CONCURRENCY` | `1` | Maximum concurrent M365 turns. |
| `M365_MAX_QUEUE_LENGTH` | `8` | Queue depth before new work is rejected with `429` (`m365_queue_full`). |
| `M365_NEW_THREADS_PER_MINUTE` | `2` | Token-bucket refill rate for *new* conversations. |
| `M365_NEW_THREAD_BURST` | `1` | Burst size for new conversations. |

### Throttle handling, backoff and telemetry — `packages/core/src/auth-recovery.ts`, `throttle-telemetry.ts`

| Variable | Default | Effect |
|---|---|---|
| `M365_NO_BACKOFF` | off | Disable degradation backoff (legacy alias `M365_NO_AUTO_REAUTH` also disables it). |
| `M365_BACKOFF_STATE_FILE` | `~/.config/opencode-m365/backoff-state.json` | Where backoff state is persisted. |
| `M365_BACKOFF_WINDOW_MS` | `120000` | Sliding window for counting empty conversations. |
| `M365_BACKOFF_THRESHOLD` | `3` (alias `M365_REAUTH_EMPTY_THRESHOLD`) | Distinct empty conversations within the window that trigger backoff. |
| `M365_BACKOFF_BASE_MS` | `90000` | Base cooldown. |
| `M365_BACKOFF_MAX_MS` | `600000` | Maximum cooldown. |
| `M365_NO_TELEMETRY` | off | Set to `1` to stop writing the throttle telemetry file (events are still counted for `/health`). |
| `M365_THROTTLE_TELEMETRY_FILE` | `~/.config/opencode-m365/throttle-telemetry.ndjson` | Throttle telemetry destination. |

### Models and output — `packages/proxy-lib/src/backends.ts`, `output-ceiling.ts`

| Variable | Default | Effect |
|---|---|---|
| `M365_CONTEXT_WINDOW` | `1000000` | Advertised context window on `GET /v1/models`. |
| `M365_MAX_OUTPUT_TOKENS` | `1000000` | Advertised output ceiling for the M365 backend. |
| `CHATGPT_WEB_MAX_OUTPUT_TOKENS` | `1000000` | Advertised output ceiling for the ChatGPT Web backend. |
| `M365_TOOL_MODEL` | unset | Model id to route tool-enabled turns to; also surfaced on `/health`. |
| `M365_OUTPUT_CHAR_CEILING` | `12000` | Character count at which a reply is flagged `finish_reason: "length"`. |

### Tool calling — `packages/proxy-lib/src/tool-path.ts`, `tool-repair.ts`, `intent-verifier.ts`, `packages/core/src/tools.ts`, `model.ts`, `session.ts`, `fenced.ts`

| Variable | Default | Effect |
|---|---|---|
| `M365_ALLOW_MULTI_TOOL` | off | Allow more than one tool call per turn (default keeps only the first). |
| `M365_STEERING` | off | Set to `1` to enable steering when a turn has tool calls. |
| `M365_INJECT_REPLY_TOOL` | off | Inject a `reply` tool so prose answers also come back as tool calls (also enabled by the `reply_tool` framing variant). |
| `M365_TOOL_RESULT_MAX_CHARS` | `12000` | Truncation bound for a tool result fed back to the model. |
| `M365_FRAMING_VARIANT` | `baseline` | Active prompt-framing variant (`baseline`, `softened`, `reply_tool`, …). |
| `M365_FRAMING_FILE` | unset | Control file whose first line names the framing variant (overrides `M365_FRAMING_VARIANT` per request). |
| `M365_FORCE_AGENT` | off | Set to `1` to always attach the Copilot Studio tool agent, even on Claude tones. |
| `M365_NO_DISENGAGE_RETRY` | off | Disable the single softened-framing retry in a fresh conversation after a `Disengaged`. |
| `M365_NO_IMAGE_GEN` | off | Disable image generation on the agent-less path. |
| `M365_NO_CODE_INTERPRETER` | off | Disable the hosted code-interpreter options on the agent-less path. |
| `M365_EXTRA_OPTIONSSETS` | unset | Comma-separated extra `optionsSets` entries merged into every chat payload. |
| `M365_AGENT_FAILURE_TTL_MS` | `3600000` (1 h) | How long an agent-endpoint failure suppresses agent creation. |
| `M365_TOOL_REPAIR` | off | Set to `1` to enable the local tool-call repair model. |
| `M365_TOOL_REPAIR_ENDPOINT` | `http://127.0.0.1:1234/v1/chat/completions` | Repair model endpoint. |
| `M365_TOOL_REPAIR_MODEL` | `watt-tool-8b` | Repair model id. |
| `M365_TOOL_REPAIR_TIMEOUT_MS` | `30000` | Repair request timeout. |
| `M365_TOOL_REPAIR_MAX_TOKENS` | `1024` | Repair response token cap. |
| `M365_INTENT_VERIFIER` | on (disabled only by `0`) | Execution-intent verifier gate. Anything other than `0` keeps it enabled. |
| `M365_INTENT_VERIFIER_ENDPOINT` | `http://127.0.0.1:1234/v1/chat/completions` | Verifier endpoint override. |
| `M365_INTENT_VERIFIER_MODEL` | `bonsai-27b-q1` | Verifier model override. |
| `M365_INTENT_VERIFIER_TIMEOUT_MS` | `120000` | Verifier request timeout. |
| `M365_INTENT_VERIFIER_MAX_TOKENS` | `2048` | Verifier response token cap. |
| `M365_INTENT_VERIFIER_RETRY_BACKOFF_MS` | `15000` | Verifier retry backoff. |
| `M365_INTENT_VERIFIER_TEMPLATE_KWARGS` | unset | JSON template kwargs forwarded to the verifier. |

### Client attestation — `packages/proxy-lib/src/attestation.ts`

| Variable | Default | Effect |
|---|---|---|
| `M365_CLIENT_ATTESTATION` | off | Set to `1` to enable the loopback client-attestation gate. |
| `M365_ATTESTATION_SECRET` | unset | Shared secret for the attestation gate (required when the gate is on). |

### Images — `packages/proxy-lib/src/images.ts`

| Variable | Default | Effect |
|---|---|---|
| `M365_IMAGE_MAX_BYTES` | `20971520` (20 MiB) | Maximum accepted input image size. |

### Windows shell routing — `packages/core/src/fenced.ts`

| Variable | Default | Effect |
|---|---|---|
| `M365_LOCAL_SHELL` | `git-bash` | Shell backend on Windows: `git-bash` or `wsl`. |
| `M365_GIT_BASH_PATH` | `%ProgramFiles%\Git\bin\bash.exe` | Git Bash executable path. |

### ChatGPT Web lane (**deprecated**) — `packages/chatgpt-web/src/browser.ts`

> **Deprecated: superseded by `PROVIDER=openai`.** This lane drives a personal
> chatgpt.com session, which cannot honour the requested `model` — the site's own
> picker decides what answers, so the slug is metadata only. It is kept working so
> existing deployments do not break on upgrade, and will be removed. Use
> `PROVIDER=openai` (including against a local server) for a lane where `model`
> really selects the model.

| Variable | Default | Effect |
|---|---|---|
| `CHATGPT_WEB_PROFILE` | `~/.config/opencode-m365/chatgpt-web-profile` | Dedicated browser profile for the ChatGPT Web lane (never your own browsing profile). |
| `CHATGPT_WEB_HEADLESS` | off (headed) | Set to `1` for headless. The lane is headed by default because Cloudflare blocks headless Chromium. |

### Developer and experiment knobs

These exist for the reverse-engineering workflow and are not needed to run the proxy
normally: `M365_STEERING_FILE`, `M365_STEERING_LIVE`, `M365_REPO_ROOT`, `M365_NODE_BIN`
(`packages/core/src/steering.ts`); `M365_COWORK_RUNTIME_HOST`,
`M365_COWORK_TROUTER_HOST`, `M365_COWORK_TIMEOUT_MS` (`packages/core/src/cowork.ts`).

## HTTP surface

### Standalone server (`packages/proxy/routes/`, Nitro)

| Method and path | Handler | Notes |
|---|---|---|
| `GET /health` | `routes/health.get.ts` | Runs the reaper, then returns the health payload. |
| `GET /v1/models` | `routes/v1/models.get.ts` | OpenAI-compatible model list. |
| `POST /v1/chat/completions` | `routes/v1/chat/completions.post.ts` | Chat, streaming (SSE) or not. |
| `POST /v1/responses` | `routes/v1/responses.post.ts` | OpenAI Responses API shape. |
| `POST /v1/images/generations` | `routes/v1/images/generations.post.ts` | M365 image generation. |
| `POST /v1/attestations` | `routes/v1/attestations.post.ts` | Loopback-only control endpoint for client-attested execution; returns `404` to non-loopback peers or when the gate is off. |
| `POST /v1/conversations/prune` | `routes/v1/conversations/prune.post.ts` | Requires `Authorization: Bearer $M365_PRUNE_TOKEN`; returns `404` while `M365_PRUNE_TOKEN` is unset, `401` on a bad token. |

CORS is permissive on every route (`origin: "*"`, all methods and headers;
`packages/proxy/middleware/cors.ts`). A client may pin a conversation with the
`X-M365-Session-Key` header, which the handler forwards as the session key.

### Embeddable handler (`packages/proxy-lib/src/index.ts`, `createApp()`)

`createApp()` returns a framework-free `fetch` handler that serves a subset of the
same API for tests and shell-capable clients:

- `OPTIONS *` → `204` with CORS headers
- `GET /health` → the same health payload (without the reaper block)
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- anything else → `404` `{"error":{"message":"Not found","type":"invalid_request_error"}}`

It does **not** serve `/v1/images/generations`, `/v1/attestations`, or
`/v1/conversations/prune`.

### Health payload

`GET /health` returns `status: "ok"` plus diagnostics
(`buildHealthPayload` in `packages/proxy-lib/src/index.ts`):

```json
{
  "backend": "m365",
  "status": "ok",
  "activeSessions": 0,
  "persistedSessions": 0,
  "scheduler": {
    "active": 0, "queued": 0, "completed": 0, "rejected": 0,
    "averageWaitMs": 0, "maxConcurrency": 1, "maxQueueLength": 8,
    "newThreadsPerMinute": 2, "newThreadBurst": 1
  },
  "reaper": { "lastRunAt": null, "pruned": 0, "failed": 0, "disabled": true },
  "backoff": {
    "active": false, "until": null, "level": 0,
    "recentEmptyConversations": 0, "telemetry": {}
  },
  "temporaryChat": false,
  "toolModel": null,
  "agent": { "available": true, "retryAt": null, "reason": null }
}
```

`activeSessions`, `persistedSessions` and `scheduler` are present when a session pool
is supplied (the Nitro server always supplies one); `reaper` is present on the Nitro
route only.

### Models

`GET /v1/models` lists the model ids in `MODEL_TONES`
(`packages/core/src/copilot.ts`), for example `m365-copilot`, `auto`, `quick`,
`think-deeper`, `claude-sonnet`, and the `gpt-5.x*` family. Each entry carries
non-standard `context_window`, `max_context_length`, `max_input_tokens` and
`max_output_tokens` keys that OpenAI-compatible harnesses read. `owned_by` is
`microsoft` on the M365 lane and `chatgpt-web` on the browser lane.

## Tool calling

M365 has no native tool-calling protocol, so the proxy **emulates** one and enforces
it at the proxy layer. The full contract is in
[`docs/tool-calling.md`](docs/tool-calling.md); the short version:

- The model emits a tool call as a **Markdown code fence** whose info-string is the
  tool name (for example ` ```bash `), with scalar arguments as `key: value` header
  lines and one free-form argument as the fence body. The old JSON `{"tool":...}`
  format was removed (it scored 0/5 on real agentic tasks).
- **Shell-routing** is the load-bearing trick: when the request's `tools` array
  contains a shell tool (`bash`, `shell`, `run`, `run_command`, …), the proxy injects
  framing that routes a ` ```bash ` block to that tool. **No matching tool in the
  request means no tool call** — the fence is dropped.
- **One call per turn.** The proxy keeps only the first tool call, because M365
  batches its whole plan into one reply and then runs later steps on guessed state.
  Override with `M365_ALLOW_MULTI_TOOL`.
- Enforcement lives in three places: the per-request `<tools>` block
  (`packages/core/src/tools.ts`), the Copilot Studio agent's server-side system prompt
  (the auto-created, versioned `m365-tool-agent-<hash>`), and the behaviour-hardening
  in `packages/proxy-lib/src/handler.ts` (document guard, self-written
  `<tool_response>` truncation, one-call-per-turn, tool-result labelling).
- The proxy does **not** retry on confabulation or hallucination: a buffered M365 turn
  is translated once. Execution and retry policy belong to the consuming harness.

## Known limitations

- **Throttle versus `Disengaged`.** Both look like an empty reply, and they are
  different things. `Disengaged` is M365's refusal signal (`messageType:
  "Disengaged"`), driven by the *shape* of the prompt (jailbreak framing, a large tool
  block) rather than its size; it often masquerades as throttling. A thread-rate
  throttle is an empty reply with **no** `Disengaged` frame and is keyed to your
  account identity (`oid`), so a fresh login does not clear it. When the proxy sees
  repeated empties across *distinct* conversations it paces subsequent turns via
  degradation backoff so the account can self-heal. Recovery is a lull — the API doc
  observed self-healing after roughly a 15-minute idle gap. See
  [`docs/m365-copilot-api.md`](docs/m365-copilot-api.md) §7 and §9.
- **No native tool calling.** MCP or a full Dataverse bot needs a Copilot Studio
  licence, which breaks the zero-cost premise, so prompt-emulated tool calling is
  permanent. Keep toolsets lean — a full coding-agent toolset (roughly 15+ tools) can
  disengage persistently.
- **The conversation budget.** M365 caps a conversation at **600 user messages**
  (`maxNumUserMessagesInConversation`), per `ConversationId`, and retries like
  `Please continue.` count against it. The proxy therefore reuses one conversation per
  session and sends only new messages on follow-ups. Separately, sustained heavy use
  drives the account into a degraded state that makes `Disengaged` fire far more
  readily, independent of the 600 cap.
- **Output ceiling.** M365 soft-caps output around 3k tokens (~12k characters) and
  tends to conclude early rather than truncate mid-stream; replies at or above
  `M365_OUTPUT_CHAR_CEILING` are flagged `finish_reason: "length"`.
- **The ChatGPT Web lane is opt-in and ToS-constrained.** `PROVIDER=chatgpt-web` only,
  never a default, and headed because Cloudflare blocks headless Chromium. Use your own
  account; account action is a real possibility.
- **Sign-in state is a file.** Tokens are cached in `token-cache.json`. If it is
  missing or expired, requests fail until you run `m365-login` again.

## Documentation

- [`docs/m365-copilot-api.md`](docs/m365-copilot-api.md) — the protocol field notes
  (endpoint, auth, framing, throttling, the `Disengaged` filter, tool calling).
- [`docs/tool-calling.md`](docs/tool-calling.md) — the tool-calling contract.
- [`CONTEXT.md`](CONTEXT.md) — vocabulary and locked decisions.
- [`docs/experiments.md`](docs/experiments.md) — the runnable experiment catalog.

## License

MIT. This is a fork of [`cramt/m365-copilot-proxy`](https://github.com/cramt/m365-copilot-proxy);
the upstream copyright is retained in [`LICENSE`](LICENSE) alongside the fork's.
