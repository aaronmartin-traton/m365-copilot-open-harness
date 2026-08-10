# Adversarial review — DS V4 Flash judge (2026-08-09)
> Snapshot as of 2026-08-09.


**Judge:** `reviewer` agent on the deepseek/deepseek-v4-flash lane (kdash guard: ok).
**Scope:** `docs/research/2026-08-09-local-models-8gb-blackwell.md` + the six lane
files under `docs/research/notes/` + repo ground truth (ADR-0002,
`experiments/tool-decision/README.md`, `intent-verifier.ts`, NEXT.md, hypotheses.md).
**Verdict:** NEEDS-REVISION (confidence 0.98).

## What survives attack

The repo-grounded core holds: 28 dev + 32 held-out cases, 0 unsafe FP / 0.969
held-out, 24.7 s median / 35.9 s p95, literal-EXECUTE fail-closed semantics, the
measured-and-rejected KV-cache-reuse result, and explicit labels/caveats on
community throughput figures. Keeping the M365-first modular architecture remains
defensible; small-model verifier safety does not by itself establish local-generator
quality.

## Findings (ordered by priority)

### 1. Expose the thinking-mode switch before calling this an env swap
**FACT-ERROR, priority 1, confidence 0.99.** §8 says every verifier candidate,
including Bonsai-27B `enable_thinking:false`, is a zero-code env-var swap, but
`packages/proxy-lib/src/intent-verifier.ts:159-164` only reads
endpoint/model/max-token/timeout/backoff variables and its request (lines 277-287)
sends no `chat_template_kwargs`. Changing `M365_INTENT_VERIFIER_MODEL` can select a
direct-answer checkpoint, but cannot turn thinking off for Bonsai/Gemma/Nemotron as
the experiment requires. Fix: add a supported request/server configuration path for
the template kwarg, or state the required server reconfiguration for those rows.

### 2. Do not select verifier candidates on the held-out split
**METHOD-FLAW, priority 1, confidence 0.97.** §8 proposes running five candidates
and accepting them on the 32 held-out cases. Comparing candidates on that split
turns it into model-selection data and violates ADR-0002's frozen rule that the
verifier never validates against its own held-out set. Fix: screen candidates on the
28-case dev corpus, freeze ONE model/configuration, use the 32 held-out cases once
for the final gate. The ≥0.95 bar is achievable in principle (Bonsai is 0.969
held-out), but the best new-model dev result is 0.808 with documented TEXT bias —
do not imply a same-day pass.

### 3. Replicate and counterbalance the custom-instructions arms
**METHOD-FLAW, priority 1, confidence 1.0.** Lane F's probe is four DIFFERENT arms
at n=1 while its own decision table requires `T1 ≥2/2` — satisfying one criterion
already exceeds the stated cost. Contradicts AGENTS.md ("n=1 is noise") and the F24
correction (back-to-back fresh conversations measure thread-rate state, not
treatment). Fix: repeated flag-on/flag-off pairs with rotated order on a rested
account; throttle onset = inconclusive run; separate replicated experiments for
tone and full-triplet questions.

### 4. Do not treat the intent gate as a complete fallback safety boundary
**OVERREACH, priority 1, confidence 0.96.** The verifier's frozen prompt asks only
whether command-shaped text is intended to execute now. If untrusted repository or
tool output prompt-injects the local generator into emitting a destructive fenced
command, the verifier can correctly answer EXECUTE — it does not assess
authorization, provenance, path scope, or harmfulness. The fallback design needs an
explicit untrusted-tool-output / prompt-injection threat model and an adversarial
multi-turn bake-off, plus whatever policy boundary owns dangerous commands.

### 5. Label the 24.7-second decomposition as a hypothesis
**HAND-WAVE, priority 2, confidence 0.98.** "~2 s prefill + ~23 s thinking decode"
is circular: Lane D derives 35 tok/s by assuming an 800-token conversion and a ~2 s
prefill, then uses that rate to "confirm" the ~23 s decode term. Neither term was
measured for the held-out median, and the rounded terms sum to ~25 s, not 24.7 s.
Fix: keep the measured 24.7 s total, label the split as estimate, measure
prompt-eval/decode timings before causal claims.

### 6. Correct the stated verifier speedup range
**FACT-ERROR, priority 2, confidence 0.99.** 24.7 s baseline vs 0.3–1.6 s estimate
implies ~15.4–82.3×, not "15–50×". The anchor extrapolates a community Llama-7B
pp512 score to 1–4B models and 1–4K prompts by inverse parameter count — it does
not cover prompt-length scaling, local machine clocks, architecture, quantization, or
fixed overhead. Fix: report the full interval with wide uncertainty, or run
`llama-bench -p 1024,2048,4096` on the target local machine first.

### 7. Resolve the contradictory llama.cpp NVFP4 support claim
**FACT-ERROR, priority 2, confidence 1.0.** §3.4 (following Lane A) says llama.cpp
merged an NVFP4 GGUF type + CUDA kernels; Lane C says "no NVFP4 GGUF type in ggml
today (MXFP4 only)". Both cannot be true at the same research date. Fix: recheck
PRs #19769/#20644/#21074 to distinguish NVFP4 vs MXFP4 vs conversion-only paths
and make all three documents agree. (Recommendation unaffected: stay on GGUF Q4–Q6.)

### 8. Test the fallback as a routed multi-turn system, not only a model
**METHOD-FLAW, priority 2, confidence 0.97.** The offline Docker bake-off cannot
validate the proposed behavior: activation from degradation state, preserving or
compacting an existing long conversation, avoiding duplicate side effects, labeling
degraded responses, probing M365 recovery. Lane E itself names context-size
mismatch as the main integration hazard, and backoff already paces new M365 turns.
Fix: add a replay/simulation of the routing state machine plus representative
multi-turn transcripts, and quantify observed throttle frequency/duration before
calling the lane "medium value".

### 9. Include Qwen3.5-4B in the stated safety evidence
**FACT-ERROR, priority 2, confidence 1.0.** §7 says only Bonsai and qwythos-9b have
safety evidence, but Step 4b reports Qwen3.5-4B at 0 unsafe FP on the dev corpus
(selAcc 0.692, execute recall 0.167, 2 invalids). LFM2.5-2.6B has negative evidence
(2 stable unsafe FPs). Distinguish held-out evidence (Bonsai only), positive
dev-only evidence (qwythos-9b, Qwen3.5-4B), and disqualifying dev evidence.

### 10. Evaluate the existing logprob path before adding an encoder sidecar
**MISSING-ALTERNATIVE, priority 2, confidence 0.86.** NEXT.md documents that the
current llama.cpp endpoint already exposes `top_logprobs:8`. A constrained
EXECUTE/TEXT/UNCERTAIN grammar or first-token logprob scorer could preserve the
known Bonsai model while bounding free-form decode. It may fail (chat template
still invokes reasoning), but it is a cheap corpus-and-latency experiment that
should be dispositioned before recommending new runtime/training infrastructure.
The document correctly respects the measured rejection of KV-cache reuse and should
say so explicitly alongside this remaining alternative.

## Overall

The repo-grounded core survives. The recommended experiments currently misuse the
held-out split, cannot apply thinking-off through the documented env contract, use
an invalid n=1 custom-instructions design, and overstate both latency arithmetic
and fallback safety/value. The unconditional "keep the architecture" conclusion
should be narrowed until the corrected verifier bake-off, routed-fallback test, and
replicated custom-instructions experiment produce evidence.
