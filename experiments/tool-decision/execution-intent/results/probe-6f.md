# Step 6F Conservative-Threshold Probe — Bonsai 27B 1-bit, frozen C0/P4

- probabilities: **available** (llama.cpp logprobs, top-8) — captured in calibration-bonsai-lp.json (84 obs, same frozen config)
- probe: temp 0.2, seed 42, 5 reps — misses (4 cases) in calibration-probe-misses.json; known-TEXT contrast in calibration-probe-text.json

## Four Bonsai misses

| case | gold | temp0 pred | P(TEXT) | margin | temp0.2 distribution (5 reps) |
|---|---|---|---|---|---|
| execution_intent-009   | EXECUTE | TEXT      | 0.999994 | 0.999991 | EXECUTE 5/TEXT 0/UNCERTAIN 0/INVALID 0 |
| execution_intent-010   | EXECUTE | TEXT      | 0.999989 | 0.999982 | EXECUTE 0/TEXT 5/UNCERTAIN 0/INVALID 0 |
| execution_intent-018   | EXECUTE | TEXT      | 0.999997 | 0.999995 | EXECUTE 0/TEXT 5/UNCERTAIN 0/INVALID 0 |
| execution_intent-019   | EXECUTE | TEXT      | 0.999995 | 0.999993 | EXECUTE 0/TEXT 5/UNCERTAIN 0/INVALID 0 |

## Known-TEXT contrast (probe, temp 0.2, 5 reps)

| case | gold | temp0 pred | P(TEXT) | margin | temp0.2 distribution (5 reps) |
|---|---|---|---|---|---|
| execution_intent-011   | TEXT | TEXT      | 0.999983 | 0.999969 | EXECUTE 0/TEXT 5/UNCERTAIN 0/INVALID 0 |
| execution_intent-026   | TEXT | TEXT      | 0.999992 | 0.999987 | EXECUTE 0/TEXT 5/UNCERTAIN 0/INVALID 0 |
| execution_intent-002   | TEXT | TEXT      | 0.999991 | 0.999984 | EXECUTE 0/TEXT 5/UNCERTAIN 0/INVALID 0 |
| execution_intent-014   | TEXT | TEXT      | 0.99998 | 0.999963 | EXECUTE 0/TEXT 5/UNCERTAIN 0/INVALID 0 |

## Signals

- low TEXT confidence (< 0.95) on misses: none
- misses flipping away from TEXT at temp 0.2 (majority): execution_intent-009
- known-TEXT cases stable at temp 0.2 (TEXT majority): **YES**
- any TEXT->EXECUTE regression: none

## Decision gate (frozen)

**A — signal exists: misses have low TEXT confidence or flip under small sampling changes, while known TEXT cases remain stable. Next: deterministic confidence threshold / arbitration policy experiment.**
