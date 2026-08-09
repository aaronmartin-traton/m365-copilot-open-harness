# Lane F — Custom Instructions as a persistent tool-format lever

- **Research date:** 2026-08-09 (all "current" claims as of this date)
- **Question:** can M365 Copilot's account-level **Custom instructions** feature act as a
  *persistent, server-side* instruction layer that makes the agent-less BizChat path emit
  fenced ```` ```bash ```` tool blocks — i.e. a lever that sits ABOVE or BESIDE Microsoft's
  BizChat system prompt (the "cage", `docs/prompt-engineering.md`), where our per-request
  instructions demonstrably do not? And does the feature reach the
  `substrate.office.com/m365Copilot/Chathub` endpoint this proxy drives at all?
- **Evidence labels:** [documented] = Microsoft support/Learn page statement ·
  [observed] = captured first-party or third-party wire traffic (repo captures, GitHub
  captures) · [code-verified] = read in a live implementation's source · [inference] =
  reasoning in this note, not directly observed. Repo pointers cite
  `docs/hypotheses.md` / `docs/m365-copilot-api.md` / `packages/core/src`.

---

## 0. Bottom line

1. **The feature is real, account-scoped, and documented.** Custom instructions are one of
   the three "Copilot Memory" channels (saved memories, chat-history inferences, custom
   instructions), set by the user in Copilot Chat → Settings → Personalization, stored in
   the user's **Exchange mailbox**, and applied by the server to future conversations
   (§1). Microsoft documents *what* it does but **not where in the prompt stack it lands**
   — that is the key unknown this lane exists to probe (§3).
2. **The first-party client reaches our exact endpoint WITH custom-instructions flags on
   every turn.** Two independent captures — our own GUI capture (June 25, repo) and a
   July 13 enterprise capture (OmniRoute #6334) — both show the working BizChat turn
   carrying `optionsSets: ["add_custom_instructions", "update_memory_plugin",
   "enable_inferred_memory_read", …]` + `MemoryUpdate` in `allowedMessageTypes` (§2.2).
   **No capture anywhere carries the instruction *text* in the chat frame** — the content
   is retrieved server-side; the client only sends gate flags (§2.5).
3. **The proxy sends NONE of these flags today** — agent-less path = code-interpreter
   optionsSets (+ image-gen/`M365_EXTRA_OPTIONSSETS`), nothing else. The gate flags are
   already probe-ready via `scripts/_probe-chat.mjs` `optionsSets` override (§2.1).
4. **The lever hypothesis is coherent and cheap to test.** If account-level instructions
   are injected at/above the system-prompt layer (unlike per-request text, which sits
   below the cage and is ignored or meta-analysed — F12/F17/F23), they could
   persistently steer fenced output on the agent-less path, harden the Claude path
   without per-request jailbreak-shape framing, and potentially open an agent-less tool
   path for GPT tones too. Evidence supports the injection-point assumption but does not
   prove it (§3).
5. **Cheap probe: 4 threads, sequential, rested account.** Set a format-only instruction
   via the real GUI, then one-turn `_probe-chat.mjs` probes with/without
   `add_custom_instructions`, measuring fence emission, `dea_violation`, and Disengaged
   rate (§5). Falsification criteria are explicit; total cost ≤ 4 of the 6-thread budget.

---

## 1. What the feature IS (primary docs)

### 1.1 Where users set it [documented]

`support.microsoft.com/.../customize-how-microsoft-365-copilot-responds-to-you`
(updated 2026-07-15):

1. Go to **Copilot Chat** (`https://m365.cloud.microsoft/chat`), sign in with the M365
   account.
2. **… Settings and more → Chat settings → Personalization**.
3. **Custom instructions** tile → toggle + **Edit instructions** → free-form compose box
   or suggested instructions → **Save instructions**.
4. "In future Copilot conversations, Copilot remembers your preferences and uses it to
   tailor its responses to your needs."

