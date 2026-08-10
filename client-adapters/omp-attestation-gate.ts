import { attestCommand } from "./attestation-helper.mjs";

type GateResult = { block: true; reason: string } | undefined;

interface ToolCallEvent {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

interface ToolCallContext {
  hasUI: boolean;
  ui: { confirm(title: string, message: string): Promise<boolean> };
}

interface ToolCallAPI {
  on(event: "tool_call", handler: (event: ToolCallEvent, ctx: ToolCallContext) => Promise<GateResult>): void;
}

export default function attestationGate(pi: ToolCallAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const command = String(event.input.command ?? "");
    if (!ctx.hasUI) return { block: true, reason: "Cannot confirm command without a UI" };
    if (!await ctx.ui.confirm("Execute command?", command)) {
      return { block: true, reason: "User denied command" };
    }
    const result = await attestCommand({ client: "omp", toolCallId: event.toolCallId, command });
    return result.allowed ? undefined : { block: true, reason: result.reason };
  });
}
