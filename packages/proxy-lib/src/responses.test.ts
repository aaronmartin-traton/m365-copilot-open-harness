import { describe, expect, it, vi } from "vitest";

const scripted = {
  text: "translated response",
  fail: false,
  toolCalls: [] as Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>,
  prompts: [] as string[],
};
vi.mock("@m365-copilot/core", async (importActual) => {
  const actual = await importActual<typeof import("@m365-copilot/core")>();
  class FakeModelSession {
    turnCount = 0;
    conversationId = "response-conversation";
    sessionId = "response-session";
    newConversation() { this.conversationId = "response-conversation-2"; }
    reset() {}
    async refreshAgent() { return false; }
    async run(prompt: string) {
      scripted.prompts.push(prompt);
      if (scripted.fail) throw new Error("upstream failed");
      const text = scripted.text;
      return {
        fullText: text,
        hasContent: text.length > 0 || scripted.toolCalls.length > 0,
        throttle: { current: 1, max: 600 },
        contentOrigin: "GPT",
        messageType: null,
        messageId: "response-message",
        scores: null,
        turnCount: ++this.turnCount,
        turnState: "Completed",
        async *[Symbol.asyncIterator]() {
          if (text) yield text;
        },
      };
    }
  }
  return { ...actual, ModelSession: FakeModelSession };
});

const { handleResponse, ResponsesRequest } = await import("./responses.js");
const { SessionPool } = await import("./handler.js");

function base(input: unknown, extra: Record<string, unknown> = {}) {
  return ResponsesRequest.parse({ model: "gpt-5.5-think-deeper", input, ...extra });
}

async function responseFor(input: unknown, extra: Record<string, unknown> = {}) {
  scripted.text = "translated response";
  scripted.fail = false;
  scripted.prompts.length = 0;
  const response = await handleResponse(base(input, extra), new SessionPool());
  return { response, body: await response.json() as Record<string, unknown> };
}

describe("Responses adapter conversion", () => {
  it("converts instructions and string input", async () => {
    const { body } = await responseFor("hello", { instructions: "be concise" });
    expect(scripted.prompts[0]).toContain("be concise");
    expect(scripted.prompts[0]).toContain("hello");
    expect(body.object).toBe("response");
  });

  it("converts message text and image content", async () => {
    const { body } = await responseFor([{
      type: "message", role: "user", content: [
        { type: "input_text", text: "describe" },
        { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
      ],
    }]);
    expect(scripted.prompts[0]).toContain("describe");
    expect(body.status).toBe("completed");
  });

  it("converts function call and function call output items", async () => {
    const { body } = await responseFor([
      { type: "function_call", call_id: "call-1", name: "lookup", arguments: "{\"q\":\"x\"}" },
      { type: "function_call_output", call_id: "call-1", output: "result" },
    ]);
    expect(scripted.prompts[0]).toContain("lookup");
    expect(scripted.prompts[0]).toContain("x");
    expect(body.id).toMatch(/^resp_/);
  });

  it("converts valid function tools and every tool choice form", async () => {
    for (const tool_choice of ["auto", "none", "required", { type: "function", name: "lookup" }]) {
      const { response } = await responseFor("hello", {
        tools: [{ type: "function", name: "lookup", description: "look up", parameters: { type: "object" } }],
        tool_choice,
      });
      expect(response.status).toBe(200);
    }
  });
});

describe("Responses envelopes and streaming", () => {
  it("returns completed response and maps usage", async () => {
    const { response, body } = await responseFor("hello");
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ object: "response", status: "completed", id: expect.stringMatching(/^resp_/), usage: {
      input_tokens: 0, output_tokens: 0, total_tokens: 0,
    }, output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "translated response" }] }] });
  });

  it("emits ordered SSE lifecycle and output events", async () => {
    const response = await handleResponse(base("hello", { stream: true }), new SessionPool());
    const text = await response.text();
    const events = [...text.matchAll(/^event: ([^\n]+)/gm)].map((match) => match[1]);
    expect(events).toEqual([
      "response.created", "response.in_progress", "response.output_item.added",
      "response.content_part.added", "response.output_text.delta", "response.output_text.done",
      "response.content_part.done", "response.output_item.done", "response.completed",
    ]);
  });

  it("emits response.failed on an upstream error while preserving HTTP 200 SSE", async () => {
    scripted.fail = true;
    try {
      const response = await handleResponse(base("hello", { stream: true }), new SessionPool());
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).toContain("event: response.failed");
    } finally {
      scripted.fail = false;
    }
  });
  it("continues by previous response id and rejects a pruned id", async () => {
    const pool = new SessionPool({}, { remotePruner: async () => {} });
    const first = await handleResponse(base("hello"), pool);
    const firstBody = await first.json() as { id: string };
    const continued = await handleResponse(base("follow-up", { previous_response_id: firstBody.id }), pool);
    expect(continued.status).toBe(200);
    await pool.prune({ sessionKey: `response:${firstBody.id}` });
    const pruned = await handleResponse(base("after prune", { previous_response_id: firstBody.id }), pool);
    expect(pruned.status).toBe(404);
    expect((await pruned.json()).error.message).toBe("Unknown or pruned previous_response_id");
  });
});
