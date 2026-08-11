# M365 Auth Workflow (runbook)

How to authenticate this proxy against real Microsoft 365 Copilot, and how
to re-authenticate when the token cache is missing or expired. This is the
operational companion to the protocol details in
`docs/m365-copilot-api.md` §2 (MSAL PKCE).

## What auth is

- OAuth 2.0 authorization-code flow with PKCE, via `@azure/msal-node`.
- Client id `c0ab8ce9-e9a0-42e7-b064-33d422df41f1`, authority
  `https://login.microsoftonline.com/common`, redirect
  `.../common/oauth2/nativeclient`.
- Token cache file: `~/.config/opencode-m365/msal-cache.json`
  (override: `M365_CACHE_FILE`).
- Browser profile dir for the interactive login:
  `~/.config/opencode-m365/browser-profile-cdp`
  (override: `M365_BROWSER_PROFILE`).
- Scope sets (authorized in order by the login launcher):
  1. Microsoft 365 Copilot chat (`substrate.office.com/sydney/...`).
  2. Power Platform environment discovery (`api.bap.microsoft.com`).
  3. Copilot Studio agent management (`api.powerplatform.com`).
- The Copilot Studio agent id is cached separately in
  `~/.config/opencode-m365/agent-id.json`.

## Machine roles

| Machine | Role | Auth state (2026-08-10) |
|---|---|---|
| Laptop (`LAPTOP`) | The live-M365 machine | Cache present; silent refresh works |
| PC (`PC_HOST`, this box) | Implementation; live M365 only after a human login | No cache, no recorded login |

No live M365 run is on record for locally. The throttle-telemetry file
(`~/.config/opencode-m365/throttle-telemetry.ndjson`) contains only
unit-test events — every line hashes to `handler-conversation`, the
`handler.test.ts` fixture (traced 2026-08-10). Do not cite it as
live-traffic evidence. The workflow below is the supported path to
authenticate. Until a human completes it, locally stays auth-blocked and
live M365 work stays on the local machine.

## Workflow 1 — first login (human required)

1. `bun run build`
2. `bun packages/proxy/bin/m365-login.mjs`
   - Opens a visible Chromium window.
   - You enter the password and MFA only on Microsoft's sign-in page.
   - It authorizes the three scope sets in sequence.
   - It saves the token cache to `~/.config/opencode-m365/msal-cache.json`.
3. Start the proxy: `bun packages/proxy/bin/m365-proxy.mjs`
   - The proxy refreshes the token silently on startup.

## Workflow 2 — proxy self-service login

Start the proxy with `M365_ENABLE_INTERACTIVE_APPROVAL=1`. When no token
exists or the silent refresh fails, the proxy opens the same visible
browser login automatically. `M365_NO_INTERACTIVE=1` vetoes this fallback.

## The nativeclient redirect (gotcha)

After login the browser bounces to `/common/wrongplace`. The auth code is
NOT in the settled URL. The proxy scrapes `?code=` from the navigation
request (`Network.requestWillBeSent`, see `auth.ts`). Do not change this to
wait for a settled URL.

## Verify auth

- Live loop (the real end-to-end check):
  `M365_DEBUG=1 bun scripts/proxy-verify.mjs --agent --multiturn`
  — exits 0 only after a real tool loop.
- Debug log: `~/.config/opencode-m365/debug.log`. It is written only when
  `M365_DEBUG=1` or `M365_TRACE=1`.
- Frame dump: set `M365_DUMP_FRAMES=1`; frames land in
  `~/.config/opencode-m365/frames/<requestId>.ndjson`.
- Single-turn probe: `bun scripts/_probe-chat.mjs` (see its usage comment).

## Gotchas

- The cache is disposable. Delete `msal-cache.json` and re-run the login
  (or start the proxy with `M365_ENABLE_INTERACTIVE_APPROVAL=1`).
- A fresh login does NOT clear account throttling. Throttle is keyed by the
  account id (`oid`), not the token. Thread-rate throttle looks like an
  empty response with no `Disengaged` frame.
- One conversation caps at ~600 messages. Respect the thread budget
  (about 12 new conversations per hour).
- `CHROMIUM_PATH` overrides the bundled Playwright browser.
- The interactive login times out after 15 minutes.
- `scripts/m365-gui-emulate.mjs` needs `CHROMIUM_PATH` and a logged-in
  browser context. It is for GUI-side payload isolation only.
- Never store a password or MFA seed in this repo. The login flow keeps
  credentials on Microsoft's page only.
