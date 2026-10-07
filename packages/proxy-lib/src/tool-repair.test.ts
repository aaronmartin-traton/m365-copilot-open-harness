import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDef } from "@m365-copilot/core";
import { getToolRepair, resetToolRepair, TOOL_REPAIR_PROMPT } from "./tool-repair.js";

const bashTool: ToolDef = {
  type: "function",
  function: {
    name: "bash",
    description: "Run a shell command",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
};

const CTX = { request: "list files", response: "I can't access your files.", tools: [bashTool] };

function reply(content: string | null, model = "watt-tool-8b", status = 200) {
  return new Response(JSON.stringify({ model, choices: [{ message: { content } }] }), { status });
}

describe("tool-repair", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    resetToolRepair();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    process.env.M365_TOOL_REPAIR = "1";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.M365_TOOL_REPAIR;
    delete process.env.M365_TOOL_REPAIR_MODEL;
    delete process.env.M365_TOOL_REPAIR_TIMEOUT_MS;
    resetToolRepair();
  });

  it("is off unless M365_TOOL_REPAIR=1", () => {
    delete process.env.M365_TOOL_REPAIR;
    expect(getToolRepair()).toBeNull();
    process.env.M365_TOOL_REPAIR = "true";
    expect(getToolRepair()).toBeNull();
  });

  it("returns the model's fenced call and sends the tool list + transcript", async () => {
    fetchMock.mockResolvedValue(reply("```bash\nls\n```"));
    const out = await getToolRepair()!(CTX);
    expect(out).toBe("```bash\nls\n```");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("watt-tool-8b");
    expect(body.messages[0].content.startsWith(TOOL_REPAIR_PROMPT)).toBe(true);
    expect(body.messages[0].content).toContain("bash");
    expect(body.messages[1].content).toContain("list files");
    expect(body.messages[1].content).toContain("I can't access your files.");
  });

  it.each([
    ["NONE", () => reply("NONE")],
    ["empty content", () => reply(null)],
    ["HTTP 500", () => reply("```bash\nls\n```", "watt-tool-8b", 500)],
    ["model mismatch", () => reply("```bash\nls\n```", "some-other-model")],
  ])("fails closed on %s", async (_label, make) => {
    fetchMock.mockResolvedValue(make());
    expect(await getToolRepair()!(CTX)).toBeNull();
  });

  it("fails closed on network error", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect(await getToolRepair()!(CTX)).toBeNull();
  });

  it("fails closed on timeout", async () => {
    process.env.M365_TOOL_REPAIR_TIMEOUT_MS = "10";
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    expect(await getToolRepair()!(CTX)).toBeNull();
  });

  it("honors M365_TOOL_REPAIR_MODEL for the identity guard", async () => {
    process.env.M365_TOOL_REPAIR_MODEL = "lfm2.5-8b-a1b";
    fetchMock.mockResolvedValue(reply("```bash\nls\n```", "lfm2.5-8b-a1b"));
    expect(await getToolRepair()!(CTX)).toBe("```bash\nls\n```");
  });
});
