import { describe, expect, it, vi } from "vitest";
import * as core from "@m365-copilot/core";
import type { ModelProvider, ProviderStopReason, ProviderTurn, ProviderUsage } from "@m365-copilot/core";
import type { z } from "zod/v4";
import { ChatCompletionRequest, ToolDefinition } from "./schemas.js";
import { handleChatCompletion } from "./handler.js";
import { SessionPool } from "./session-pool.js";

// tool-path tests run WITHOUT a local intent verifier: the simplified proxy
// no longer gates execution on a model classifier. The verifier's own
// contract (if ever revived) is covered in intent-verifier.test.ts.
process.env.M365_INTENT_VERIFIER = "0";

/** The turn the fake backend replays; each test mutates it before driving the handler. */
interface ScriptedBackend {
  text: string;
  throttle: { current: number; max: number } | null;
  fail: boolean;
  messageType: string | null;
  result: { value: string; errorCode?: string; message?: string } | null;
  prompts: string[];
}

const scripted: ScriptedBackend = {
  text: "answer",
  throttle: { current: 1, max: 600 },
  fail: false,
  messageType: null,
  result: null,
  prompts: [],
};

/**
 * The M365 backend stand-in: a faithful `ModelProvider` that replays `scripted`.
 * It reaches the handler through the session pool's `createSession` seam, so no
 * module is mocked.
 */
class FakeModelSession implements ModelProvider {
  id = "m365";
  sessionId = "handler-session";
  conversationId = "handler-conversation";
  turnCount = 0;

  newConversation() {}

  supportsTools() { return true; }

  describeModel(model: string) { return model; }

  listModels() { return ["gpt-5.5-think-deeper"]; }

  recoverFromRefusal(rebuild: (framing: "softened") => string) { return rebuild("softened"); }

  async refreshTools() { return false; }

  async run(prompt: string): Promise<ProviderTurn> {
    scripted.prompts.push(prompt);

    if (scripted.fail) throw new Error("upstream failed");
    const text = scripted.text;
    const messageType = scripted.messageType;

    const usage: ProviderUsage = messageType === null
      ? { content_origin: "GPT" }
      : { content_origin: "GPT", message_type: messageType };

    const stopReason: ProviderStopReason =
      messageType === "Disengaged" ? "refused" : text.length > 0 ? "completed" : "empty";

    return {
      fullText: text,
      hasContent: text.length > 0,
      images: [],
      throttle: scripted.throttle,
      stopReason,
      turnCount: ++this.turnCount,
      result: scripted.result,
      usage,
      async *[Symbol.asyncIterator]() { if (text) yield text; },
    };
  }
}

/** A pool wired to the fake backend through the pool's `createSession` seam. */
const fakePool = () => new SessionPool({}, { createSession: () => new FakeModelSession() });

/** A tool definition as a request fixture supplies it (derived from the request schema). */
type TestTool = z.input<typeof ToolDefinition>;

