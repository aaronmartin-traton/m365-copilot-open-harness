# Component Reference

## Extracted Modules

These modules are now separate from `handler.ts`.

### Proxy-Lib Modules

**session-pool.ts** - Session management
- The `SessionPool` class manages sessions.
- It tracks conversations and tool calls.
- It removes idle sessions.

**context-compiler.ts** - Message formatting
- The `ContextCompiler` interface has two methods.
- `compileFull()` formats the first message.
- `compileDelta()` formats follow-up messages.

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

**force-prompts.ts** - Force prompts
- Force prompts make M365 continue.
- `CONFAB_FORCE_PROMPT` handles confabulation.
- `HALLUCINATION_FORCE_PROMPT` handles hallucinations.
- `REMOTE_ARTIFACT_FORCE_PROMPT` handles remote files.

**image-renderer.ts** - Image rendering
- `renderImagesMarkdown()` renders images.
- It fetches images from M365.
- It returns Markdown text.

### Core Package Modules

**tools.ts** - Tool handling
- `formatMessages()` formats tool messages.
- `parseToolCalls()` parses tool calls.

**session.ts** - Session class
- `ModelSession` manages one session.

**auth.ts** - Authentication
- Handles M365 authentication.

## Main Handler

**handler.ts** (~540 lines) - Request handler
- `handleChatCompletion()` is the main function.
- It gets sessions.
- It formats messages.
- It calls the M365 API.
- It handles streaming.

## Module Dependencies

```
handler.ts
  ├── session-pool.ts
  ├── context-compiler.ts
  ├── usage-builder.ts
  ├── response-helpers.ts
  ├── local-response-helpers.ts
  ├── output-ceiling.ts
  ├── force-prompts.ts
  ├── image-renderer.ts
  └── packages/core
```

## Extraction Rules

We follow these rules:
- Each module has one job.
- Each module is testable.
- We do not change behavior.
- We commit each extraction separately.
