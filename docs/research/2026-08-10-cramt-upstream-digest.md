# Cramt/m365-copilot-proxy — Upstream Architecture Digest

**Date:** 2026-08-10
**Repo analyzed:** https://github.com/cramt/m365-copilot-proxy
**Commit analyzed:** `805c1b7ad7ccd3117926e4e08fe36842ea766d2f` (HEAD of `main`, pushed 2026-08-06; last upstream activity 2026-08-06)
**Method:** cloned via GitHub API tree + `raw.githubusercontent.com` file reads (shell `git clone` unavailable in this session). All claims are grounded in upstream files; nothing was executed against M365, no auth, no live traffic.
**Citation convention:** `path::symbol` for function/const anchors, `path §N` for doc sections, `path:file:line` where the tool surfaced line numbers (upstream README/docs reads via the GitHub page renderer; local fork reads via grep). Chunk-derived line ranges on upstream sources are marked `≈L`. `[UNVERIFIED]` marks anything not directly observed.

---

## 1. Upstream architecture

### 1.1 Language / runtime / build

- TypeScript, ESM (`"type": "module"`), pnpm 10 monorepo with `packages/*` workspaces (`pnpm-workspace.yaml`), `packageManager: pnpm@10.32.1` (`package.json`). Requires Node 24+ (README §Setup).
- Build: `tsdown` for `@m365-copilot/core` (ESM + dts, `packages/core/package.json`), **Nitro** (`nitropack ^2.10.4`) for the standalone proxy (`packages/proxy/package.json`). Tests: `vitest`, unit vs live (`M365_LIVE=1` gate, root `package.json` scripts).
- One extra root-level presence: a Nix flake (`flake.nix`, `flake.lock`) + `nix/module.nix` — the repo is packaged as a NixOS service module (5 KB module, runs the proxy as a systemd-style service with its own config surface).

### 1.2 Package layout (pnpm workspace)

| Package | Role |
|---|---|
| `@m365-copilot/core` | Shared engine: auth, WS/SignalR client (`copilot.ts`, `session.ts`), agent provisioning (`agent.ts`), tool formatting/parsing (`tools.ts`, `fenced.ts`), session state (`model.ts`), image gen (`image.ts`), degradation backoff (`auth-recovery.ts`), native actions (`native-actions.ts`), Zod schemas (`schemas.ts`), logging (`log.ts`). |
| `@m365-copilot/proxy-lib` | Embeddable OpenAI-compatible app: `handler.ts` (OpenAI↔M365 translation + `SessionPool` + retry/hardening loop), `schemas.ts` (zod request schema), `createApp()` fetch-handler factory (`index.ts`). |
| `@m365-copilot/proxy` | Standalone binary: Nitro server, `bin/m365-proxy.mjs` launcher, routes `v1/chat/completions.post.ts` + `v1/models.get.ts` + `health.get.ts`, boot-time auth plugin, CORS middleware, process-wide session pool (`server-pool.ts`). |
| `@m365-copilot/openclaw-plugin` | OpenClaw config generator (`src/index.ts`), setup CLI that writes `~/.openclaw/openclaw.json` and installs a skill (`src/setup.ts`, `skill/SKILL.md`). |

### 1.3 Entry points