Microsoft's own example instruction is a **format preference**: *"When summarizing a
meeting, use bullet points for key details instead of paragraphs."* — format steering is
the intended use of the feature, which is exactly the shape this lane wants (a ```` ```bash ````
output-format preference), not an "act as an agent" role override.

### 1.2 What it applies to [documented + inference]

- It is a feature of **Microsoft 365 Copilot Chat (the work/BizChat surface)** —
  `m365.cloud.microsoft/chat`, the same front-end whose backend is the substrate BizChat
  endpoint this proxy drives (`docs/m365-copilot-api.md` §1).
- "Copilot memory is available to Copilot Chat users **with and without** a Microsoft 365
  Copilot license" [documented, admin doc]. So licensing our account may not have is not
  an expected gate.
- The feature is **in preview** ("Copilot personalization and memory are in preview and
  subject to change", part of the Frontier program) [documented] — treat any observed
  behaviour as volatile.
- **Consumer Copilot** (`copilot.microsoft.com`) is a separate product/account system:
  the M365 FAQ states work and personal accounts cannot be mixed in one session, and all
  custom-instructions docs live under the M365 Copilot product. The consumer app has its
  own memory/personalization surface, but its store and backend are not the BizChat ones
  [inference — no consumer-side wire capture examined; irrelevant to this proxy anyway].
- **Temporary chats bypass it:** "These conversations won't access or store any
  personalized information" [documented]. Conversely, normal chats access it — relevant
  because our proxy's conversations are normal (non-temporary) chats
  [inference: we send no temporary-chat marker; see §2.5 on the `disableMemory` URL flag].

### 1.3 Storage & admin control [documented]

From `learn.microsoft.com/en-us/microsoft-365/copilot/copilot-personalization-memory`
(admin doc, ms.date 2025-11-18):

- **Storage:** "Memories, which include saved memories, details inferred from chat history
  **and custom instructions**, are stored in the user's **Exchange mailbox in a hidden
  folder**" (`IPM.Contact` items inside a `CopilotMemory` folder), subject to the same
  security/compliance as mailbox data (Customer Lockbox, encryption at rest).
- **Admin kill-switch:** the tenant-level **Enhanced personalization control** (Microsoft
  Graph `enhancedPersonalizationSetting` resource), **ON by default**. "End-users that
  have the Enhanced personalization control turned off see the user-level controls for
  Custom instructions, Saved memories, and Chat history … as turned off. **They can't
  turn on these settings.**" A tenant admin can disable the whole family for the tenant
  or a group, at any time.
- **Disable ≠ delete:** "Copilot is stopped from **applying** custom instructions, but
  doesn't remove those custom instructions."
- **Discoverability:** custom instructions are **not** eDiscovery/Content-Search
  discoverable (only user-exportable); "Memory and personalization actions don't generate
  audit log entries in Purview"; admins cannot restrict what information is added.
  (Double-edged for us — see §4 risk (d).)

### 1.4 Length limit — NOT documented

No Microsoft page fetched states a character cap for custom instructions (checked the
customize page, the get-started page, the manage-memory page, the Copilot Chat FAQ).
One community walkthrough video reports the compose box holding "about 250 characters"
[community, unverified, Instagram reel — weakest source class]. The 8,000-char limit that
does exist is **Copilot Studio's** agent-instructions limit (unrelated; hypotheses H8.15).
**Probe step S0 doubles as the empirical cap measurement** (§5): if the UI truncates or
rejects the proposed text, record the actual limit.

### 1.5 Documented statement of WHERE it is injected — there isn't one

Closest documented statements:

- "Copilot remembers your preferences and uses it to **tailor its responses**" (support).
- Saved memories "become **part of the context** Copilot uses to generate responses"
  (manage-memory page) — and custom instructions are one of the three memory channels.
- Turning the control off makes Copilot "stop **applying**" them (admin doc) — i.e.
  application is a server-side per-turn decision, not client-side prepending.

Nothing documents stack position relative to the BizChat system prompt. That gap is what
§3 reasons about and §5 probes.

---

## 2. Does it reach the substrate BizChat endpoint the proxy drives?

### 2.1 What the proxy sends today [code-verified]

`packages/core/src/session.ts` (`sendChat`, `optionsSets` construction ~L536–550):

- Agent-less path: `CODE_INTERPRETER_OPTIONS_SETS` (the 5 `cwc_code_interpreter*` flags,
  on by default; `M365_NO_CODE_INTERPRETER=1` disables) — confirmed live in §8.9.
- `IMAGE_GEN_OPTIONS_SETS` only when image generation is requested; image-*input*
  optionsSets only when attachments are present.
- `M365_EXTRA_OPTIONSSETS` (comma-sep env) merges arbitrary flags on any path — added for
  the F17 GUI-optionsSets test (which proved optionsSets do NOT rescue the agent path).
- **No `add_custom_instructions`, `update_memory_plugin`, or
  `enable_inferred_memory_read` anywhere in the default path.** [code-verified, grep]
- `scripts/_probe-chat.mjs::oneTurn` already accepts `optionsSets` / `extraAllowed` /
  `plugins` / `variants` overrides (§8.9 "Probes added") — the probe needs **zero new
  plumbing**.

### 2.2 Captured first-party frames: the flags ARE in live turns [observed]

| Capture | Date | Source | Memory/custom-instructions signals |
|---|---|---|---|
| **Our own GUI capture** (`scripts/m365-gui-capture.mjs`, headless Playwright on the real `m365.cloud.microsoft` client; hypotheses.md F17 section, ~L340) | 2026-06-25 | repo | GUI turn sends `threadLevelGptId: {}` (no agent), `tone: Magic`, and rich `optionsSets` incl. **`update_memory_plugin`, `add_custom_instructions`**, `cwc_code_interpreter*`, flux/image flags |
| **OmniRoute #6334 enterprise capture** (sanitized working turn from a Premium work account's own browser session, `result.value: "Success"`) | 2026-07-13 | [github.com/diegosouzapw/OmniRoute/issues/6334](https://github.com/diegosouzapw/OmniRoute/issues/6334) | `optionsSets` incl. **`update_memory_plugin`, `add_custom_instructions`, `enable_inferred_memory_read`, `agent_recommendations`**; `allowedMessageTypes` incl. **`MemoryUpdate`**; `contentOrigin: DeepLeo` |
| OmniRoute #6210 (EDU-tier) optionsSets snippet | 2026-06 | same tracker | also lists `add_custom_instructions` |

Two independent captures, five weeks apart, both on the exact endpoint family we drive,
both with the flags in the *working* turn. Strong evidence the flags are part of the
normal first-party turn shape, not an experiment.

Capture caveat: the OmniRoute capture's host was `substrate.svc.cloud.microsoft` (the
capture notes `substrate.office.com` still accepts the handshake because the token's
`aud` is `substrate.office.com/sydney`). Our proxy uses `substrate.office.com` and it
serves us fine (all repo results). If the probe mysteriously no-ops, host is a
second-order variable to try (§5 step T5 note). [observed + inference]

### 2.3 Reference implementations [code-verified]

- **kuchris/m365-copilot-openai-proxy** (`src/m365_copilot_openai_proxy/substrate_client.py`):
  default `_OPTIONS_SETS` sent on **every** turn include `update_memory_plugin` and
  `add_custom_instructions` (no `enable_inferred_memory_read`); `allowedMessageTypes`
  includes `MemoryUpdate`. Its `m365-copilot:persist` model suffix is **session reuse**
  (same `ConversationId` across HTTP calls via `x-m365-session-id`), *not* a memory-write
  mechanism — correcting the §8.8 shorthand "a persist model on memory flags": the memory
  flags are simply in its always-on optionsSets, the `:persist` suffix is conversation
  pinning. [code-verified, read from main branch 2026-08-09]
- **microsoft/PyRIT** (`pyrit/prompt_target/websocket_copilot_target.py`, repo moved from
  Azure/PyRIT): Microsoft's own red-team harness sends a rich optionsSets
  (`enterprise_flux_*`, `enterprise_flux_work_code_interpreter`,
  `enable_batch_token_processing`, …) but **no memory/custom-instruction flags** in the
  current version. [code-verified] Interpretation: the flags are not load-bearing for a
  turn to succeed (PyRIT works without them), so sending them is low-risk, and whatever
  they gate is additive — consistent with "server applies account memory when asked".
  [inference]

### 2.4 The flag set

| Flag (optionsSets) | Putative role | Seen in |
|---|---|---|
| `add_custom_instructions` | apply account custom instructions to this turn | GUI capture, OmniRoute ×2, kuchris |
| `update_memory_plugin` | enable the memory-write path (chat "remember X" → `MemoryUpdate` frames → mailbox) | same |
| `enable_inferred_memory_read` | apply chat-history-inferred memories | OmniRoute 6334 |
| `allowedMessageTypes: "MemoryUpdate"` | permit memory-control frames in the response | GUI/PyRIT-era lists, kuchris, OmniRoute |

Roles are putative (names + co-occurrence); none is documented. [inference on roles,
observed on presence]

### 2.5 No `customInstructions` field in any captured chat frame [observed + grep]

Repo-wide grep (`customInstructions|add_custom_instructions|update_memory_plugin|…`)
finds the flags only in hypotheses/experiments text — **no captured frame anywhere in the
repo carries an instruction-text field**, and neither the OmniRoute capture nor kuchris's
payload contains one. Combined with the mailbox-storage doc (§1.3), the design is
[inference, high confidence]: **the server retrieves the instruction text itself, keyed
by the authenticated identity (`oid` in the Chathub URL/token), when the per-turn gate
flag is present. The client's only job is the flag.** Consequence: our proxy — which
already authenticates as the same `oid` and matches the GUI's `scenario`/`agentHost`/
`source`/`clientPlatform` — needs to add at most one optionsSet string.

Adjacent evidence the gate is per-request, not session-type: the temporary-chat opt-out
is a client signal (edlaver's captured `disableMemory=1` URL flag, §8.8) [observed in a
third-party capture], implying memory application toggles per request. [inference]

---

## 3. Injection-point analysis — the actual hypothesis

### 3.1 The cage, restated [observed, repo]

`docs/prompt-engineering.md` "The cage theory" + api doc §10 + hypotheses §9 F12:
Microsoft's server-side BizChat system prompt sits **above** our per-request instructions
in priority and defines the model as a retrieval chat assistant. Per-request "be an
agent / emit a tool call" framing is refused or meta-analysed (F17/F23). The two levers
that work today:

1. **Copilot Studio declarative agent** — its server-side system prompt carries the tool
   contract (works, but overrides tone to GPT-5, and its classifier Disengages on benign
   substitution-shaped asks: F17 15/15 on `edit-config`).
2. **Agent-less shell-routing** on Claude tones — the cage *encourages* "write the shell
   command a user would run", so ```` ```bash ```` fences come out and the proxy routes
   them (F23: 8/8 fix-bug on claude-sonnet, Disengage-immune).

### 3.2 Hypothesis H-CI

**Account-level custom instructions are injected by the server at or above the BizChat
system-prompt layer (i.e. ABOVE or BESIDE the cage, not below it like per-request user
text).** If so, a saved instruction such as "answer shell-request prompts with a single
```` ```bash ```` fenced block" becomes a *persistent* format steer on the agent-less path:
no per-request framing (lower jailbreak shape → lower `dea_violation`), no Copilot Studio
agent (no F17 agent-path classifier, no tone override), surviving across conversations
without burning context every turn (the H8.14 payoff, now with a documented feature as
its substrate). [inference — this is the lane thesis]

### 3.3 Evidence SUPPORTING the above/beside-cage assumption

1. **Cross-conversation persistence is documented.** Instructions apply to "future
   conversations". User-message content cannot persist across conversations server-side
   (our §F11-style secret-planting only persists *within* a conversation's context);
   something applied to *new* conversations must be fetched and injected at turn
   assembly, alongside or above the system prompt. [documented + inference, strong]
2. **The flags ride agent-less GUI turns.** Both captures show them with
   `threadLevelGptId: {}` and `tone: Magic`, i.e. on the exact DeepLeo agent-less path
   our proxy uses — the first-party client expects them to take effect *without* an
   agent. [observed]
3. **Identity-keyed retrieval.** Storage in the user's mailbox + `oid` in the Chathub
   path means the server can apply them regardless of which client sent the turn.
   [documented + inference]
4. **Analogy.** The feature mirrors ChatGPT's "custom instructions", which OpenAI applies
   at system level. Same name, same UX shape, launched the year after. [inference, weak
   — different vendor, no public statement for M365]

### 3.4 Evidence CONTRADICTING / open unknowns

1. **No documented stack position.** It may be injected as *user-preference context*
   (e.g. an "about the user" block) **below** the system prompt — in which case the cage
   still dominates and format adherence is probabilistic, not guaranteed. Nothing rules
   this out. [unknown — probe decides]
2. **Even if above the system prompt, it is below the safety layer.** Classifiers
   (`dea_violation`, Disengaged) sit above everything; instruction text that reads like
   a directive ("never say you can't run commands") could itself raise scores on every
   turn it is applied to. F17 proved an *agent-path* classifier fires on benign shapes —
   a memory-pipeline classifier is not ruled out. [unknown — probe measures]
3. **Preview volatility.** Injection point can move silently (Frontier/preview). Any win
   needs a regression canary (cheap: re-run T1 periodically). [documented preview status
   + inference]
4. **PyRIT's omission** (§2.3) is neutral-to-negative evidence that the flags are
   load-bearing for *anything* observable — nobody has publicly verified the channel
   changes model output via API-driven turns. [inference]

---

## 4. Risks

**(a) Applies only to interactive-UI sessions, not API-driven turns.**
For: application could be gated on some UI-only session attribute we don't send, or on
an entitlement check tied to the Enhanced-personalization rollout state of the `oid`.
Against: the gate appears to be a per-request optionsSet flag (§2.5); our payload already
matches the GUI's `source`/`scenario`/`agentHost`/`clientInfo` shape (api doc §4); the
turn-level opt-out is itself a request marker (`disableMemory`). kuchris ships the flags
on API turns but there's no public confirmation they *verified* effect. The probe's T1
vs T2 contrast settles this directly; if flag-on fails, a GUI-emulation diff (as in the
F17 in-GUI-context test) is the escalation. [mixed — untested]

**(b) Tenant/admin policy disables it.**
The Enhanced personalization control is ON by default but can be turned off per
tenant/group via Graph, which force-greys the user toggle (§1.3). Our test tenant's state
is unknown. **Pre-flight check:** open the Personalization settings in the GUI — greyed
toggles = tenant-disabled = lever dead on this tenant, stop (zero thread cost). Also:
the feature is preview — Microsoft can withdraw it. [documented mechanism, unknown state]

**(c) Added jailbreak-shape surface → higher dea / Disengaged rate.**
Instruction text is persistent context on every applied turn. Mitigations in the probe
design: format-only wording (no role-override, no "ignore previous", no NEVER/MUST
barrage — the shapes F10/F22/§12 identified as hot); measure `dea_violation` and
Disengaged rate against same-prompt baselines in the same run; abort criterion defined
up front (§5). Note the instruction is *short* (~200 chars) compared to the per-request
framing it could replace — net jailbreak-shape surface likely *decreases* if the lever
works. [inference, mitigated by design]

**(d) Detection-profile considerations (§11 logic: coherence beats spoofing).**
- **Fingerprint-positive:** adding `add_custom_instructions`/`update_memory_plugin` makes
  our turns *more* like the first-party GUI's (both captures carry them) — reduces, not
  adds, API-vs-GUI divergence.
- **Setting them is normal-user behaviour:** one settings-UI action, no chat turns, no
  audit-log entries for personalization actions [documented], not eDiscovery-visible
  [documented].
- **Avoid chat-driven memory writes during probes:** `update_memory_plugin` enables
  "remember this" → `MemoryUpdate` frames + mailbox churn. The probe uses the settings
  UI (one-shot), not chat-planted memories, to keep the account's behavioural profile
  boring. [inference]
- **Residual forensic trace:** if the account is ever scrutinized, the mailbox contains
  a saved instruction demanding shell-block output — an automation-flavoured artefact.
  Accepted risk on a dedicated test account; cleanup step deletes the instruction after
  the probe. [speculative]

---

## 5. Cheap probe — E-CI (hypothesis format per `docs/experiments.md`)

### E-CI — Custom instructions as an agent-less format lever (H-CI)

- **Hypothesis (H-CI):** account-level custom instructions, when the turn carries
  `optionsSets:["add_custom_instructions"]`, are applied server-side to **API-driven,
  agent-less** turns on `substrate.office.com`, and steer output format (fenced ```` ```bash ````
  emission) persistently across new conversations.
