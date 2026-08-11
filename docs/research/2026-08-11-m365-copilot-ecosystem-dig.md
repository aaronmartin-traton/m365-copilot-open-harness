# M365 Copilot knowledge-gap + ecosystem dig (2026-08-11)

Deep research pass (DSV4 subagent, in parallel with the capture-browser fix).
Scope: four knowledge gaps + an ecosystem scan of projects exposing M365
Copilot with tunable knobs. Read-only — no live probes, no threads spent.

## Section 1 — Knowledge-gap findings

### 1.1 Token / quota surface (challenges F5)

- **F5 stands, strengthened.** The 2026-08-11 browser-headers re-run
  (`usage-endpoint-hunt-v2.mjs`) falsified header-gating: Sydney REST
  siblings return header-independent 500s. No new per-user REST token
  endpoint surfaced. Confidence: **High** that no self-service token-usage
  surface exists on the BizChat path.
- **NEW — admin-gated usage exists, as prompt counts, not tokens.**
  MC1423101 (2026-07-10): `GET /v1.0/copilot/reports/
  getMicrosoft365CopilotUsageUserDetail(period=D28, version=v2)` exposes
  user-level **prompt counts** + active-day metrics. Requires `Reports.Read.All`
  + a limited admin role. **Unlicensed Copilot Chat is explicitly NOT in
  Graph** ("future release"); only Admin Center report / Purview audit /
  `Search-UnifiedAuditLog` / O365 Management Activity API reach it.
  Confidence: **High** (primary MS docs).
- **Closest per-message oracle stays the audit schema**
  (RecordType 261, `Messages[].Size`, `ModelTransparencyDetails.ModelName`) —
  admin-gated, already H8.22. Copilot Credits (1/2/5/10) remain the only cost
  metering, only on the licensed Studio-agent path (§8.5 guardrail).

**Implication:** no change — F5's "correctly empty" reading is right. The
proxy's `usage.x_m365_*` conversation-quota block is the only client-facing
metering worth keeping. The admin-only prompt-count surface is unreachable for
a zero-cost account and counts ≠ tokens. Do not re-hunt REST siblings.

### 1.2 Custom instructions + memory mechanics

- **Storage model confirmed** by two independent 2026 sources: saved memories,
  chat-history inferences, and custom instructions live in the user's Exchange
  mailbox, hidden `CopilotMemory` folder under Contacts, as `IPM.Contact`
  items; tenant kill-switch = Graph `enhancedPersonalizationSetting` (beta),
  ON by default.
- **NEW — programmatic read/export of *memories* exists, admin-gated:**
  Purview eDiscovery searches `IPM.Contact` to find/export/delete saved +
  inferred memories (Graph `purgeData`, 10 items/mailbox); BizChat
  prompt/response items are `IPM.SkypeTeams.Message.Copilot.BizChat`.
  **Custom instructions are NOT eDiscovery-discoverable** — user exports from
  Settings only. Confidence: **High** (memories), **Medium-High** (instructions
  non-discoverability).
