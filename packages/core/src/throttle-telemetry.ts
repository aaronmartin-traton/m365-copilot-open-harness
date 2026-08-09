import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { createLogger } from "./log.js";

const log = createLogger("throttle-telemetry");

/**
 * Passive degradation telemetry — the decision-gate data for the fallback-lane
 * option (`.scratch/fallback-lane-telemetry/`). Logs throttle / backoff /
 * disengage events to a NDJSON file OUTSIDE the repo (the repo is public).
 *
 * Hard rules (ticket 01):
 * - Passive only: an event is recorded at an EXISTING detection site and must
 *   NEVER trigger, delay, or modify any M365 request. No new request logic.
 * - No PII, no raw conversation ids, no request bodies. convIds are sha256
 *   hashed; the hash is useless for recovery but lets us count distinct
 *   conversations without leaking them.
 * - Best-effort append (mirrors log.ts): I/O failure never surfaces upstream.
 */

export type ThrottleEventType =
  | "empty-throttle"
  | "backoff-enter"
  | "backoff-exit"
  | "disengaged"
  | "at-limit";

export interface ThrottleEvent {
  /** ISO timestamp. */
  ts: string;
  event: ThrottleEventType;
  /** sha256 of the conversation id (never the raw id). */
  convIdHash?: string;
  /** Backoff level (backoff-enter/backoff-exit). */
  level?: number;
  /** Backoff window expiry (epoch ms) when the window was opened. */
  backoffUntil?: number;
  /** Measured backoff window duration (ms) on exit. */
  durationMs?: number;
  /** Disengaged: framing used (`default` | `softened`). */
  framing?: string;
  /** Disengaged: retry outcome (`softened-retry` | `fail-fast`). */
  retryOutcome?: string;
  /** At-limit: per-conversation counters. */
  current?: number;
  max?: number;
}

/** sha256 hex digest of a conversation id — never record raw ids. */
export function hashConversationId(convId: string): string {
  return createHash("sha256").update(convId, "utf-8").digest("hex");
}

/** In-memory event counts since process start, surfaced on /health. */
const counts: Record<ThrottleEventType, number> = {
  "empty-throttle": 0,
  "backoff-enter": 0,
  "backoff-exit": 0,
  disengaged: 0,
  "at-limit": 0,
};

/** Record one telemetry event. Passive + best-effort; never throws upstream. */
export function emitThrottleEvent(ev: ThrottleEvent): void {
  counts[ev.event] += 1;
  if (process.env.M365_NO_TELEMETRY === "1") return;
  const line = `${JSON.stringify(ev)}\n`;
  try {
    const path = process.env.M365_THROTTLE_TELEMETRY_FILE?.trim() ||
      join(homedir(), ".config", "opencode-m365", "throttle-telemetry.ndjson");
    mkdirSync(join(path, ".."), { recursive: true });
    appendFileSync(path, line);
  } catch (err) {
    log.error(`throttle-telemetry write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Snapshot of in-memory event counts since process start (for /health). */
export function getThrottleEventCounts(): Readonly<Record<ThrottleEventType, number>> {
  return { ...counts };
}

/** Test hook: clear the in-memory counts. Does not touch the on-disk log. */
export function resetThrottleEventCounts(): void {
  for (const k of Object.keys(counts) as ThrottleEventType[]) counts[k] = 0;
}
