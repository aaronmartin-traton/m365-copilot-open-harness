/**
 * tool-path.contract.test.ts
 *
 * Executable architectural contract for the simplified proxy: "translate, do
 * not infer." Locked at the `produceToolPath()` seam with a fake `runTurn` —
 * no network, no model, no quota, no verifier.
 *
 * Governing property:
 *   M365 text → deterministic translation
 *
 * Killer invariant (asserted in every test):
 *   `runTurn` is called exactly once — semantic content can never trigger a
 *   corrective upstream turn.
 *
 * Golden table (fake runTurn return → required result):
 *   ordinary prose           → text, exact
 *   valid `bash` fence       → tools (one call)
 *   valid named-tool fence   → tools
 *   two valid calls          → first only
 *   "I updated README.md."   → text unchanged
 *   "I cannot access files"  → text
 *   Teams artifact URL       → text
 *   /mnt/data/foo.patch      → text
 *   malformed fence syntax   → text / parser-defined non-tool result
 */
import { describe, expect, it, vi } from "vitest";
import { produceToolPath, type ToolPathDeps, type ToolPathResult } from "./tool-path.js";
import type { ToolDef } from "@m365-copilot/core";

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
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
};

const readTool: ToolDef = {
  type: "function",
  function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
};

const INITIAL_PROMPT = "fix the bug";

/** One fake turn: runTurn resolves exactly once with `fullText`, then never again. */
function fakeTurn(fullText: string) {
  const runTurn = vi.fn().mockResolvedValue({ fullText });
  return runTurn;
}
function depsLike(runTurn: ReturnType<typeof fakeTurn>, extra: Partial<ToolPathDeps> = {}) {
  return {
    runTurn,
    markSent: vi.fn(),
    registerToolCalls: vi.fn(),
    messages: [],
    tools: [bashTool, readTool],
    ...extra,
  } as ToolPathDeps;
}

describe("produceToolPath contract — translate, do not infer", () => {
  it("ordinary prose returns text unchanged", async () => {
    const runTurn = fakeTurn("The hostname is web-prod-01.");
    const r = narrow(await produceToolPath(INITIAL_PROMPT, depsLike(runTurn)), "text");
    expect(r.text).toBe("The hostname is web-prod-01.");
    expect(runTurn).toHaveBeenCalledOnce();
  });

  it("valid bash fence becomes a single tool call", async () => {
    const runTurn = fakeTurn("```bash\nls -la\n```");
    const r = narrow(await produceToolPath(INITIAL_PROMPT, depsLike(runTurn)), "tools");
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0].function.name).toBe("bash");
    expect(runTurn).toHaveBeenCalledOnce();
  });

  it("valid named-tool fence becomes a tool call", async () => {
    const runTurn = fakeTurn("```read_file\npath: src/index.ts\n```");
    const r = narrow(await produceToolPath(INITIAL_PROMPT, depsLike(runTurn)), "tools");
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0].function.name).toBe("read_file");
    expect(runTurn).toHaveBeenCalledOnce();
  });

  it("two valid calls collapse to the first (one-call-per-turn)", async () => {
    const runTurn = fakeTurn("```bash\necho 1\n```\n```bash\necho 2\n```");
    const r = narrow(await produceToolPath(INITIAL_PROMPT, depsLike(runTurn)), "tools");
    expect(r.toolCalls).toHaveLength(1);
    expect(JSON.parse(r.toolCalls[0].function.arguments)).toEqual({ command: "echo 1" });
    expect(runTurn).toHaveBeenCalledOnce();
  });

  it("prose that merely looks like a file mutation stays text", async () => {
    const runTurn = fakeTurn("I've updated the README with the new instructions.");
    const r = narrow(await produceToolPath(INITIAL_PROMPT, depsLike(runTurn)), "text");
    expect(r.text).toBe("I've updated the README with the new instructions.");
    expect(runTurn).toHaveBeenCalledOnce();
  });

  it("confabulation prose stays text (no retry)", async () => {
    const runTurn = fakeTurn("I can't access the files in the repository. Please paste the contents of package.json.");
    const r = narrow(await produceToolPath(INITIAL_PROMPT, depsLike(runTurn)), "text");
    expect(r.text).toBe("I can't access the files in the repository. Please paste the contents of package.json.");
    expect(runTurn).toHaveBeenCalledOnce();
  });

  it("Teams artifact URL stays text", async () => {
    const url = "https://asyncgw.teams.microsoft.com/artifacts/plan.patch";
    const runTurn = fakeTurn(`I saved the fix as a remote patch: ${url} — please apply it.`);
    const r = narrow(await produceToolPath(INITIAL_PROMPT, depsLike(runTurn)), "text");
    expect(r.text).toContain(url);
    expect(runTurn).toHaveBeenCalledOnce();
  });

  it("/mnt/data artifact path stays text", async () => {
    const runTurn = fakeTurn("The updated file is at sandbox:/mnt/data/output/plan.md. Apply it with git apply.");
    const r = narrow(await produceToolPath(INITIAL_PROMPT, depsLike(runTurn)), "text");
    expect(r.text).toBe("The updated file is at sandbox:/mnt/data/output/plan.md. Apply it with git apply.");
    expect(runTurn).toHaveBeenCalledOnce();
  });

  it("prose containing classifier-like content stays text", async () => {
    const runTurn = fakeTurn("The shell tools are not available to me here. The command returned no output.");
    const r = narrow(await produceToolPath(INITIAL_PROMPT, depsLike(runTurn)), "text");
    expect(r.text).toBe("The shell tools are not available to me here. The command returned no output.");
    expect(runTurn).toHaveBeenCalledOnce();
  });

  it("malformed fence syntax does not become a tool call", async () => {
    const runTurn = fakeTurn("```bash\nls -la\n```");
    const r = narrow(await produceToolPath(INITIAL_PROMPT, depsLike(runTurn, { tools: [] })), "text");
    expect(r.text).toBe("```bash\nls -la\n```");
    expect(runTurn).toHaveBeenCalledOnce();
  });

  it("reply-only fence becomes text (representation)", async () => {
    const replyTool: ToolDef = {
      type: "function",
      function: { name: "reply", description: "plain answer", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    };
    const runTurn = fakeTurn("```reply\ndone\n```");
    const r = narrow(await produceToolPath(INITIAL_PROMPT, depsLike(runTurn, { tools: [replyTool] })), "text");
    expect(r.text).toBe("done");
    expect(runTurn).toHaveBeenCalledOnce();
  });

  it("runTurn called exactly once even when no fence parses", async () => {
    const runTurn = fakeTurn("Just some explanation text with a ```bash inside``` but not a real call.");
    const r = narrow(await produceToolPath(INITIAL_PROMPT, depsLike(runTurn)), "text");
    expect(runTurn).toHaveBeenCalledOnce(); // no corrective turn
    expect(r.text).toBeTruthy();
  });
});
