/**
 * Disengagement/dea-drift guard (ticket 03): observational telemetry sink
 * keyed by steering-fingerprint bucket.
 *
 * Injection (custom-instructions / gate flags) changes the Prompt-Shields
 * shape balance (F22) — an additive jailbreak-shape classifier — so injected
 * override-shape text can raise `dea_violation` and the Disengaged rate even
 * on benign turns. This sink accumulates per-turn Disengaged events and
 * `dea_violation` scores per fingerprint bucket and reports a
 * baseline-vs-steered delta when the steered window's Disengaged rate or mean
 * dea score clears the unsteered baseline by a threshold.
 *
 * The guard is OBSERVATIONAL ONLY: it never fails a request and never
 * auto-fails the steering ladder. Alert = a log line carrying the delta;
 * thresholds are set from baseline first, never tuned on one session (plan
 * Risks). Reset for rotation with `resetDriftSink`.
 */

export interface DriftSample {
  /** Steering-fingerprint bucket: "unsteered" or "steered:<channel>". */
  fingerprint: string;
  /** True when this turn ended in a `Disengaged` refusal frame. */
  disengaged: boolean;
  /** `scores.dea_violation` for the turn, when the backend reported it. */
  deaScore?: number;
  /** Epoch milliseconds. */
  at: number;
}

/** Steered mean dea must exceed the unsteered baseline mean by this factor. */
export const DRIFT_DEA_FACTOR = 3;
/** Steered Disengaged rate must exceed the unsteered baseline rate by this gap. */
export const DRIFT_DISENGAGED_GAP = 0.1;
/** A bucket with fewer than this many samples never alerts. */
export const DRIFT_MIN_SAMPLES = 5;
/** Per-bucket ring size: bounded memory while remembering a session's tail. */
export const DRIFT_WINDOW = 100;

export interface DriftStats {
  fingerprint: string;
  turns: number;
  disengaged: number;
  disengagedRate: number;
  meanDea: number | null;
}

const sink = new Map<string, DriftSample[]>();

/** Bucket a fingerprint: everything not exactly "unsteered" is a steered channel. */
function bucketOf(fingerprint: string): string {
  return fingerprint === "unsteered" ? "unsteered" : fingerprint;
}

/** Record one turn into its fingerprint bucket (bounded ring per bucket). */
export function recordDriftSample(sample: DriftSample): void {
  const bucket = bucketOf(sample.fingerprint);
  const ring = sink.get(bucket) ?? [];
  ring.push(sample);
  if (ring.length > DRIFT_WINDOW) ring.splice(0, ring.length - DRIFT_WINDOW);
  sink.set(bucket, ring);
}

/** Summary stats for one bucket (empty bucket => zeros, null mean dea). */
export function driftStats(fingerprint: string): DriftStats {
  const ring = sink.get(bucketOf(fingerprint)) ?? [];
  const disengaged = ring.filter((s) => s.disengaged).length;
  const deaScores = ring
    .filter((s) => typeof s.deaScore === "number")
    .map((s) => s.deaScore as number);
  return {
    fingerprint: bucketOf(fingerprint),
    turns: ring.length,
    disengaged,
    disengagedRate: ring.length > 0 ? disengaged / ring.length : 0,
    meanDea:
      deaScores.length > 0
        ? deaScores.reduce((a, b) => a + b, 0) / deaScores.length
        : null,
  };
}

/**
 * Baseline-vs-steered drift check. Returns an alert string when the merged
 * steered buckets' Disengaged rate or mean dea score clears the unsteered
 * baseline by the configured thresholds, else null. Both sides must have
 * >= DRIFT_MIN_SAMPLES; a missing dea baseline never triggers the dea leg.
 */
export function driftAlert(): string | null {
  const baseline = driftStats("unsteered");
  if (baseline.turns < DRIFT_MIN_SAMPLES) return null;
  const steered = [...sink.keys()]
    .filter((k) => k !== "unsteered")
    .flatMap((k) => sink.get(k) ?? []);
  if (steered.length < DRIFT_MIN_SAMPLES) return null;
  const sTurns = steered.length;
  const sDisengaged = steered.filter((s) => s.disengaged).length;
  const sRate = sDisengaged / sTurns;
  const sDeaScores = steered
    .filter((s) => typeof s.deaScore === "number")
    .map((s) => s.deaScore as number);
  const sMean =
    sDeaScores.length > 0
      ? sDeaScores.reduce((a, b) => a + b, 0) / sDeaScores.length
      : null;

  const problems: string[] = [];
  if (baseline.meanDea !== null && sMean !== null && sMean > baseline.meanDea * DRIFT_DEA_FACTOR) {
    problems.push(`mean dea ${sMean.toFixed(6)} vs baseline ${baseline.meanDea.toFixed(6)} (>${DRIFT_DEA_FACTOR}x)`);
  }
  if (sRate > baseline.disengagedRate + DRIFT_DISENGAGED_GAP) {
    problems.push(`Disengaged rate ${sRate.toFixed(3)} vs baseline ${baseline.disengagedRate.toFixed(3)} (+>${DRIFT_DISENGAGED_GAP})`);
  }
  if (problems.length === 0) return null;
  return `steered (${sTurns} turns) exceeds baseline (${baseline.turns} turns): ${problems.join("; ")}`;
}

/** Clear all accumulated samples (tests, run rotation). */
export function resetDriftSink(): void {
  sink.clear();
}
