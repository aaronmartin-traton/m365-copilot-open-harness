import { describe, expect, it } from "vitest";
import { formatMessages } from "@m365-copilot/core";
import { contextCompiler, LOCAL_TOOL_REMINDER } from "./context-compiler.js";

describe("contextCompiler", () => {
  it("preserves full compilation output", () => {
    const messages = [{ role: "user", content: "task" }];
    const tools = [{
      type: "function" as const,
      function: {
        name: "bash",
        description: "Run a shell command",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    }];

    expect(contextCompiler.compileFull({
      messages,
      tools,
      toolChoice: "auto",
      conversationId: "conv-1",
      framingVariant: "softened",
    })).toBe(formatMessages(messages, tools, "auto", "conv-1", "softened"));
  });

  it("preserves delta compilation behavior", () => {
    const output = contextCompiler.compileDelta({
      messages: [
        { role: "system", content: "ignored" },
        { role: "assistant", content: "already upstream" },
        { role: "tool", name: "bash", tool_call_id: "call-1", content: "ok" },
        { role: "user", content: "continue" },
      ],
      taskAnchor: "task",
      hasTools: true,
    });

    expect(output).toBe([
      LOCAL_TOOL_REMINDER,
      "<task_anchor>task</task_anchor>",
      '<tool_response name="bash" call_id="call-1">\nok\n</tool_response>',
      "<user>\ncontinue\n</user>",
    ].join("\n\n"));
  });

  it("does not synthesize tool context in tool-less delta mode", () => {
    expect(contextCompiler.compileDelta({
      messages: [{ role: "user", content: "continue" }],
      taskAnchor: "task",
      hasTools: false,
    })).toBe("<user>\ncontinue\n</user>");
  });
});
