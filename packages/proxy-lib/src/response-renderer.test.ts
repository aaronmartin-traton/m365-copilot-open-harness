import { describe, expect, it, vi } from "vitest";
import { renderResponse, type RenderResponseArgs } from "./response-renderer.js";
import { jsonResponse } from "./response-helpers.js";
import { outputFinishReason } from "./output-ceiling.js";
import type { ParsedToolCall } from "@m365-copilot/core";

const bashCall: ParsedToolCall = {
  id: "call_1",
  type: "function",
  function: { name: "bash", arguments: JSON.stringify({ command: "ls -la" }) },
};

const secondCall: ParsedToolCall = {
  id: "call_2",
  type: "function",
  function: { name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: "hi" }) },
};

function args(over: Partial<RenderResponseArgs> = {}): RenderResponseArgs {
  return {
    stream: false,
    produce: vi.fn(async () => ({ kind: "text" as const, text: "hello" })),
    hasTools: false,
    usage: vi.fn(() => ({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })),
    includeUsage: true,
    completionId: "cmpl-test",
    created: 1234,
    model: "m365-test",
    ...over,
  };
}

/** Read an SSE body once; return the raw text and the parsed `data: {json}` events
 * (skipping keepalive comments and [DONE]). */
async function readSSE(resp: Response): Promise<{ text: string; events: Array<Record<string, any>> }> {
  const text = await resp.text();
  return {
    text,
    events: text
      .split("\n\n")
      .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
      .map((l) => JSON.parse(l.slice("data: ".length))),
  };
}

