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

## Handoff

See `CONTINUATION_PROMPT.md` for instructions.

**Rule**: Extract from real code. Make small changes. Keep behavior.
