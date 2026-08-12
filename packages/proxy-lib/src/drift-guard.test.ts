import { beforeEach, describe, expect, it } from "vitest";
import {
  DRIFT_DEA_FACTOR,
  DRIFT_DISENGAGED_GAP,
  DRIFT_MIN_SAMPLES,
  DRIFT_WINDOW,
  driftAlert,
  driftStats,
  recordDriftSample,
  resetDriftSink,
} from "./drift-guard.js";

function sample(fingerprint: string, disengaged = false, deaScore?: number): void {
  recordDriftSample({ fingerprint, disengaged, deaScore, at: Date.now() });
}

function fill(fingerprint: string, n: number, disengaged = false, deaScore?: number): void {
  for (let i = 0; i < n; i++) sample(fingerprint, disengaged, deaScore);
}

beforeEach(() => {
  resetDriftSink();
});

describe("drift guard bucket stats", () => {
  it("records into fingerprint buckets with a bounded ring", () => {
    fill("steered:channel=textarea", DRIFT_WINDOW + 10, false, 1e-8);
    const stats = driftStats("steered:channel=textarea");
    expect(stats.turns).toBe(DRIFT_WINDOW);
    expect(stats.meanDea).toBeCloseTo(1e-8, 12);
  });

  it("collapses steered channels into a single steered bucket for stats lookup", () => {
    sample("steered:channel=textarea", true);
    sample("steered:channel=custom-instr");
    const merged = driftStats("steered:channel=textarea");
    // driftStats is per-bucket; the alert path merges. Per-bucket stats here:
    expect(merged.turns).toBe(1);
    expect(driftStats("steered:channel=custom-instr").turns).toBe(1);
  });

  it("returns zeros for an empty bucket", () => {
    const stats = driftStats("unsteered");
    expect(stats.turns).toBe(0);
    expect(stats.disengagedRate).toBe(0);
    expect(stats.meanDea).toBeNull();
  });

  it("treats an unknown fingerprint as its own steered bucket", () => {
    sample("steered:channel=textarea");
    expect(driftStats("unsteered").turns).toBe(0);
  });
});

describe("drift alert", () => {
  it("never alerts below the minimum sample count", () => {
    fill("unsteered", DRIFT_MIN_SAMPLES, false, 1e-8);
    fill("steered:channel=textarea", DRIFT_MIN_SAMPLES - 1, true, 1e-5);
    expect(driftAlert()).toBeNull();
  });

  it("alerts when steered mean dea clears baseline by the factor", () => {
    fill("unsteered", DRIFT_MIN_SAMPLES, false, 1e-8);
    fill("steered:channel=textarea", DRIFT_MIN_SAMPLES, false, 1e-8 * DRIFT_DEA_FACTOR * 10);
    const alert = driftAlert();
    expect(alert).not.toBeNull();
    expect(alert).toContain("mean dea");
  });

  it("stays silent when steered dea is within the factor", () => {
    fill("unsteered", DRIFT_MIN_SAMPLES, false, 1e-8);
    fill("steered:channel=textarea", DRIFT_MIN_SAMPLES, false, 1e-8 * 2);
    expect(driftAlert()).toBeNull();
  });

  it("alerts when steered Disengaged rate clears baseline by the gap", () => {
    fill("unsteered", DRIFT_MIN_SAMPLES, false, 1e-8);
    fill("steered:channel=textarea", 6, true, 1e-8); // rate 1.0 vs 0.0
    const alert = driftAlert();
    expect(alert).not.toBeNull();
    expect(alert).toContain("Disengaged rate");
  });

  it("stays silent when the Disengaged rate gap is within tolerance", () => {
    fill("unsteered", 10, false, 1e-8);
    sample("steered:channel=textarea", true, 1e-8);
    fill("steered:channel=textarea", 9, false, 1e-8); // 0.1 vs 0.0 → equal to gap, not above
    expect(driftAlert()).toBeNull();
  });

  it("never triggers the dea leg without a baseline dea", () => {
    fill("unsteered", DRIFT_MIN_SAMPLES); // no deaScore at all
    fill("steered:channel=textarea", DRIFT_MIN_SAMPLES, false, 1e-5);
    expect(driftAlert()).toBeNull();
  });

  it("merges multiple steered channels into the steered window", () => {
    fill("unsteered", DRIFT_MIN_SAMPLES, false, 1e-8);
    fill("steered:channel=textarea", 3, true, 1e-8);
    fill("steered:channel=custom-instr", 3, true, 1e-8);
    const alert = driftAlert();
    expect(alert).not.toBeNull();
    expect(alert).toContain("6 turns");
  });

  it("reset clears all buckets", () => {
    fill("unsteered", DRIFT_MIN_SAMPLES);
    fill("steered:channel=textarea", DRIFT_MIN_SAMPLES, true);
    expect(driftAlert()).not.toBeNull();
    resetDriftSink();
    expect(driftAlert()).toBeNull();
    expect(driftStats("unsteered").turns).toBe(0);
  });

  it("threshold constants are exported for ops tuning", () => {
    expect(DRIFT_DEA_FACTOR).toBeGreaterThan(1);
    expect(DRIFT_DISENGAGED_GAP).toBeGreaterThan(0);
    expect(DRIFT_MIN_SAMPLES).toBeGreaterThan(0);
    expect(DRIFT_WINDOW).toBeGreaterThan(DRIFT_MIN_SAMPLES);
  });
});
