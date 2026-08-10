# Client → Proxy: trusted human-approval proof for one exact tool command

**Date:** 2026-08-09 · **Scope:** research only, source-backed · **Clients:** pi (pi.dev), Codex CLI, Oh My Pi (omp), DCG (the local destructive-command guard)

## Conclusion (TL;DR)

**No client exposes a native, machine-verifiable "a human approved this exact command" primitive to a model endpoint.** In all four, the approval decision happens client-side, between the model response and tool execution, inside the harness's own process — a proxy sitting on the OpenAI-compatible axis can never observe it.

The one universal crossing point is the **client-side pre-execution hook/extension event that carries the exact command and runs with process access**: pi extensions (`pi.on("tool_call")`), omp hooks (same family, `.omp/hooks/pre/*.ts`), and Codex hooks (`PreToolUse` / `PermissionRequest`, JSON `tool_input.command`). **Recommended contract: the hook POSTs an HMAC-signed, single-use, time-bound attestation of the exact command to the proxy's loopback control endpoint; the proxy fails closed on any mismatch.** This works for pi, omp, and Codex from one contract; DCG stays the deny floor inside omp.

## Follow-up (2026-08-09): pre-execution hooks DO receive the tool-call ID

Verified from source — all three clients hand the exact tool-call ID (plus provider metadata) to pre-execution hook handlers, not just the command string:

| Client | Hook event | ID field | Provider/session metadata | Evidence |
|---|---|---|---|---|
| pi | `tool_call` (extension) | `toolCallId: string` on `ToolCallEventBase` | `toolName`, `input` (args) | `packages/coding-agent/src/core/extensions/types.ts:853-862`; id sourced from the model's assistant-message tool call: `agent-session.ts:490` (`toolCallId: toolCall.id`) |
| omp | `tool_call` (hook) | `toolCallId: string` | `toolName`, `input` (mutable) | `packages/coding-agent/src/extensibility/hooks/types.ts:306-313`; emitted by `HookToolWrapper.execute(toolCallId)` pre-execution (`extensibility/hooks/tool-wrapper.ts:35-50,78`) |
| Codex | `PreToolUse` (hook) | `tool_use_id: String` | `session_id`, `turn_id`, `model`, `permission_mode`, `cwd`, `transcript_path`, `tool_input` | `codex-rs/hooks/src/events/pre_tool_use.rs:24-35,172-193` (stdin JSON includes `tool_use_id`); id sourced from the response stream: `codex-rs/core/src/exec.rs:290,1134` |

Codex's `PermissionRequest` hook correlates through the same id via `run_id_suffix` (= `call_id`) but its stdin JSON omits an explicit `tool_use_id` field (`codex-rs/hooks/src/events/permission_request.rs:36-49,178-189`; `codex-rs/core/src/tools/approvals.rs:40,310-313`). pi additionally exposes `before_provider_headers` — a mutable `ProviderHeaders` hook before the provider HTTP call — enabling per-request header injection to the proxy (`packages/coding-agent/src/core/extensions/types.ts:127-131`).

### Collision-safe correlation (portable scheme)

The proxy issues the tool call, so it controls a globally unique `id` per candidate in its response; the client passes that id through to the hook. **Bind the attestation on `(tool_call_id, command_sha256)`**: the proxy maps `id → exact fenced command → candidate`, so two identical commands are still distinguishable and a reused command under a new id cannot inherit an old approval.

