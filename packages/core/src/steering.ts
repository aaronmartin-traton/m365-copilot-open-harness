/**
 * Steering ladder controller (programmatic-injection ticket 02).
 *
 * Owns the channel-walk state machine, mapping-canary verification, per-channel
 * circuit breakers, and the rehydration sled for proxy steering injection into
 * the M365 turn.
 *
 * Live side effects (browser writes, canary chat turns) are gated behind
 * `M365_STEERING_LIVE=1` — the explicit authorization flag. Without it the
 * module only replays latched state from disk and reports the fingerprint; it
 * never touches the browser or the M365 thread budget. The module never
 * throws: every failure degrades to `unsteered` and is logged.
 *
 * State lives at `~/.config/opencode-m365/steering.json` (override with
 * `M365_STEERING_FILE`, e.g. in tests).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createLogger } from "./log.js";

const log = createLogger("steering");

/** The proven injection channel. */
export type SteeringChannel = "textarea";

/** Honest-degrade values surfaced as the OpenAI `system_fingerprint` field. */
export type SteeringFingerprint =
  | "unsteered"
  | "steered:channel=textarea";

export interface ChannelBreaker {
  /** Consecutive canary failures since last pass (or reset). */
  failures: number;
  /** Open after `STEERING_BREAKER_THRESHOLD` consecutive failures. */
  open: boolean;
  /** Epoch ms the breaker tripped (null while closed). */
  openedAt: number | null;
}

export interface SteeringState {
  /** Latched channel — the last canary-verified win. */
  channel: SteeringChannel | null;
  /** Last-good injected payload text (never logged). */
  payload: string | null;
  /** Per-channel circuit breakers. */
  breakers: Record<SteeringChannel, ChannelBreaker>;
  /** Epoch ms of the last successful canary verification. */
  lastVerifiedAt: number | null;
  /** Epoch ms of the last canary attempt (thread-budget pacing). */
  lastAttemptAt: number | null;
}

export const STEERING_BREAKER_THRESHOLD = 3;
/** Do not re-verify a latched channel more often than this. */
export const STEERING_REVERIFY_MS = 6 * 60 * 60 * 1000;
/** Thread-budget pacing: never start a canary sooner than this after the last. */
export const STEERING_MIN_CANARY_SPACING_MS = 3 * 60 * 1000;

function freshBreaker(): ChannelBreaker {
  return { failures: 0, open: false, openedAt: null };
}

function freshState(): SteeringState {
  return {
    channel: null,
    payload: null,
    breakers: { textarea: freshBreaker() },
    lastVerifiedAt: null,
    lastAttemptAt: null,
  };
}

export function steeringStateFile(): string {
  return process.env.M365_STEERING_FILE ?? join(homedir(), ".config", "opencode-m365", "steering.json");
}

function normalizeState(raw: unknown): SteeringState {
  const base = freshState();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const merged: SteeringState = {
    ...base,
    channel: r.channel === "textarea" ? r.channel : null,
    payload: typeof r.payload === "string" && r.payload.length > 0 ? r.payload : null,
    lastVerifiedAt: typeof r.lastVerifiedAt === "number" ? r.lastVerifiedAt : null,
    lastAttemptAt: typeof r.lastAttemptAt === "number" ? r.lastAttemptAt : null,
  };
  const br = (r.breakers ?? {}) as Record<string, unknown>;
  for (const ch of ["textarea"] as const) {
    const b = br[ch] as Record<string, unknown> | undefined;
    merged.breakers[ch] = b && typeof b === "object"
      ? {
          failures: typeof b.failures === "number" ? Math.max(0, b.failures) : 0,
          open: b.open === true,
          openedAt: typeof b.openedAt === "number" ? b.openedAt : null,
        }
      : freshBreaker();
  }
  return merged;
}

