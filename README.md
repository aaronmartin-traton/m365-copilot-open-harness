# M365 Copilot Proxy

A mature fork of [cramt/m365-copilot-proxy](https://github.com/cramt/m365-copilot-proxy) with extracted architecture.

## Architecture

The codebase is being incrementally refactored to extract cohesive responsibilities from `handler.ts` into focused modules.

### Extracted Modules (so far)

- **context-compiler.ts** - Compiles request context into model-facing text (full and delta modes)
- **usage-builder.ts** - Constructs OpenAI-compatible usage objects from M365 telemetry
- **response-helpers.ts** - Response construction helpers (JSON, SSE, rate limits)
- **local-response-helpers.ts** - Local response handling (metadata, read-only fallbacks)
- **session-pool.ts** - Session lifecycle management and conversation state
- **output-ceiling.ts** - Output truncation detection

### Core Handler

`handler.ts` now contains primarily the main `handleChatCompletion` function (~570 lines) which orchestrates the request flow.

## Documentation

Architecture documentation is in `docs/architecture/`:

- **SYSTEM_REFERENCE.md** - Project direction and goals
- **ENGINEERING_RULES.md** - Development principles (preserve behavior, earn abstractions)
- **MIGRATION_PLAN.md** - Incremental extraction approach
- **COMPONENT_REFERENCE.md** - Current component descriptions
- **REQUEST_LIFECYCLE.md** - Request flow documentation

## Development

```bash
# Install dependencies
bun install

# Build
bun run build

# Test
bun run test:unit
```

## Handoff

This repository was extracted from a larger handoff package. See `CONTINUATION_PROMPT.md` for the original handoff instructions.

**Key principle**: Extract architecture from existing code, not from imagination. Each extraction should be small, reviewable, and preserve existing behavior.