- **Primary binding:** exact `tool_call_id` match + `command_sha256` (defense-in-depth against id reuse).
- **Fallback** (clients/wire shapes that strip or regenerate ids): `command_sha256` + `session_id` + TTL + single-use nonce — weaker (collides on repeated identical commands), never accept without nonce + TTL.
- **Cross-client safety:** include `client` + `session_id` in the attestation — tool-call ids are per-client namespaces (a `call_…` from pi is not comparable to Codex's).

### Limits

1. **Codex `PermissionRequest` stdin has no explicit `tool_use_id`** — `PreToolUse` is the portable Codex surface for id-bound attestation.
2. **ID pass-through requires the proxy's response id to survive to tool execution:** pi/omp chat-completions keep the proxy-issued id (`toolCall.id` → wrapper `execute(toolCallId)`); Codex Responses uses the stream's `call_id`. A proxy must emit stable, per-tool-call ids for this binding to hold.
3. **Hook-side trust unchanged:** the attestation still depends on the client-side secret held by the hook (prior section); the tool-call id does not add trust, it adds collision-freedom.

## Per-client mechanisms

### pi (pi.dev · earendil-works/pi; omp is a port of pi-mono)

| Mechanism | Verdict | Evidence |
|---|---|---|
| Custom/provider headers | **PARTIAL** — static only | `ProviderHeaders = Record<string, string \| null>`; `ProviderConfig.headers` merged into the OpenAI client (`packages/ai/src/types.ts:110,116,154`; `packages/ai/src/api/openai-completions.ts:227-235,639-674`). No provenance or per-approval header. |
| Tool-approval hooks | **YES** — extension surface | `pi.on("tool_call", (event, ctx))` receives `event.input.command`, can `ctx.ui.select/confirm` and `{ block: true, reason }` (`packages/coding-agent/examples/extensions/permission-gate.ts`); harness bash tool exposes a `prepare` hook over `BashExecution.command` (`packages/agent/src/harness/tools/bash.ts:56-60`). No built-in command approval (security doc: extensions are the mechanism; project-trust gates extension loading, "not a sandbox"). |
| Local control endpoints | **PARTIAL** | llama.cpp router server (`/login llama.cpp`, `/llama` model management — pi.dev/docs/latest/providers). No approval-state endpoint. |
| Message provenance | **PARTIAL** | Session format persists tool calls; approval decisions are extension-internal, no signed record. |
| API boundary | Approval lives in the extension layer between model response and execution — invisible to the model endpoint. | |

### Codex CLI (openai/codex)

| Mechanism | Verdict | Evidence |
|---|---|---|
| Custom/provider headers | **PARTIAL** — static only | `ModelProviderInfo.http_headers` / `env_http_headers` per `[model_providers]` (`codex-rs/model-provider-info/src/lib.rs:113-120`); `x-openai-actor-authorization` (lib.rs:35). Static, not approval-derived. |
| Tool-approval hooks | **YES** — native hook system | Hooks (`hooks.json` / inline `[hooks]`) run `PreToolUse`, `PermissionRequest`, `PostToolUse` (learn.chatgpt.com/docs/hooks). `PreToolUse` receives `tool_name` + `tool_input` (JSON incl. `command` for Bash) and can **block** (exit 2 + stderr, or JSON decision) and **rewrite input** (`permissionDecision: allow` + `updatedInput`) (`codex-rs/core/src/hook_runtime.rs:168-224`). **`PermissionRequest` hooks receive the exact `tool_input` and can decide the approval** — `PermissionRequestDecision::Allow \| Deny{message}` (`codex-rs/hooks/src/events/permission_request.rs:36-59,151-201`). Closest native approval-decision surface of the four. |
| Local control endpoints | **PARTIAL** | `codex exec` JSON mode; app-server remote control (`codex-rs/cli/src/remote_control_cmd.rs`). No approval-state query. |
| Message provenance | **PARTIAL** | JSONL session transcripts (path passed to hooks as `transcript_path`) record tool calls/results; approval decisions are TUI-internal. |
| API boundary | `x-oai-attestation` header exists but is a host-integration **upstream** header, not an approval proof (`codex-rs/core/src/attestation.rs:8-13`). Approval prompt + hooks are client-side. | |

### Oh My Pi (omp) — richest surface

| Mechanism | Verdict | Evidence |
|---|---|---|
| Custom/provider headers | **PARTIAL** — static only | `apiKey` (env-var name) + `authHeader: true` → Bearer (`~/.omp/agent/models.yml`); gateway-specific headers only (Azure `api-key`, Copilot dynamic headers, Codex account headers — omp://provider-endpoint-constraints.md). No provenance header. |
| Approval tiers | **YES** | Tool tiers `read/write/exec`; tool policy `allow\|deny\|prompt`; user `tools.approval.<tool>`; modes `always-ask/write/yolo`; **`bash.patterns` deny is absolute, `prompt` forces a prompt, `allow` lowers the tier but never approves compound commands** (omp://approval-mode.md; omp://tools/bash.md). |
| Hooks | **YES** | `.omp/hooks/pre/*.ts` `tool_call` event → `{ block, reason, input }` (replace args) + `tool_result` override; `ctx.ui.confirm/select`; concrete safety-hook example (omp://hooks.md; omp://skills/examples/safety-hook/README.md). Fires before the underlying tool runs. |
| Local control | **PARTIAL→YES** | RPC mode: `bash` command + `extension_ui_request.confirm` frames + `tool_execution_start/end` events over stdio JSONL (omp://rpc.md) — a host can implement the approval UI and observe every tool call. ACP: client-gated `bash/edit/delete/move` route through `session/request_permission` (omp://approval-mode.md). No approval-state query endpoint. |
| API boundary | Approval prompt occurs post-response, pre-execution, in-process. A hook sees the exact command (including DCG-denied ones, since the wrapper fires before the tool's internal pattern check). | |

### DCG — the local destructive-command guard (omp config layer)

- **What it is:** the `bash.patterns` tier system in `~/.omp/agent/config.yml` — live config is an all-`deny` floor (~80 rules: `git push --force`, `rm -rf*`, `diskpart*`, `reg delete*`, `Stop-Service/Stop-Process` on firewall/BFE/svchost, `*FirewallPolicy*` writes, …). Tier semantics `allow\|prompt\|deny` per omp://approval-mode.md + omp://tools/bash.md. Drift-audit vocabulary names "DCG scope" = firewall/registry/service/elevation commands (harvest skill; `scripts/destructive-patterns.json` mirror, path unverified).
- **Verdict:** it is the **enforcement floor, not an attestation source**. Deny decisions are silent to outsiders; the `prompt` tier is the human-approval moment but the event is in-process — no webhook, no record. Its value for attestation: it makes the harness-side gate strict so a hook can rely on it.

## Gaps that prevent a trusted proof today

1. **No approval attestation primitive.** The model API axis (requests/responses) never carries approval state in any client.
2. **Static headers only.** pi `ProviderHeaders`, Codex `http_headers`, omp `authHeader` are config-time; none can bind a per-approval claim to one command.
3. **Hooks are unauthenticated, per-client, hand-wired.** pi/omp hooks run inside the model-adjacent process; Codex hooks are separate executables (stronger isolation). Nothing signs or nonce-binds a claim to the proxy.
4. **Command normalization breaks binding.** The model-emitted fenced command (this proxy: `packages/core/src/session.ts:429-438` rewrites M365 hosted-shell intent into a fenced `bash` block) may differ byte-wise from what executes after `cwd` rewrite / shell expansion. Attestation must bind the *exact string the tool executes*.
5. **No replay protection / TTL semantics** in any client — an attestation record needs nonce + expiry to be a proof.
6. **Trust anchor.** The proxy must trust a client-side secret; if the model can read it (in-process hooks), forgery is possible. Residual risk; Codex's separate hook processes are the cleanest model.

## Recommended integration contract (cross-client)

**Push model: pre-execution hook → proxy loopback control endpoint, HMAC-signed exact-command attestation; proxy fails closed.**

1. **Endpoint (loopback only):** `POST http://127.0.0.1:<proxy-port>/v1/attestations`
2. **Payload:** `{ client: "pi|codex|omp", tool: "bash", tool_call_id, command_sha256, command_excerpt, session_id, model_id, ts, nonce }` — `tool_call_id` is the proxy-issued id echoed back from the hook (see follow-up section; all three clients expose it pre-execution).
3. **Signature:** `HMAC-SHA256(secret)` in `X-Attestation-Sig`; secret from a shared file (e.g. `~/.config/opencode-m365/attestation.key`, owner-only), never exposed to the model.
4. **Proxy enforcement:** when emitting the fenced tool command (or before authorizing its execution), accept only an attestation with (a) matching `tool_call_id` AND `command_sha256` (primary binding; see fallback in follow-up section when a client cannot expose the id), (b) `ts` within TTL (e.g. 60 s), (c) unused `nonce`, (d) consistent `session_id`/`model_id` — else **fail closed** (deny execution, return error).
5. **Per-client wiring (same contract):**
   - **pi:** `.pi/extensions/` `tool_call` handler (permission-gate.ts pattern) → POST after `ctx.ui.confirm`.
   - **omp:** `.omp/hooks/pre/*.ts` `tool_call` handler → POST; optional ACP `session/request_permission` when running as an ACP host. DCG `bash.patterns` stays the deny floor (hook should not attest denied commands).
   - **Codex:** `hooks.json` `PreToolUse` (or `PermissionRequest`) handler script → POST with `tool_input.command`; can additionally return `permissionDecision` to be the gate itself.
6. **Why this one:** pre-execution hook/extension events with the exact command are the *only* mechanism present in all three harness clients; a config file + small hook script is client-agnostic; HMAC + nonce + TTL + sha256 binding gives the proxy a real proof; fail-closed preserves the 8H verifier's safety posture.

## Primary sources

- pi: https://github.com/earendil-works/pi (`packages/ai/src/types.ts`, `packages/ai/src/api/openai-completions.ts`, `packages/agent/src/harness/tools/bash.ts`, `packages/coding-agent/examples/extensions/permission-gate.ts`); https://pi.dev/docs/latest/providers, https://pi.dev/docs/latest/security
- Codex: https://github.com/openai/codex (`codex-rs/model-provider-info/src/lib.rs`, `codex-rs/core/src/hook_runtime.rs`, `codex-rs/hooks/src/events/permission_request.rs`, `codex-rs/core/src/attestation.rs`, `codex-rs/cli/src/remote_control_cmd.rs`); https://learn.chatgpt.com/docs/hooks
- omp: omp://approval-mode.md, omp://hooks.md, omp://tools/bash.md, omp://rpc.md, omp://provider-endpoint-constraints.md; `~/.omp/agent/config.yml` (DCG deny floor); `~/.omp/agent/models.yml`
- Follow-up (tool-call ID in hooks): pi `packages/coding-agent/src/core/extensions/types.ts:127-131,853-862`, `packages/coding-agent/src/core/agent-session.ts:490`; omp `packages/coding-agent/src/extensibility/hooks/types.ts:306-313`, `packages/coding-agent/src/extensibility/hooks/tool-wrapper.ts:35-50,78` (both repos public: https://github.com/earendil-works/pi, https://github.com/can1357/oh-my-pi); Codex `codex-rs/hooks/src/events/pre_tool_use.rs:24-35,172-193`, `codex-rs/hooks/src/events/permission_request.rs:36-49,178-189`, `codex-rs/core/src/tools/approvals.rs:40,310-313`, `codex-rs/core/src/exec.rs:290,1134`
- Local integration point: `packages/core/src/session.ts:254,429-438` (hosted-shell → fenced-bash interception)
