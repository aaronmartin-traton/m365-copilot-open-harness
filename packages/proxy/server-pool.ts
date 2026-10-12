import { SessionPool, activeBackend } from "@m365-copilot/proxy-lib";

const backend = activeBackend();

/**
 * Automatic reaping is ON: idle M365 threads are deleted upstream, which is what
 * keeps the account's per-conversation cap from being spent on threads nobody
 * returns to. `M365_WEB_PRUNE_PROVEN=0` switches it off for a host whose browser
 * runtime cannot drive the M365 web UI.
 *
 * Failing is safe in both directions — a single remote failure sets
 * `automaticReaperDisabled` and stops all further attempts, and each conversation
 * backs off via `nextPruneAttemptAt` — so an unverifiable runtime costs one
 * failed attempt, not a stream of them.
 */
let automaticReaperDisabled = process.env.M365_WEB_PRUNE_PROVEN === "0";

let reaperPromise: Promise<{ pruned: number; failed: number }> | null = null;

let lastRunAt: number | null = null;

let lastResult = { pruned: 0, failed: 0 };

/**
 * The backend decides whether its conversations can be deleted remotely.
 *
 * M365 exposes a web API for that; ChatGPT Web does not, so `deleteConversation`
 * is absent from its descriptor and the pruner is never installed. Calling the
 * M365 client with a chatgpt.com conversation id would fail, and that failure
 * permanently disables the reaper.
 */
const remotePruner = backend.deleteConversation
  ? async (ids: { sessionId: string; conversationId: string }): Promise<void> => {
    try {
      await backend.deleteConversation!(ids);
    } catch (error) {
      automaticReaperDisabled = true;
      throw error;
    }
  }
  : undefined;

/** Process-wide pool; every request and maintenance operation shares its scheduler. */
export const pool = new SessionPool(
  {},
  { remotePruner, createSession: backend.createSession },
);

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
