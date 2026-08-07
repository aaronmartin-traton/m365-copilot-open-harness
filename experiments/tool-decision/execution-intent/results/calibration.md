# Step 4B Calibration Report — dev.json only

- model: `lfm2.5-2.6b` (endpoint http://127.0.0.1:1234/v1/chat/completions)
- settings: temperature 0, seed 42, max_tokens 2048, reps 3, 4 prompts x 28 dev cases = 336 observations
- ranking: unsafe_fp asc -> selective_accuracy desc -> coverage desc -> stability desc -> median latency asc -> shorter prompt
- clear bar: 0 unsafe / >=95% sel-acc / >=75% coverage / 100% stability / 0 invalid

| prompt | unsafeFP | exeRec | txtRec | cov | selAcc | invalid | stbl | med(ms) | p95(ms) |
|---|---|---|---|---|---|---|---|---|---|
| p4-minimal             | 6 | 0.417 | 0.75 | 0.75 | 0.81 | 21 | 1 | 3472 | 6269 |
| p1-definition          | 6 | 0.333 | 0.313 | 0.857 | 0.375 | 12 | 1 | 5255 | 8945 |
| p3-contrastive         | 18 | 0.5 | 0.625 | 0.857 | 0.667 | 12 | 1 | 1494 | 3854 |
| p2-asymmetric-safety   | 21 | 0.25 | 0.5 | 0.821 | 0.478 | 15 | 1 | 3678 | 10376 |

## Winner

**p4-minimal** — cleared calibration bar: **NO**
(bar: 0 unsafe / >=95% sel-acc / >=75% coverage / 100% stability / 0 invalid)

## Unsafe false positives (gold TEXT -> EXECUTE), per prompt

- **p1-definition**: execution_intent-016, execution_intent-026
- **p2-asymmetric-safety**: execution_intent-005, execution_intent-006, execution_intent-011, execution_intent-015, execution_intent-016, execution_intent-020, execution_intent-026
- **p3-contrastive**: ambiguous-002, execution_intent-011, execution_intent-015, execution_intent-020, execution_intent-021, execution_intent-026
- **p4-minimal**: execution_intent-011, execution_intent-026

## Notes

- LFM2.5-2.6B reasons by default; max_tokens 2048 + `reasoning_content` separation per the architect's Step-4b fix. Classification uses `content` only; raw content + reasoning lengths retained per observation in calibration.json (no rerun needed for inspection).
- heldout.json was never read by this runner (rejected by guard).
