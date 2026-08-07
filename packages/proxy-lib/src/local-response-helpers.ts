/**
 * Local response helpers for special cases where M365 Copilot isn't called.
 *
 * These handle: metadata responses, read-only fallback tool calls,
 * and locally-rendered completions.
 */

import { getMessageContent } from "@m365-copilot/core";
import { ChatCompletionRequest } from "./schemas.js";
import type { z } from "zod/v4";
import { jsonResponse, sseResponse } from "./response-helpers.js";

type ChatBody = z.infer<typeof ChatCompletionRequest>;
type ToolDef = NonNullable<ChatBody["tools"]>[number];
/**
 * Detect if this is a metadata-only request (title generation) and return local response.
 * Returns null if this is a normal conversation request.
 */
export function localMetaResponse(body: ChatBody): string | null {
  const metadataType = body.metadata && typeof body.metadata.request_type === "string"
    ? body.metadata.request_type.toLowerCase()
    : "";
  const lastUser = [...body.messages].reverse().find((message) => message.role === "user");
  const prompt = lastUser ? getMessageContent(lastUser).trim().toLowerCase() : "";
  const explicit = metadataType === "title" || metadataType === "title_generation";
  const knownPrompt = prompt.includes("generate a concise, sentence-case title") ||
    (prompt.startsWith("generate a concise title") && prompt.includes("conversation"));
  if (!explicit && !knownPrompt) return null;
  return '{"title":"New conversation"}';
}

/**
 * In read-only mode, detect when the user is asking for a safe read operation
 * and synthesize the corresponding tool call directly (without sending to M365).
 */
export function readOnlyFallbackToolCall(
  body: ChatBody,
  assistantText: string,
): { id: string; type: "function"; function: { name: string; arguments: string } } | null {
  const tools = body.tools ?? [];
  if (tools.length === 0) return null;
  let lastUserIndex = -1;
  for (let index = body.messages.length - 1; index >= 0; index--) {
    if (body.messages[index].role === "user") { lastUserIndex = index; break; }
  }
  if (lastUserIndex < 0 || body.messages.slice(lastUserIndex + 1).some((message) => message.role === "tool")) return null;

  const userText = getMessageContent(body.messages[lastUserIndex]).trim().toLowerCase();
  const staleSandbox = /\/mnt\/(?:data|workspace)|no (?:user )?files uploaded|nothing uploaded/i.test(assistantText) ||
    ((assistantText.match(/(?:input|output|working)\//gi)?.length ?? 0) >= 2 && /empty|upload/i.test(assistantText));
  const asksPwd = /^(?:pwd|where am i|current directory|working directory)[?.!\s]*$/.test(userText);
  const asksGit = /\bgit status\b|^repo(?:sitory)? status[?.!\s]*$/.test(userText);
  const asksFiles = /\b(?:list|show|what|which)\b[\w\s'",:.-]{0,50}\bfiles\b/.test(userText) ||
    /^(?:ls|dir|tree)(?:\s|$)/.test(userText) || (staleSandbox && /files|workspace|repo/.test(userText));
  if (!asksPwd && !asksGit && !asksFiles) return null;

  if (asksFiles) {
    const glob = tools.find((tool: ToolDef) => /^(?:glob|find_files|list_files)$/i.test(tool.function.name));
    if (glob) {
      const properties = Object.keys(glob.function.parameters?.properties ?? {});
      const key = properties.find((name) => /^(?:pattern|glob)$/i.test(name)) ??
        properties.find((name) => /^path$/i.test(name));
      if (key) return makeDirectToolCall(glob.function.name, { [key]: key.toLowerCase() === "path" ? "." : "**/*" });
    }
  }

  const shell = tools.find((tool: ToolDef) => /^(?:bash|sh|shell|shell_command|run|exec|command|run_command|execute_command)$/i.test(tool.function.name));
  if (!shell) return null;
  const properties = Object.keys(shell.function.parameters?.properties ?? {});
  const commandKey = properties.find((name) => /^(?:command|cmd|script|input)$/i.test(name));
  if (!commandKey) return null;
  const powershell = /powershell/i.test(shell.function.description ?? "");
  const command = asksPwd
    ? (powershell ? "Get-Location" : "pwd")
    : asksGit
      ? "git status --short"
      : powershell
        ? "Get-ChildItem -Recurse -File | Select-Object -First 200 -ExpandProperty FullName"
        : "find . -maxdepth 3 -type f | sort | sed -n '1,200p'";
  return makeDirectToolCall(shell.function.name, { [commandKey]: command });
}

/**
 * Create a tool call object with a generated ID.
 */
export function makeDirectToolCall(name: string, args: Record<string, unknown>) {
  return {
    id: `call_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}

/**
 * Render a local completion (not sent to M365) as JSON or SSE response.
 */
export function renderLocalCompletion(body: ChatBody, text: string): Response {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  if (!body.stream) {
    return jsonResponse(200, {
      id,
      object: "chat.completion",
      created,
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, x_m365_local_response: true },
    });
  }
  const enc = new TextEncoder();
  return sseResponse(new ReadableStream({
    start(controller) {
      const send = (payload: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`));
      const base = { id, object: "chat.completion.chunk", created, model: body.model };
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  }));
}
