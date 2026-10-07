import { describe, it, expect } from "vitest";
import {
  deriveFencedSpec,
  findFirstToolFence,
  renderFencedCall,
  parseFencedToolCalls,
  buildSpecMap,
  formatFencedToolDefinitions,
  findShellTool,
} from "./fenced.js";
import type { ToolDef } from "./tools.js";

const bash: ToolDef = {
  type: "function",
  function: {
    name: "bash",
    description: "Run a shell command.",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
};

const readFile: ToolDef = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
};

const writeFile: ToolDef = {
  type: "function",
  function: {
    name: "write_file",
    description: "Write a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
};

const editFile: ToolDef = {
  type: "function",
  function: {
    name: "edit_file",
    description: "Replace text.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } },
      required: ["path", "old", "new"],
    },
  },
};

const ALL = [bash, readFile, writeFile, editFile];

const specs = buildSpecMap(ALL);

const singleEditSpecs = buildSpecMap([editFile]);

describe("single edit aliases", () => {
  it("maps edit and edit_file fences to the supplied tool name", () => {
    expect(singleEditSpecs.has("edit")).toBe(true);
    expect(singleEditSpecs.has("edit_file")).toBe(true);
    const parsed = parseFencedToolCalls("before\n```edit\npath: app.ts\n\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n```\nafter", singleEditSpecs);
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0].function.name).toBe("edit_file");
    expect(JSON.parse(parsed.calls[0].function.arguments)).toEqual({ path: "app.ts", old: "old", new: "new" });
    expect(parsed.leftover).toContain("before");
    expect(parsed.leftover).toContain("after");
  });

  it("does not add aliases for multiple edit tools", () => {
    const second = { ...editFile, function: { ...editFile.function, name: "replace_file" } };
    const specs = buildSpecMap([editFile, second]);
    expect(specs.has("edit")).toBe(false);
    expect(specs.has("edit_file")).toBe(true);
  });
});

describe("deriveFencedSpec", () => {
  it("maps a single-param tool's param to the body", () => {
    const s = deriveFencedSpec(readFile);
    expect(s.bodyParam).toBe("path");
    expect(s.headerParams).toEqual([]);
  });

  it("recognizes a named body param and keeps the rest as headers", () => {
    const s = deriveFencedSpec(writeFile);
    expect(s.bodyParam).toBe("content");
    expect(s.headerParams).toEqual(["path"]);
  });

  it("detects an old/new pair as a SEARCH/REPLACE edit", () => {
    const s = deriveFencedSpec(editFile);
    expect(s.editPair).toEqual({ search: "old", replace: "new" });
    expect(s.bodyParam).toBeUndefined();
    expect(s.headerParams).toEqual(["path"]);
  });
});

describe("renderFencedCall", () => {
  it("renders a body-only call with no header", () => {
    const out = renderFencedCall(deriveFencedSpec(bash), { command: "ls -la" });
    expect(out).toBe("```bash\nls -la\n```");
  });

  it("renders header + body separated by a blank line", () => {
    const out = renderFencedCall(deriveFencedSpec(writeFile), { path: "a.py", content: "print(1)" });
    expect(out).toBe("```write_file\npath: a.py\n\nprint(1)\n```");
  });

  it("renders an edit as SEARCH/REPLACE", () => {
    const out = renderFencedCall(deriveFencedSpec(editFile), { path: "a.py", old: "x", new: "y" });
    expect(out).toBe("```edit_file\npath: a.py\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n```");
  });
});

