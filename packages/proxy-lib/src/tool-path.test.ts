import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { produceToolPath, type ToolPathDeps, type ToolPathResult } from "./tool-path.js";
import type { ToolDef } from "@m365-copilot/core";
import { CONFAB_FORCE_PROMPT, HALLUCINATION_FORCE_PROMPT, REMOTE_ARTIFACT_FORCE_PROMPT } from "./force-prompts.js";

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

describe("produceToolPath recovery loop", () => {
  // Realistic text fixtures that trigger the real detectors in @m365-copilot/core.
  const CONFAB_TEXT = "I can't access the files in the repository.";
  const HALLUC_TEXT = "I've updated the README with the new instructions.";
  const REMOTE_TEXT = "I saved the fix as a remote patch: https://asyncgw.teams.microsoft.com/artifacts/plan.patch — please apply it.";
  const PRECEDENCE_TEXT = "I can't access the local files, but I updated the remote copy: https://asyncgw.teams.microsoft.com/artifacts/plan.patch";
  const BASH_FENCE = "```bash\nls -la\n```";

  beforeEach(() => {
    delete process.env.M365_ALLOW_MULTI_TOOL;
    delete process.env.M365_NO_CONFAB_RETRY;
    delete process.env.M365_CONFAB_RETRIES;
  });

  afterEach(() => {
    delete process.env.M365_ALLOW_MULTI_TOOL;
    delete process.env.M365_NO_CONFAB_RETRY;
    delete process.env.M365_CONFAB_RETRIES;
  });

  it("confabulation triggers a forced retry and recovers a tool call", async () => {
    const runTurn = vi.fn()
      .mockResolvedValueOnce({ fullText: CONFAB_TEXT })
      .mockResolvedValueOnce({ fullText: BASH_FENCE });
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
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({ command: "ls -la" });
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(runTurn.mock.calls[0][0]).toBe(INITIAL_PROMPT);
    expect(runTurn.mock.calls[1][0]).toBe(CONFAB_FORCE_PROMPT);
    expect(markSent).toHaveBeenCalledTimes(2);
    expect(markSent).toHaveBeenCalledWith(0);
    expect(registerToolCalls).toHaveBeenCalledOnce();
    expect(registerToolCalls).toHaveBeenCalledWith(result.toolCalls);
  });

  it("confabulation retry error propagates", async () => {
    const resp = new Response("boom", { status: 503 });
    const runTurn = vi.fn()
      .mockResolvedValueOnce({ fullText: CONFAB_TEXT })
      .mockResolvedValueOnce({ error: resp });
    const markSent = vi.fn();
    const registerToolCalls = vi.fn();
    const deps: ToolPathDeps = {
      runTurn,
      markSent,
      registerToolCalls,
      messages: [],
      tools: [bashTool],
    };

    const result = narrow(await produceToolPath(INITIAL_PROMPT, deps), "error");

    expect(result.resp).toBe(resp);
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(runTurn.mock.calls[0][0]).toBe(INITIAL_PROMPT);
    expect(runTurn.mock.calls[1][0]).toBe(CONFAB_FORCE_PROMPT);
    expect(markSent).toHaveBeenCalledOnce();
    expect(markSent).toHaveBeenCalledWith(0);
    expect(registerToolCalls).not.toHaveBeenCalled();
  });

  it("M365_NO_CONFAB_RETRY disables the retry", async () => {
    process.env.M365_NO_CONFAB_RETRY = "1";
    const runTurn = vi.fn().mockResolvedValue({ fullText: CONFAB_TEXT });
    const markSent = vi.fn();
    const registerToolCalls = vi.fn();
    const deps: ToolPathDeps = {
      runTurn,
      markSent,
      registerToolCalls,
      messages: [],
      tools: [bashTool],
    };

    const result = narrow(await produceToolPath(INITIAL_PROMPT, deps), "text");

    expect(result.text).toBe(CONFAB_TEXT);
    expect(runTurn).toHaveBeenCalledOnce();
    expect(runTurn).toHaveBeenCalledWith(INITIAL_PROMPT);
    expect(registerToolCalls).not.toHaveBeenCalled();
    expect(markSent).toHaveBeenCalledOnce();
    expect(markSent).toHaveBeenCalledWith(0);
  });

  it("M365_CONFAB_RETRIES permits multiple recovery attempts", async () => {
    process.env.M365_CONFAB_RETRIES = "2";
    const runTurn = vi.fn()
      .mockResolvedValueOnce({ fullText: CONFAB_TEXT })
      .mockResolvedValueOnce({ fullText: CONFAB_TEXT })
      .mockResolvedValueOnce({ fullText: BASH_FENCE });
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
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({ command: "ls -la" });
    expect(runTurn).toHaveBeenCalledTimes(3);
    expect(runTurn.mock.calls[0][0]).toBe(INITIAL_PROMPT);
    expect(runTurn.mock.calls[1][0]).toBe(CONFAB_FORCE_PROMPT);
    expect(runTurn.mock.calls[2][0]).toBe(CONFAB_FORCE_PROMPT);
    expect(markSent).toHaveBeenCalledTimes(3);
    expect(markSent).toHaveBeenCalledWith(0);
    expect(registerToolCalls).toHaveBeenCalledOnce();
    expect(registerToolCalls).toHaveBeenCalledWith(result.toolCalls);
  });

  it("hallucinated completion triggers a forced retry when no tool ran", async () => {
    const runTurn = vi.fn()
      .mockResolvedValueOnce({ fullText: HALLUC_TEXT })
      .mockResolvedValueOnce({ fullText: BASH_FENCE });
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
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({ command: "ls -la" });
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(runTurn.mock.calls[0][0]).toBe(INITIAL_PROMPT);
    expect(runTurn.mock.calls[1][0]).toBe(HALLUCINATION_FORCE_PROMPT);
    expect(markSent).toHaveBeenCalledTimes(2);
    expect(markSent).toHaveBeenCalledWith(0);
    expect(registerToolCalls).toHaveBeenCalledOnce();
    expect(registerToolCalls).toHaveBeenCalledWith(result.toolCalls);
  });

  it("prior real tool activity suppresses hallucination recovery", async () => {
    const runTurn = vi.fn().mockResolvedValue({ fullText: HALLUC_TEXT });
    const markSent = vi.fn();
    const registerToolCalls = vi.fn();
    const deps: ToolPathDeps = {
      runTurn,
      markSent,
      registerToolCalls,
      messages: [{ role: "assistant", tool_calls: [{ id: "call-1", function: { name: "bash", arguments: "{}" } }] }],
      tools: [bashTool],
    };

    const result = narrow(await produceToolPath(INITIAL_PROMPT, deps), "text");

    expect(result.text).toBe(HALLUC_TEXT);
    expect(runTurn).toHaveBeenCalledOnce();
    expect(runTurn).toHaveBeenCalledWith(INITIAL_PROMPT);
    expect(registerToolCalls).not.toHaveBeenCalled();
    expect(markSent).toHaveBeenCalledOnce();
    expect(markSent).toHaveBeenCalledWith(1);
  });

  it("hallucinated completion persists after retry and fails closed", async () => {
    const runTurn = vi.fn()
      .mockResolvedValueOnce({ fullText: HALLUC_TEXT })
      .mockResolvedValueOnce({ fullText: HALLUC_TEXT });
    const markSent = vi.fn();
    const registerToolCalls = vi.fn();
    const deps: ToolPathDeps = {
      runTurn,
      markSent,
      registerToolCalls,
      messages: [],
      tools: [bashTool],
    };

    const result = narrow(await produceToolPath(INITIAL_PROMPT, deps), "error");

    expect(result.resp.status).toBe(502);
    const body = await result.resp.json();
    expect(body.error.type).toBe("file_mutation_without_local_tool");
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(runTurn.mock.calls[1][0]).toBe(HALLUCINATION_FORCE_PROMPT);
    expect(markSent).toHaveBeenCalledTimes(2);
    expect(markSent).toHaveBeenCalledWith(0);
    expect(registerToolCalls).not.toHaveBeenCalled();
  });

  it("remote artifact triggers a forced retry and recovers a local tool call", async () => {
    const runTurn = vi.fn()
      .mockResolvedValueOnce({ fullText: REMOTE_TEXT })
      .mockResolvedValueOnce({ fullText: BASH_FENCE });
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
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({ command: "ls -la" });
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(runTurn.mock.calls[0][0]).toBe(INITIAL_PROMPT);
    expect(runTurn.mock.calls[1][0]).toBe(REMOTE_ARTIFACT_FORCE_PROMPT);
    expect(markSent).toHaveBeenCalledTimes(2);
    expect(markSent).toHaveBeenCalledWith(0);
    expect(registerToolCalls).toHaveBeenCalledOnce();
    expect(registerToolCalls).toHaveBeenCalledWith(result.toolCalls);
  });

  it("remote artifact persists after retry and fails closed", async () => {
    const runTurn = vi.fn()
      .mockResolvedValueOnce({ fullText: REMOTE_TEXT })
      .mockResolvedValueOnce({ fullText: REMOTE_TEXT });
    const markSent = vi.fn();
    const registerToolCalls = vi.fn();
    const deps: ToolPathDeps = {
      runTurn,
      markSent,
      registerToolCalls,
      messages: [],
      tools: [bashTool],
    };

    const result = narrow(await produceToolPath(INITIAL_PROMPT, deps), "error");

    expect(result.resp.status).toBe(502);
    const body = await result.resp.json();
    expect(body.error.type).toBe("file_mutation_without_local_tool");
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(runTurn.mock.calls[1][0]).toBe(REMOTE_ARTIFACT_FORCE_PROMPT);
    expect(markSent).toHaveBeenCalledTimes(2);
    expect(markSent).toHaveBeenCalledWith(0);
    expect(registerToolCalls).not.toHaveBeenCalled();
  });

  // All three detectors fire on this text (confab + remote + hallucination);
  // remote-artifact wins because it is checked first in the recovery loop.
  it("remote artifact wins detector precedence", async () => {
    const runTurn = vi.fn()
      .mockResolvedValueOnce({ fullText: PRECEDENCE_TEXT })
      .mockResolvedValueOnce({ fullText: BASH_FENCE });
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
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({ command: "ls -la" });
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(runTurn.mock.calls[0][0]).toBe(INITIAL_PROMPT);
    expect(runTurn.mock.calls[1][0]).toBe(REMOTE_ARTIFACT_FORCE_PROMPT);
    expect(markSent).toHaveBeenCalledTimes(2);
    expect(markSent).toHaveBeenCalledWith(0);
    expect(registerToolCalls).toHaveBeenCalledOnce();
    expect(registerToolCalls).toHaveBeenCalledWith(result.toolCalls);
  });
});
