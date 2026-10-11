import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import type { ModelProvider, ProviderTurn } from "@m365-copilot/core";
import { handleResponse, ResponsesRequest, type ResponsesRequestBody } from "./responses.js";
import { SessionPool } from "./session-pool.js";

/** A tool call a scripted turn reports. */
interface ScriptedToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** The scripted behaviour of the next turns; each test resets what it depends on. */
interface ScriptedTurns {
  text: string;
  fail: boolean;
  toolCalls: ScriptedToolCall[];
  prompts: string[];
}

const scripted: ScriptedTurns = { text: "translated response", fail: false, toolCalls: [], prompts: [] };

/** A faithful `ModelProvider` stand-in: canned turns, injected through the pool's seam. */
class FakeModelSession implements ModelProvider {
  readonly id = "m365";
  readonly sessionId = "response-session";
  conversationId = "response-conversation";
  turnCount = 0;

  newConversation() { this.conversationId = "response-conversation-2"; }

  supportsTools() { return true; }

  describeModel(model: string) { return model; }

  listModels() { return ["gpt-5.5-think-deeper"]; }

  recoverFromRefusal(rebuild: (framing: "softened") => string) { return rebuild("softened"); }

  async refreshTools() { return false; }

  async run(prompt: string): Promise<ProviderTurn> {
    scripted.prompts.push(prompt);

    if (scripted.fail) throw new Error("upstream failed");
    const text = scripted.text;
    const hasContent = text.length > 0 || scripted.toolCalls.length > 0;

    return {
      fullText: text,
      hasContent,
      images: [],
      throttle: { current: 1, max: 600 },
      stopReason: hasContent ? "completed" : "empty",
      turnCount: ++this.turnCount,
      usage: { content_origin: "GPT" },
      async *[Symbol.asyncIterator]() {
        if (text) yield text;
      },
    };
  }
}

/** A pool whose conversations all run on the fake provider. */
function newPool(): SessionPool {
  return new SessionPool({}, { createSession: () => new FakeModelSession() });
}

/** The Responses envelope fields these tests read back. */
const ResponseEnvelope = z.object({
  id: z.string(),
  object: z.string(),
  status: z.string(),
  error: z.null(),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number(), total_tokens: z.number() }),
  output: z.array(z.object({
    type: z.string(),
    role: z.string().optional(),
    status: z.string().optional(),
    content: z.array(z.object({ type: z.string(), text: z.string() })).optional(),
  })),
});

/** The error body an invalid `previous_response_id` returns. */
const ErrorBody = z.object({ error: z.object({ type: z.string(), message: z.string() }) });

type ResponseEnvelope = z.infer<typeof ResponseEnvelope>;

/** Request fields a test may add on top of the input under test. */
type ResponseExtras = Partial<Omit<ResponsesRequestBody, "input" | "model">>;

function base(input: ResponsesRequestBody["input"], extra: ResponseExtras = {}) {
  return ResponsesRequest.parse({ model: "gpt-5.5-think-deeper", input, ...extra });
}

async function responseFor(input: ResponsesRequestBody["input"], extra: ResponseExtras = {}) {
  scripted.text = "translated response";
  scripted.fail = false;
  scripted.prompts.length = 0;
  const response = await handleResponse(base(input, extra), newPool());

  return { response, body: ResponseEnvelope.parse(await response.json()) };
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
    const response = await handleResponse(base("hello", { stream: true }), newPool());
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
      const response = await handleResponse(base("hello", { stream: true }), newPool());
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).toContain("event: response.failed");
    } finally {
      scripted.fail = false;
    }
  });
  it("continues by previous response id and rejects a pruned id", async () => {
    const pool = new SessionPool({}, {
      createSession: () => new FakeModelSession(),
      remotePruner: async () => {},
    });

    const first = await handleResponse(base("hello"), pool);
    const firstBody = ResponseEnvelope.parse(await first.json());
    const continued = await handleResponse(base("follow-up", { previous_response_id: firstBody.id }), pool);
    expect(continued.status).toBe(200);
    await pool.prune({ sessionKey: `response:${firstBody.id}` });
    const pruned = await handleResponse(base("after prune", { previous_response_id: firstBody.id }), pool);
    expect(pruned.status).toBe(404);
    expect(ErrorBody.parse(await pruned.json()).error.message).toBe("Unknown or pruned previous_response_id");
  });
});
