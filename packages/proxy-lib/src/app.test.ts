import { describe, expect, it } from "vitest";
import type { ModelProvider, ProviderTurn } from "@m365-copilot/core";
import { createApp } from "./index.js";
import { handleResponse, ResponsesRequest } from "./responses.js";
import { SessionPool } from "./session-pool.js";

const prompts: string[] = [];

/** A faithful `ModelProvider` stand-in: the turn path runs on this, injected through the pool. */
class FakeModelSession implements ModelProvider {
  readonly id = "m365";
  readonly sessionId = "app-session";
  conversationId = "app-conversation";
  turnCount = 0;

  newConversation() {}

  supportsTools() { return true; }

  describeModel(model: string) { return model; }

  listModels() { return ["gpt-5.5-think-deeper"]; }

  recoverFromRefusal(rebuild: (framing: "softened") => string) { return rebuild("softened"); }

  async refreshTools() { return false; }

  async run(prompt: string): Promise<ProviderTurn> {
    prompts.push(prompt);

    return {
      fullText: "app response",
      hasContent: true,
      images: [],
      throttle: { current: 1, max: 600 },
      stopReason: "completed",
      turnCount: ++this.turnCount,
      usage: { content_origin: "GPT" },
      async *[Symbol.asyncIterator]() { yield "app response"; },
    };
  }
}

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

  it("reuses one conversation for repeated Responses requests with the same session key", async () => {
    prompts.length = 0;
    let sessions = 0;

    const pool = new SessionPool({}, {
      createSession: () => {
        sessions += 1;

        return new FakeModelSession();
      },
    });

    const response = await handleResponse(ResponsesRequest.parse(responseBody), pool, { sessionKey: "thread-1" });
    expect(response.status).toBe(200);
    expect((await response.json()).object).toBe("response");
    expect(prompts[0]).toContain("hello");

    const followUp = await handleResponse(ResponsesRequest.parse(responseBody), pool, { sessionKey: "thread-1" });
    expect(followUp.status).toBe(200);
    expect(prompts).toHaveLength(2);
    expect(sessions).toBe(1);
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
