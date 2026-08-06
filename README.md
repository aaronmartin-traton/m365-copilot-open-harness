# m365-copilot-proxy

Use Microsoft 365 Copilot as an LLM backend for OpenAI-compatible coding agents like [pi](https://pi.dev/) and Codex. Wraps M365 Copilot's WebSocket/SignalR API in an OpenAI-compatible interface with tool calling support.

> **Want the gory protocol details?** See [docs/m365-copilot-api.md](docs/m365-copilot-api.md) — a full write-up of M365 Copilot's undocumented WebSocket API: auth, SignalR frames, tones/models, throttling, the "Disengaged" filter, and the Copilot Studio agent trick that makes tool calling work.

## How it works

M365 Copilot uses a SignalR WebSocket protocol, not the OpenAI API. This project translates between the two:

1. **Standalone proxy** — HTTP server with `/v1/chat/completions`, `/v1/responses`, and `/v1/models` endpoints. Works with OpenAI-compatible clients including pi and Codex.
2. **OpenClaw tombstone** — Retained as a private, disabled, non-publishable compatibility package.

### Tool calling

M365 Copilot doesn't support OpenAI-style `tool_calls` natively. Instead, tools are
emulated via a **Markdown-fence format** (the JSON `{"tool":...}` format was removed —
it scored 0/5 on real agentic tasks; see [hypotheses §9](docs/hypotheses.md)):

- Tool definitions are injected into the prompt as fenced templates inside a `<tools>` block
- The model emits a fenced tool call — a code block whose info-string is the tool name
  (scalar args as `key: value` header lines, one free-form body arg as the fence body,
  `old`/`new` edits as aider-style `SEARCH/REPLACE` diffs)
- The proxy/handler parses that and converts it to OpenAI `tool_calls` format
- **Shell-routing (the key lever):** M365's chat-tuned model won't "act as an agent" on
  demand but *will* reflexively write a ```` ```bash ```` block. When the toolset includes a
  shell tool (`bash`/`shell`/`run`/`run_command`/… — any name), the proxy injects "do the
  whole step by writing one ```` ```bash ```` block" framing and routes that block to the
  shell tool. This exploits the one agentic behavior Microsoft's system prompt permits, and
  is what turns 0/5 into real multi-turn loops (verified 9-tool-call bug fix).
- **Reliability comes from the Copilot Studio agent (below) + the fenced/shell framing** —
  without the agent, M365 ignores tool instructions and answers in prose

### Agent mode

On first use, the system creates a **Copilot Studio agent** with tool-calling instructions baked into its server-side system prompt. This is done via the PowerPlatform API:

1. Discovers the environment URL via the BAP API (`api.bap.microsoft.com`)
2. Creates a bot with instructions in the Copilot Studio `minimalBots` API
3. Publishes the bot to get a `TitleId`
4. Uses the agent ID (`T_{titleId}.{botId}.gpt.default`) in WebSocket chat requests
5. Caches the agent ID in `~/.config/opencode-m365/agent-id.json`

### Conversation reuse

Each keyed client session reuses one M365 conversation (`sessionId` + `conversationId`). The WebSocket reconnects per turn while M365 keeps server-side context. This saves quota — the 600-message limit applies per conversation.

For plain multi-turn chat, clients **must** provide a stable per-thread key through `X-M365-Session-Key`, Codex `prompt_cache_key`, or `client_metadata.session_id`. Keyed mappings persist in `session-state.json`. Unkeyed first turns are deliberately isolated and are not persisted, preventing two callers with the same prompt from sharing M365 context. Unkeyed tool loops remain linked in memory through their unique tool-call IDs.

The proxy accepts concurrent HTTP requests but serializes M365 turns through a bounded process-wide queue. Continuations run before new threads. Set `M365_TEMPORARY_CHAT=1` only after validating the tenant-specific `disableMemory=1` behavior.

### Image input

Chat Completions `image_url` and Responses `input_image` accept bounded PNG, JPEG, and WebP data URLs. The proxy uploads each image through `POST /m365Copilot/UploadFile`, then sends the returned `docId` as an `ImageFile` message annotation. Remote image URLs and `file://` paths are rejected.

## Packages

```
@m365-copilot/core          — Shared: auth, WebSocket client, tool formatting, proxy server, agent management, session
├── @m365-copilot/proxy     — Standalone HTTP proxy binary
└── @m365-copilot/openclaw-plugin  — disabled, non-publishable compatibility tombstone
```

## Setup

### Prerequisites

- Bun 1.3.14+ and Bun package manager
- An M365 account with Copilot access
- A visible browser session for Microsoft OAuth
- Git for Windows when Codex/OMP will execute Bash-shaped local tool calls on Windows

### 1. Install

```sh
git clone https://github.com/cramt/m365-copilot-proxy
cd m365-copilot-proxy
bun install
bun run build
```

### 2. Authorize Microsoft OAuth

Run the interactive login before starting the proxy:

```sh
bun packages/proxy/bin/m365-login.mjs
```

Enter the password and MFA response only on Microsoft's page. The proxy stores the resulting MSAL token cache under `~/.config/opencode-m365/`; do not create a plaintext `secrets.json` containing a password or TOTP seed. Subsequent starts use silent token refresh.

### 3. Use with pi (or any OpenAI-compatible agent)

Start the loopback-only proxy:

```sh
bun packages/proxy/bin/m365-proxy.mjs 4143
```

The launcher defaults to `127.0.0.1`. Do not bind beyond loopback without adding a separate authenticated reverse proxy; this service spends the signed-in user's M365 quota and has no inbound client authentication.

Point [pi](https://pi.dev/) at it via `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "m365": {
      "baseUrl": "http://localhost:4143/v1",
      "api": "openai-completions",
      "apiKey": "m365",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "supportsUsageInStreaming": false
      },
      "models": [
        { "id": "gpt-5.5-think-deeper", "name": "M365 Copilot (GPT-5.5, recommended)" },
        { "id": "m365-copilot", "name": "M365 Copilot (Auto)" }
      ]
    }
  }
}
```

Then run pi (use `gpt-5.5-think-deeper` — the reliable tool-calling model — and keep the
toolset lean; M365 "disengages" on very large tool payloads, see
[docs/m365-copilot-api.md](docs/m365-copilot-api.md#the-disengaged-filter)):

```sh
pi --models "gpt-5.5-think-deeper" -p --tools read,list,edit,write "your task"
```

This is verified working end-to-end, including multi-tool calls and real file edits.

### 4. Use with Codex

Codex requires the Responses API. Add a profile file such as
`~/.codex/m365.config.toml`:

```toml
model = "gpt-5.6-think-deeper"
model_provider = "m365"

