# Component Reference

## Extracted Modules (Actual)

These modules have been extracted from `handler.ts` and are the current architecture:

### Core Proxy-Lib Modules

- **session-pool.ts** - Session lifecycle management
  - `SessionPool` class manages conversation state, tool call tracking, idle pruning
  - Responsibilities: session acquisition, conversation resolution, state persistence

- **context-compiler.ts** - Request context compilation
  - `ContextCompiler` interface with `compileFull()` and `compileDelta()`
  - Handles message formatting for M365 API (full prompts and delta updates)

- **usage-builder.ts** - Usage telemetry formatting
  - `buildUsage()` constructs OpenAI-compatible usage objects
  - Formats throttle status, classifier scores, model routing info

- **response-helpers.ts** - Response construction
  - `jsonResponse()`, `sseResponse()`, `rateLimitResponse()`, etc.
  - All OpenAI-compatible response formatting

- **local-response-helpers.ts** - Local response handling
  - `localMetaResponse()`, `readOnlyFallbackToolCall()`, `renderLocalCompletion()`
  - Handles metadata responses and read-only fallback tool calls

- **output-ceiling.ts** - Output truncation detection
  - `outputFinishReason()` determines if response was truncated
  - `OUTPUT_CHAR_CEILING` constant for empirical output limit

### Core Package Modules (packages/core/src)

- **tools.ts** - Tool formatting and parsing
  - `formatMessages()` (used by ContextCompiler)
  - `parseToolCalls()`, tool definitions formatting

- **session.ts** - ModelSession class
  - M365 session management, conversation lifecycle

- **auth.ts** - Authentication handling
  - M365 authentication and token management

## Main Handler

**handler.ts** (~570 lines) - Core request orchestration
- `handleChatCompletion()` - Main entry point
- Coordinates session acquisition, message compilation, M365 API calls
- Handles streaming, retries, error recovery

## Module Dependencies

```
handler.ts
  ├── session-pool.ts (SessionPool)
  ├── context-compiler.ts (ContextCompiler)
  ├── usage-builder.ts (buildUsage)
  ├── response-helpers.ts (response construction)
  ├── local-response-helpers.ts (local responses)
  ├── output-ceiling.ts (outputFinishReason)
  └── packages/core (tools, session, auth)
```

## Extraction Principles

Each extracted module:
- Has a single cohesive responsibility
- Is independently testable
- Preserves identical behavior
- Is committed separately with clear commit message