- **Prediction:** with the instruction saved and the flag present, a bare "run this
  command" turn emits a ```` ```bash ```` fence **≥2/2** (each probe is a *fresh*
  conversation, so this simultaneously proves cross-conversation persistence); the
  no-flag control emits fences at the much-lower agent-less baseline rate (repo history:
  ~1/3 on minimal framing, 0/4 on baseline — §F17/GUI-capture section).
- **Falsification criteria (any one kills or reshapes the lever):**
  1. Flag-on fence rate 0/2 with instructions confirmed saved → instructions don't reach
     API-driven turns (UI-only or extra gate) → lever dead as designed; escalation =
     GUI-emulate diff on a turn with instructions active (F17 method).
  2. Flag-on == flag-off at ≥2/2 → the flag is not the gate (server applies unconditionally
     — rerun without any memory flags; the lever works *without* touching optionsSets,
     which is even better).
  3. Flag-on == flag-off at 0/2 → the saved instruction isn't being honoured at all
     (injected below the cage, or not injected) → lever dead.
  4. Disengaged rate on flag-on turns > 0 while control is 0, or `dea_violation` jumps
     ≥1 order of magnitude vs control (baseline band per api doc §6: clean ~1e-8…1e-6) →
     filter-risk realized → do not ship (§4c).

