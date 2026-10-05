# M365 Copilot Proxy

This is a fork of cramt/m365-copilot-proxy.
We extracted the architecture.

## Architecture

We moved code from `handler.ts` to modules.
Each module has one job.

### Extracted Modules

- **context-compiler.ts** - Formats messages
- **usage-builder.ts** - Makes usage objects
- **response-helpers.ts** - Makes responses
- **local-response-helpers.ts** - Handles local responses
- **session-pool.ts** - Manages sessions
- **output-ceiling.ts** - Checks output length
- **image-renderer.ts** - Renders images

### Main Handler

`handler.ts` has 540 lines.
It contains `handleChatCompletion()`.
This function handles requests.

## Documentation

See `docs/architecture/` for documentation:
- **ENGINEERING_RULES.md** - Development rules
- **COMPONENT_REFERENCE.md** - Module descriptions
- **ARCHITECTURE_ROADMAP.md** - Extraction progress

## Backends

The OpenAI-compatible surface is backend-agnostic. The backend is selected with
`PROVIDER`:

| `PROVIDER` | Backend | Notes |
|---|---|---|
| `m365` (default) | Microsoft 365 Copilot SignalR/WebSocket | The original backend. Unset behaves exactly as before. |
| `chatgpt-web` | ChatGPT Web, driven in a real browser | Opt-in. Headed Chromium against a signed-in `chatgpt.com` profile; no API key. |

```bash
# Sign in once, by hand, into the dedicated profile:
#   ~/.config/opencode-m365/chatgpt-web-profile
PROVIDER=chatgpt-web bun run proxy
```

**`chatgpt-web` is opt-in and constrained.** Driving a ChatGPT web session as an
API endpoint is against OpenAI's terms; accounts can be limited or banned. It
runs headed because Cloudflare serves headless Chromium an interstitial. It is
never a default route, and do not raise concurrency on it to chase throughput.

Adding a backend means implementing `ModelProvider`
(`packages/core/src/provider.ts`) — not forking the translation layer. See
`.scratch/chatgpt-web-backend/spec.md`.

## Development

Install dependencies:
```bash
bun install
```

Build:
```bash
bun run build
```

Test:
```bash
bun run test:unit
```

Lint (Oxlint + the vendored `anti-slop` rules):
```bash
bun run lint
bun run lint:fix
```

## Handoff

See `CONTINUATION_PROMPT.md` for instructions.

**Rule**: Extract from real code. Make small changes. Keep behavior.