describe("renderResponse non-stream", () => {
  it("renders text as the OpenAI chat.completion envelope", async () => {
    const a = args({ stream: false });
    const resp = await renderResponse(a);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.id).toBe("cmpl-test");
    expect(body.object).toBe("chat.completion");
    expect(body.created).toBe(1234);
    expect(body.model).toBe("m365-test");
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0].message.role).toBe("assistant");
    expect(body.choices[0].message.content).toBe("hello");
    expect(body.choices[0].finish_reason).toBe(outputFinishReason("hello"));
    expect(body.usage).toEqual({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
    expect(a.produce).toHaveBeenCalledOnce();
    expect((a.produce as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBeUndefined();
    expect(a.usage).toHaveBeenCalledOnce();
  });

  it("emits system_fingerprint when the session is steered", async () => {
    const a = args({ stream: false, fingerprint: "steered:channel=textarea" });
    const body = await (await renderResponse(a)).json();
    expect(body.system_fingerprint).toBe("steered:channel=textarea");
    expect(body.choices[0].message.content).toBe("hello");
  });

  it("omits system_fingerprint when unset", async () => {
    const body = await (await renderResponse(args({ stream: false }))).json();
    expect(body.system_fingerprint).toBeUndefined();
  });

  it("carries system_fingerprint on streamed chunks when steered", async () => {
    const a = args({ stream: true, fingerprint: "unsteered" });
    const { events } = await readSSE(await renderResponse(a));
    const withFp = events.filter((e) => e.system_fingerprint != null);
    expect(withFp.length).toBeGreaterThan(0);
    expect(withFp[0].system_fingerprint).toBe("unsteered");
  });

  it("renders tool calls as OpenAI tool-call JSON", async () => {
    const a = args({
      produce: vi.fn(async () => ({ kind: "tools" as const, toolCalls: [bashCall] })),
    });
    const resp = await renderResponse(a);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.choices[0].message.content).toBeNull();
    expect(body.choices[0].message.tool_calls).toEqual([bashCall]);
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(body.usage).toEqual({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
  });

  it("passes an upstream error response through unchanged", async () => {
    const upstream = jsonResponse(503, { error: { message: "boom" } });
    const a = args({ produce: vi.fn(async () => ({ kind: "error" as const, resp: upstream })) });
    const resp = await renderResponse(a);
    expect(resp).toBe(upstream);
    expect(resp.status).toBe(503);
    expect(await resp.json()).toEqual({ error: { message: "boom" } });
    expect(a.usage).not.toHaveBeenCalled();
  });
});

describe("renderResponse streaming", () => {
  it("starts with a role chunk and terminates with [DONE]", async () => {
    const a = args({ stream: true });
    const resp = await renderResponse(a);
    expect(resp.status).toBe(200);
    const { text, events } = await readSSE(resp);
    expect(events[0].choices[0].delta.role).toBe("assistant");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("streams non-tool live deltas incrementally without duplication", async () => {
    const produce = vi.fn(async (onDelta?: (d: string) => void) => {
      onDelta?.("hel");
      onDelta?.("lo");
      return { kind: "text" as const, text: "hello" };
    });
    const a = args({ stream: true, produce });
    const resp = await renderResponse(a);
    const { events } = await readSSE(resp);
    const content = events
      .map((e) => e.choices?.[0]?.delta?.content)
      .filter((c): c is string => typeof c === "string");
    expect(content).toEqual(["hel", "lo"]);
    // finalization must not re-emit the full text
    expect(content.join("")).toBe("hello");
    expect(content.filter((c) => c === "hello")).toHaveLength(0);
    const finish = events.filter((e) => e.choices?.[0]?.finish_reason != null);
    expect(finish).toHaveLength(1);
  });

  it("emits only the missing tail after live deltas", async () => {
    const produce = vi.fn(async (onDelta?: (d: string) => void) => {
      onDelta?.("hel");
      return { kind: "text" as const, text: "hello world" };
    });
    const a = args({ stream: true, produce });
    const resp = await renderResponse(a);
    const { events } = await readSSE(resp);
    const content = events
      .map((e) => e.choices?.[0]?.delta?.content)
      .filter((c): c is string => typeof c === "string");
    expect(content).toEqual(["hel", "lo world"]);
    expect(content.some((c) => c === "hello world")).toBe(false);
  });

  it("suppresses live text passthrough in tool mode", async () => {
    const produce = vi.fn(async (onDelta?: (d: string) => void) => {
      expect(onDelta).toBeUndefined();
      return { kind: "tools" as const, toolCalls: [bashCall] };
    });
    const a = args({ stream: true, hasTools: true, produce });
    const resp = await renderResponse(a);
    const { events } = await readSSE(resp);
    const content = events
      .map((e) => e.choices?.[0]?.delta?.content)
      .filter((c): c is string => typeof c === "string");
    expect(content).toHaveLength(0);
    const toolDeltas = events
      .map((e) => e.choices?.[0]?.delta?.tool_calls)
      .filter(Boolean);
    expect(toolDeltas.length).toBeGreaterThan(0);
    expect(toolDeltas[0][0].index).toBe(0);
    expect(toolDeltas[0][0].id).toBe("call_1");
    expect(toolDeltas[0][0].function.name).toBe("bash");
    expect(JSON.parse(toolDeltas[0][0].function.arguments)).toEqual({ command: "ls -la" });
    expect(events.some((e) => e.choices?.[0]?.finish_reason === "tool_calls")).toBe(true);
  });

  it("preserves tool-call index and function data across the stream", async () => {
    const a = args({
      stream: true,
      hasTools: true,
      produce: vi.fn(async () => ({ kind: "tools" as const, toolCalls: [bashCall, secondCall] })),
    });
    const resp = await renderResponse(a);
    const { events } = await readSSE(resp);
    const toolDeltas = events
      .flatMap((e) => (e.choices?.[0]?.delta?.tool_calls ?? []) as any[])
      .filter(Boolean);
    expect(toolDeltas.map((d) => d.index)).toEqual([0, 1]);
    expect(toolDeltas.map((d) => d.id)).toEqual(["call_1", "call_2"]);
    expect(toolDeltas.map((d) => d.function.name)).toEqual(["bash", "write_file"]);
    expect(toolDeltas[0].function.arguments).toBe(bashCall.function.arguments);
    expect(toolDeltas[1].function.arguments).toBe(secondCall.function.arguments);
    expect(events.some((e) => e.choices?.[0]?.finish_reason === "tool_calls")).toBe(true);
  });

  it("adds usage only to the terminal stream chunk when includeUsage is true", async () => {
    const a = args({ stream: true });
    const resp = await renderResponse(a);
    const { events } = await readSSE(resp);
    const withUsage = events.filter((e) => e.usage != null);
    expect(withUsage).toHaveLength(1);
    expect(withUsage[0].choices[0].finish_reason).not.toBeNull();
    expect(withUsage[0].usage).toEqual({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
    expect(a.usage).toHaveBeenCalledOnce();
  });

  it("omits usage from the stream when includeUsage is false", async () => {
    const a = args({ stream: true, includeUsage: false });
    const resp = await renderResponse(a);
    const { events } = await readSSE(resp);
    expect(events.some((e) => e.usage != null)).toBe(false);
    expect(a.usage).not.toHaveBeenCalled();
  });

  it("turns a produced error into an in-stream error event after HTTP 200", async () => {
    const errResp = jsonResponse(502, { error: { message: "upstream exploded", type: "whatever" } });
    const a = args({
      stream: true,
      produce: vi.fn(async () => ({ kind: "error" as const, resp: errResp })),
    });
    const resp = await renderResponse(a);
    expect(resp.status).toBe(200);
    const { text, events } = await readSSE(resp);
    const errEvent = events.find((e) => e.error != null);
    expect(errEvent?.error.message).toBe("upstream exploded");
    expect(errEvent?.error.type).toBe("upstream_error");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("turns a thrown produce error into an in-stream upstream error", async () => {
    const a = args({
      stream: true,
      produce: vi.fn(async () => { throw new Error("boom"); }),
    });
    const resp = await renderResponse(a);
    expect(resp.status).toBe(200);
    const { text, events } = await readSSE(resp);
    const errEvent = events.find((e) => e.error != null);
    expect(errEvent?.error.message).toBe("boom");
    expect(errEvent?.error.type).toBe("upstream_error");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("does not duplicate a divergent live prefix", async () => {
    const produce = vi.fn(async (onDelta?: (d: string) => void) => {
      onDelta?.("hello");
      return { kind: "text" as const, text: "goodbye" };
    });
    const a = args({ stream: true, produce });
    const resp = await renderResponse(a);
    const { text, events } = await readSSE(resp);
    const content = events
      .map((e) => e.choices?.[0]?.delta?.content)
      .filter((c): c is string => typeof c === "string");
    expect(content).toEqual(["hello"]);
    expect(content.some((c) => c.includes("goodbye"))).toBe(false);
    expect(events.filter((e) => e.choices?.[0]?.finish_reason != null)).toHaveLength(1);
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("emits the complete text at finalization when there are no live deltas", async () => {
    const a = args({ stream: true }); // default produce ignores the callback
    const resp = await renderResponse(a);
    const { events } = await readSSE(resp);
    const content = events
      .map((e) => e.choices?.[0]?.delta?.content)
      .filter((c): c is string => typeof c === "string");
    expect(content).toEqual(["hello"]);
    expect(events.filter((e) => e.choices?.[0]?.finish_reason != null)).toHaveLength(1);
  });
});
