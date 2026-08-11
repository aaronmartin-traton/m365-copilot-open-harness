# M365 programmatic-injection ideation + GLM-5.2 cross-check (2026-08-11)

Source: ADHD skill fan-out (2 rounds, 10 frames, 60 ideas) on "expose more of
M365 so we can inject steering/tools/instructions programmatically", then an
independent adversarial judge (GLM-5.2 via Command Code pane) scored the 8
best ideas. This note records the ideas, the cross-check, and the reconciled
verdict.

## Problem

`m365-copilot-proxy` wraps M365 Copilot's undocumented Chathub WebSocket in an
OpenAI-compatible proxy. Goal: inject our steering/instructions/tools into the
M365-served model programmatically, on a zero-cost "Copilot Chat (Basic)"
license where native tool-calling / MCP is LOCKED OUT.

## Established facts (2026-08-11)

- Custom-instructions is an EMPTY, settable `<textarea>` (Settings→Personalization,
  writable via CDP). Server applies it to turns sending `add_custom_instructions`.
- OptionsSets flags honored server-side: `add_custom_instructions`,
  `update_memory_plugin`, `enable_inferred_memory_read`.
- Token carries Graph `Mail.ReadWrite` (mailbox readback possible).
- Memory lives in the Exchange mailbox (`CopilotMemory` folder, `IPM.Contact`).
- Org-gate: sideloading requires Teams admin "Upload custom apps"=On
  (`Set-CsTeamsAppSetupPolicy -AllowUserToUploadCustomApps`); else agents go
  through org catalog + M365 admin approval.
- Confirmed tooling: `atk` (M365 Agents Toolkit CLI), `pac` (Copilot Studio
  ALM), Graph `appCatalogs/teamsApps` + `PATCH appDefinitions` +
  `userTeamwork/installedApps`, M365 Agents SDK.

## The 8 judged ideas

1. **Injection-channel ladder** — canary-verified, rehydration sled, honest degrade
2. **Durable mailbox/memory slot** — `update_memory_plugin` write-once + Graph attestation
3. **GUI-surface HTTP harvest → wrapped REST APIs**
4. **Two-phase install** — benign agent then `PATCH appDefinitions` with steering
5. **Proxy as custom-engine agent URL** (M365 Agents SDK, engine = our proxy)
6. **MCP via agent manifest** pointing at our tools
7. **Output-boundary steering** — route/interleave tool calls at the proxy
8. **Clone + pac-publish user's own agents** with injected YAML

## GLM-5.2 adversarial verdict (viability / fit)

| Idea | Score | Verdict |
|---|---|---|
| 1 ladder | high | **bank on it** |
| 2 memory-slot | license-gated | **dead end** on Basic (no Studio authoring) |
| 3 REST harvest | 6/5 | plumbing, not an injection vector (steering is per-frame WS, not REST) |
| 4 two-phase PATCH | 3/3 | **dead** — Basic has no Studio authoring; PATCH targets wrong artifact; bait-and-switch = trust violation |
| 5 proxy-as-engine | 5/2 | different product (replaces Copilot, doesn't steer it) |
| 6 MCP manifest | 1/1 | don't — execution is license-gated (the documented dead-end) |
| 7 output-boundary | 7/9 | **route fences = correct; do NOT rewrite prose→tool calls** (fabricates intent) |
| 8 clone+pac | 2/2 | dead — Basic has nothing to clone; pac needs Studio |

**GLM verdict:** *"bank on (1) + (7-route-only). (3) is plumbing. (2)/(4)/(6)/(8)
are license-gated dead ends. (5) is a different product."*

## Reconciled recommendation

- **Keep (strong):** (1) injection ladder + (7) route-only output steering.
- **Demote:** (2) memory-slot from "durable channel" to **probe-only** — GLM's
  challenge (Basic cannot author Studio memory; mailbox-write unverified) is
  fair. Verify H8.14 reachability before betting on it.
- **Keep as plumbing, not lever:** (3) REST harvest (worth having for a cleaner
  client surface, not an injection vector).
- **Drop:** (4) — GLM's technical correction (PATCH appDefinitions edits the
  app definition, not the Dataverse bot record where instructions live) is a
  real flaw our ADHD convergence missed. (6) and (8) are license-gated.

## Key GLM corrections to our ADHD output

1. **(4) two-phase PATCH is technically wrong** — instructions live in the
   Dataverse bot record, not the app definition; PATCH targets the wrong artifact.
2. **(2) may be license-gated** — the "memory dodge" is unverified speculation;
   Basic entitlements are the real gate.

## Where this lives

- Discovery: `agent://CopilotAppsSearch` (round-2 confirmed candidate research)
- Runbook for driving the live UI: `docs/agents/m365-ui-investigation.md`
- Ecosystem dig: `docs/research/2026-08-11-m365-copilot-ecosystem-dig.md`