### Setup S0 — zero thread cost

1. **Rested account** (≥24 h idle or `pong` probe shows clean throttle; §M/F24 lesson:
   back-to-back fresh threads self-throttle and poison A/Bs).
2. Open the real GUI (`m365.cloud.microsoft/chat`) → Chat settings → Personalization:
   - toggle greyed/forced off → risk (b) realized; record and stop.
   - otherwise verify Custom instructions toggle is ON.
3. **Save instructions** via the GUI (manual, ~2 min; or Playwright reusing `auth.ts`'s
   persistent profile). Proposed text (format-only, no role override, no cage-fighting):

   > When I ask you to run, test, or check something, answer with the exact shell command
   > inside a single ```bash code block. Do not explain that you cannot run commands.

   If the compose box truncates or rejects it, **record the true character cap** (§1.4
   gap closed) and shorten accordingly.
4. Confirm no recent threads on the account (chat list) so throttle is clean.

### Probe turns — `scripts/_probe-chat.mjs` oneTurn, sequential, 60 s cooldowns

All turns: `agentId: null`, `streamingMode: "ConciseWithPadding"`, capture `fullText`,
`disengaged`, `scores`, `contentOrigin`, `messageTypes`, `throttle`, `serviceVersion`,
`elapsedMs`. One thread each (fresh conversation per turn — that IS the persistence test).

| # | Arm | Options | Prompt | Reads |
|---|---|---|---|---|
| T1 | flag-on, `magic` | `optionsSets:["add_custom_instructions"]` | "Run `echo M365_CI_SENTINEL_<ts>` and show me the output." | fence? sentinel in fence? dea; Disengaged?; `MemoryUpdate` frames? |
| T2 | control, `magic` | `optionsSets: []` (identical otherwise) | same prompt | same reads |
| T3 | flag-on, `Claude_Sonnet` | `optionsSets:["add_custom_instructions"]`, `tone:"Claude_Sonnet"` | same prompt | does the lever work on the Claude agent-less path (our actual tool path)? |
| T4 | flag-on triplet, `magic` | `optionsSets:["add_custom_instructions","update_memory_plugin","enable_inferred_memory_read"]` + `extraAllowed:["MemoryUpdate"]` | same prompt | is the single flag enough, or does application need the full GUI triplet? |

- **Cost:** 4 threads (budget was <6). Optional T5 (only if T1 no-ops weirdly): repeat T1
  against `substrate.svc.cloud.microsoft` host (§2.2 caveat) — +1 thread.
- **Cadence:** strictly sequential, ≥60 s cooldown; stop-and-wait-15-min if any
  empty/Disengaged spike (experiments.md discipline).

### Measurements & decision

Per turn: tool-fence emission (bool/count, ```` ```bash ```` regex as in `fenced.ts`),
sentinel presence, `dea_violation`, `BotOffense`, Disengaged bool, `contentOrigin`
(must be `DeepLeo` to count as model output), latency, throttle counter.

