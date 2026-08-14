import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { produceToolPath, type ToolPathDeps, type ToolPathResult } from "./tool-path.js";
import type { ToolDef } from "@m365-copilot/core";
/** Assert the result kind and narrow the discriminated union for typecheck. */
function narrow<T extends ToolPathResult["kind"]>(
  r: ToolPathResult,
  kind: T,
): Extract<ToolPathResult, { kind: T }> {
  expect(r.kind).toBe(kind);
  return r as Extract<ToolPathResult, { kind: T }>;
}

const bashTool: ToolDef = {
  type: "function",
  function: {
    name: "bash",
    description: "Run a shell command",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
};

const replyTool: ToolDef = {
  type: "function",
  function: {
    name: "reply",
    description: "Send a plain-text answer to the user",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
};

const INITIAL_PROMPT = "fix the bug";

describe("produceToolPath normal path", () => {
  beforeEach(() => {
    delete process.env.M365_ALLOW_MULTI_TOOL;
  });

  afterEach(() => {
    delete process.env.M365_ALLOW_MULTI_TOOL;
  });

  it("valid single tool call passes through", async () => {
    const runTurn = vi.fn().mockResolvedValue({ fullText: "```bash\nls -la\n```" });
    const markSent = vi.fn();
    const registerToolCalls = vi.fn();
    const deps: ToolPathDeps = {
      runTurn,
      markSent,
      registerToolCalls,
      messages: [],
      tools: [bashTool],
    };

    const result = narrow(await produceToolPath(INITIAL_PROMPT, deps), "tools");

    expect(result.toolCalls).toHaveLength(1);
    const call = result.toolCalls[0];
    expect(call.function.name).toBe("bash");
    expect(JSON.parse(call.function.arguments)).toEqual({ command: "ls -la" });
    expect(runTurn).toHaveBeenCalledOnce();
    expect(runTurn).toHaveBeenCalledWith(INITIAL_PROMPT);
    expect(markSent).toHaveBeenCalledOnce();
    expect(markSent).toHaveBeenCalledWith(0);
    expect(registerToolCalls).toHaveBeenCalledOnce();
    expect(registerToolCalls).toHaveBeenCalledWith(result.toolCalls);
  });

  it("plain text passes through", async () => {
    const runTurn = vi.fn().mockResolvedValue({ fullText: "hello" });
    const markSent = vi.fn();
    const registerToolCalls = vi.fn();
    const deps: ToolPathDeps = {
      runTurn,
      markSent,
      registerToolCalls,
      messages: [],
      tools: [],
    };

    const result = narrow(await produceToolPath(INITIAL_PROMPT, deps), "text");

    expect(result.text).toBe("hello");
    expect(registerToolCalls).not.toHaveBeenCalled();
    expect(runTurn).toHaveBeenCalledOnce();
    expect(runTurn).toHaveBeenCalledWith(INITIAL_PROMPT);
    expect(markSent).toHaveBeenCalledOnce();
    expect(markSent).toHaveBeenCalledWith(0);
  });

  it("initial upstream error propagates unchanged", async () => {
    const resp = new Response("boom", { status: 503 });
    const runTurn = vi.fn().mockResolvedValue({ error: resp });
    const markSent = vi.fn();
    const registerToolCalls = vi.fn();
    const deps: ToolPathDeps = {
      runTurn,
      markSent,
      registerToolCalls,
      messages: [],
      tools: [],
    };

    const result = narrow(await produceToolPath(INITIAL_PROMPT, deps), "error");

    expect(result.resp).toBe(resp);
    expect(markSent).not.toHaveBeenCalled();
    expect(registerToolCalls).not.toHaveBeenCalled();
    expect(runTurn).toHaveBeenCalledOnce();
    expect(runTurn).toHaveBeenCalledWith(INITIAL_PROMPT);
  });

  it("multiple calls collapse to the first by default", async () => {
    delete process.env.M365_ALLOW_MULTI_TOOL;
    const runTurn = vi.fn().mockResolvedValue({
      fullText: "```bash\necho 1\n```\n```bash\necho 2\n```",
    });
    const markSent = vi.fn();
    const registerToolCalls = vi.fn();
    const deps: ToolPathDeps = {
      runTurn,
      markSent,
      registerToolCalls,
      messages: [],
      tools: [bashTool],
    };

    const result = narrow(await produceToolPath(INITIAL_PROMPT, deps), "tools");

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe("bash");
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({ command: "echo 1" });
    expect(registerToolCalls).toHaveBeenCalledOnce();
    expect(registerToolCalls).toHaveBeenCalledWith(result.toolCalls);
    expect(markSent).toHaveBeenCalledOnce();
    expect(markSent).toHaveBeenCalledWith(0);
    expect(runTurn).toHaveBeenCalledOnce();
    expect(runTurn).toHaveBeenCalledWith(INITIAL_PROMPT);
  });

  it("M365_ALLOW_MULTI_TOOL preserves the batch", async () => {
    process.env.M365_ALLOW_MULTI_TOOL = "1";
    const runTurn = vi.fn().mockResolvedValue({
      fullText: "```bash\necho 1\n```\n```bash\necho 2\n```",
    });
    const markSent = vi.fn();
    const registerToolCalls = vi.fn();
    const deps: ToolPathDeps = {
      runTurn,
      markSent,
      registerToolCalls,
      messages: [],
      tools: [bashTool],
    };

    const result = narrow(await produceToolPath(INITIAL_PROMPT, deps), "tools");

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].function.name).toBe("bash");
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({ command: "echo 1" });
    expect(result.toolCalls[1].function.name).toBe("bash");
    expect(JSON.parse(result.toolCalls[1].function.arguments)).toEqual({ command: "echo 2" });
    expect(registerToolCalls).toHaveBeenCalledOnce();
    expect(registerToolCalls).toHaveBeenCalledWith(result.toolCalls);
    expect(markSent).toHaveBeenCalledOnce();
    expect(markSent).toHaveBeenCalledWith(0);
    expect(runTurn).toHaveBeenCalledOnce();
    expect(runTurn).toHaveBeenCalledWith(INITIAL_PROMPT);
  });

  it("reply-only call becomes text", async () => {
    const runTurn = vi.fn().mockResolvedValue({ fullText: "```reply\ndone\n```" });
    const markSent = vi.fn();
    const registerToolCalls = vi.fn();
    const deps: ToolPathDeps = {
      runTurn,
      markSent,
      registerToolCalls,
      messages: [],
      tools: [replyTool],
    };

    const result = narrow(await produceToolPath(INITIAL_PROMPT, deps), "text");

    expect(result.text).toBe("done");
    expect(registerToolCalls).not.toHaveBeenCalled();
    expect(runTurn).toHaveBeenCalledOnce();
    expect(runTurn).toHaveBeenCalledWith(INITIAL_PROMPT);
    expect(markSent).toHaveBeenCalledOnce();
    expect(markSent).toHaveBeenCalledWith(0);
  });

  it("reply mixed with a real tool keeps only the real tool", async () => {
    const runTurn = vi.fn().mockResolvedValue({
      fullText: "```reply\ndone\n```\n```bash\nls -la\n```",
    });
    const markSent = vi.fn();
    const registerToolCalls = vi.fn();
    const deps: ToolPathDeps = {
      runTurn,
      markSent,
      registerToolCalls,
      messages: [],
      tools: [replyTool, bashTool],
    };

    const result = narrow(await produceToolPath(INITIAL_PROMPT, deps), "tools");

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe("bash");
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({ command: "ls -la" });
    expect(registerToolCalls).toHaveBeenCalledOnce();
    expect(registerToolCalls).toHaveBeenCalledWith(result.toolCalls);
    expect(markSent).toHaveBeenCalledOnce();
    expect(markSent).toHaveBeenCalledWith(0);
    expect(runTurn).toHaveBeenCalledOnce();
    expect(runTurn).toHaveBeenCalledWith(INITIAL_PROMPT);
  });
});


