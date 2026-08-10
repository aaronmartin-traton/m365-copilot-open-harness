import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "./log.js";
import { emitThrottleEvent, hashConversationId } from "./throttle-telemetry.js";

const log = createLogger("backoff");

// Degradation BACKOFF policy (docs/hypotheses.md §11, H-R1). Account degradation is
// thread-rate throttle that surfaces as EMPTY responses across many DISTINCT
// conversations. The old policy fired a background re-login on this signal — but a
// fresh token carries the same `oid`, so it lands in the same identity-keyed throttle
// bucket (API doc §2/§7): re-auth does NOT clear the throttle. The one observation that
// a fresh login "recovered" it (F13) was confounded by the ~15 min the login+restart
// took — it was the idle time, not the token. And the headless re-login is the single
// most detectable thing we do at Microsoft (F25: `webdriver=true`, a `HeadlessChrome`
// UA, a fresh unfamiliar device every time). So we drop the login entirely and do what
// actually works against a time-driven throttle: BACK OFF. On sustained distinct-
// conversation empties we self-impose a paced delay before starting new backend turns,
// giving the account room to self-heal.
//
// A real pi/Codex session is ONE long thread, so it never trips the distinct-
// conversation trigger — only bursty multi-conversation use (experiments, benches) does,
// which is exactly the traffic that should slow down.
//
// Guards: distinct-conversation gating (repeated empties in ONE conversation are usually
// content-specific — a bad agent, a Disengage-shaped prompt — not throttle), a window so
// stale empties expire, escalation so repeated triggers back off harder, and a clean
// response that lifts the backoff immediately.

export interface BackoffState {
  empties: Array<{ t: number; conv: string }>;
  backoffUntil: number | null;
  level: number;
}

export interface BackoffOptions {
  /** Clock injection for tests. Defaults to Date.now. */
  now?: () => number;
  /** Sleep injection for tests. Defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source in [0,1). Defaults to Math.random. */
  rng?: () => number;
  /** Empties older than this fall out of the window. */
  windowMs?: number;
  /** Distinct-conversation empties within the window needed to enter backoff. */
  threshold?: number;
  /** Initial backoff window opened on the first trigger. */
  baseCooldownMs?: number;
  /** Cap on the backoff window after escalation. */
  maxCooldownMs?: number;
  /** Per-gated-request paced delay is drawn uniformly from [min, max]. */
  jitterMinMs?: number;
  jitterMaxMs?: number;
  /** Called when backoff opens/escalates (for logging/telemetry). */
  onTrigger?: (info: { distinctConversations: number; cooldownMs: number; level: number }) => void;
  initialState?: BackoffState;
  onStateChange?: (state: BackoffState) => void;
}

export interface BackoffController {
  /** Record one request outcome. `empty` = throttle-shaped empty response. */
  note: (empty: boolean, conversationId: string) => void;
  /** Await a paced slot before starting a backend turn. Resolves immediately when
   *  healthy; during backoff it sleeps a jittered delay. Returns ms slept. */
  waitForSlot: () => Promise<number>;
  /** Whether the controller is currently in a backoff window. */
  isBackingOff: () => boolean;
  state: () => BackoffState;
}

export function createBackoffController(opts: BackoffOptions): BackoffController {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rng = opts.rng ?? Math.random;
  const windowMs = opts.windowMs ?? 120_000;
  const threshold = opts.threshold ?? 3;
  const baseCooldownMs = opts.baseCooldownMs ?? 90_000;
  const maxCooldownMs = opts.maxCooldownMs ?? 600_000;
  const jitterMinMs = opts.jitterMinMs ?? 10_000;
  const jitterMaxMs = opts.jitterMaxMs ?? 25_000;

  let empties: Array<{ t: number; conv: string }> = [...(opts.initialState?.empties ?? [])];
  let backoffUntil = opts.initialState?.backoffUntil ?? -Infinity;
  let level = opts.initialState?.level ?? 0;
  const snapshot = (): BackoffState => ({
    empties: [...empties],
    backoffUntil: Number.isFinite(backoffUntil) ? backoffUntil : null,
    level,
  });
  const changed = () => opts.onStateChange?.(snapshot());

  return {
    note(empty, conversationId) {
      const t = now();
      if (!empty) {
        // A clean response means degradation has lifted — reset the streak AND the
        // backoff window so the next request runs at full speed.
        empties = [];
        backoffUntil = -Infinity;
        level = 0;
        changed();
        return;
      }

      empties.push({ t, conv: conversationId || `anon-${t}` });
      empties = empties.filter((e) => t - e.t < windowMs);

      const distinct = new Set(empties.map((e) => e.conv)).size;
      changed();
      if (distinct < threshold) return;
      // Already backing off within the current window — don't re-arm/escalate until it
      // elapses, so a burst of empties doesn't stack the delay unboundedly.
      if (t < backoffUntil) return;

      level += 1;
      const cooldownMs = Math.min(baseCooldownMs * 2 ** (level - 1), maxCooldownMs);
      backoffUntil = t + cooldownMs;
      empties = [];
      opts.onTrigger?.({ distinctConversations: distinct, cooldownMs, level });
      changed();
    },

    async waitForSlot() {
      const remaining = backoffUntil - now();
      if (remaining <= 0) return 0;
      const span = Math.max(0, jitterMaxMs - jitterMinMs);
      const delay = Math.min(remaining, jitterMinMs + Math.floor(rng() * (span + 1)));
      if (delay > 0) await sleep(delay);
      return delay;
    },

    isBackingOff() {
      return now() < backoffUntil;
    },
    state() {
      return snapshot();
    },
  };
}