| Result pattern | Verdict | Next |
|---|---|---|
| T1 ≥2/2 fences (run twice if 1/1), T2 lower, dea flat | **Lever works; flag is the gate** | Wire `add_custom_instructions` into the agent-less path behind `M365_CUSTOM_INSTRUCTIONS=1`; then a 2-task bench (fix-bug, count-lines) claude-sonnet ± lever to measure framing replacement |
| T1 ≥2/2, T2 also ≥2/2 | Flag not the gate; applied unconditionally | Same wiring minus the flag; verify with a second account or post-cleanup run |
| T3 passes even if T1 fails | Claude-path-only effect (still valuable — replaces per-request framing, lowers dea) | Claude-only wiring |
| T1/T2 both 0/2 | Instructions ignored on API path | Kill lever; record in hypotheses.md §8.4 as H8.14-adjacent ⚫ |
| Any Disengaged / dea ≥10× | Risk (c) realized | Kill lever; keep the data point |

### Cleanup (zero thread cost)

Delete the saved instruction via GUI (restore pristine account), note final throttle
counter, file results into `docs/hypotheses.md` §8.4 with n/service-version per §M.

### Why this probe is well-formed (repo-method checks)

- One variable per arm (flag / tone / flag-set); same prompt text everywhere.
- Unfakeable read: fence + sentinel emission is mechanically checkable; the sentinel
  string is unique per run.
