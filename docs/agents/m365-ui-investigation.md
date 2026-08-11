# Investigating the live M365 Copilot UI via the persistent-profile browser

Durable notes for driving the real `m365.cloud.microsoft` Copilot UI headful,
read-only, to study what Microsoft's own client exposes (optionsSets, custom
instructions, memory, image gen, apps/agent store). Written 2026-08-11 from a
hands-on session. The goal is always: **what can we control/inject
programmatically into M365 from our proxy?**

## The three-working-parts model

To investigate the live UI you need three things working together:

| Part | What | Current state (2026-08-11) |
|---|---|---|
| **Auth** | MSAL token cache (no password in scripts) | ✅ `~/.config/opencode-m365/msal-cache.json` live (`getTokenSilent()` works, `account@example.com`) |
| **Browser** | Persistent Playwright profile stays logged in | ✅ `browser-profile-cdp`, but see lock caveat |
| **CDP attach** | Drive the live browser + read tabs | ✅ port 9222 |

## The capture scripts — migrated off the dead `loadSecrets()` API

`loadSecrets()` (old password/MFA login) **does not exist** in `packages/core`
— it died in the password→MSAL migration. Every capture script that still
imports it crashes at load. The live path is the **persistent profile** +
`getBrowserProfileDir()` + `loginInteractive()`.

- `scripts/m365-gui-capture.mjs` — migrated: launches the persistent profile,
  captures the Chathub WS frames (optionsSets / variants / tone / agent),
  `M365_KEEP_OPEN=1` keeps the browser alive.
- `scripts/_profile-cdp.mjs [port]` — launches the persistent profile **with a
  CDP debug port** (default 9222) and holds it open. THIS is the right way to
  drive the live UI for tab exploration.
- `scripts/_cdp-shot.mjs <wsUrl> <out.png>` — direct CDP screenshot of a live
  page by its `webSocketDebuggerUrl` (bypasses heavy-page tab crashes).
- `scripts/_profile-diag.mjs` — minimal launch + navigate + hold, for debugging
  profile locks.

## The profile-lock footgun (read before driving)

`chromium.launchPersistentContext(profileDir)` fails with
**"Opening in existing browser session"** if ANY other Chromium instance holds
`browser-profile-cdp`. Stale `Default/LOCK` files cause it even after the
holding process is gone. Fix: `rm -f ~/.config/opencode-m365/browser-profile-cdp/Default/LOCK`
before launching. Only one Playwright context may use the profile at a time.

## Driving the browser (proven sequence)

1. Launch: `hub start m365-cdp` running `node scripts/_profile-cdp.mjs 9222`
   with `CHROMIUM_PATH` + the persistent profile. See `_profile-cdp.mjs`.
2. Attach: browser tool `{"action":"open","app":{"cdp_url":"http://127.0.0.1:9222"}}`.
3. Navigate a tab by direct URL; the profile is logged in, so M365 pages
   render authenticated.
4. Read the UI with `tab.ariaSnapshot()` or (for heavy pages) a CDP screenshot
   + `inspect_image` vision model. **Heavy pages** (agent store, apps catalog
   inside a Teams iframe) crash `tab.evaluate`/fullPage scroll — use a viewport
   screenshot via `_cdp-shot.mjs` + vision instead.

## URLs found (2026-08-11)

| Surface | URL | Notes |
|---|---|---|
| Chat | `https://m365.cloud.microsoft/chat/` | composer, model selector, settings |
| Create (image gen) | `https://m365.cloud.microsoft/create` | textarea "Describe the image you want to create"; modes: image/video/infographic/poster/edit-image/form/banner/doc/presentation/workbook; Style/Color/Size controls |
| **Agent store** (org agents) | `https://m365.cloud.microsoft/chat/agentstore` | "Your agents" (org/custom) + "Built by Microsoft" |
| Apps catalog | `https://m365.cloud.microsoft/m365apps/<id>` | session-stamped URL — `ERR_ABORTED` on direct re-navigation; reach via App Launcher → "More apps"; renders inside Teams `metaos-store` iframe |
| Settings → Personalization | via Chat → "Settings and more" → Personalization | custom instructions, work profile, saved memories, chat history |

## Custom instructions — the programmatic-injection surface (KEY)

Settings → Personalization → Custom instructions → "Edit instructions":

- Toggle is **ON** for this account, but the **textarea is EMPTY** (clean slate).
- The field is a **plain `<textarea>`** — fill + click "Save instructions".
- Server applies it to turns that send the `add_custom_instructions`
  optionsSet (lane F doc). So the injection path is: **set text via CDP UI →
  proxy sends `add_custom_instructions` flag → server injects text → model
  output shaped**. Programmatic set = fill textarea + save.
- Personalization panel also has: Work profile, Saved memories (toggle +
  Manage), Chat history (Frontier — disabled/preview-gated).

## Apps catalog — what's there + permissions to check

Visible apps (browse view): Jira Cloud (Atlassian), Forms (MS), **Copilot**
(MS), Cowork (MS), Polly, Power BI (MS), AI Learning (MS), SME Finder (MS).
Sections: Built for your org, Featured, Popular, **Agents, Agents for your
team**, Built by Microsoft. Browse view shows **no "Add" button on cards** —
Add/Install/Get appears in the individual app detail view or "See all".

**Open question (evaluate per candidate):** does the org allow adding a
specific app as an app/agent? The catalog browse view does not expose the
permission gate. Check the individual app's detail page for Add/Install and
any "contact admin" block — that gate determines whether a candidate tool can
be injected into this org's Copilot.

**2026-08-11 confirmation (browse view).** The catalog browse view shows
**no Add/Install/Get/Request affordance on cards and no org-policy text**
("contact admin", "request access" absent). Actions are hover/detail-page
only. To determine org-allow for a specific candidate, open its **detail
page** or **"Manage your apps"** (sidebar, bottom-left) — those carry the
Add / installed / permission state. Not yet confirmed for any single app;
pending the CopilotAppsSearch candidate list.

## Licensing facts

- This account plan shows **"Copilot Chat (Basic)"** — matches the repo's
  zero-cost premise (no paid Copilot/Studio license).
- "Upgrade" is offered in the nav — do NOT accept (breaks the premise).

## What to do next (leads)

1. Open an app's detail page in the catalog → does an **Add** action exist?
   (answers org-allow for injection of that app)
2. Probe the custom-instructions write path read-only: confirm the textarea
   save round-trip in a THROWAWAY thread, then drive turns with
   `add_custom_instructions` (lane F probe).
3. THE IMPORTANT CAVEAT: this was read-only exploration. **Do not** set custom
   instructions, save memories, add apps, or generate images without explicit
   user approval. The user's standing instruction was "be careful about writing".

## Source files changed / added this session

- `scripts/m365-gui-capture.mjs` (migrated off loadSecrets)
- `scripts/_profile-cdp.mjs`, `scripts/_cdp-shot.mjs`, `scripts/_profile-diag.mjs` (new helpers)
- `docs/research/2026-08-11-m365-copilot-ecosystem-dig.md` (DSV4 research pass)
- `.scratch/lightweight-model-eval/issues/01-needle2-agentic-model.md`
- `.scratch/capture-path-migration/issues/01-migrate-off-loadSecrets.md`
