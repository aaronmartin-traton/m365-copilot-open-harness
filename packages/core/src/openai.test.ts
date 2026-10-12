/**
 * The OpenAI lane, driven against a real HTTP server on a loopback port.
 *
 * The streaming path is the part worth testing for real: an SSE reader that
 * splits frames at the wrong boundary silently loses or duplicates content, and
 * a mock `fetch` returning whole objects cannot reproduce that.
 */
import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import {
  OpenAiProvider,
  OpenAiError,
  openAiModelNames,
  openAiContextWindow,
  openAiRequiresKey,
  discoverOpenAiModels,
} from "./openai.js";

// --- stub OpenAI endpoint ---------------------------------------------------

const BoundAddressSchema = z.object({ port: z.number() });

/** The JSON body of a request the lane sent, as the stub parsed it. */
type SentRequest = z.infer<typeof SentRequestSchema>;

const SentRequestSchema = z.object({
  model: z.string(),
  stream: z.boolean(),
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
});

interface StubOpenAi {
  readonly baseUrl: string;
  readonly requests: SentRequest[];
  readonly authorizations: string[];
  close: () => Promise<void>;
}

/** Answers `/chat/completions` with `reply`, recording what arrived. */
async function startStubOpenAi(
  reply: (request: SentRequest) => { status: number; body: string; contentType?: string },
): Promise<StubOpenAi> {
  const requests: SentRequest[] = [];
  const authorizations: string[] = [];

  const server: Server = createServer((request, response) => {
    let raw = "";

    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      raw += chunk;
    });
    request.on("end", () => {
      const sent = SentRequestSchema.parse(JSON.parse(raw));

      requests.push(sent);
      authorizations.push(request.headers.authorization ?? "");

      const answered = reply(sent);

      response.writeHead(answered.status, {
        "Content-Type": answered.contentType ?? "text/event-stream",
      });
      response.end(answered.body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = BoundAddressSchema.parse(server.address());

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    authorizations,
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** One SSE frame carrying `content`, in the shape the API sends. */
function frame(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

/** The final SSE frame, carrying the finish reason instead of content. */
function finishFrame(finishReason: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`;
}

// --- tests ------------------------------------------------------------------

describe("OpenAiProvider", () => {
  it("streams a reply and forwards each delta in order", async () => {
    const stub = await startStubOpenAi(() => ({
      status: 200,
      body: frame("Hello") + frame(", ") + frame("world") + finishFrame("stop"),
    }));

    try {
      const provider = new OpenAiProvider({ apiKey: "sk-test", baseUrl: stub.baseUrl });
      const turn = await provider.run("Say hello.", "gpt-5");

      const deltas: string[] = [];

      for await (const delta of turn) deltas.push(delta);

      expect(deltas).toEqual(["Hello", ", ", "world"]);
      expect(turn.fullText).toBe("Hello, world");
      expect(turn.hasContent).toBe(true);
      expect(turn.stopReason).toBe("completed");
      expect(turn.turnCount).toBe(1);
      expect(stub.requests[0]?.model).toBe("gpt-5");
      expect(stub.authorizations[0]).toBe("Bearer sk-test");
    } finally {
      await stub.close();
    }
  });

  it("passes the requested model through, so the field really selects it", async () => {
    const stub = await startStubOpenAi(() => ({ status: 200, body: frame("ok") + finishFrame("stop") }));

    try {
      const provider = new OpenAiProvider({ apiKey: "sk-test", baseUrl: stub.baseUrl });
      // The whole point of this lane over chatgpt-web: the id is not advisory.
      await provider.run("hi", "gpt-6.1-sol");
      await provider.run("hi again", "o3");

      expect(stub.requests.map((request) => request.model)).toEqual(["gpt-6.1-sol", "o3"]);
    } finally {
      await stub.close();
    }
  });

  it("reports a content filter as refused rather than a normal finish", async () => {
    const stub = await startStubOpenAi(() => ({ status: 200, body: frame("") + finishFrame("content_filter") }));

    try {
      const provider = new OpenAiProvider({ apiKey: "sk-test", baseUrl: stub.baseUrl });
      const turn = await provider.run("hi", "gpt-5");

      for await (const _ of turn) {
        // Drain the stream so the finish reason is observed.
      }

      expect(turn.stopReason).toBe("refused");
    } finally {
      await stub.close();
    }
  });

  it("surfaces an upstream refusal in plain language, keeping the status", async () => {
    const stub = await startStubOpenAi(() => ({
      status: 429,
      body: JSON.stringify({ error: { message: "Rate limit reached" } }),
      contentType: "application/json",
    }));

    try {
      const provider = new OpenAiProvider({ apiKey: "sk-test", baseUrl: stub.baseUrl });

      await expect(provider.run("hi", "gpt-5")).rejects.toBeInstanceOf(OpenAiError);
      await expect(provider.run("hi", "gpt-5")).rejects.toMatchObject({ status: 429 });
    } finally {
      await stub.close();
    }
  });

  it("refuses to run without an API key, before spending a request", async () => {
    const stub = await startStubOpenAi(() => ({ status: 200, body: frame("never") + finishFrame("stop") }));

    try {
      const provider = new OpenAiProvider({ apiKey: null, baseUrl: stub.baseUrl });

      await expect(provider.run("hi", "gpt-5")).rejects.toThrow(/OPENAI_API_KEY/);
      expect(stub.requests).toHaveLength(0);
    } finally {
      await stub.close();
    }
  });

  it("reassembles a frame split across two TCP reads", async () => {
    // One SSE frame delivered in two writes with a boundary mid-JSON: the reader
    // must buffer, not parse half a frame or drop the tail.
    const whole = frame("split-me") + finishFrame("stop");
    const cut = whole.indexOf(",") + 1;

    const stub = await startStubOpenAi(() => ({ status: 200, body: whole.slice(0, cut) + whole.slice(cut) }));

    try {
      const provider = new OpenAiProvider({ apiKey: "sk-test", baseUrl: stub.baseUrl });
      const turn = await provider.run("hi", "gpt-5");
      const deltas: string[] = [];

      for await (const delta of turn) deltas.push(delta);

      expect(deltas).toEqual(["split-me"]);
      expect(turn.fullText).toBe("split-me");
    } finally {
      await stub.close();
    }
  });

  it("drives a local OpenAI-compatible server with no API key (LM Studio, vLLM)", async () => {
    const stub = await startStubOpenAi(() => ({ status: 200, body: frame("local") + finishFrame("stop") }));
    const previousBase = process.env.OPENAI_BASE_URL;
    const previousKey = process.env.OPENAI_API_KEY;

    try {
      process.env.OPENAI_BASE_URL = stub.baseUrl;
      delete process.env.OPENAI_API_KEY;

      // A self-hosted endpoint authenticates by nothing; OpenAI's own cannot.
      expect(openAiRequiresKey()).toBe(false);

      const provider = new OpenAiProvider({ baseUrl: stub.baseUrl });
      const turn = await provider.run("hi", "local-model");

      for await (const _ of turn) {
        // Drain the stream.
      }

      expect(turn.fullText).toBe("local");
      expect(stub.authorizations[0]).toBe("");
    } finally {
      if (previousBase === undefined) { delete process.env.OPENAI_BASE_URL; } else { process.env.OPENAI_BASE_URL = previousBase; }

      if (previousKey === undefined) { delete process.env.OPENAI_API_KEY; } else { process.env.OPENAI_API_KEY = previousKey; }
    }
  });

  it("discovers the models a local server actually serves", async () => {
    const server: Server = createServer((request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "qwen3-coder" }, { id: "llama-3.3" }] }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = BoundAddressSchema.parse(server.address()).port;

    try {
      const found = await discoverOpenAiModels(`http://127.0.0.1:${port}/v1`);

      expect(found).toEqual(["qwen3-coder", "llama-3.3"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("advertises models and a context window, overridable per host", async () => {
    const previous = process.env.OPENAI_MODELS;

    try {
      delete process.env.OPENAI_MODELS;
      expect(openAiModelNames()).toContain("gpt-5");
      expect(openAiContextWindow()).toBe(1_050_000);

      process.env.OPENAI_MODELS = "custom-a, custom-b";
      expect(openAiModelNames()).toEqual(["custom-a", "custom-b"]);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_MODELS;
      else process.env.OPENAI_MODELS = previous;
    }
  });

  it("sends images as data URLs alongside the prompt", async () => {
    const stub = await startStubOpenAi(() => ({ status: 200, body: frame("seen") + finishFrame("stop") }));

    try {
      const provider = new OpenAiProvider({ apiKey: "sk-test", baseUrl: stub.baseUrl });
      await provider.run("what is this?", "gpt-5", undefined, false, [
        { mediaType: "image/png", data: new Uint8Array([1, 2, 3]) },
      ]);

      const content = stub.requests[0]?.messages[0]?.content;

      expect(content).toEqual([
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
      ]);
    } finally {
      await stub.close();
    }
  });
});