describe("parseFencedToolCalls", () => {
  function argsOf(text: string, n = 0) {
    const { calls } = parseFencedToolCalls(text, specs);

    return { calls, args: calls[n] ? JSON.parse(calls[n].function.arguments) : null };
  }

  it("parses a body-only bash call", () => {
    const { calls, args } = argsOf("```bash\nls -la\n```");
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("bash");
    expect(args).toEqual({ command: "ls -la" });
  });

  it("maps a required body parameter when properties are omitted", () => {
    const incompleteShell: ToolDef = {
      type: "function",
      function: {
        name: "bash",
        parameters: { type: "object", required: ["command"] },
      },
    };

    const { calls } = parseFencedToolCalls("```bash\nprintf ok\n```", buildSpecMap([incompleteShell]));
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ command: "printf ok" });
  });

  it("accepts omitted optional shell controls marked required by a client", () => {
    const normalizedShell: ToolDef = {
      type: "function",
      function: {
        name: "bash",
        parameters: { type: "object", required: ["command", "cwd", "env", "timeout", "pty", "async", "workspace"] },
      },
    };

    const { calls } = parseFencedToolCalls("```bash\nprintf ok\n```", buildSpecMap([normalizedShell]));
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ command: "printf ok" });
  });

  it("round-trips a write_file with a multi-line body", () => {
    const content = "def f():\n    return 1\n\nprint(f())";
    const rendered = renderFencedCall(deriveFencedSpec(writeFile), { path: "f.py", content });
    const { args } = argsOf(rendered);
    expect(args).toEqual({ path: "f.py", content });
  });

  it("round-trips an edit_file SEARCH/REPLACE", () => {
    const rendered = renderFencedCall(deriveFencedSpec(editFile), {
      path: "app.py",
      old: "debug = False",
      new: "debug = True",
    });

    const { args } = argsOf(rendered);
    expect(args).toEqual({ path: "app.py", old: "debug = False", new: "debug = True" });
  });

  it("parses a header body even without the blank separator", () => {
    const { args } = argsOf("```write_file\npath: f.py\nprint(1)\n```");
    expect(args).toEqual({ path: "f.py", content: "print(1)" });
  });

  it("ignores an illustration fence whose lang is not a tool", () => {
    const { calls, leftover } = parseFencedToolCalls("```python\nprint('hi')\n```", specs);
    expect(calls).toHaveLength(0);
    expect(leftover).toContain("print('hi')");
  });

  it("strips matched fences from leftover but keeps real prose", () => {
    const { calls, leftover } = parseFencedToolCalls("Here you go:\n```bash\nls\n```", specs);
    expect(calls).toHaveLength(1);
    expect(leftover).toContain("Here you go");
    expect(leftover).not.toContain("ls\n```");
  });

  it("parses multiple fenced calls", () => {
    const { calls } = parseFencedToolCalls("```read_file\na\n```\n```read_file\nb\n```", specs);
    expect(calls).toHaveLength(2);
  });

  it("drops an edit fence missing SEARCH/REPLACE markers", () => {
    const { calls } = parseFencedToolCalls("```edit_file\npath: a.py\njust some text\n```", specs);
    expect(calls).toHaveLength(0);
  });

  it("handles a body that contains colon-prefixed lines (not misread as headers)", () => {
    const content = "note: this is body text\nmore: lines";
    const rendered = renderFencedCall(deriveFencedSpec(writeFile), { path: "n.txt", content });
    const { args } = argsOf(rendered);
    expect(args.content).toBe(content);
  });

  it("coerces declared boolean headers and rejects missing required arguments", () => {
    const exec: ToolDef = {
      type: "function",
      function: {
        name: "exec",
        parameters: {
          type: "object",
          properties: { command: { type: "string" }, interactive: { type: "boolean" } },
          required: ["command", "interactive"],
        },
      },
    };

    const execSpecs = buildSpecMap([exec]);
    const parsed = parseFencedToolCalls("```exec\ninteractive: false\n\npwd\n```", execSpecs).calls;
    expect(parsed).toHaveLength(1);
    expect(JSON.parse(parsed[0].function.arguments)).toEqual({ command: "pwd", interactive: false });
    expect(parseFencedToolCalls("```exec\npwd\n```", execSpecs).calls).toHaveLength(0);
  });

  it("accepts hyphenated tool names", () => {
    const hyphenated: ToolDef = {
      type: "function",
      function: { name: "read-file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    };

    const calls = parseFencedToolCalls("```read-file\nfile.txt\n```", buildSpecMap([hyphenated])).calls;
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("read-file");
  });
});

