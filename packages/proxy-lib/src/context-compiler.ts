import { boundedToolResult, getMessageContent, type Message } from "@m365-copilot/core";

export const LOCAL_TOOL_REMINDER = "<local_tool_context>LOCAL harness; use relative paths in the caller working directory. Never use /mnt/data or /workspace. Preserve errors and run one focused step.</local_tool_context>";

export interface DeltaContextInput {
  messages: Message[];
  taskAnchor: string;
  hasTools: boolean;
}

/**
 * Deterministically transforms the follow-up turn's new messages into the
 * model-facing delta text. The full first-turn prompt is built by the handler
 * with `formatMessages` directly — M365 is stateful, so after the first turn
 * only the new messages are sent.
 */
export function compileDelta({ messages, taskAnchor, hasTools }: DeltaContextInput): string {
  const parts: string[] = hasTools
    ? [LOCAL_TOOL_REMINDER, `<task_anchor>${taskAnchor.slice(0, 3_000)}</task_anchor>`]
    : [];
  for (const message of messages) {
    if (message.role === "assistant") {
      continue;
    } else if (message.role === "tool") {
      const name = message.name || "unknown";
      const callId = message.tool_call_id || "?";
      parts.push(`<tool_response name="${name}" call_id="${callId}">\n${boundedToolResult(getMessageContent(message))}\n</tool_response>`);
    } else if (message.role !== "system") {
      parts.push(`<${message.role}>\n${getMessageContent(message)}\n</${message.role}>`);
    }
  }
  return parts.join("\n\n");
}
