# Bun-only browser runtime migration

## Current state

The proxy, builds, Vitest suite, and ordinary scripts run under Bun. The authenticated M365 browser deletion path currently uses Node 24 for Playwright on Windows because Playwright's browser launch and CDP handshake time out under Bun 1.3.14. Node + Edge completes the same launch, navigation, header capture, and deletion flow.

The browser profile remains browser-owned. The proxy never reads cookies or copies bearer credentials.

## Migration plan

1. **Isolate the browser transport.** Define a small internal interface for persistent-context launch, page navigation, request-header capture, page-context fetch, and context close. Keep `M365WebConversationClient` independent from the runtime-specific implementation.
2. **Build a Bun CDP transport.** Reuse the existing CDP message model from `auth.ts`, using Bun's WebSocket implementation and an externally launched Chromium/Edge process. Support target creation/selection, `Page.navigate`, `Runtime.evaluate`, `Network.enable`, and request events.
3. **Preserve browser security invariants.** Keep cookies and credentials inside the page context; forward only the validated UI-context headers; never log headers, cookies, page state, or tokens.
4. **Add transport-equivalence tests.** Cover browser startup, sign-in redirect detection, delayed UI-header capture, `RefreshNavPane`, target presence, exactly one `DeleteConversation`, HTTP 200, post-delete absence, and guaranteed close. Run the same fake-browser contract against the Playwright and Bun-CDP transports.
5. **Run a live parity probe.** Sequentially validate both transports against one clearly named disposable owned conversation. Require identical HTTP status, target disappearance, and redacted diagnostics.
6. **Switch the runtime default.** Use the Bun CDP transport once parity passes; retain Node/Playwright only as a temporary rollback during the migration. Remove the Node-only probe path after one release cycle with no parity regressions.

## Acceptance criteria

- `bun scripts/web-conversation-prune-probe.mjs` completes on Windows and Nix without Node.
- The proxy can run under Bun with automatic pruning enabled.
- No concurrent M365 requests are introduced.
- Unit, build, browser-contract, and bounded live probe evidence all pass.
- The Node/Playwright compatibility path can be removed without changing the deletion payload or safety checks.
