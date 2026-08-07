import {
  formatMessages,
  getMessageContent,
  type Message,
  type ToolChoice,
  type ToolDef,
} from "@m365-copilot/core";

const DELTA_TOOL_RESULT_MAX_CHARS = Number(process.env.M365_TOOL_RESULT_MAX_CHARS ?? 12_000);

export const LOCAL_TOOL_REMINDER = "<local_tool_context>LOCAL harness; use relative paths in the caller working directory. Never use /mnt/data or /workspace. Preserve errors and run one focused step.</local_tool_context>";

export interface FullContextInput {
  messages: Message[];
  tools?: ToolDef[];
  toolChoice?: ToolChoice;
  conversationId?: string;
  framingVariant?: string;
}

export interface DeltaContextInput {
  messages: Message[];
  taskAnchor: string;
  hasTools: boolean;
}

/**
 * Deterministically transforms request context into the model-facing text form.
 * Session state decides which compilation mode is valid; the compiler only
 * performs the selected full or delta transformation.
 */
export interface ContextCompiler {
  compileFull(input: FullContextInput): string;
  compileDelta(input: DeltaContextInput): string;
}

function boundedDeltaResult(text: string): string {
  if (!Number.isFinite(DELTA_TOOL_RESULT_MAX_CHARS) || DELTA_TOOL_RESULT_MAX_CHARS <= 0 || text.length <= DELTA_TOOL_RESULT_MAX_CHARS) return text;
  const marker = `\n...[tool output truncated: ${text.length - DELTA_TOOL_RESULT_MAX_CHARS} chars omitted]...\n`;
  const available = Math.max(0, DELTA_TOOL_RESULT_MAX_CHARS - marker.length);
  const head = Math.ceil(available * 0.7);
  return text.slice(0, head) + marker + text.slice(text.length - (available - head));
}

export const contextCompiler: ContextCompiler = {
  compileFull({ messages, tools, toolChoice, conversationId, framingVariant }) {
    return formatMessages(messages, tools, toolChoice, conversationId, framingVariant);
  },

  compileDelta({ messages, taskAnchor, hasTools }) {
    const parts: string[] = hasTools
      ? [LOCAL_TOOL_REMINDER, `<task_anchor>${taskAnchor.slice(0, 3_000)}</task_anchor>`]
      : [];
    for (const message of messages) {
      if (message.role === "assistant") {
        continue;
      } else if (message.role === "tool") {
        const name = message.name || "unknown";
        const callId = message.tool_call_id || "?";
        parts.push(`<tool_response name="${name}" call_id="${callId}">\n${boundedDeltaResult(getMessageContent(message))}\n</tool_response>`);
      } else if (message.role !== "system") {
        parts.push(`<${message.role}>\n${getMessageContent(message)}\n</${message.role}>`);
      }
    }
    return parts.join("\n\n");
  },
};