/** A message as a request fixture supplies it; `ChatCompletionRequest` validates it. */
interface TestMessage {
  role: string;
  content?: string | null;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

interface TestBodyExtra {
  conversation_id?: string;
  tools?: TestTool[];
}

function body(messages: TestMessage[], extra: TestBodyExtra = {}) {
  return ChatCompletionRequest.parse({ model: "gpt-5.5-think-deeper", messages, ...extra });
}

describe("handler deterministic boundaries", () => {
  it("formats the first request fully and subsequent requests as deltas", async () => {
    scripted.text = "answer";
    scripted.throttle = { current: 1, max: 600 };
    scripted.prompts.length = 0;
    const pool = fakePool();
    const first = [{ role: "user", content: "task" }];
    await handleChatCompletion(body(first, { conversation_id: "handler-test" }), pool);
    await handleChatCompletion(body([...first, { role: "user", content: "follow-up" }], { conversation_id: "handler-test" }), pool);
    expect(scripted.prompts[0]).toContain("task");
    expect(scripted.prompts[1]).toContain("follow-up");
    expect(scripted.prompts[1]).not.toContain("<system>");
  });

  it("prepends the only-the-first-call-ran note to the next tool result", async () => {
    const tools = [{
      type: "function" as const,
      function: { name: "bash", description: "Run a command", parameters: { type: "object" as const, properties: { command: { type: "string" as const } }, required: ["command"] } },
    }];

    scripted.prompts.length = 0;
    scripted.text = "```bash\nls\n```\n\n<tool_response>\nok\n</tool_response>\n\nFixed.";
    const pool = fakePool();
    const first = [{ role: "user", content: "task" }];
    const toolCall = await handleChatCompletion(body(first, { conversation_id: "note-test", tools }), pool);
    expect(toolCall.status).toBe(200);
    scripted.text = "```bash\npwd\n```";
    await handleChatCompletion(body([
      ...first,
      { role: "assistant", content: null, tool_calls: [{ id: "call-1", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call-1", content: "ok" },
    ], { conversation_id: "note-test", tools }), pool);
    expect(scripted.prompts[1]).toContain("only the first tool call in your previous reply was actually run");
    expect(scripted.prompts[1]).toContain('<tool_response name="bash" call_id="call-1">');
    // one turn only: a third turn must not repeat the note
    await handleChatCompletion(body([
      ...first,
      { role: "assistant", content: null, tool_calls: [{ id: "call-1", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call-1", content: "ok" },
      { role: "user", content: "next" },
    ], { conversation_id: "note-test", tools }), pool);
    expect(scripted.prompts[2]).not.toContain("only the first tool call in your previous reply");
  });

  it("sends Please continue when a continuation has no new content", async () => {
    scripted.prompts.length = 0;
    const pool = fakePool();
    const messages = [{ role: "user", content: "task" }];
    await handleChatCompletion(body(messages, { conversation_id: "continue-test" }), pool);
    await handleChatCompletion(body(messages, { conversation_id: "continue-test" }), pool);
    expect(scripted.prompts[1]).toBe("Please continue.");
  });

  it("maps an at-limit empty response to rate_limit_error", async () => {
    scripted.text = "";
    scripted.throttle = { current: 600, max: 600 };
    const emitSpy = vi.spyOn(core, "emitThrottleEvent");

    try {
      const response = await handleChatCompletion(body([{ role: "user", content: "task" }]), fakePool());
      expect(response.status).toBe(429);
      expect((await response.json()).error.type).toBe("rate_limit_error");
      const atLimit = emitSpy.mock.calls.find(([ev]) => ev.event === "at-limit")?.[0];
      expect(atLimit).toMatchObject({ event: "at-limit", current: 600, max: 600 });
      expect(atLimit?.convIdHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      emitSpy.mockRestore();
      scripted.text = "answer";
      scripted.throttle = { current: 1, max: 600 };
    }
  });

  it("emits disengaged telemetry with framing and retry outcome", async () => {
    scripted.text = "";
    scripted.messageType = "Disengaged";
    const emitSpy = vi.spyOn(core, "emitThrottleEvent");

    try {
      const response = await handleChatCompletion(
        body([{ role: "user", content: "task" }], { tools: [{ type: "function", function: { name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } }] }),
        fakePool(),
      );

      expect(response.status).toBe(502);
      const events = emitSpy.mock.calls.map(([ev]) => ev);
      const retry = events.find((ev) => ev.event === "disengaged" && ev.retryOutcome === "softened-retry");
      expect(retry).toMatchObject({ event: "disengaged", framing: "softened" });
      const failFast = events.find((ev) => ev.event === "disengaged" && ev.retryOutcome === "fail-fast");
      expect(failFast).toMatchObject({ framing: "softened" });
      expect(failFast?.convIdHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      emitSpy.mockRestore();
      scripted.messageType = null;
      scripted.text = "answer";
    }
  });

  it("answers an explicitly Throttled turn with 429 m365_throttled after ONE attempt", async () => {
    scripted.text = "";
    scripted.result = { value: "Throttled", errorCode: "PerUserThrottled", message: "Sorry, too many requests." };
    scripted.prompts.length = 0;
    const emitSpy = vi.spyOn(core, "emitThrottleEvent");

    try {
      const response = await handleChatCompletion(body([{ role: "user", content: "task" }]), fakePool());
      expect(response.status).toBe(429);
      const json = await response.json();
      expect(json.error).toMatchObject({ type: "rate_limit_error", code: "m365_throttled", param: "PerUserThrottled" });
      expect(response.headers.get("Retry-After")).toBeNull();
      expect(scripted.prompts).toHaveLength(1);
      expect(emitSpy.mock.calls.map(([ev]) => ev.event)).toContain("throttled");
    } finally {
      emitSpy.mockRestore();
      scripted.result = null;
      scripted.text = "answer";
    }
  });

  it("a Throttled result wins even if apology text arrived as content", async () => {
    scripted.text = "I'm sorry, I can't help right now.";
    scripted.result = { value: "Throttled" };

    try {
      const response = await handleChatCompletion(body([{ role: "user", content: "task" }]), fakePool());
      expect(response.status).toBe(429);
    } finally {
      scripted.result = null;
      scripted.text = "answer";
    }
  });

  it("maps upstream failures to 502", async () => {
    scripted.fail = true;

    try {
      const response = await handleChatCompletion(body([{ role: "user", content: "task" }]), fakePool());
      expect(response.status).toBe(502);
    } finally {
      scripted.fail = false;
    }
  });

  it("converts an edit fence into the supplied OpenAI tool call", async () => {
    const editTool = {
      type: "function" as const,
      function: {
        name: "apply_patch",
        description: "Edit a file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            search: { type: "string" },
            replace: { type: "string" },
          },
          required: ["path", "search", "replace"],
        },
      },
    };

    scripted.text = "```edit\npath: fixture.txt\n\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n```";
    scripted.prompts.length = 0;
    const pool = fakePool();
    const firstMessages = [{ role: "user", content: "task" }];
    const first = await handleChatCompletion(body(firstMessages, { tools: [editTool], conversation_id: "edit-test" }), pool);
    const firstJson = await first.json();
    expect(firstJson.choices[0].finish_reason).toBe("tool_calls");
    expect(firstJson.choices[0].message.tool_calls).toHaveLength(1);
    expect(firstJson.choices[0].message.tool_calls[0].function.name).toBe("apply_patch");
    expect(JSON.parse(firstJson.choices[0].message.tool_calls[0].function.arguments)).toEqual({ path: "fixture.txt", search: "old", replace: "new" });

    scripted.text = "done";

    const next = await handleChatCompletion(body([
      ...firstMessages,
      { role: "assistant", content: null, tool_calls: firstJson.choices[0].message.tool_calls },
      { role: "tool", tool_call_id: firstJson.choices[0].message.tool_calls[0].id, name: "apply_patch", content: "updated" },
    ], { tools: [editTool], conversation_id: "edit-test" }), pool);

    expect(next.status).toBe(200);
    expect(scripted.prompts[1]).toContain('<tool_response name="apply_patch"');
    expect(scripted.prompts[1]).toContain("<task_anchor>task</task_anchor>");
    expect(scripted.prompts[1]).not.toContain("<system>");
  });
});