- **No API returns instruction TEXT.** No 2026 source documents any endpoint
  returning custom-instruction content; the client only sends gate flags
  (`add_custom_instructions`, `update_memory_plugin`,
  `enable_inferred_memory_read`) and the server retrieves the text keyed by
  `oid` [inference, high — lane F §2.5]. No public doc names
  `add_custom_instructions`; evidence remains captures (repo GUI 2026-06-25,
  OmniRoute #6334) + kuchris code.

**Implication:** the flag-as-gate question stays probe-decidable only — lane
F's probe (4 threads, `_probe-chat.mjs` optionsSets override) is the cheapest
path. Programmatic *reading* of instruction text is a documented dead end.
**Bonus [inference]:** if `update_memory_plugin`'s write side works, the proxy
could persist steering (e.g. a fenced-format instruction) into the account
mailbox via chat turns, and the token already carries `Mail.ReadWrite` (api
doc §2) to read it back via Graph — an **undocumented self-service memory
channel**. Worth a probe.

### 1.3 Copilot Tuning (updates §8.13)

- **Still early access as of July 2026.** Tuning overview (2026-06-11) and FAQ
  (2026-07-15) still carry "limited set of customers… Access through Frontier
  **planned for April 2026**" — Frontier access has not shipped/documented as
  of this pass. Confidence: **Medium-High** (docs may lag; no GA announcement).
- **NEW — three tuning dimensions:** Tune Context / Tune Tools / Tune Model
  (SFT/RL via a reinforcement-learning environment); tunable templates (doc
  writing, summary, expert answers, validation, style editing, optimization)
  in Agent Builder, by **Copilot-licensed users in eligible tenants**,
  admin-config gated. Confidence: **High**.
- **Frontier Tuning (Build, 2026-06-02):** private preview delivered only via
  Forward Deployed Engineer engagements; "upcoming" in Copilot Studio +
  Foundry; named customers are enterprises (EY, Pearson, McKinsey…) — **no
  self-serve or free path exists**. [self-reported]

**Implication:** §8.13's verdict is unchanged — **watch item, not a probe**.
No license-free path appeared; tuning stays tenant-admin + Copilot-license
gated, so it cannot affect the zero-cost premise or the locked native-tooling
decision (it is a format/tone lever, not a tool-attachment lever). Revisit only
if Frontier ships a no-cost lane.

### 1.4 Throttling / degradation model (updates F13/§18, H8.20)

- **NEW — documented RPM anchor for the agent path.** Copilot Studio quotas
  (2026-08-04): generative-AI messages per Dataverse env = **100 RPM / 2,000
  RPH for "Microsoft 365 Copilot users"**; trial/dev 10 RPM/200 RPH; PAYG 100
  RPM/2,000 RPH. The proxy's tool agent rides the Studio `minimalBots` path —
  closest published figure to H8.20's guessed 100 RPM. Confidence: **High**
  (doc); transfer to the chat/thread-rate path is [inference].
- **Consumer side shows the feature-limit shape only:** M365
  Personal/Family/Premium (2026-07-15) have per-feature limits + AI credits
  (Vision 10–15 min/day, Voice 30–60 min/day, Agents 25 tasks/month, 60
  credits/month for Copilot-in-apps; Chat "extensive use"; Premium = "Priority
  access"). Confidence: **High** (doc); applicability to work BizChat: **Low**.
- **Work Copilot Chat still publishes no numeric limits.** No 2025–26 public
  info on thread-rate throttling or per-conversation caps beyond "standard
  access limits apply" (MS Q&A 2026-04-23, cited repo §18) and community "this
  conversation has reached its limit" reports. Confidence: **Medium** in the
  absence.

**Implication:** F13/§18 remain the best model — binding limit is thread-rate
per `oid`, recovered by idle; the 12 threads/hr budget stands. The 100 RPM
figure gives H8.20 a calibration target and suggests per-agent RPM is *not*
the binding constraint for a one-conversation-per-session proxy (a real pi
loop is one thread ≪ 100 RPM). No public numbers justify changing the backoff
design.

## Section 2 — Ecosystem scan

Metadata via GitHub API 2026-08-10 unless noted. "Knobs" = operator-tunable
parameters.

| Project | Exposes | Tunable knobs | License | Maintained |
|---|---|---|---|---|
| **HEXUXIU/M365-Copilot2API** | Go gateway: OpenAI + Anthropic + Responses over Chathub | **Richest catalog found**: `M365_TOOL_PLANNING_MODE` (router/native), max tool calls/rounds, web-search toggle, context-similarity session reuse, multi-account rotation, proxy pool, usage stats, image in/gen, **MCP tool gateway**, `reasoning_effort` mapping | MIT | 149★, push 2026-08-10 (very active) |
| **kuchris/m365-copilot-openai-proxy** | Enterprise BizChat as OpenAI-compatible proxy | Always-on optionsSets incl. `update_memory_plugin` + `add_custom_instructions` + `MemoryUpdate`; `:persist` suffix = conversation pinning (lane F correction) | Apache-2.0 | 57★, 2026-06-01 (slowing) |
| **cramt/m365-copilot-proxy** | Same Chathub→OpenAI proxy (this repo's lineage) | tone map, framing variants, agent attach, `M365_EXTRA_OPTIONSSETS`, code-interpreter flags, conversation reuse; OpenClaw plugin + NixOS module | MIT | 52★, 2026-08-06 (active) |
| **microsoft/PyRIT** | Red-team harness; `websocket_copilot_target.py` + `playwright_copilot_target.py` | Rich optionsSets (`enterprise_flux_*`, `skdsstore*`, `enable_response_action_processing`, interstitials), `X-Variants`, image upload; **no memory flags** | MIT | 4,277★, active |
| **diegosouzapw/OmniRoute** | 290+ provider gateway incl. `copilot-m365-web` (Chathub, cookie auth) + consumer `copilot-web` | Tone models only (`copilot-m365`, `-claude-opus`, `-gpt-5-6-reasoning`, `-gpt-5-5-chat`); **`toolCalling: false`** — chat-only | MIT | 45,223★, active |
| **notBlubbll/g365-headless-relay** | Enterprise BizChat relay | `Gpt_5_5_*` tone map, rich optionsSets, `SwitchRespondingEndpoint` (repo §8.8) | — | exists |
| **edlaver/m365-copilot-bun-proxy** | Bun-based BizChat proxy | `disableMemory=1` URL flag (temp chat), `enterprise_flux_*` optionsSets (repo §8.8) | — | exists |
| **juzeon/SydneyQt** | Consumer Bing/Sydney (same lineage, other host) | `nosearchall` toggle, `codeintfile`/`sdretrieval`/`ldqa`/`gptv*` optionsSets, `kblob` upload (repo §8.8) | Unlicense | 879★, 2024-11 (stale) |
| **Azure-Samples/m365-custom-engine-agents** | Official "proxy agent" via M365 Agents SDK — licensed surface, not the Chathub hack | SDK-level engine config | MIT | 21★, 2026-02 |
| **guberm/chatgpt-web-provider** / **andeya/token-free-gateway** | ChatGPT.com web facades (NOT M365) | browser-backed, token-free patterns only | MIT | active-ish |

**Prose.** No published "knob catalog" document exists — the only catalogs are
these codebases' constants plus this repo's §8.8 table. Two leaders:
**M365-Copilot2API** (broadest operator surface: planning mode, tool caps,
search toggle, account pools, usage metering, MCP gateway; claims OpenAI
function-calling ⇄ M365 tool-protocol conversion with router/native modes
[self-reported] — read `internal/chathub` + `internal/mcp` for a possible
native-tool angle) and **kuchris** (memory flags, already mined). **PyRIT**
gives canonical enterprise optionsSets but no memory flags; **OmniRoute's**
M365 provider is deliberately tool-less; **g365/edlaver** contribute
`SwitchRespondingEndpoint` and `disableMemory`; **SydneyQt** is the stale
consumer reference. The ecosystem is small, MIT/Apache-licensed, and every
project's knob surface is a subset of what this proxy already controls via env
(tones, framing variants, agent attach).

## Follow-ups worth an issue

1. **M365-Copilot2API knob mining** — its `internal/chathub` + `internal/mcp`
   likely hold optionsSets/variants this repo hasn't tried. Cross-check against
   §8.8.
2. **Memory-write channel [inference]** — probe whether a chat turn with
   `update_memory_plugin` persists a fenced-format instruction into the
   mailbox, then read it back via Graph `Mail.ReadWrite` (token already has the
   scope). Undocumented self-service steering.
3. **H8.20 RPM calibration** — set the 100 RPM / 2,000 RPH figure as the
   agent-path calibration target.