1. **Standalone HTTP proxy** — `packages/proxy/bin/m365-proxy.mjs` (47 lines): thin launcher that sets `PORT` and imports the Nitro build output `.output/server/index.mjs`. Nitro routes (`packages/proxy/routes/`):
   - `POST /v1/chat/completions` → `completions.post.ts`: parses body with zod, wires client-disconnect → `AbortSignal` (the "Stop" cancel path), delegates to `handleChatCompletion(body, pool, {signal})`.
   - `GET /v1/models` → `models.get.ts` → `buildModelsPayload()` (proxy-lib): lists all `MODEL_TONES` keys with advertised `context_window`/`max_output_tokens` of **1,000,000** each (deliberately roomy so harnesses don't pre-truncate; M365 accepts ≥500k-token input, proxy-lib `index.ts`).
   - `GET /health` → static `{status:"ok"}`.
   - Startup plugin `plugins/auth.ts` calls `getToken()` once and **aborts boot on auth failure** (fail-loud for headless hosts).
2. **Embeddable app** — `packages/proxy-lib/src/index.ts::createApp()` returns a framework-free `{fetch(req)}` handler serving `/v1/chat/completions`, `/v1/models`, `/health`, OPTIONS/CORS, and 400/404 JSON errors. Used by tests, `proxy-verify`, and the openclaw-plugin (`startForOpenClaw`).
3. **Library** — `packages/core/src/index.ts` exports the full engine surface (tokens, sessions, agent, tools, image gen, backoff, native actions, log).

### 1.4 How it wraps M365 Copilot (the shape of the whole thing)

```
OpenAI client (pi/openclaw/any)
   │  HTTP POST /v1/chat/completions  {messages, tools, model, stream}
   ▼
proxy-lib handler.ts  ── SessionPool (fingerprint = hash of first user message)
   │                     delta-mode text formatting after turn 1
   ▼
core ModelSession     ── auth token + (optional) Copilot Studio agent id
   ▼
core CopilotSession   ── per-turn fresh WebSocket, reused conversationId/sessionId
   ▼
wss://substrate.office.com/m365Copilot/Chathub/{oid}@{tid}?access_token=…  (SignalR JSON, 0x1E framing)
```

- Every turn opens a **fresh WebSocket** but reuses the same `ConversationId`/`X-SessionId`, so M365 keeps server-side context; `isStartOfSession:true` only on turn 0 (`session.ts::chat`, `model.ts::ModelSession`).
- Response is a streaming `CopilotStream` (async-iterable of deltas + diagnostics getters: `throttle`, `contentOrigin`, `messageType`, `scores`, `turnCount`, `turnState`, `images`, `sawAction`) (`copilot.ts::CopilotStream`).
- The handler buffers tool-mode responses (must parse fences before emitting), streams tool-less text live through SSE with early HTTP 200 + 15s keepalive comments (`handler.ts` ~L564-660), and surfaces M365 diagnostics in the OpenAI `usage` block as `x_m365_*` extension fields (`handler.ts::buildUsage`).

---

## 2. The M365 wire protocol as upstream understands it

Primary source: `docs/m365-copilot-api.md` ("field notes from reverse engineering", as of **June 2026**, against the `substrate.office.com` Sydney backend), implemented in `packages/core/src/{copilot,session,schemas,agent}.ts`.

### 2.1 Transport & handshake (`docs/m365-copilot-api.md §0, §3`; `session.ts`)

- **SignalR-over-WebSocket**, URL `wss://substrate.office.com/m365Copilot/Chathub/{oid}@{tid}?…` — `{oid}`/`{tid}` from JWT claims (`copilot.ts::decodeJwt`).
- **Access token goes in the WS URL query string** (`access_token=…`), never a header.
- Node's native `fetch`/`WebSocket` **do not work**; must use `ws` package with browser `Origin: https://m365.cloud.microsoft` and a real `User-Agent` (Firefox/148.0 UA in `session.ts`) or the upgrade is refused.
- Every frame is terminated by `0x1E` (RS record separator); one WS message may hold multiple frames. Handshake: send `{"protocol":"json","version":1}\x1E`; server replies `{}` (or first parse just succeeds).
- Query params include `ConversationId` (client-generated UUID, reused), `chatsessionid`/`clientrequestid`/`X-SessionId` (UUIDs), `source:"officeweb"`, `product:Office`, `agentHost:Bizchat.FullScreen`, `scenario:OfficeWebIncludedCopilot`, `licenseType:Starter`, and `variants` — a long comma-separated flag list (`session.ts::VARIANTS`, 40+ cargo-culted flags).

### 2.2 Frame types (`session.ts::handleMsg`, `schemas.ts`)

| type | Meaning | Upstream handling |
|---|---|---|
| 1 | Invocation/update; server→client `target:"update"` streaming; client→server `Metrics` | dispatch `DeltaUpdate` / `MessageUpdate` / `ThrottlingUpdate` |
| 2 | Stream item — final conversation state | mine throttle/turnCount/scores/`contentOrigin`/`messageType`, then close |
| 3 | Completion (optional `error`) | error → reject; close |
| 4 | Invocation (no-result) — the chat turn (`target:"chat"`, `invocationId:"0"`) | sent |
| 6 | Ping | reply `{"type":6}\x1E` |
| 7 | Close (optional `error`) | close |

### 2.3 Sending a chat turn (`session.ts::sendChat`, `docs/m365-copilot-api.md §4`)

- **Two frames in one `ws.send()`**: the chat invocation **and** a `Metrics` frame (`target:"Metrics"`, `type:1`, cosmetic timestamps). Omitting Metrics ⇒ the turn never produces output.
- Chat `arguments[0]` key fields: `message.text` (prompt), `message.author:"user"`, `tone` (model selector, §2.4), `source:"officeweb"`, `streamingMode:"ConciseWithPadding"`, `isStartOfSession`, `allowedMessageTypes` (long allow-list incl. `Chat`, `Disengaged`, `Progress`, `GeneratedCode`, `GenerateGraphicArt` when image gen), `clientInfo` (`clientPlatform:"mcmcopilot-web"`, …), `optionsSets` (§2.6), `plugins:[{Id:"BingWebSearch",Source:"BuiltIn"}]` **only on the agent-less path**, `threadLevelGptId` + `gpts[]` **instead of plugins** when an agent is attached (§2.8), `locationInfo`/`locale` (cosmetic), `disconnectBehavior:"continue"`, plus native-action skill flags when enabled.
- **Cancel** (client-abort): send `{"arguments":[{}],"invocationId":"1","target":"stop","type":1}\x1E` on the same socket, then close; server acks `type:3` and discards the partial answer — **but the cancelled message still counts toward the 600 cap and its context persists server-side** (`session.ts::STOP_FRAME`, `docs/m365-copilot-api.md §6`). Upstream propagates HTTP-client disconnect as `AbortSignal` through `completions.post.ts → handler → model.ts → session.ts` and sends this Stop frame.

### 2.4 Models are selected by `tone`, not model id (`copilot.ts::MODEL_TONES`, `docs/m365-copilot-api.md §5`)

- No `model` field exists on the wire; the tone string picks the backend. Mapping (all live-validated; server rejects unknown tones with `Failed to invoke 'Chat'`):
  - `m365-copilot`/`auto` → `magic` (GPT auto-router; high variance at turn-1 tool calling)
  - `quick` → `Gpt_Quick`, `think-deeper` → `Gpt_Reasoning`
  - `claude`/`claude-sonnet` → `Claude_Sonnet` — **real Anthropic Claude Sonnet 4.5** (self-identifies); `claude-sonnet-think-deeper` → `Claude_Sonnet_Reasoning`; `claude-opus` → `Claude_Opus` (accepted, identity deflected)
  - `gpt-5.5*` → `Gpt_5_5_Chat`/`Gpt_5_5_Reasoning`; `gpt-5.6-think-deeper` → `Gpt_5_6_Reasoning` (live-validated 2026-08-06); `gpt-5.4*`/`gpt-5.3*`/`gpt-5.2*` → `Gpt_5_4_*`/`Gpt_5_3_*`/`Gpt_5_2_*`
- Any unmapped `claude-*` string (e.g. a Claude Code client's `claude-opus-4-8[1m]`) routes to `Claude_Sonnet`, **not** to the GPT `magic` tone — the magic path doesn't tool-call agent-less (route-probe 2026-07-07) (`copilot.ts::getToneForModel`).
- Three tone outcomes (Aug 6 2026): **Live** (`contentOrigin:"DeepLeo"`), **Rejected** (`type:3` error, ~250-300ms), **Registered-but-dead** (canned "Sorry, I wasn't able to respond" + `contentOrigin:"BotConnection"` ~1.6s). "Didn't error" is not sufficient to map a tone.
- ⚠️ **The declarative agent overrides the tone → GPT-5.** With `threadLevelGptId` attached, `Claude_Sonnet` silently routes to GPT, and reasoning tones Disengage on heavy tool prompts. Consequence: proxy attaches the agent **only for tool requests** (`model.ts::run(useAgent=hasTools)`, `handler.ts`); plain chat stays agent-less and gets the real model the tone selects. A non-default tone + agent = unsupported combination (DeepLeo meta-reasons over the injected prompt and reasons itself *out* of tools).

### 2.5 Receiving a response (`session.ts::handleMsg`, `docs/m365-copilot-api.md §6`)

- Streamed as `type:1 target:"update"` frames whose `arguments[]` each contain one of:
  - **Delta**: `{writeAtCursor:"partial text", streamingMode:"Delta"}` — concatenate.
  - **Message snapshot**: `{messages:[{author:"bot", text:"full text so far", …}]}` — only treated as content when **`messageType` is absent** (a `messageType` marks control/meta frames: `Disengaged`, `Progress`, `EndOfRequest`, `ReferencesListComplete`, `RenderCardRequest`, `InternalSearchQuery`, …).
  - **Throttling**: `{throttling:{numUserMessagesInConversation, maxNumUserMessagesInConversation:600, numLongDocSummaryUserMessagesInConversation}}`.
- The first token often arrives **only as a snapshot**, so naive delta concatenation drops the head — `session.ts::foldStreamText` folds both shapes, emitting only true prefixes of the final answer.
- Final `type:2` stream item carries canonical state: messages with final `scores`, `throttling`, `result.{value,message,serviceVersion}` (e.g. `1.0.03443.34112`), `turnState:"Completed"`, `conversationExpiryTime` (~30 days), **`conversationTransferToken`** (base64 → `{"type":"FullConversation","conversationId":"…"}`; mechanism unclear, not yet investigated — possible cross-host conversation migration handle), and **`firstNewMessageIndex`** (which message is new since previous turn — could power smarter delta sends).
- Per-message classifier `scores` (`BotOffense`, `dea_violation`) are tiny floats; `dea_violation` is the "disengaged-eligible answer" classifier. Empirically: clean tool calls ~1e-8, prose ~1e-6, jailbreak-shaped ~1e-3, Disengaged fires > some threshold above ~2e-3. Proxy surfaces the max per-turn values as `usage.x_m365_dea_score` / `x_m365_offense_score` (`handler.ts::buildUsage`).
- **I/O asymmetry** (quirk 20): input is retrieval-backed (≥500k tokens, benign size never Disengages); output soft-caps ~3k tokens by **concluding early**, not truncating. Proxy heuristically emits `finish_reason:"length"` at ≥12,000 chars (`handler.ts::outputFinishReason`, `M365_OUTPUT_CHAR_CEILING`).

### 2.6 optionsSets & allowedMessageTypes (`session.ts`)

- Upstream historically sent `optionsSets: []` and now populates it per path (quirk 24 notes the richer reference impls: PyRIT, `kuchris/m365-copilot-openai-proxy`):
  - **Code interpreter** (agent-less path only): `cwc_code_interpreter, cwc_code_interpreter_amsfix, cwc_code_interpreter_citation_fix, code_interpreter_interactive_charts, code_interpreter_matplotlib_patching` + `GeneratedCode`/`GenerateContentQuery` in allowedMessageTypes → **real server-side Python sandbox** (verified with a SHA-256 oracle). Disable `M365_NO_CODE_INTERPRETER=1`. (`session.ts::CODE_INTERPRETER_OPTIONS_SETS`)
  - **Image generation** (agent-less path only): the full GUI option set (`cwc_flux_image`, `cwc_flux_v3`, `enable_gg_gpt`, dimension/story/designer flags, `…non_watermarked_storage`) + `GenerateGraphicArt` allowedMessageType. (`session.ts::IMAGE_GEN_OPTIONS_SETS`)
  - `M365_EXTRA_OPTIONSSETS` (comma-sep) merges onto **any** path — the lever used to test whether the GUI's rich set stops agent-path Disengage (F17/F21).
- **Declare-to-receive rule**: the server only sends `GraphicArt` frames or native-action trigger frames if the client declares the corresponding allowedMessageTypes (`GenerateGraphicArt`, `ACTION_ALLOWED_MESSAGE_TYPES`).

### 2.7 Throttling & quotas (`docs/m365-copilot-api.md §7`, `auth-recovery.ts`)

- **600 user messages per conversation** — hard cap, keyed per `ConversationId`. Every retry ("Please continue.") counts.
- Conversation reuse + delta sends exist to conserve this quota.
- **Account-level degradation** (thread-rate throttle, observed June 13 2026): sustained heavy use (~80+ messages in hours) makes M365 return `Disengaged`/empty on **fresh** conversations too; self-heals with a lull (~15 min); is **`oid`-keyed** — re-auth does NOT clear it. Replaced the old auto-reauth with **degradation backoff** (`auth-recovery.ts`): ≥3 empties across **distinct conversations** within a 120 s window ⇒ pace new turns with jittered delay (90 s base, exponential to 600 s cap), reset instantly on a clean response. Tuned by `M365_BACKOFF_*`, disabled by `M365_NO_BACKOFF` (legacy alias `M365_NO_AUTO_REAUTH`). A single long thread never trips it.
- Empty reply ≠ rate limit unless `throttle.current >= throttle.max` (→ HTTP 429); otherwise fail fast after ≤2 quick retries (→ 502 `upstream_empty_response`), with one **agent re-resolution** on empty (deleted-agent trap, §2.8).

### 2.8 Copilot Studio agent (`agent.ts`, `docs/m365-copilot-api.md §10`)

Tool calling works only with a server-side system prompt, delivered via an auto-provisioned **Copilot Studio declarative agent**:

1. Discover environment: `GET api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/environments/~default` → `Default-<tenantGuid>`.
2. Power Platform host: `default<envId>.df.environment.api.powerplatform.com`, envId = tenant GUID minus dashes; **DNS quirk — trim the last 2 chars** (probe candidates; `agent.ts::getEnvironmentUrl`).
3. Create bot via `copilotstudio/minimalBots/api` (GptComponent with `instructions` = tool-format contract, `gptCapabilities` all false, `aISettings.useModelKnowledge:true`).
4. Publish → `TitleId`; usable id = **`T_{titleId}.{botId}.gpt.default`**, cached in `~/.config/opencode-m365/agent-id.json`.
5. On the wire: `threadLevelGptId:{id,source:"MOS3"}` + `gpts:[{id,source:"MOS3",version:"1.0.0",clientOverrides:{capabilities:[],…}}]` instead of `plugins`.

- **Versioned by name** `m365-tool-agent-<sha256(instructions)[:8]>`; editing `getAgentInstructions()` re-provisions a fresh agent; old agents are **never deleted** (multi-host safety — a second proxy may still be mid-conversation with one; the deletion pass was removed after the "deleted-agent trap"). ⚠️ The cheat-sheet quirk #15 still says "cleans up old" — doc drift vs the code (`agent.ts` explicitly: "Stale older-version agents are intentionally LEFT in place — never deleted").
- **Deleted-agent trap**: a long-lived host caches the agent id for process life (`ModelSession.cachedAgentId` only set when `=== undefined`; `reset()` clears it now, `refreshAgent()` re-resolves on empty reply) — a dead agent yields an instant empty reply (`throttle:null`, ~0.7 s) that looks like rate limiting.
- Declarative (`minimalBots`) agents are **not** Dataverse bots (that table is empty for them) and have **no model field** — you cannot bind a model to our agent type. Full Studio/Dataverse PVA bots (which can bind a model) are the open frontier, not yet tested over BizChat WS (`agent-model-probe.mjs`, `dataverse-bot-probe.mjs`).

### 2.9 Auth (`auth.ts`, `docs/m365-copilot-api.md §2`)

- MSAL PKCE via `@azure/msal-node`; **client id `c0ab8ce9-e9a0-42e7-b064-33d422df41f1`** (Microsoft's own Office-web Copilot app — nobody can register a redirect for it); authority `login.microsoftonline.com/common`; **redirect `…/oauth2/nativeclient`** (only door: loopback is AADSTS50011; device code demands a client_secret only MS holds, AADSTS7000218 — both measured live, don't re-derive).
- Scopes: `substrate.office.com/sydney/M365Chat.Read` + `sydney.readwrite` (chat), `api.powerplatform.com/.default` (agent mgmt), `api.bap.microsoft.com/.default` (env discovery), `designerappservice.officeapps.live.com/.default` (image artifact bytes — separate auth boundary; artifact URLs 401 without it).
- Token cache at `~/.config/opencode-m365/msal-cache.json`, silent refresh preferred; disposable (delete → self-heals in ~12 s).
- **Automated login**: headless Playwright with persistent browser profile (anti-detection: `--disable-blink-features=AutomationControlled`, `navigator.webdriver` spoof, coherent Linux Chrome UA, locale/timezone fingerprint, SSO-silent returning sessions), stored creds + **TOTP from base32 seed** (`otpauth`), and the **`nativeclient` redirect gotcha**: a real browser bounces to `/common/wrongplace`, so the `?code=` is scraped from the navigation *request* (`page.on("request")`), not `waitForURL` (`auth.ts::runBrowserLogin`). Hidden-duplicate password inputs on the AAD page → `fillVerified()`.
- **Interactive approval** fallback (`M365_ENABLE_INTERACTIVE_APPROVAL=1`, contributed by @EatonWu): visible browser, human completes SSO/MFA once; kicks in when stored creds fail. Hard veto `M365_NO_INTERACTIVE=1`. Opt-in so headless hosts fail loudly.
- Observed token scopes already include `Files.ReadWrite(All)`, `Mail.Read(.Shared)`, `Sites.Read.All`, `Teams.ReadWrite.All`, `Presence.Read`, `CopilotPlatform{Content.Process,…}` + DLP/protection scopes — i.e. the foundation for Graph "Work" grounding is already in the auth we hold (hypotheses §8 H8.11).

---

## 3. Tool calling / agent behavior (upstream's answer to "does it support tool calling?")

**No native `tool_calls`. It is fully emulated, in four layers** (`docs/tool-calling.md`, `docs/prompt-engineering.md`):

1. **Copilot Studio agent** (server-side system prompt, §2.8) — the load-bearing lever. The agent's instructions are deliberately **format-contract-only** ("output ONLY a single Markdown code fence whose info-string is the tool name; a fence is an ACTION, never an illustration; one call per turn") — an earlier version that baked heavy anti-advise framing **suppressed tool emission to 0** (`agent.ts::getAgentInstructions`).
2. **Fenced format** (`fenced.ts`) — the JSON `{"tool":…}` format was **removed** (scored 0/5 on real agentic tasks). Tool calls are Markdown code fences: info-string = tool name; scalar args as `key: value` header lines; one free-form body arg as the fence body; `old`/`new` edit pairs as aider-style `SEARCH/REPLACE` diffs. `parseFencedToolCalls` is schema-aware; `M365_ALLOW_MULTI_TOOL=1` restores batched calls (default keeps only the first).
3. **Shell-routing — the key unlock** (`fenced.ts::SHELL_LANGS`/`findShellTool`/`buildSpecMap`): M365's chat-tuned model won't "act as an agent" on demand but **will reflexively write a ```` ```bash ```` block**. Any tool whose name matches `SHELL_TOOL_NAME` (`bash|sh|shell|run|exec|…|run_command|execute_command|…`) is the shell target; ```` ```bash ```` / ```` ```sh ```` / ```` ```shell ```` / even leaked runtime tools (```` ```container.exec ```` etc.) are aliased to it in the spec map. The per-request `<tools>` framing injects "do the whole step by writing ONE ```` ```bash ```` block" + anti-confabulation ("you've run nothing yet; never claim commands return no output; your FIRST output is a ```` ```bash ```` block") + anti-premature-success ("never claim `✅`/`SUCCESS`/`Done` unless a `<tool_response>` proving it appears above"). This turned the bench from 0/5 into verified multi-turn loops (9-tool-call bug fix).
4. **Proxy-side hardening** (`handler.ts`, `tools.ts`) — deterministic levers that work even when the prompt fails:
   - `isProseDocument` — a response that *is* a document (≥4 fences, or markdown headers, or ≥300 chars prose around fences) returns as text, never executed (a model answering "here's a README" must not have its own answer run as shell).
   - **Confabulation retry** (`looksLikeConfabulation`, ~25 regex patterns incl. `container.exec`/`/mnt/data` tells) — re-prompt forcefully in the **same conversation** (`CONFAB_FORCE_PROMPT`), `M365_CONFAB_RETRIES` default 1.
   - **Hallucinated-completion retry** (`looksLikeHallucinatedCompletion`, gated on "no tool call ever acted") and **remote-artifact detection** (`looksLikeRemoteArtifactCompletion` — Teams `asyncgw.teams.microsoft.com` patch URLs, `sandbox:/mnt/data/…`, PUA citation markers) which **fails closed to 502** if a mutation claim persists without a local tool call.
   - Tool-result labelling (`<tool_response tool="bash" command="ls -la">` via `tool_call_id` correlation) so the model reads output in context; mixed text+tool output strips the text; `{"confidence":N}`/`{"final":…}` invented JSON stripped/unwrapped.
   - `Disengaged` → fail fast with 502 `type:"disengaged"` (never blind-retry; it re-disengages and burns quota) — except one F22 retry: **fresh conversation + `softened` framing** (low jailbreak-shape variant) recovers most disengages.
   - Framing is a **runtime-selectable registry** (`FRAMING_VARIANTS` in `fenced.ts`: `baseline`, `minimal`, `softened`, `recency`, `fewshot`, `proof_demand`, `persona`, `react`, `negative`, `terse`, `demo_only`, `session_facts`; plus `reply_tool` strategy injecting a synthetic `reply(text)` tool via `M365_INJECT_REPLY_TOOL=1`) — A/B'd live via `M365_FRAMING_VARIANT` / `M365_FRAMING_FILE` (per-request strategy switching without restart).
   - `M365_ALLOW_MULTI_TOOL` gates one-call-per-turn; the `reply` tool (when enabled) converts back to a plain assistant text message (`handler.ts`).

**Also on the tool-calling frontier:**
- **Native custom actions** (`native-actions.ts`, H-NATIVE-6/7): the server can trigger a real **custom action/plugin** via a confirmation adaptive-card frame (`messageType: ConfirmationCard/TriggerConfirmation/RenderCardRequest` + `actionId`/`isConsequential`); the proxy replies on the same socket with a `ResumeInvokeAction` message (button-title-derived `text`, `invokeActionMessages:[trigger]`) and the **server-side orchestrator executes the action** and streams the result — a native, MCP-like tool channel over the same WS. Auto-approves read-only actions; consequential ones require `autoConfirmAll` (`M365_AUTO_CONFIRM_ACTIONS`). Declare the vocabulary via `ACTION_ALLOWED_MESSAGE_TYPES`. This is the "Claude-grade tool use without the declarative agent" path — currently experimental, fields are best-effort from the decompiled client.
- **Code interpreter** (§2.6) — real server-side Python execution on the agent-less path.
- **Image generation** (`image.ts` + `session.ts::IMAGE_GEN_OPTIONS_SETS`): agent-less chat turn with `generateImages:true`; pictures arrive on **`GraphicArt` frames** (`contentGenerationProgressList`, `ImageReferenceUrls`, `fileToken`, `status:2=ready`) as URLs, never chat text; bytes fetched with the separate `designerappservice` token. Separate daily quota (map `quota_exceeded` → 429). Exposed via core `generateImage()`; a plain chat turn also draws when asked (GUI-style). Upstream README notes an OpenAI `/v1/images/generations` endpoint is the announced next step, "core API already in place".
- **Measurement traps documented** (don't re-learn): the model hallucinates success on *fakeable* tasks (weights bench scoreboards), bench ≠ real pi, and `tool_choice:"required"` translated to a prompt rule forces bogus calls (pass through as advisory only).

---

## 4. Notable upstream features vs this fork

### Upstream features the fork has kept (verified in local `packages/core/src/session.ts`, `fenced.ts`, `tools.ts` via grep)

`STOP_FRAME` cancel, `CODE_INTERPRETER_OPTIONS_SETS` (+`M365_NO_CODE_INTERPRETER`), `IMAGE_GEN_OPTIONS_SETS`, `M365_EXTRA_OPTIONSSETS`, `M365_DUMP_FRAMES` frame dumping, the 40-flag `VARIANTS` list, the full `FRAMING_VARIANTS` registry, `SHELL_LANGS`/`findShellTool` shell-routing, `M365_INJECT_REPLY_TOOL`, `M365_ALLOW_MULTI_TOOL`, agent provisioning (`agent.ts`), native actions (`native-actions.ts`), image gen (`image.ts`), degradation backoff (`auth-recovery.ts`).

### Upstream features this fork lacks or simplified

- **Claude/Claude_* tone path is intact upstream but the fork's `MODEL_TONES` copy is older**: fork `copilot.ts` is 4.3 KB vs upstream 4.6 KB; upstream added `gpt-5.6-think-deeper → Gpt_5_6_Reasoning` (live-validated 2026-08-06) and the `claude-*` → `Claude_Sonnet` fallback in `getToneForModel`. [Verify fork's model list before relying on `gpt-5.6` or unmapped `claude-*` routing.]
- **Nix packaging** (`flake.nix` + `nix/module.nix`): fork root listing has `nix/` but no `flake.nix`/`flake.lock` — the flake was dropped (or moved); fork runs on **bun** (`packageManager: bun@1.3.14`, `bun.lock`) vs upstream pnpm. Fork's proxy package still builds with Nitro.
- **`agent.ts` dead code**: upstream `updateBotInstructions()` noted as dead code in `docs/m365-copilot-api.md §10` (needs a `changeToken` only returned by create).
- **Upstream script suite** (`scripts/bench/*`, `scripts/*-probe.mjs` — overnight sweeps, `_mock-proxy.mjs`, `analyze-sweep.mjs`, `pi-reliability.sh`, tool-compliance A/B harnesses): the fork kept many scripts (`scripts/_probe-chat.mjs`, `cancel-frame-capture.mjs`, `variants-bisect.mjs`, `toolformat-experiment.mjs`, `tool-compliance-experiment.mjs` present per local listing) but the bench sweep infrastructure was replaced by fork-specific experiments (`experiments/tool-decision/`). [Partial: not every upstream script checked against fork.]

### Fork features upstream lacks (the reverse direction — see §6)

`intent-verifier` (fail-closed 8H gate), client attestation (`attestation.ts` + `client-adapters/` for pi/omp/codex), throttle telemetry, `/v1/responses` (OpenAI Responses API), `/v1/attestations`, `/v1/conversations/prune`, session scheduler/store/pruning, image-*input* attachments (`cwcgptvsan` optionsSets), local-shell backend for Windows (git-bash/WSL), `cowork.ts` probe (a *second*, Socket.IO-based Copilot surface via `edge.skype.com` registrar — fork-only reverse engineering).

---

## 5. Concretely adoptable ideas (with effort guesses)

Priority-ordered by architect value. "Tiny" ≈ ≤1 h, "small" ≈ half day, "medium" ≈ 1-2 days, all fork-context effort.

1. **[tiny] Sync `MODEL_TONES` + `getToneForModel` from upstream `copilot.ts`.** Adds `gpt-5.6-think-deeper` (live-validated 2026-08-06, `Gpt_5_6_Reasoning`) and the unmapped-`claude-*`→`Claude_Sonnet` fallback that keeps Claude-Code-style clients on the working agent-less path instead of the GPT confab quadrant. Also note the three-outcome tone probe (`DeepLeo` vs `BotConnection` dead-tone trap) — re-probe before mapping any new tone.
2. **[tiny] Adopt the `usage` extension-field telemetry (`x_m365_dea_score`, `x_m365_offense_score`, conversation-quota %, `contentOrigin`, `turnCount`).** Fork already has `usage-builder.ts`; verify it carries the scores + quota (upstream `handler.ts::buildUsage`). `dea_violation` is the only live "how close to Disengaged am I" signal (clean ~1e-8, prose ~1e-6, jailbreak ~1e-3, fires >2e-3) — feeds the fork's throttle telemetry directly.
3. **[tiny] `M365_DUMP_FRAMES` forensic NDJSON frame capture** — fork already has it (local `session.ts:63`); make sure it's exercised in the fork's live-probe workflow (`scripts/frame-dump-disengage.mjs`). Zero-cost, high debug value when M365 changes the protocol.
4. **[small] F22 Disengaged-recovery retry** (fresh conversation + `softened` framing) — verify the fork's handler still does this (fork moved `produce()` to `tool-path.ts`); it cuts worst-case disengage ~100%→~4% and is strictly better than fail-fast. Requires `newConversation()` on `ModelSession` (upstream `model.ts`).
5. **[small] `firstNewMessageIndex` / `conversationTransferToken` mining** (upstream `docs/m365-copilot-api.md §6`, type:2 item). Upstream hasn't exploited either; `firstNewMessageIndex` could power smarter delta sends than the current "count-based" delta (`conv.sentMessageCount` slicing), and `conversationTransferToken` is a plausible cross-host conversation-migration handle — worth a frame-dump dig, not yet validated.
6. **[small] Native custom actions (`native-actions.ts`)**: the `ResumeInvokeAction` confirm→invoke round-trip gives real MCP-like server-executed actions over the same WS, with read-only auto-approve and consequential gating. Fork already has the file (8.9 KB, same as upstream); it is experimental — the inline `gptDefinitions` schema needs a live `M365_DUMP_FRAMES=1` capture to confirm. Adopt behind a flag; the fork's attestation/verifier gates make it a natural fit.
7. **[small] Code-interpreter optionsSets on the agent-less path** (already present in fork `session.ts:39-45`): free server-side Python (verified SHA-256 oracle) for plain chat; keep it off the tool path so it doesn't compete with fence emission.
8. **[small] Image-gen end-to-end (GraphicArt frames + designerappservice token + `/v1/images/generations`)** — upstream has the full chain in `image.ts` and calls the OpenAI image endpoint the "next step, core API already in place". Fork split this into `image.ts` + `images.ts` (attachment prep); adding the `/v1/images/generations` route is the visible gap. Note the separate daily quota.
9. **[medium] Degradation backoff policy alignment** — upstream replaced auto-reauth with distinct-conversation-empties → pacing (`auth-recovery.ts`, `oid`-keyed throttle evidence). Fork has the file (10.1 KB, grew with `getDegradationBackoffState`) + throttle telemetry; verify threshold/window tuning parity (`M365_BACKOFF_THRESHOLD=3`, `WINDOW_MS=120000`, `BASE_MS=90000`, `MAX_MS=600000`) and that re-auth is never fired on empties.
10. **[medium] Framing-variant A/B harness + `M365_FRAMING_FILE` per-request strategy switching** — fork kept the registry; adopting upstream's `scripts/bench` sweep (mock proxy + `analyze-sweep.mjs` + overnight `sweep.sh`) would let the fork re-validate its verifier changes against the same discriminating (unfakeable) task set instead of one-off experiments.
11. **[medium] OpenClaw plugin parity** — upstream ships config generator + setup CLI + skill (`packages/openclaw-plugin`), fork has the package; diff the model display names / reasoning flags against the synced `MODEL_TONES`.
12. **[watch] TOTP headless login with persistent profile + interactive-approval fallback** — upstream's `auth.ts` has heavy anti-detection investment (persistent profile, UA/locale/timezone fingerprint, `fillVerified`, account-picker handling, `nativeclient` request-scrape). Fork's `auth.ts` is 12.8 KB vs upstream 27.7 KB — confirm which of these survived the fork's rewrite before trusting headless login on a new tenant. (Fork exports `loginInteractive`/`getBrowserProfileDir` — renamed surface.)

---

## 6. Divergence map (fork vs upstream — brief)

Ground truth: local `git remote -v` shows the fork's `origin` is **`asmartin-ai/m365-copilot-proxy`** (not cramt directly), plus a `lan` remote (`/path/to/the remote/shared/m365-copilot-proxy.git`). The fork's latest commits (9f1ae1b, eb0fa7f, …) are fork-authored (attestation wire contract, client-attested execution gate, verifier bake-off, telemetry). The fork kept the upstream protocol core (verified by grep, §4) and layered on its own architecture.

**Fork changed / added:**

- **Runtime & build**: pnpm → **bun** (`packageManager: bun@1.3.14`, `bun.lock`, bun workspaces); root `flake.nix` dropped (fork retains `nix/` dir only); upstream docs/README rewritten as fork README ("This fork extracts the architecture").
- **Handler decomposition**: upstream's 36 KB monolith `proxy-lib/src/handler.ts` → fork modules `context-compiler.ts`, `usage-builder.ts`, `response-helpers.ts`, `local-response-helpers.ts`, `session-pool.ts`, `output-ceiling.ts`, `force-prompts.ts`, `image-renderer.ts`, plus extracted decision policy in **`tool-path.ts`** (upstream's `produce()` closure) and new `scheduler.ts`, `session-store.ts` (persisted session state), `pruning.ts` (+ `POST /v1/conversations/prune`).
- **Verifier (fork-only)**: **`intent-verifier.ts`** — fail-closed "8H policy" gate between the deterministic tool parse and execution; a frozen local-LLM prompt (`INTENT_VERIFIER_PROMPT`, drift-tested against `experiments/tool-decision/execution-intent/prompts/p4-minimal.txt`) classifies `EXECUTE | TEXT | UNCERTAIN`; **only EXECUTE executes**; timeout/error/model-mismatch → TEXT (never execute); default ON, `M365_INTENT_VERIFIER=0` opt-out. Upstream has no such gate.
- **Attestation (fork-only)**: **`attestation.ts`** + `client-adapters/` — opt-in client-attested execution control plane for **pi/omp/codex**: the harness HMAC-signs a request (`client, tool:"bash", tool_call_id, command_sha256, ts, nonce`; 60 s TTL, 1k capacity, timing-safe compare) to attest one exact bash command before executing it; the proxy then skips the verifier for that call (latency win) and records proof-of-authorization. Wire contract documented in the fork's `docs/m365-copilot-api.md §11`. New route `POST /v1/attestations`.
- **Telemetry (fork-only)**: **`throttle-telemetry.ts`** — passive NDJSON event log *outside* the repo (`~/.config/opencode-m365/throttle-telemetry.ndjson`), events `empty-throttle | backoff-enter | backoff-exit | disengaged | at-limit`, convIds sha256-hashed, in-memory counts surfaced on `/health`, `M365_NO_TELEMETRY=1` opt-out. Upstream has no telemetry channel.
- **New API surface (fork-only)**: `POST /v1/responses` (**OpenAI Responses API** adapter in `responses.ts`, incl. `function_call`/`function_call_output` items, image_url content parts, `previous_response_id`) — upstream only speaks `/v1/chat/completions`.
- **Windows/local-shell (fork-only)**: `fenced.ts::getLocalShellBackend` — bash tool calls execute through **git-bash or WSL** (`M365_LOCAL_SHELL=wsl|git-bash`, `M365_GIT_BASH_PATH`), matching this Windows workstation; upstream is Linux-oriented.
- **Image input (fork-only)**: `images.ts` + `getMessageImages` + `cwcgptvsan`/`flux_v3_gptv_enable_upload_multi_image…` optionsSets — the fork sends image *attachments* into turns; upstream deliberately excludes the GPT-V/upload family ("image *input*, a separate capability").
- **Second Copilot surface (fork-only)**: `cowork.ts` + `cowork-protocol.ts` — a Socket.IO probe against `edge.skype.com/registrar` with `containerConfig="…model=fable-5:claude"`; a separate, fork-originated reverse-engineering thread (likely the `the remote` remote's shared work).
- **Docs**: fork `docs/m365-copilot-api.md` (53.4 KB) = upstream doc + new §11 "Client-attested execution (opt-in)"; sections after §10 renumbered (§12 quirks, §13 source map).

**What upstream has that the fork does not** (summary of §4): the newest tone mappings, the Nix flake, the bench-sweep script suite, and the documented-but-dead `updateBotInstructions`. Everything protocol-critical is shared; the fork's risk surface is its own additions (verifier misclassification, attestation HMAC, telemetry I/O), not protocol drift.

---

## Appendix — key upstream file map

| File | What it holds |
|---|---|
| `packages/core/src/auth.ts` (27.7 KB) | MSAL PKCE, silent refresh, Playwright automated login, interactive approval, token-for-scope |
| `packages/core/src/copilot.ts` (4.6 KB) | `MODEL_TONES`, `getToneForModel`, `decodeJwt`, `CopilotStream`/`CapturedImage` types |
| `packages/core/src/session.ts` (~800 L) | `CopilotSession`, WS URL/headers/framing, `sendChat` envelope, `Metrics`, `STOP_FRAME`, optionsSets, `handleMsg`, `foldStreamText`, frame dumping |
| `packages/core/src/model.ts` | `ModelSession` (auth + agent + conversation continuity, `newConversation`, `refreshAgent`) |
| `packages/core/src/agent.ts` | BAP env discovery, `minimalBots` create/publish, versioned agent id |
| `packages/core/src/tools.ts` (24 KB) | prompt formatting, `parseToolCalls`, confab/hallucinated/remote-artifact detectors, `isProseDocument` |
| `packages/core/src/fenced.ts` (32.4 KB) | fenced format spec, shell-routing, `FRAMING_VARIANTS` registry, `parseFencedToolCalls` |
| `packages/core/src/native-actions.ts` | `ResumeInvokeAction` round-trip, action confirmation parsing |
| `packages/core/src/schemas.ts` | Zod: SignalR frames, throttling, classifier scores, JWT claims |
| `packages/core/src/auth-recovery.ts` | degradation backoff controller (replaces auto-reauth) |
| `packages/core/src/image.ts` | image gen chain (GraphicArt frames → bytes), failure classification |
| `packages/proxy-lib/src/handler.ts` (36 KB) | OpenAI↔M365 translation, `SessionPool`, retry/hardening loop, SSE renderer, `buildUsage` |
| `packages/proxy/*` | Nitro server, routes, boot auth, CORS |
| `docs/m365-copilot-api.md` | protocol field notes (the source of truth for §2) |
| `docs/tool-calling.md`, `docs/prompt-engineering.md` | the emulated-tool contract and settled prompt findings |
| `docs/hypotheses.md` (183 KB) | the open-questions notebook (F-series findings cited throughout) |
