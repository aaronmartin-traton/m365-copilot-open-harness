import { describe, expect, it, vi } from "vitest";

const calls: string[] = [];
vi.mock("@m365-copilot/core", async (importActual) => {
  const actual = await importActual<typeof import("@m365-copilot/core")>();
  class FakeModelSession {
    turnCount = 0;
    conversationId = "app-conversation";
    sessionId = "app-session";
    newConversation() {}
    reset() {}
    async refreshAgent() { return false; }
    async run(prompt: string) {
      calls.push(prompt);
      return {
        fullText: "app response",
        hasContent: true,
        throttle: { current: 1, max: 600 },
        contentOrigin: "GPT",
        messageType: null,
        messageId: "app-message",
        scores: null,
        turnCount: ++this.turnCount,
        turnState: "Completed",
        async *[Symbol.asyncIterator]() { yield "app response"; },
      };
    }
  }
  return { ...actual, ModelSession: FakeModelSession };
});

const { createApp } = await import("./index.js");

function request(path: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, init);
}

const responseBody = { model: "gpt-5.5-think-deeper", input: "hello" };

describe("framework-free app routes", () => {
  it("serves health and models payloads", async () => {
    const app = createApp();
    const health = await app.fetch(request("/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok" });
    const models = await app.fetch(request("/v1/models"));
    expect(models.status).toBe(200);
    expect((await models.json()).data).toBeInstanceOf(Array);
  });

  it("serves Responses and preserves the session key", async () => {
    calls.length = 0;
    const app = createApp();
    const response = await app.fetch(request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "x-m365-session-key": "thread-1" },
      body: JSON.stringify(responseBody),
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).object).toBe("response");
    expect(calls[0]).toContain("hello");
    const followUp = await app.fetch(request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "x-m365-session-key": "thread-1" },
      body: JSON.stringify(responseBody),
    }));
    expect(followUp.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("returns CORS and 400 for malformed Chat and Responses bodies", async () => {
    const app = createApp();
    for (const path of ["/v1/chat/completions", "/v1/responses"]) {
      const response = await app.fetch(request(path, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      }));
      expect(response.status).toBe(400);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect((await response.json()).error.type).toBe("invalid_request_error");
    }
  });

  it("returns 404 for unknown paths and 204 CORS preflight", async () => {
    const app = createApp();
    const unknown = await app.fetch(request("/missing"));
    expect(unknown.status).toBe(404);
    const options = await app.fetch(request("/v1/responses", { method: "OPTIONS" }));
    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-methods")).toContain("POST");
  });
});
