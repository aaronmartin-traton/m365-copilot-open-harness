import { boundedToolResult, getMessageContent, type Message } from "@m365-copilot/core";

export const LOCAL_TOOL_REMINDER = "<local_tool_context>LOCAL harness; use relative paths in the caller working directory. Never use /mnt/data or /workspace. Preserve errors and run one focused step.</local_tool_context>";

export interface DeltaContextInput {
  messages: Message[];
  taskAnchor: string;
  hasTools: boolean;
  /**
   * The whole request. A tool message names its call only by `tool_call_id`
   * (pi sends no `name`), so the name comes from the assistant `tool_calls`
   * that issued it. Defaults to `messages`.
   */
  history?: Message[];
}

/**
 * Deterministically transforms the follow-up turn's new messages into the
 * model-facing delta text. The full first-turn prompt is built by the handler
 * with `formatMessages` directly — M365 is stateful, so after the first turn
 * only the new messages are sent.
 */
export function compileDelta({ messages, taskAnchor, hasTools, history = messages }: DeltaContextInput): string {
  const callNames = new Map<string, string>();

  for (const message of history) {
    for (const call of message.role === "assistant" ? message.tool_calls ?? [] : []) {
      if (call.id) callNames.set(call.id, call.function.name);
    }
  }

  const parts: string[] = hasTools
    ? [LOCAL_TOOL_REMINDER, `<task_anchor>${taskAnchor.slice(0, 3_000)}</task_anchor>`]
    : [];

  for (const message of messages) {
    if (message.role === "assistant") {
      continue;
    } else if (message.role === "tool") {
      const name = message.name || (message.tool_call_id && callNames.get(message.tool_call_id)) || "unknown";
      const callId = message.tool_call_id || "?";
      parts.push(`<tool_response name="${name}" call_id="${callId}">\n${boundedToolResult(getMessageContent(message))}\n</tool_response>`);
    } else if (message.role !== "system") {
      parts.push(`<${message.role}>\n${getMessageContent(message)}\n</${message.role}>`);
    }
  }

  return parts.join("\n\n");
}