[model_providers.m365]
name = "M365 Copilot Proxy"
base_url = "http://127.0.0.1:4143/v1"
wire_api = "responses"
```

Then run `codex --profile m365`. On Windows, the local-shell bridge expects Git for
Windows at its default installation path so Bash-shaped M365 commands can run through
Codex's PowerShell `shell_command` tool.

Codex Desktop uses the same user-level provider table in `~/.codex/config.toml`, with M365 model/profile overrides in `~/.codex/m365.config.toml`. Codex may warn and use fallback model metadata; its private catalog schema is not the standard `/v1/models` response, so do not point `model_catalog_json` at an OpenAI model-list payload.

### 5. Use as standalone proxy

```sh

bun packages/proxy/bin/m365-proxy.mjs 4141
# development server:
bun run dev
```

Then point an OpenAI-compatible client at `http://127.0.0.1:4141/v1`. The packaged launcher binds loopback by default; the development server should also be given an explicit loopback host when used outside a disposable workstation.

## Available models

| Model ID | M365 Tone | Description |
|---|---|---|
| `gpt-5.5-think-deeper` | Gpt_5_5_Reasoning | **Recommended default for agents/tool-calling** — robust tool compliance |
| `gpt-5.5` / `gpt-5.5-quick` | Gpt_5_5_Chat | GPT-5.5 fast |
| `m365-copilot` / `auto` | magic | Auto-routing — high-variance at tool-calling (confabulates; see below) |
| `quick` | Gpt_Quick | Fast responses |
| `think-deeper` | Gpt_Reasoning | Slower, more thorough |
| `claude` / `claude-sonnet` | Claude_Sonnet | Real Anthropic Claude (agent-less path) |
| `claude-sonnet-think-deeper` | Claude_Sonnet_Reasoning | Claude reasoning |
| `gpt-5.4` / `gpt-5.4-quick` | Gpt_5_4_* | GPT-5.4 |
| `gpt-5.3` / `gpt-5.3-think-deeper` | Gpt_5_3_* | GPT-5.3 |
| `gpt-5.2` / `gpt-5.2-think-deeper` | Gpt_5_2_* | GPT-5.2 |