- Rested account + spacing controls F13/F24 thread-rate confound.
- ≤4 threads, sequential — well under the 6-thread ceiling and cheaper than any
  agent-rebuild alternative (H8.13/H8.2 route).

---

## 6. What a win buys (and what it doesn't)

- **Buys:** persistent format steer without per-request framing (less jailbreak shape on
  every turn → lower dea, per §4c reasoning); agent-less path hardening for the Claude
  tool path (F23's winner); possibly an agent-less tool path for GPT tones (F23 showed
  agent-less `magic` at 0/4 fences — H-CI is the first lever aimed at moving *that*
  number without an agent); H8.14's "stateful steering without burning context" payoff
  with a documented feature underneath.
- **Doesn't buy:** native tool execution (still prompt-emulated shell-routing), GPT-tone
  tool use without further evidence, anything about the agent path (F17's classifier is
  attached to `threadLevelGptId`, independent of optionsSets — §F17 GUI test already
  proved optionsSets don't rescue it).
- **Interaction with existing levers:** complementary to shell-routing (F12), not a
  replacement — it asks for the *same* ```` ```bash ```` output the cage already permits,
  just from a higher-precedence seat.

---

## Sources

**Microsoft (primary):**
- Customize how Microsoft 365 Copilot responds to you — <https://support.microsoft.com/en-us/microsoft-365-copilot/customize-how-microsoft-365-copilot-responds-to-you> (fetched 2026-08-09)
- Manage Copilot personalization and memory (admin) — <https://learn.microsoft.com/en-us/microsoft-365/copilot/copilot-personalization-memory>
- Microsoft 365 Copilot enhanced personalization control (Graph) — <https://learn.microsoft.com/en-us/graph/control-enhanced-personalization-privacy>
- Personalize what Microsoft 365 Copilot remembers — <https://support.microsoft.com/en-us/topic/cba7b79a-c46f-4ca7-b46e-2fa22c563f90>
- Manage Copilot Memory in Microsoft 365 Copilot — <https://support.microsoft.com/en-us/microsoft-365-copilot/manage-copilot-memory-in-microsoft-365-copilot>
- Copilot Chat FAQ — <https://support.microsoft.com/en-us/topic/6f4e0ad9-d354-461e-8640-03d1629febfc>

**Implementations & captures (read 2026-08-09):**
- kuchris/m365-copilot-openai-proxy, `src/m365_copilot_openai_proxy/substrate_client.py` + `app.py` — <https://github.com/kuchris/m365-copilot-openai-proxy>
- microsoft/PyRIT, `pyrit/prompt_target/websocket_copilot_target.py` — <https://github.com/microsoft/PyRIT> (moved from Azure/PyRIT)
- OmniRoute #6334 — working enterprise BizChat capture (July 13 2026) with memory/custom-instruction optionsSets — <https://github.com/diegosouzapw/OmniRoute/issues/6334>; #6210 optionsSets snippet — <https://github.com/diegosouzapw/OmniRoute/issues/6210>

**Community (unverified):**
- Custom-instructions compose box "about 250 characters" — Instagram walkthrough reel <https://www.instagram.com/reel/DXhG0m3jNVA/> (weakest source class; probe S0 measures the real cap)
- Feature announcement context (Wave 2 spring 2025) — <https://www.microsoft.com/en-us/microsoft-365/blog/2025/04/23/microsoft-365-copilot-built-for-the-era-of-human-agent-collaboration/>

**Repo (internal):**
- `docs/hypotheses.md` — §8.4 H8.14 (memory/custom-instructions channel, 🔴), §8.8–8.9 (optionsSets catalogue, probe plumbing), F17 section (GUI capture: flags in first-party turn; optionsSets don't rescue agent path), F23/F24 (agent-less Claude path, thread-rate confound), §11 (detection-profile logic)
- `docs/experiments.md` — E-O2 (prior memory probe sketch, superseded by E-CI here), setup/discipline rules
- `docs/m365-copilot-api.md` — §1 endpoint, §4 turn shape, §5 optionsSets history, §6 scores/`dea_violation`, §10 cage/tool-calling
- `docs/prompt-engineering.md` — "The cage theory", load-bearing levers
- `packages/core/src/session.ts` — current optionsSets construction (`CODE_INTERPRETER_OPTIONS_SETS`, `M365_EXTRA_OPTIONSSETS`)
- `scripts/_probe-chat.mjs` — oneTurn override surface the probe uses
