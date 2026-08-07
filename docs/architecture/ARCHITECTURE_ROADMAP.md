# Architecture Roadmap

## Phase 1: Analyze ✅ (Completed)
- Analyzed handler.ts responsibilities
- Identified cohesive responsibilities for extraction
- Established extraction principles

## Phase 2: Extract Responsibilities ✅ (In Progress)
**Completed extractions:**
1. ✅ Context Compiler (formatMessages, delta formatting)
2. ✅ Usage Builder (buildUsage)
3. ✅ Response Helpers (jsonResponse, sseResponse, etc.)
4. ✅ Local Response Helpers (localMetaResponse, readOnlyFallbackToolCall)
5. ✅ SessionPool (session lifecycle management)
6. ✅ Output Ceiling (outputFinishReason)

**Remaining in handler.ts (~570 lines):**
- Main `handleChatCompletion()` orchestration logic
- Request validation and routing
- M365 API call coordination
- Streaming and retry logic

**Next extractions to consider:**
- Image rendering helpers (`renderImagesMarkdown`)
- Force prompt constants and logic
- Request validation logic
- Streaming response handling

## Phase 3: Introduce Interfaces Only When Justified
- Wait for extractions to reveal natural interfaces
- Avoid premature abstraction
- Let the code show us what interfaces are needed

## Principles
- Extract architecture from existing code (not imagination)
- Each extraction must preserve behavior
- Small, reviewable commits
- Update docs to be descriptive (not prescriptive)