> ✅ **For tool calling, use `gpt-5.5-think-deeper` (the default when no model is sent).**
> The current agent + fenced/shell-routing path makes this reasoning tone robust —
> 100% compliance and solve across prompt/toolset sizes on the bench (docs/hypotheses.md
> §12.10/§12.11). The **default `m365-copilot` (magic) tone is *not* reliable** for
> tools — it confabulates ("I no longer have access to the filesystem tools") and solves
> ~0% of real tasks (§12.11); a proxy request with no `model` field already defaults to
> `gpt-5.5-think-deeper` for this reason.
>
> ⚠️ The **older** reasoning tones (`gpt-5.2`/`gpt-5.3`/`gpt-5.4` `*-think-deeper`, bare
> `think-deeper`) route through M365's `DeepLeo` pipeline, which meta-analyzes the
> injected prompt and can disengage from tools. Prefer `gpt-5.5-think-deeper`.
> See [docs/m365-copilot-api.md](docs/m365-copilot-api.md) §5/§10.

## Image generation

M365 Copilot image generation is available through the core API and plain agent-less
chat turns. `generateImage()` returns fetched artifact bytes plus base64 metadata:

```ts
import { generateImage } from "@m365-copilot/core";

const [image] = await generateImage("A minimalist teal lighthouse logo", { style: "icon" });
// image.data, image.base64, image.contentType, image.size, image.orientation
```

Supported options include `landscape`, `portrait`, or `square` orientation and
`natural`, `icon`, `story`, or `designer` style. Plain chat requests can also ask to
draw an image; the proxy embeds the artifact as a markdown data URI. Set
`M365_NO_IMAGE_GEN=1` to disable implicit image generation. Image generation has a
separate daily quota; quota failures surface as `ImageGenerationError` with
`reason: "quota_exceeded"` from the core API.

## Authentication

The auth flow uses Azure MSAL authorization-code + PKCE:

1. **Interactive authorization** — `m365-login` opens visible Chromium; credentials and MFA stay on Microsoft's page.
2. **Silent refresh** — cached OAuth tokens are refreshed from `~/.config/opencode-m365/msal-cache.json`.
3. **Fail-closed startup** — the proxy refuses to start when no usable cached token exists.

Three token scopes are acquired:
- `substrate.office.com/sydney/*` — For M365 Copilot chat
- `api.powerplatform.com/.default` — For Copilot Studio agent management
- `api.bap.microsoft.com/.default` — For environment discovery

## Environment variables

