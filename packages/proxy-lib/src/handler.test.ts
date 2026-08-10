import { createHash, createHmac } from "node:crypto";
import { getAttestationGate, resetAttestationGate } from "./attestation.js";
import { describe, expect, it, vi } from "vitest";

// Legacy tool-path tests run WITHOUT the intent verifier: opt out explicitly
// (default is now ON). The verifier's own contract is covered in
// intent-verifier.test.ts.
process.env.M365_INTENT_VERIFIER = "0";

const scripted = {
  text: "answer",
  throttle: { current: 1, max: 600 } as { current: number; max: number } | null,
  fail: false,
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
        messageType: null,
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
    const response = await handleChatCompletion(body([{ role: "user", content: "task" }]), new SessionPool());
    expect(response.status).toBe(429);
    expect((await response.json()).error.type).toBe("rate_limit_error");
    scripted.text = "answer";
    scripted.throttle = { current: 1, max: 600 };
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

  it("requires attestation before accepting a selected client tool result", async () => {
    process.env.M365_CLIENT_ATTESTATION = "1";
    process.env.M365_ATTESTATION_SECRET = "handler-attestation-secret";
    resetAttestationGate();
    const bashTool = {
      type: "function" as const,
      function: {
        name: "bash",
        description: "Run a command",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
    };
    const initialMessages = [{ role: "user", content: "task" }];
    const pool = new SessionPool();
    try {
      scripted.text = "```bash\necho attested\n```";
      const first = await handleChatCompletion(
        body(initialMessages, { tools: [bashTool], conversation_id: "attestation-test" }),
        pool,
        { executionGate: "attestation-v1", attestationClient: "pi" },
      );
      const firstJson = await first.json();
      const call = firstJson.choices[0].message.tool_calls[0];
      const command = JSON.parse(call.function.arguments).command;
      const attestation = {
        client: "pi" as const,
        tool: "bash" as const,
        tool_call_id: call.id,
        command_sha256: createHash("sha256").update(command, "utf8").digest("hex"),
        ts: Math.floor(Date.now() / 1_000),
        nonce: "handler-attestation-nonce",
      };
      const signature = createHmac("sha256", process.env.M365_ATTESTATION_SECRET).update([
        attestation.client,
        attestation.tool,
        attestation.tool_call_id,
        attestation.command_sha256,
        attestation.ts,
        attestation.nonce,
      ].join("\n"), "utf8").digest("hex");
      expect(getAttestationGate()!.attest(attestation, signature)).toBe(true);

      scripted.text = "done";
      const next = await handleChatCompletion(body([
        ...initialMessages,
        { role: "assistant", content: null, tool_calls: firstJson.choices[0].message.tool_calls },
        { role: "tool", tool_call_id: call.id, name: "bash", content: "attested" },
      ], { tools: [bashTool], conversation_id: "attestation-test" }), pool, {
        executionGate: "attestation-v1",
        attestationClient: "pi",
      });
      expect(next.status).toBe(200);
    } finally {
      delete process.env.M365_CLIENT_ATTESTATION;
      delete process.env.M365_ATTESTATION_SECRET;
      resetAttestationGate();
    }
  });
 });