describe("shell routing (Tier 1)", () => {
  const runCommand: ToolDef = {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  };

  const codexShell: ToolDef = {
    type: "function",
    function: {
      name: "shell_command",
      description: "Runs a Powershell command (Windows) and returns its output.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout_ms: { type: "number" },
        },
        required: ["command"],
      },
    },
  };

  it("detects a shell tool under various names", () => {
    expect(findShellTool([bash])?.function.name).toBe("bash");
    expect(findShellTool([runCommand])?.function.name).toBe("run_command");
    expect(findShellTool([readFile, writeFile])).toBeUndefined();
  });

  it("routes a ```bash block to a differently-named shell tool", () => {
    const specs = buildSpecMap([runCommand, readFile]);
    const { calls } = parseFencedToolCalls("```bash\nsed -i 's/a/b/' f.py\n```", specs);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("run_command");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ command: "sed -i 's/a/b/' f.py" });
  });

  it("routes Bash through Git Bash for Codex's PowerShell tool", () => {
    const specs = buildSpecMap([codexShell]);
    const call = parseFencedToolCalls("```bash\ncat file.txt\n```", specs).calls[0];
    expect(call.function.name).toBe("shell_command");
    const args = JSON.parse(call.function.arguments);
    expect(args.command).toContain("Y2F0IGZpbGUudHh0");
    expect(args.command).toContain("$env:ProgramFiles\\Git\\bin\\bash.exe");
  });

  it("warns Codex-backed prompts not to use the hosted /mnt/data sandbox", () => {
    expect(formatFencedToolDefinitions([codexShell])).toContain("Never use /mnt/data");
  });

  it("routes ```sh and ```shell aliases too", () => {
    const specs = buildSpecMap([runCommand]);
    expect(parseFencedToolCalls("```sh\nls\n```", specs).calls[0]?.function.name).toBe("run_command");
    expect(parseFencedToolCalls("```shell\nls\n```", specs).calls[0]?.function.name).toBe("run_command");
  });
  it("routes leaked container execution fences to the harness shell", () => {
    const specs = buildSpecMap([runCommand]);
    const call = parseFencedToolCalls("```container.exec\nls -la\n```", specs).calls[0];
    expect(call?.function.name).toBe("run_command");
    expect(JSON.parse(call.function.arguments)).toEqual({ command: "ls -la" });
  });

  it("does not hijack ```bash when a real tool is literally named bash", () => {
    // bash tool present → ```bash maps to it directly (not via alias), name stays bash
    const specs = buildSpecMap([bash, readFile]);
    expect(parseFencedToolCalls("```bash\nls\n```", specs).calls[0]?.function.name).toBe("bash");
  });

  it("injects shell-first framing only when a shell tool is present", () => {
    expect(formatFencedToolDefinitions([bash, readFile])).toContain("You have a real shell");
    expect(formatFencedToolDefinitions([readFile, writeFile])).not.toContain("You have a real shell");
  });
});

