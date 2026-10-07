import { describe, expect, it } from "vitest";
import { compileDelta, LOCAL_TOOL_REMINDER } from "./context-compiler.js";

describe("compileDelta", () => {
  it("preserves delta compilation behavior", () => {
    const output = compileDelta({
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
    expect(compileDelta({
      messages: [{ role: "user", content: "continue" }],
      taskAnchor: "task",
      hasTools: false,
    })).toBe("<user>\ncontinue\n</user>");
  });

  it("truncates oversized tool results via the shared bounded truncation", () => {
    const big = "x".repeat(20_000);
    const output = compileDelta({
      messages: [{ role: "tool", name: "bash", tool_call_id: "call-1", content: big }],
      taskAnchor: "task",
      hasTools: true,
    });
    expect(output.length).toBeLessThan(big.length + 400);
    expect(output).toContain("[tool output truncated:");
  });

  it("names a tool result from the issuing assistant tool_call when the message has no name", () => {
    const history = [
      { role: "user", content: "fix it" },
      { role: "assistant", content: null, tool_calls: [{ id: "call-7", function: { name: "edit", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call-7", content: "applied" },
      { role: "tool", tool_call_id: "call-missing", content: "orphan" },
    ];

    const output = compileDelta({ messages: history.slice(2), taskAnchor: "t", hasTools: false, history });

    expect(output).toBe([
      '<tool_response name="edit" call_id="call-7">\napplied\n</tool_response>',
      '<tool_response name="unknown" call_id="call-missing">\norphan\n</tool_response>',
    ].join("\n\n"));
  });
});