describe("produceToolPath steering-attribution gate (ticket 03)", () => {
  beforeEach(() => {
    delete process.env.M365_STEERING;
  });

  afterEach(() => {
    delete process.env.M365_STEERING;
  });

  it("degrades to raw text when the ladder is active but the response is unsteered", async () => {
    process.env.M365_STEERING = "1";
    const deps: ToolPathDeps = {
      runTurn: vi.fn().mockResolvedValue({ fullText: "```bash\nls -la\n```" }),
      markSent: vi.fn(),
      registerToolCalls: vi.fn(),
      messages: [],
      tools: [bashTool],
      steeringFingerprint: () => "unsteered",
    };

    const result = narrow(await produceToolPath(INITIAL_PROMPT, deps), "text");

    expect(result.text).toContain("ls -la");
    expect(deps.registerToolCalls).not.toHaveBeenCalled();
  });

  it("degrades to raw text when the ladder is active and no fingerprint is available", async () => {
    process.env.M365_STEERING = "1";
    const registerToolCalls = vi.fn();
    const deps: ToolPathDeps = {
      runTurn: vi.fn().mockResolvedValue({ fullText: "```bash\nls -la\n```" }),
      markSent: vi.fn(),
      registerToolCalls,
      messages: [],
      tools: [bashTool],
    };

    const result = narrow(await produceToolPath(INITIAL_PROMPT, deps), "text");

    expect(result.text).toContain("ls -la");
    expect(registerToolCalls).not.toHaveBeenCalled();
  });

  it("routes the fence when the response is attributable as steered", async () => {
    process.env.M365_STEERING = "1";
    const registerToolCalls = vi.fn();
    const deps: ToolPathDeps = {
      runTurn: vi.fn().mockResolvedValue({ fullText: "```bash\nls -la\n```" }),
      markSent: vi.fn(),
      registerToolCalls,
      messages: [],
      tools: [bashTool],
      steeringFingerprint: () => "steered:channel=textarea",
    };

    const result = narrow(await produceToolPath(INITIAL_PROMPT, deps), "tools");

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe("bash");
    expect(registerToolCalls).toHaveBeenCalledOnce();
  });

  it("preserves legacy routing when the ladder is disabled (M365_STEERING unset)", async () => {
    delete process.env.M365_STEERING;
    const registerToolCalls = vi.fn();
    const deps: ToolPathDeps = {
      runTurn: vi.fn().mockResolvedValue({ fullText: "```bash\nls -la\n```" }),
      markSent: vi.fn(),
      registerToolCalls,
      messages: [],
      tools: [bashTool],
      steeringFingerprint: () => "unsteered",
    };

    const result = narrow(await produceToolPath(INITIAL_PROMPT, deps), "tools");

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe("bash");
    expect(registerToolCalls).toHaveBeenCalledOnce();
  });
});
