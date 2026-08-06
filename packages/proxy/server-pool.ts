import type { M365WebConversationClientLike } from "@m365-copilot/core";
import { SessionPool } from "@m365-copilot/proxy-lib";
let webClient: M365WebConversationClientLike | null = null;
let automaticReaperDisabled = process.env.M365_WEB_PRUNE_PROVEN !== "1";
let reaperPromise: Promise<{ pruned: number; failed: number }> | null = null;
let lastRunAt: number | null = null;
let lastResult = { pruned: 0, failed: 0 };

const remotePruner = async (ids: { sessionId: string; conversationId: string }): Promise<void> => {
  if (!webClient) {
    // Keep Playwright out of Bun startup and ordinary proxy requests. This import
    // runs only after the proof gate and only when a due record is actually pruned.
    const { M365WebConversationClient } = await import("@m365-copilot/core");
    webClient = new M365WebConversationClient();
  }
  try {
    await webClient.deleteConversation({ conversationId: ids.conversationId });
  } catch (error) {
    automaticReaperDisabled = true;
    throw error;
  }
};

/** Process-wide pool; every request and maintenance operation shares its scheduler. */
export const pool = new SessionPool({}, { remotePruner });

export async function runReaper(): Promise<{ pruned: number; failed: number }> {
  if (reaperPromise) return reaperPromise;
  reaperPromise = (async () => {
    lastRunAt = Date.now();
    lastResult = automaticReaperDisabled
      ? { pruned: 0, failed: 0 }
      : await pool.reapIdle();
    return lastResult;
  })().finally(() => { reaperPromise = null; });
  return reaperPromise;
}

export function reaperHealth() {
  return {
    lastRunAt,
    pruned: lastResult.pruned,
    failed: lastResult.failed,
    disabled: automaticReaperDisabled,
  };
}

const reaperTimer = setInterval(() => { void runReaper(); }, 60_000);
reaperTimer.unref?.();
