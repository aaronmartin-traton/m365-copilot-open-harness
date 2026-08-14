# Component Reference

## Extracted Modules

These modules are now separate from `handler.ts`.

### Proxy-Lib Modules

**session-pool.ts** - Session management
- The `SessionPool` class manages sessions.
- It tracks conversations and tool calls.
- It removes idle sessions.

**context-compiler.ts** - Message formatting
- `compileDelta()` formats follow-up messages.
- The handler formats the first message directly with `formatMessages`.

**usage-builder.ts** - Usage data formatting
- `buildUsage()` makes usage objects.
- Usage objects work with OpenAI.
- The function formats throttle data and scores.

**response-helpers.ts** - Response creation
- `jsonResponse()` makes JSON responses.
- `sseResponse()` makes streaming responses.
- Other functions make error responses.

**local-response-helpers.ts** - Local response handling
- `localMetaResponse()` handles metadata requests.
- `readOnlyFallbackToolCall()` handles safe tool calls.
- `renderLocalCompletion()` makes local responses.

**output-ceiling.ts** - Output length check
- `outputFinishReason()` checks response length.
- `OUTPUT_CHAR_CEILING` is the maximum length.

**image-renderer.ts** - Image rendering
- `renderImagesMarkdown()` renders images.
- It fetches images from M365.
- It returns Markdown text.

**tool-path.ts** - Tool result production
- `produceToolPath()` turns the buffered M365 response into the final result.
- It parses tool calls from the buffered response.
- It applies the prose-document guard, reply→text conversion, and
  one-call-per-turn.
- It gates fenced tool calls on the steering-attribution fingerprint
  (`M365_STEERING`).
- It is a pure translator: no behavioral correction, no local-model intent
  verifier, no attestation gate. The consuming harness owns retry/policy.
- The handler injects `runTurn`, `markSent`, and `registerToolCalls`.

**response-renderer.ts** - Response rendering
- `renderResponse()` makes the final Response.
- It renders JSON for non-streaming requests.
- It renders an early-flushed SSE stream for `stream: true`.
- It emits keepalives, live deltas, tool calls, and usage.
- The handler injects `produce()` so the renderer is testable without M365.

### Core Package Modules

**tools.ts** - Tool handling
- `formatMessages()` formats tool messages.
- `parseToolCalls()` parses tool calls.

**session.ts** - Session class
- `ModelSession` manages one session.

**auth.ts** - Authentication
- Handles M365 authentication.

## Main Handler

**handler.ts** - Request handler
- `handleChatCompletion()` is the main function.
- It gets sessions.
- It formats messages.
- It calls the M365 API.
- It handles streaming.
- It is orchestration only: request setup, message compilation, the buffered retry loop, and response rendering.
- Architect verdict (2026-08-07): cohesive orchestration; extraction phase closed. Characterization coverage: tool-path.ts (23 tests: 11 translation + 12 contract) and response-renderer.ts (17 tests). Mutable counts live in `NEXT.md`.

## Module Dependencies

```
handler.ts
  ├── session-pool.ts
  ├── context-compiler.ts
  ├── usage-builder.ts
  ├── response-helpers.ts
  ├── local-response-helpers.ts
  ├── output-ceiling.ts
  ├── image-renderer.ts
  ├── tool-path.ts
  ├── response-renderer.ts
  └── packages/core
```

## Extraction Rules

We follow these rules:
- Each module has one job.
- Each module is testable.
- We do not change behavior.
- We commit each extraction separately.
