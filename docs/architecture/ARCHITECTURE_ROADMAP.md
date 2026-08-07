# Architecture Roadmap

## Phase 1: Analyze - Done

We analyzed `handler.ts`.
We found responsibilities to extract.
We made extraction principles.

## Phase 2: Extract Responsibilities - In Progress

**Done extractions:**
1. Context Compiler - message formatting
2. Usage Builder - usage data
3. Response Helpers - response creation
4. Local Response Helpers - local responses
5. SessionPool - session management
6. Output Ceiling - output length check
7. Force Prompts - force prompts
8. Image Renderer - image rendering

**handler.ts now has 540 lines.**
- The main function is `handleChatCompletion()`.
- It coordinates requests.
- It calls the M365 API.

**We can extract more:**
- Request validation
- Model routing
- Streaming logic

## Phase 3: Make Interfaces - Not Started

We will wait.
We will not make interfaces now.
The code will show us the interfaces.

## Rules

- We extract from real code.
- We do not change behavior.
- We make small commits.
- We write descriptive docs.