| Variable | Description |
|---|---|
| `M365_DEBUG` | Set to `1` to enable debug logging to `~/.config/opencode-m365/debug.log` (truncated payloads) |
| `M365_TRACE` | Set to `1` for full, untruncated debug logging (every WS frame/prompt/response) — implies `M365_DEBUG`. For reverse engineering. |
| `M365_DUMP_FRAMES` | Set to `1` to write every WebSocket frame (both directions) to `~/.config/opencode-m365/frames/<requestId>.ndjson`. For offline diffing of new M365 fields. |
| `M365_LOG_STDOUT` | Set to `1` with `M365_DEBUG` or `M365_TRACE` to mirror debug lines to proxy stdout. |
| `M365_ALLOW_MULTI_TOOL` | Allow the model to emit multiple tool calls per turn (default: only the first is kept) |
| `M365_INJECT_REPLY_TOOL` | Set to `1` to inject a synthetic `reply(text)` tool. Forces every turn to be a tool call, including pure-prose answers. Cleaner contract for the model, +1 tool to the prompt (watch the Disengaged threshold). Confirmed 5/5 compliance on June 9 2026 ([hypotheses §1.1](docs/hypotheses.md)). |
| `M365_NO_CONFAB_RETRY` / `M365_CONFAB_RETRIES` | M365's chat model sometimes produces prose instead of a tool call when it should act — either confabulating an inability ("I can't access the files, please paste them") **or** claiming a completion it never did ("I've replaced the README", with no tool call). By default the proxy detects both and re-prompts forcefully **in the same conversation** (`M365_CONFAB_RETRIES`, default `1`) to force a real action. Set `M365_NO_CONFAB_RETRY=1` to disable. |
| `M365_NO_BACKOFF` (alias `M365_NO_AUTO_REAUTH`) | Set to `1` to disable degradation backoff. By default, when empty/throttled responses span several **distinct conversations** in a short window (the thread-rate-throttle signature, [F13](docs/hypotheses.md)), the proxy **paces subsequent turns** (a jittered delay before starting new backend conversations) to let the account self-heal. This replaced the old auto-reauth: a fresh login does **not** clear this throttle (it's `oid`-keyed — [§11 H-R1](docs/hypotheses.md)) and raised our detection profile. A single long pi thread never trips the trigger. |
| `M365_BACKOFF_THRESHOLD` / `M365_BACKOFF_WINDOW_MS` / `M365_BACKOFF_BASE_MS` / `M365_BACKOFF_MAX_MS` | Tune backoff: distinct-conversation empties to trigger (default `3`), the window they must fall in (default `120000`), the initial pacing window (default `90000`), and its escalation cap (default `600000`). |
| `M365_MAX_UPSTREAM_CONCURRENCY` / `M365_MAX_QUEUE_LENGTH` | Bound active M365 turns and queued client requests (defaults `1` and `8`). |
| `M365_NEW_THREADS_PER_MINUTE` / `M365_NEW_THREAD_BURST` | Limit fresh M365 conversations while allowing queued continuation turns first (defaults `2` and `1`). |
| `M365_SESSION_STATE_FILE` / `M365_SESSION_TTL_MINUTES` | Override persisted client-session → M365-session mapping and TTL (default `180` minutes). |
| `M365_TEMPORARY_CHAT` | Set to `1` to request stateless/hidden M365 chat with `disableMemory=1`. |
| `M365_TOOL_MODEL` | Route tool-enabled turns through a separate model ID while preserving the requested model in the OpenAI response. |
| `M365_TOOL_RESULT_MAX_CHARS` | Bound each tool result retained in the M365 prompt (default `12000`, preserving head and tail). |
| `M365_LOCAL_SHELL` / `M365_GIT_BASH_PATH` | Select validated Windows shell backend (`git-bash`, default, or `wsl`) and override Git Bash path. |
| `M365_AGENT_FAILURE_TTL_MS` | Cache unavailable Copilot Studio provisioning to avoid repeating dead tenant calls (default one hour). |
| `M365_IMAGE_MAX_BYTES` | Maximum decoded bytes per PNG/JPEG/WebP data URL (default 20 MiB). |
| `M365_COWORK_RUNTIME_HOST` | Enables the optional `scripts/cowork-probe.mjs` Aether/Trouter experiment; must be captured for the current tenant/region. |
| `M365_BROWSER_PROFILE` | Override the dedicated interactive-login browser profile directory. |
| `M365_WEB_PRUNE_PROVEN` | Set to `1` only after the disposable authenticated-browser deletion probe passes; enables automatic remote conversation reaping. Default disabled. |
| `M365_WEB_HEADLESS` | Set to `0` for headed Edge when the tenant requires interactive browser state; default `1` for server/headless environments. |
| `M365_CACHE_FILE` | Override the MSAL token-cache location. Treat it as a credential. |
| `CHROMIUM_PATH` | Override the Chromium binary used by interactive login. |

### Usage / context-window % in responses

The OpenAI `usage` block in every chat completion response now includes M365
extension fields with the **per-conversation message quota** — the closest
proxy we have to "context-window utilisation" since M365 hides token counts:

```json
"usage": {
  "prompt_tokens": 0,
  "completion_tokens": 0,
  "total_tokens": 0,
  "x_m365_conversation_messages": 42,
  "x_m365_conversation_max": 600,
  "x_m365_conversation_pct": 7,
  "x_m365_conversation_remaining": 558,
  "x_m365_content_origin": "DeepLeo",
  "x_m365_message_type": null,
  "x_m365_turn_count": 3,
  "x_m365_classifier_scores": {
    "BotOffense": 1.27e-7,
    "dea_violation": 2.81e-6
  },
  "x_m365_dea_score": 2.81e-6,
  "x_m365_offense_score": 1.27e-7
}
```

`x_m365_dea_score` is M365's own "disengaged-eligible answer" classifier
score — the closest signal to "am I about to get Disengaged?". Empirically:
clean tool calls sit at ~1 × 10⁻⁸, prose at ~1 × 10⁻⁶, jailbreak-shaped
prompts at ~1 × 10⁻³. Disengaged itself fires at some threshold > 2 × 10⁻³
that we haven't yet pinpointed. Clients can monitor this to back off before
tripping the filter.

Clients that ignore unknown extension fields keep working; curious users can
read them. See [docs/hypotheses.md §0](docs/hypotheses.md) for the full
findings dump and [§2](docs/hypotheses.md) for what we tried and didn't find.

## Config files

All stored in `~/.config/opencode-m365/`:

| File | Description |
|---|---|
| `msal-cache.json` | Credential-bearing MSAL token cache (auto-managed; never share or commit) |
| `agent-id.json` | Cached Copilot Studio agent ID |
| `debug.log` | Debug log (when `M365_DEBUG=1`) |
| `session-state.json` | Persisted client-session → M365 conversation/session mapping (no tokens) |
| `backoff-state.json` | Persisted degradation/backoff state across proxy restarts |

`GET /health` reports queue depth, active/persisted sessions, backoff state, temporary-chat mode, routed tool model, and agent-provisioning availability.

## Development

```sh
bun install
bun run build            # Build all packages
bun run dev              # Start standalone proxy on :4141
bun run test:unit        # Run vitest unit tests (no auth/network)
bun run test:live        # Run live integration tests against M365
```

### Research-script safety

Files under `scripts/` are reverse-engineering utilities, not supported coworker workflows. Some scripts create Copilot Studio agents, install Teams apps, or capture tenant request bodies immediately when run. Do not execute them against a production tenant without reading the complete script, bounding the mutation, and obtaining explicit tenant-owner approval. The supported coworker entry points are `m365-login`, the loopback proxy launcher, and the client configurations above.

## Known limitations

- **M365 "disengages" on large tool payloads** — heavy agent harnesses (e.g. opencode's ~15-tool prompt) get empty `Disengaged` responses. Keep the toolset lean (this is why [pi](https://pi.dev/) works well). See [docs/m365-copilot-api.md](docs/m365-copilot-api.md#the-disengaged-filter).
- Tool calling is emulated (prompt injection + a Copilot Studio agent), not native function calling — robust with the agent, unreliable without it
- The `think-deeper` / `*_Reasoning` models take 10-30s per response
- Hard quota of ~600 messages **per conversation** (mitigated by session reuse + delta sends)
- Streaming: **tool-less** responses stream incrementally (deltas forwarded as they arrive). **Tool-calling** turns are still buffered server-side — the raw text has to be parsed for tool-call fences before it can be emitted — so those arrive as a single chunk at the end (with an immediate HTTP 200 + heartbeats so the client never times out waiting)