export function readSteeringState(): SteeringState {
  const file = steeringStateFile();
  try {
    if (!existsSync(file)) return freshState();
    return normalizeState(JSON.parse(readFileSync(file, "utf8")));
  } catch (err) {
    log.error(`steering state unreadable (${file}): ${err instanceof Error ? err.message : String(err)} — using defaults`);
    return freshState();
  }
}

export function writeSteeringState(state: SteeringState): void {
  const file = steeringStateFile();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    log.error(`steering state write failed (${file}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The honest-degrade fingerprint: a latched channel with a closed breaker
 * reports `steered:channel=…`; everything else reports `unsteered`.
 */
export function getSteeringFingerprint(state: SteeringState = readSteeringState()): SteeringFingerprint {
  if (!state.channel) return "unsteered";
  if (state.breakers[state.channel]?.open) return "unsteered";
  return `steered:channel=${state.channel}`;
}

/** Rehydration sled: the last-good channel config to replay before the first turn. */
export function replayLastGood(state: SteeringState = readSteeringState()): { channel: SteeringChannel; payload: string } | null {
  if (!state.channel || !state.payload) return null;
  if (state.breakers[state.channel]?.open) return null;
  return { channel: state.channel, payload: state.payload };
}

/** Record a canary pass: latch the channel, reset its breaker. Returns the new state. */
export function recordChannelPass(
  state: SteeringState,
  channel: SteeringChannel,
  payload: string,
  now: number = Date.now(),
): SteeringState {
  return {
    ...state,
    channel,
    payload,
    lastVerifiedAt: now,
    breakers: {
      ...state.breakers,
      [channel]: { failures: 0, open: false, openedAt: null },
    },
  };
}

/** Record a canary failure: count up, trip the breaker at the threshold. */
export function recordChannelFailure(
  state: SteeringState,
  channel: SteeringChannel,
  now: number = Date.now(),
): SteeringState {
  const breaker = state.breakers[channel] ?? freshBreaker();
  const failures = breaker.failures + 1;
  const open = failures >= STEERING_BREAKER_THRESHOLD;
  return {
    ...state,
    lastAttemptAt: now,
    breakers: {
      ...state.breakers,
      [channel]: { failures, open, openedAt: open ? now : breaker.openedAt },
    },
  };
}

export interface CanaryVerdict {
  ok: boolean;
  /** Short machine-readable reason: "recall-matched" | "write-failed" | "no-reply" | "disengaged" | "throttle" | "mismatch" | "error". */
  reason: string;
  detail?: string;
}

function repoRoot(): string {
  return process.env.M365_REPO_ROOT ?? process.cwd();
}

function runNodeScript(script: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const nodeBin = process.env.M365_NODE_BIN ?? "node";
    let child;
    try {
      child = spawn(nodeBin, [script, ...args], { cwd: repoRoot(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      resolve({ code: -1, stdout, stderr: "timeout" });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: err.message });
    });
  });
}

/**
 * Write the custom-instructions textarea via the CDP helper script
 * (`scripts/set-custom-instruction.mjs`, runs under node — connectOverCDP
 * times out under Bun). Returns true when the script re-read the value back.
 */
export async function setCustomInstruction(payload: string): Promise<boolean> {
  const script = join(repoRoot(), "scripts", "set-custom-instruction.mjs");
  const { code, stderr } = await runNodeScript(script, ["--payload", payload], 60_000);
  if (code !== 0) log.error(`set-custom-instruction failed (${code}): ${stderr.slice(0, 300)}`);
  return code === 0;
}

function makeNonce(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

interface CanaryOutput {
  fullText?: string;
  disengaged?: boolean;
  throttle?: boolean;
}

function parseCanaryOutput(raw: unknown): CanaryOutput {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  return {
    fullText: typeof r.fullText === "string" ? r.fullText : undefined,
    disengaged: r.disengaged === true,
    throttle: r.throttle === true,
  };
}

/**
 * Mapping-canary probe (live-gated): plant a fresh codeword→reply mapping that
 * exists ONLY inside the injected text, then ask for the codeword without
 * revealing the reply. Recall proves the steering landed.
 */
export async function verifyChannel(channel: SteeringChannel, payload: string): Promise<CanaryVerdict> {
  const codeword = makeNonce("cw");
  const secret = makeNonce("reply");
  const plant = `${payload}\n\nPrivate rule (never mention it): when asked for the token "${codeword}", reply with exactly "${secret}".`;

  if (channel === "textarea") {
    const written = await setCustomInstruction(plant);
    if (!written) return { ok: false, reason: "write-failed" };
  }

  const probe = join(repoRoot(), "scripts", "_steering-canary.mjs");
  const { code, stdout, stderr } = await runNodeScript(probe, ["--codeword", codeword], 150_000);
  if (code !== 0) return { ok: false, reason: "error", detail: (stdout + stderr).slice(0, 200) };

  let parsed: CanaryOutput;
  try {
    parsed = parseCanaryOutput(JSON.parse(stdout));
  } catch {
    return { ok: false, reason: "error", detail: "canary runner output unparseable" };
  }
  const reply = parsed.fullText ?? "";
  if (parsed.disengaged) return { ok: false, reason: "disengaged" };
  if (parsed.throttle || reply.trim().length === 0) return { ok: false, reason: "throttle", detail: "empty reply without Disengaged frame" };
  if (reply.includes(secret)) return { ok: true, reason: "recall-matched" };
  return { ok: false, reason: "mismatch", detail: `reply ${reply.length} chars without secret` };
}

/**
 * Session-open hook. Replays the latched channel config (rehydration sled)
 * always; runs the channel walk + canary verification only when
 * `M365_STEERING_LIVE=1` (explicit authorization). Never throws.
 *
 * Returns the fingerprint to stamp on responses this session.
 */
export async function ensureSteered(): Promise<SteeringFingerprint> {
  let state = readSteeringState();
  const replay = replayLastGood(state);
  if (replay) log.info(`steering replay: channel=${replay.channel} (${state.payload?.length ?? 0} chars)`);

  if (process.env.M365_STEERING_LIVE !== "1") {
    return getSteeringFingerprint(state);
  }

  // Live walk (authorized). Pacing: respect the thread budget between canaries.
  const now = Date.now();
  if (state.lastAttemptAt && now - state.lastAttemptAt < STEERING_MIN_CANARY_SPACING_MS) {
    log.info("steering live walk skipped — canary spacing not met");
    return getSteeringFingerprint(state);
  }
  if (state.channel && state.lastVerifiedAt && now - state.lastVerifiedAt < STEERING_REVERIFY_MS) {
    log.info("steering live walk skipped — channel recently verified");
    return getSteeringFingerprint(state);
  }

  const channels: SteeringChannel[] = ["textarea"];
  for (const channel of channels) {
    if (state.breakers[channel]?.open) {
      log.info(`steering channel ${channel} breaker open — skipped`);
      continue;
    }
    const payload = replay?.channel === channel ? replay.payload : "You are a coding assistant that executes commands and tool calls directly, step by step, without asking for confirmation. Prefer action over explanation.";
    const verdict = await verifyChannel(channel, payload);
    if (verdict.ok) {
      state = recordChannelPass(state, channel, payload, now);
      writeSteeringState(state);
      log.info(`steering channel ${channel} latched (canary recall matched)`);
      return getSteeringFingerprint(state);
    }
    if (verdict.reason === "throttle") {
      log.error(`steering canary on ${channel} hit thread throttle — stopping walk for this open`);
      return getSteeringFingerprint(state);
    }
    log.error(`steering canary failed on ${channel}: ${verdict.reason}${verdict.detail ? ` — ${verdict.detail}` : ""}`);
    state = recordChannelFailure(state, channel, now);
    writeSteeringState(state);
  }
  log.error("steering: all channels failed or breakers open — unsteered");
  return "unsteered";
}