describe("formatFencedToolDefinitions", () => {
  it("lists each tool as a fenced template inside <tools>", () => {
    const out = formatFencedToolDefinitions(ALL);
    expect(out).toContain("<tools>");
    expect(out).toContain("```bash");
    expect(out).toContain("```write_file");
    expect(out).toContain("<<<<<<< SEARCH");
    // Stresses the action-not-illustration contract
    expect(out).toContain("ACTION");
    expect(out).toContain("PRIMARY JOB");
  });
});
describe("array and object params written as a YAML block (#50)", () => {
  // pi's `edit` tool: the tools block shows it as `edits: <edits>`.
  const piEdit: ToolDef = {
    type: "function",
    function: {
      name: "edit",
      description: "Edit a single file using exact text replacement.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          edits: { type: "array", items: { type: "object", properties: { oldText: { type: "string" }, newText: { type: "string" } } } },
        },
        required: ["path", "edits"],
      },
    },
  };
  const opts: ToolDef = {
    type: "function",
    function: { name: "configure", parameters: { type: "object", properties: { target: { type: "string" }, options: { type: "object" } } } },
  };
  const piSpecs = buildSpecMap([piEdit, opts, bash]);
  const argsOf = (text: string) => {
    const { calls } = parseFencedToolCalls(text, piSpecs);
    expect(calls).toHaveLength(1);
    return JSON.parse(calls[0].function.arguments);
  };

  it("reads Sonnet 4.6's block list, verbatim from real pi (44 of its 47 edits were lost)", () => {
    const args = argsOf('```edit\npath: /tmp/pi-task-mi5OyW/mathutil.py\nedits:\n  - oldText: "    return sum(nums) / len(nums) + 1"\n    newText: "    return sum(nums) / len(nums)"\n```');
    expect(args).toEqual({
      path: "/tmp/pi-task-mi5OyW/mathutil.py",
      edits: [{ oldText: "    return sum(nums) / len(nums) + 1", newText: "    return sum(nums) / len(nums)" }],
    });
  });

  it("still reads the inline JSON Opus writes", () => {
    const args = argsOf('```edit\npath: calc.py\nedits: [{"oldText": "    return a - b", "newText": "    return a + b"}]\n```');
    expect(args.edits).toEqual([{ oldText: "    return a - b", newText: "    return a + b" }]);
  });

  it("reads single-quoted text with quotes and colons inside, and several items", () => {
    const args = argsOf(`\`\`\`edit\npath: calc.py\nedits:\n  - oldText: '"quotient": a - b,'\n    newText: '"quotient": a / b,'\n  - oldText: 'it''s'\n    newText: "say \\"hi\\"\\tthere"\n\`\`\``);
    expect(args.edits).toEqual([
      { oldText: '"quotient": a - b,', newText: '"quotient": a / b,' },
      { oldText: "it's", newText: 'say "hi"\tthere' },
    ]);
  });

  it("reads multi-line text as | and |- block scalars", () => {
    const args = argsOf("```edit\npath: calc.py\nedits:\n  - oldText: |\n      def add(a, b):\n          return a - b\n    newText: |-\n      def add(a, b):\n\n          return a + b\n```");
    expect(args.edits).toEqual([
      { oldText: "def add(a, b):\n    return a - b\n", newText: "def add(a, b):\n\n    return a + b" },
    ]);
  });

  it("reads a list whose dashes sit at the key's own column", () => {
    const args = argsOf("```edit\npath: a.py\nedits:\n- oldText: x = 1\n  newText: x = 2\n```");
    expect(args.edits).toEqual([{ oldText: "x = 1", newText: "x = 2" }]);
  });

  it("keeps mapping values as text — no YAML booleans or numbers", () => {
    const args = argsOf("```edit\npath: a.txt\nedits:\n  - oldText: 3000\n    newText: true\n```");
    expect(args.edits).toEqual([{ oldText: "3000", newText: "true" }]);
  });

  it("reads an object-typed param as a mapping, and carries on with the header after it", () => {
    const args = argsOf("```configure\noptions:\n  mode: fast\n  retries: 3\ntarget: prod\n```");
    expect(args).toEqual({ options: { mode: "fast", retries: "3" }, target: "prod" });
  });

  it("falls back to the old reading when the block isn't YAML it can read", () => {
    const args = argsOf("```edit\npath: a.py\nedits:\n  - oldText: x\n        newText: misaligned\n```");
    expect(args.edits).toBe("");
  });

  it("leaves a string param's indented lines alone, as before", () => {
    const args = argsOf("```bash\n  echo indented\n```");
    expect(args.command).toBe("  echo indented");
  });
});
describe("native call closer leaking into a fence (Opus)", () => {
  const SCRIPT = "#!/bin/bash\nwc -l < data.txt | tr -d ' ' > count.txt";
  function argsOf(text: string) {
    const { calls, leftover } = parseFencedToolCalls(text, specs);
    return { calls, leftover, args: calls[0] ? JSON.parse(calls[0].function.arguments) : null };
  }

  it("keeps </invoke> out of the file when the fence is closed too", () => {
    const { args } = argsOf(`\`\`\`write_file\npath: count.sh\n\n${SCRIPT}\n</invoke>\n\`\`\``);
    expect(args).toEqual({ path: "count.sh", content: SCRIPT });
  });

  it("…and with a stray zero-width line before the closing fence", () => {
    const { args } = argsOf(`\`\`\`write_file\npath: count.sh\n\n${SCRIPT}\n</invoke>\n\u200c\n\`\`\``);
    expect(args).toEqual({ path: "count.sh", content: SCRIPT });
  });

  it("accepts a fence that </invoke> ends instead of ```, stray symbol and all", () => {
    const { calls, args, leftover } = argsOf(`\`\`\`write_file\npath: count.sh\n\n${SCRIPT}\n</invoke>\n∂`);
    expect(calls).toHaveLength(1);
    expect(args).toEqual({ path: "count.sh", content: SCRIPT });
    expect(leftover.trim()).toBe("");
  });

  it("accepts a fence that the tool's own closing tag ends", () => {
    const { args } = argsOf(`\`\`\`write_file\npath: count.sh\n\n${SCRIPT}\n</write_file>`);
    expect(args).toEqual({ path: "count.sh", content: SCRIPT });
  });

  it("drops native <parameter> lines after the closer, unclosed fence (opus45-r5c relay)", () => {
    const script = "#!/usr/bin/env bash\nwc -l < data.txt | tr -d ' ' > count.txt";
    const { calls, args } = argsOf(`\`\`\`write_file\npath: count.sh\n\n${script}\n</invoke>\n<parameter name="path">count.sh</parameter>`);
    expect(calls).toHaveLength(1);
    expect(args).toEqual({ path: "count.sh", content: script });
  });

  it("…and inside a closed fence", () => {
    const { args } = argsOf(`\`\`\`write_file\npath: count.sh\n\n${SCRIPT}\n</invoke>\n<parameter name="path">count.sh</parameter>\n</function_calls>\n\`\`\``);
    expect(args).toEqual({ path: "count.sh", content: SCRIPT });
  });

  it("drops </parameter> lines BEFORE the closer too — they'd run as shell (opus45-r5c retag)", () => {
    const command = "cat > count.sh <<'EOF'\n#!/bin/bash\nwc -l < data.txt | tr -d ' \\t' > count.txt\nEOF\nchmod +x count.sh\n./count.sh\ncat -A count.txt";
    const { calls, args } = argsOf(`\`\`\`bash\n${command}\n</parameter>\n</invoke>\n</function_calls>`);
    expect(calls).toHaveLength(1);
    expect(args).toEqual({ command });
  });

  it("drops a bare trailing </parameter> — it was written into count.sh 3 times (round 1, r3)", () => {
    const { args } = argsOf(`\`\`\`write_file\npath: count.sh\n\n${SCRIPT}\n</parameter>\n\`\`\``);
    expect(args).toEqual({ path: "count.sh", content: SCRIPT });
    const bash = argsOf("```bash\nchmod +x count.sh\ncat count.sh\n</parameter>\n```").args;
    expect(bash).toEqual({ command: "chmod +x count.sh\ncat count.sh" });
  });

  it("keeps native-looking markup that real content follows", () => {
    const { args } = argsOf("```write_file\npath: x.xml\n\n<a>\n</parameter>\n<b/>\n```");
    expect(args.content).toBe("<a>\n</parameter>\n<b/>");
  });

  it("keeps a closer that real content follows", () => {
    const content = "<x>\n</invoke>\necho done";
    const { args } = argsOf(`\`\`\`write_file\npath: x.sh\n\n${content}\n\`\`\``);
    expect(args.content).toBe(content);
    expect(argsOf(`\`\`\`write_file\npath: x.sh\n\n${content}`).calls).toHaveLength(0);
  });

  it("keeps prose before an unclosed call as leftover", () => {
    const { calls, leftover } = argsOf("Writing the script now.\n```bash\nls\n</invoke>");
    expect(calls).toHaveLength(1);
    expect(leftover.trim()).toBe("Writing the script now.");
  });

  it("does not accept an unclosed fence with no end marker — it may be truncated", () => {
    expect(argsOf(`\`\`\`write_file\npath: count.sh\n\n${SCRIPT}`).calls).toHaveLength(0);
  });

  it("only strips a closer on the LAST line, never one inside the content", () => {
    const content = "<a>\n</invoke>\n</a>";
    const { args } = argsOf(`\`\`\`write_file\npath: x.xml\n\n${content}\n\`\`\``);
    expect(args.content).toBe(content);
  });

  it("does not take another tool's closing tag as a closer", () => {
    const content = "<p>\n</read_file>";
    const { args } = argsOf(`\`\`\`write_file\npath: x.html\n\n${content}\n\`\`\``);
    expect(args.content).toBe(content);
  });

  it("finds the unclosed call for findFirstToolFence too", () => {
    const text = `\`\`\`bash\nls\n</invoke>`;
    expect(findFirstToolFence(text, specs)).toEqual({ start: 0, end: text.length });
  });
});