const disabled = () =>
  !!(process.env.M365_NO_BACKOFF ?? process.env.M365_NO_AUTO_REAUTH); // legacy alias

const BACKOFF_STATE_FILE = process.env.M365_BACKOFF_STATE_FILE ||
  join(homedir(), ".config", "opencode-m365", "backoff-state.json");

function loadBackoffState(): BackoffState | undefined {
  if (!existsSync(BACKOFF_STATE_FILE)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(BACKOFF_STATE_FILE, "utf8"));
    if (Array.isArray(parsed?.empties) && typeof parsed?.level === "number") return parsed;
  } catch {}
  return undefined;
}

function saveBackoffState(state: BackoffState): void {
  try {
    mkdirSync(dirname(BACKOFF_STATE_FILE), { recursive: true, mode: 0o700 });
    const temp = `${BACKOFF_STATE_FILE}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, BACKOFF_STATE_FILE);
  } catch {}
}

// Backoff window start/end timestamps for the telemetry `durationMs` on exit.
// A controller may re-arm (escalate) while active; exit is when a window stops
// being the active backoff state. We track the last opened window here so the
// exit event can report how long it was in force.
let backoffEnteredAt = 0;

const defaultController = createBackoffController({
  windowMs: Number(process.env.M365_BACKOFF_WINDOW_MS ?? 120_000),
  threshold: Number(process.env.M365_BACKOFF_THRESHOLD ?? process.env.M365_REAUTH_EMPTY_THRESHOLD ?? 3),
  baseCooldownMs: Number(process.env.M365_BACKOFF_BASE_MS ?? 90_000),
  maxCooldownMs: Number(process.env.M365_BACKOFF_MAX_MS ?? 600_000),
  initialState: loadBackoffState(),
  onStateChange: (state) => {
    saveBackoffState(state);
    // Telemetry: emit backoff-exit when a window that was active stops being
    // the state (level dropped OR the window elapsed). The elapsed branch is
    // the common "paced until self-healed" case — a clean response may never
    // arrive, and without this the exit is never recorded.
    if (backoffEnteredAt > 0) {
      if (state.level === 0) {
        emitThrottleEvent({
          ts: new Date().toISOString(),
          event: "backoff-exit",
          // Cap the reported duration at the window end: time after expiry is
          // idle, not paced, and would inflate the decision-gate dataset.
          durationMs: Math.min(Date.now(), state.backoffUntil ?? Infinity) - backoffEnteredAt,
        });
        backoffEnteredAt = 0;
      } else if (state.backoffUntil !== null && Date.now() >= state.backoffUntil) {
        emitThrottleEvent({
          ts: new Date().toISOString(),
          event: "backoff-exit",
          durationMs: state.backoffUntil - backoffEnteredAt,
        });
        backoffEnteredAt = 0;
      }
    }
  },
  onTrigger: ({ distinctConversations, cooldownMs, level }) => {
    backoffEnteredAt = Date.now();
    emitThrottleEvent({
      ts: new Date().toISOString(),
      event: "backoff-enter",
      level,
      backoffUntil: Date.now() + cooldownMs,
    });
    log.info(
      `Degradation backoff (level ${level}): ${distinctConversations} empty responses across distinct ` +
      `conversations — pacing new turns for ~${Math.round(cooldownMs / 1000)}s to let the account self-heal ` +
      `(H-R1: a re-login would NOT clear this and would raise our detection profile). Disable with M365_NO_BACKOFF=1.`,
    );
  },
});

/** Record a request outcome for the global degradation-backoff policy. No-op if disabled. */
export function noteRequestOutcome(empty: boolean, conversationId: string): void {
  // Passive telemetry at the empty-throttle detection site (no new request
  // logic). Records even when the backoff policy is disabled (M365_NO_BACKOFF):
  // the telemetry decision-gate wants lull frequency regardless of policy state.
  if (empty) {
    emitThrottleEvent({
      ts: new Date().toISOString(),
      event: "empty-throttle",
      convIdHash: hashConversationId(conversationId || "anon"),
    });
  }
  if (disabled()) return;
  defaultController.note(empty, conversationId);
}

/** Await a paced slot before a backend turn (self-imposed rate limit while degraded).
 *  Resolves immediately when healthy or when backoff is disabled. */
export async function awaitDegradationBackoff(): Promise<void> {
  if (disabled()) return;
  const slept = await defaultController.waitForSlot();
  if (slept > 0) log.info(`Backoff: paced this turn by ${Math.round(slept / 1000)}s (account degraded)`);
}

/** Whether the global policy is currently backing off. */
export function isDegradationBackoff(): boolean {
  return !disabled() && defaultController.isBackingOff();
}

export function getDegradationBackoffState(): BackoffState {
  return defaultController.state();
}
