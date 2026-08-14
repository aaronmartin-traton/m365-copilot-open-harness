import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

// tool-path tests run WITHOUT a local intent verifier: the simplified proxy
// no longer gates execution on a model classifier. The verifier's own
// contract (if ever revived) is covered in intent-verifier.test.ts.
process.env.M365_INTENT_VERIFIER = "0";

const scripted = {
  text: "answer",
  throttle: { current: 1, max: 600 } as { current: number; max: number } | null,
  fail: false,
  messageType: null as string | null,
  prompts: [] as string[],
};

vi.mock("@m365-copilot/core", async (importActual) => {
  const actual = await importActual<typeof import("@m365-copilot/core")>();
  class FakeModelSession {
    turnCount = 0;
    conversationId = "handler-conversation";
    sessionId = "handler-session";
    newConversation() {}
    reset() {}
    async refreshAgent() { return false; }
    async run(prompt: string) {
      scripted.prompts.push(prompt);
      if (scripted.fail) throw new Error("upstream failed");
      const text = scripted.text;
      return {
        fullText: text,
        hasContent: text.length > 0,
        throttle: scripted.throttle,
        contentOrigin: "GPT",
        messageType: scripted.messageType,
        messageId: "handler-message",
        scores: null,
        turnCount: ++this.turnCount,
        turnState: "Completed",
        async *[Symbol.asyncIterator]() { if (text) yield text; },
      };
    }
  }
  return { ...actual, ModelSession: FakeModelSession };
});

const { ChatCompletionRequest } = await import("./schemas.js");
const { handleChatCompletion } = await import("./handler.js");
const { SessionPool } = await import("./session-pool.js");

function body(messages: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return ChatCompletionRequest.parse({ model: "gpt-5.5-think-deeper", messages, ...extra });
}

describe("handler deterministic boundaries", () => {
  it("formats the first request fully and subsequent requests as deltas", async () => {
    scripted.text = "answer";
    scripted.throttle = { current: 1, max: 600 };
    scripted.prompts.length = 0;
    const pool = new SessionPool();
    const first = [{ role: "user", content: "task" }];
    await handleChatCompletion(body(first, { conversation_id: "handler-test" }), pool);
    await handleChatCompletion(body([...first, { role: "user", content: "follow-up" }], { conversation_id: "handler-test" }), pool);
    expect(scripted.prompts[0]).toContain("task");
    expect(scripted.prompts[1]).toContain("follow-up");
    expect(scripted.prompts[1]).not.toContain("<system>");
  });

  it("sends Please continue when a continuation has no new content", async () => {
    scripted.prompts.length = 0;
    const pool = new SessionPool();
    const messages = [{ role: "user", content: "task" }];
    await handleChatCompletion(body(messages, { conversation_id: "continue-test" }), pool);
    await handleChatCompletion(body(messages, { conversation_id: "continue-test" }), pool);
    expect(scripted.prompts[1]).toBe("Please continue.");
  });

  it("maps an at-limit empty response to rate_limit_error", async () => {
    scripted.text = "";
    scripted.throttle = { current: 600, max: 600 };
    const core = await import("@m365-copilot/core");
    const emitSpy = vi.spyOn(core, "emitThrottleEvent");
    try {
      const response = await handleChatCompletion(body([{ role: "user", content: "task" }]), new SessionPool());
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
    const core = await import("@m365-copilot/core");
    const emitSpy = vi.spyOn(core, "emitThrottleEvent");
    try {
      const response = await handleChatCompletion(
        body([{ role: "user", content: "task" }], { tools: [{ type: "function", function: { name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } }] }),
        new SessionPool(),
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

  it("maps upstream failures to 502", async () => {
    scripted.fail = true;
    try {
      const response = await handleChatCompletion(body([{ role: "user", content: "task" }]), new SessionPool());
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
    const pool = new SessionPool();
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
