# Local models on an 8 GB Blackwell GPU — options for m365-copilot-proxy
> Snapshot as of 2026-08-09.


**Date:** 2026-08-09 · **Status:** revised after adversarial review · **Method:** 6 background research
lanes against primary sources (files in `docs/research/notes/`) + full repo digest.
This document uses Simplified Technical English (ASD-STE100).

---

## 1. Purpose

This document answers three questions:

1. Which open-weight models run on an 8 GB NVIDIA Blackwell GPU (RTX 5060 class,
   sm_120)?
2. Which model architectures do tool usage well?
3. Which local-model options fit this project, and is the current architecture the
   right one?

Evidence files:

| Lane | File |
|---|---|
| A — 8 GB model fit | `docs/research/notes/lane-a-8gb-model-fit.md` |
| B — tool-use architectures | `docs/research/notes/lane-b-tool-use-architectures.md` |
| C — Blackwell runtimes | `docs/research/notes/lane-c-blackwell-runtimes.md` |
| D — verifier replacements | `docs/research/notes/lane-d-verifier-replacements.md` |
| E — fallback-lane fit | `docs/research/notes/lane-e-fallback-lane-fit.md` |
| F — custom-instructions lever | `docs/research/notes/lane-f-custom-instructions-lever.md` |

---

## 2. Background

The proxy wraps M365 Copilot in an OpenAI-compatible interface. Tool calling is
prompt-emulated: the model writes Markdown fences, and shell-routing executes
` ```bash ` blocks as the harness shell tool. The strict JSON tool format scored
0/5 and was removed.

A local execution-intent verifier gates every tool execution. Only a literal
`EXECUTE` verdict authorizes execution (fail-closed, ADR-0002). The verifier is
the project's first local model. It runs Bonsai-27B-Q1 (1-bit, ~5 GiB) on the
local machine RTX 5060. Median verdict latency is 24.7 s. The project's own notes name
latency as the remaining architectural constraint (NEXT.md).

Hosts: local machine RTX 5060 8 GB (sm_120, CUDA 13.3); desktop Ryzen 9 7900X with
64 GB RAM (experiments box).

---

## 3. What fits in 8 GB (Lane A)

### 3.1 The VRAM budget

Usable VRAM after CUDA context: ~7.6–7.85 GiB. Runtime buffers take 0.5–1.5 GiB.
Practical budget for weights + KV cache: **~6.5–7.0 GiB**.

KV cache per token is computed per model from `config.json` (Lane A §1.2).
Examples: Qwen3-8B = 144 KiB/token (fp16); Qwen3.5-9B hybrid = 32 KiB/token;
Granite-4.0-H-Tiny = 16 KiB/token.

### 3.2 The 2026 meta: hybrid architectures

The decisive change since 2025 is KV-efficient design:

- Qwen3.5 (Gated-DeltaNet + attention)
- Gemma 4 (sliding-window hybrid)
- Granite 4.0 / Nemotron Nano (Mamba2 hybrid)
- LFM2.5 (conv + attention)

These cut KV 4–8× vs 2025 dense models. Qwen3.5-9B Q4_K_M (5.68 GB) runs full-GPU
at 32K context in 6.96 GB total (community-measured, Lane A §7).

**KV-cache quantization is the second lever.** llama.cpp q8_0 halves and q4_0
quarters the cache. Example: Qwen3-8B Q4_K_M fits ~19K ctx with fp16 KV, ~39K
with q8_0, ~78K with q4_0 (Lane A §1.3).

### 3.3 Fit table (selection)

| Model | Params/active | Q4 size | Fit mode |
|---|---|---|---|
| Qwen3.5-4B | 4B | ~2.6 GB | FULL |
| Qwen3.5-9B | 9B | 5.68 GB | FULL, best measured all-rounder |
| Qwen3-8B | 8.2B | ~4.8 GB | FULL (KV-quant for long ctx) |
| Ministral 3 8B | 8.4B | ~5 GB | FULL at Q4 |
| Nemotron-Nano-9B-v2 | 8.9B hybrid | 6.53 GB | FULL |
| Granite-4.0-H-Tiny | 7B/1B MoE | 4.30 GB | FULL (MoE that fits) |
| LFM2.5-8B-A1B | 8.3B/1.5B MoE | 5.16 GB | FULL (MoE that fits) |
| Gemma 4 E4B | 8B | ~5 GB | FULL |
| Qwen3-Coder-30B-A3B | 30.5B/3.3B | 17.7 GB | MoE expert-offload, ~32 t/s |
| Qwen3-Coder-Next | 80B/~3B | 48.4 GB | deep expert-offload, no 8 GB data |
| gpt-oss-20b | 21B/3.6B | 11.6 GB | does not fit; slow offload |
| Devstral 24B | 24B dense | ~14 GB | layer-offload — avoid |

Rules (Lane A §4, §7):

1. Choose a fully-fitting model or a MoE with expert offload.
2. Never use dense layer-offload. It collapses to 4–11 t/s (measured).
3. Expert-offload speed scales with system RAM bandwidth, not PCIe.

### 3.4 Quantization formats on GeForce RTX 50

- GGUF Q4_K_M–Q8_0: the robust default (llama.cpp, Ollama, LM Studio).
- NVFP4: supported on GeForce sm_120 by vLLM ≥0.12. Lane A and Lane C disagree
  on llama.cpp: Lane A found NVFP4 GGUF type + CUDA kernels merged Mar–Apr 2026
  (PRs #19769/#20644/#21074, commit search); Lane C found no NVFP4 GGUF type in
  ggml (MXFP4 only). UNRESOLVED as written — recheck before relying on NVFP4.
  Not consistently faster than FP8 yet (community reports).
- FP8: fine via vLLM ≥0.12; 8B weights in FP8 are too big for 8 GB with context.
- MXFP4: native format of gpt-oss; llama.cpp sm_120 source builds have known
  ptxas failures (Lane C).
- Decision unchanged: stay on GGUF Q4–Q6 for this project.

---

## 4. Tool-use architecture findings (Lane B)

### 4.1 What makes a local model good at tools

1. Agentic RL with executable environments is the emerging post-training recipe
   (LFM2.5-2.6B trained in real agent harnesses with GRPO; Qwen3-Coder family).
2. Thinking-mode control matters. Reasoning-by-default models burn tokens and can
   starve a short-output contract. A documented off-switch is a requirement for
   latency-critical roles.
3. Chat-template tool syntax varies (JSON-schema tools, XML, python-style).
   Runtime support for rendering it varies too (Lane C: llama-server `--jinja`
   default-on; Ollama has tools but no `tool_choice`).

### 4.2 Independent benchmark picture (BFCL v4, 2026-04-12)

Best ≤13B tool-use models: Nanbeige4-3B-Thinking 51.4%, xLAM-2-8b-fc-r 46.7%
(multi-turn 70.0%), BitAgent-Bounty-8B 46.2%, ToolACE-2-8B, Qwen3-8B. Best
sub-8B generalist: Qwen3-4B-Instruct-2507 at 35.7%.

No ≤13B open model appears in independent tau2-bench runs. SWE-bench Verified
separates at ~24B (Qwen3-Coder-30B-A3B ~55.4%; Devstral Small 2 68.0%).

Reliability is the real problem: on tau-retail, GPT-4o drops to ~25% at pass^8.
Small-model failure modes documented (Lane B §3): parallel calls break first,
JSON quote/escape corruption, hallucinated arguments, 20-step loop termination,
context rot (NoLiMa: 11/13 models below 50% of baseline at 32K).

### 4.3 Format sensitivity — this project's finding is corroborated

Small models swing **50–81.5 accuracy points** across tool-call formats;
flagships swing 8.5–23.5 (BFCL format study, Lane B §4). Natural-language tool
formats beat strict JSON by +18.4pp, with the largest gains for open-weight
models (arXiv 2510.14453). Code-as-action matches or beats JSON.

This independently corroborates the repo's core lever: strict JSON failed (0/5),
fenced shell blocks produce real agent loops. The lever is general, not
M365-specific. Any local fallback lane should reuse the fenced/shell contract.

### 4.4 The classifier-vs-agent asymmetry

LFM2.5-2.6B is disqualified as a single-token classifier (this repo's bench:
2 unsafe FPs, tool-call emissions) yet scores BFCL v4 56.9% as a tool agent in
<2.5 GB at 220 tok/s. The same agentic RL that breaks the classifier contract
makes the agent contract work. Role fit is contract-specific; do not transfer
verdicts across contracts.

---

## 5. Serving on Windows Blackwell (Lane C)

| Runtime | Windows + RTX 50 status |
|---|---|
| llama.cpp | Mature. Official Windows CUDA builds. Best tools surface (`--jinja` default on, `tool_choice`, JSON-schema output). |
| Ollama | Mature. Official sm_120. Tools yes, `tool_choice` no. |
| LM Studio | RTX 50 CUDA 12.8 since 0.3.15. `tool_choice` since 0.3.15. |
| vLLM | Works on sm_120 but WSL2-only on Windows. |
| SGLang / TensorRT-LLM | Linux-first. Not recommended here. |

Throughput on 8 GB class: ~50–60 tok/s for 7–9B Q4 dense; ~29–32 tok/s for
Qwen3-30B-A3B expert-offload; ~17.6 tok/s gpt-oss-20b offload (community).

Recommendation for this host: **llama.cpp llama-server** when control matters
(KV quant, MoE offload, tool_choice), **Ollama** for lowest friction.

---

## 6. Architecture review

### 6.1 What the current architecture gets right

1. **The translation layer is the right shape.** core (protocol) / proxy-lib
   (framework-free translation) / proxy (thin Nitro shell) keep the harness
   decoupled from the backend. The OpenAI-compatible surface is what lets pi,
   Codex, and a bench share one contract.
2. **Shell-routing + proxy-side hardening is a deep module.** A small interface
   (fenced blocks in, tool calls out) hides a lot of behaviour: document guard,
   confab retry, hallucinated-completion retry, result labelling, invented-JSON
   stripping, one-call-per-turn. Each layer is deterministic and characterized
   by tests (205 pass).
3. **The verifier is principled.** Frozen corpus, held-out split, fail-closed
   semantics, model-identity guard, cache with policy version. Evidence drove
   the design (13 deterministic unsafe FPs corrected; 0 unsafe FPs at selAcc
   0.969 held-out).
4. **The verifier is already endpoint-agnostic.** Env-configured OpenAI
   endpoint + model, with fail-closed on mismatch/timeout. A model swap is a
   config change gated by the frozen corpus — no code change.
5. **Discipline is visible.** Extraction phase closed with a stated rule; corpus
   measured before models; "no runtime local model until the corpus data
   justifies it".

### 6.2 Where the pressure sits

1. **Verifier latency.** 24.7 s median per verdict, serialized (concurrency 1).
   The model is a 27B reasoning model doing a 3-class single-token job. This is
   a model-architecture mismatch, not a system-design flaw.
2. **Single remote backend.** Thread-rate throttle stops work. Degradation
   backoff paces turns but produces nothing during the lull.
3. **The fail-closed gate covers M365 output only.** Any future local fallback
   that emits tool-shaped text must go through the same gate, or the invariant
   breaks.

### 6.3 Alternative approaches considered — and rejected

**A. Replace M365 with a local primary backend.** Rejected. The best 8 GB-fit
local agent (Qwen3-Coder-30B-A3B, ~55.4% SWE-bench Verified) is far below the
frontier-class models M365 serves for free. The zero-cost frontier backend is
the project's reason to exist.

**B. Route everything through a general LLM router (LiteLLM-style).** Rejected
for the primary path. The M365 protocol needs this proxy's translation anyway;
a router adds a hop without adding capability. Fallback semantics belong in
proxy-lib, where throttle state already lives.

**C. Put a local model in the parsing/repair hot path.** Rejected. Deterministic
logic already owns parsing, recovery, and guards — measured on the corpus, fast,
stable. A local model there adds latency and failure modes for no measured gain
(tool-decision README Step 3: deterministic coverage is high; the residual class
is exactly execution_intent).

**D. Native tool-calling via Copilot Studio / MCP.** Permanently out of scope
by decision (license breaks the zero-cost premise; CONTEXT.md).

### 6.4 Verdict

Keep the architecture as the working hypothesis. The translation layer, the
shell-routing module, and the fail-closed verifier are each evidence-backed and
well-tested. Add local models only at the two points where the design already
has a socket: the verifier endpoint (exists today) and a degraded-mode fallback
route (new). This verdict narrows if the corrected experiments (§8) fail: a
verifier bake-off that finds no safe fast model, or a fallback test that shows
no continuity benefit, would each reopen part of this conclusion. (Adversarial
review: `docs/research/notes/judge-review.md`.)

---

## 7. Options that fit this project (ranked)

### Option 1 — Replace the verifier model (highest value, lowest risk)

**Problem.** The verifier takes 24.7 s median (measured). Working hypothesis
(Lane D, ESTIMATE, not measured): most of that is unrequested thinking-token
decode, not prefill — the single-token contract never reads the reasoning.
Measure prompt-eval and decode timings before citing the split as cause.

**Fix.** Point the existing env-configured endpoint at a direct-answer model.
The fail-closed invariant and the frozen corpus stay intact. Caveat (judge
finding 1): `intent-verifier.ts` reads only endpoint/model/max-tokens/timeout/
backoff env vars and sends no `chat_template_kwargs`. Candidates that need
thinking switched off (Bonsai, Gemma 4, Nemotron) need server-side template
configuration (e.g. llama-server chat-template kwargs) or a small contract
change — they are NOT zero-code swaps. Candidates with no thinking mode
(Ministral-3-3B-Instruct) are true env-var swaps.

**Measured anchor.** RTX 5060-class llama-bench (Llama-7B Q4_0): pp512
3,269–3,799 t/s, tg128 ~100 t/s. Parameter-scaled estimates (Lane D):
1–4B direct-answer models verdict in ~0.3–1.6 s at 1–4K inputs. Arithmetic
speedup vs 24.7 s: ~15–82×, wide uncertainty — the extrapolation ignores
prompt-length scaling, local machine clocks, and fixed overhead. Run
`llama-bench -p 1024,2048,4096` on the target local machine before buying a number.

**Candidates.**

| Candidate | Size (Q4) | Notes |
|---|---|---|
| Bonsai-27B + thinking-off | 3.5 GiB | Template switch verified; needs server-side kwargs (§Fix); direct-answer quality unmeasured |
| Bonsai-8B thinking-off | ~1.2 GB (1-bit) | Keeps vendor/threat model; ~0.9–1.5 s estimate; same kwargs caveat |
| Ministral-3-3B-Instruct | 2.15 GB | No thinking mode exists — true env-var swap; official GGUF |
| Nemotron-3-Nano-4B | 2.84 GB | IFEval 88 with reasoning off; official GGUF; kwargs caveat |
| Gemma 4 E2B | 3.35 GB (QAT) | IFEval 94.6, `enable_thinking=False` documented; weak IFBench; kwargs caveat |
| Qwen3.5-4B / LFM2.5-1.2B-Instruct | 2.6 / 0.7 GB | Prior shortlist; known caveats (prior research note) |

**Cheap alternative to disposition first (judge finding 10).** The current
endpoint already exposes `top_logprobs:8` (NEXT.md). A constrained
EXECUTE/TEXT/UNCERTAIN grammar or first-token logprob scorer could keep the
known Bonsai model while bounding free-form decode. Cheap corpus-and-latency
test; do it before building new infrastructure. (KV-cache reuse was already
measured and rejected — NEXT.md ticket 04; do not retry it.)

**Longer-term route.** Fine-tuned encoder. llama.cpp merged ModernBERT support
(b8100). Liquid ships LFM2.5-Encoder-230M/350M built for classification and
routing (~0.05–0.3 s estimate). Needs an ONNX sidecar and corpus augmentation
(60 cases today). Do this only if generative candidates miss the safety gate.

**Gate order (corrected per ADR-0002).** Screen candidates on the 28-case DEV
corpus and freeze ONE model/configuration. Use the 32 held-out cases ONCE, for
the final gate of the frozen choice — never for comparison shopping. Pass =
0 unsafe FP on held-out, then selective accuracy ≥ 0.95, then measured
latency. Evidence tiers today: held-out evidence — Bonsai only (0.969).
Positive dev-only evidence — qwythos-9b (0 unsafe FP, selAcc 0.808) and
Qwen3.5-4B (0 unsafe FP, selAcc 0.692, TEXT-biased). Disqualifying dev
evidence — LFM2.5-2.6B (2 stable unsafe FPs).

### Option 2 — Local fallback lane for degraded mode (medium value, more work)

**Problem.** Thread-rate throttle and Disengaged episodes stop work. Backoff
paces turns but produces nothing during the lull.

**Fix.** A proxy-side route in proxy-lib: when degradation backoff is active,
serve a local model instead of idling. Trigger on the throttle state the proxy
already tracks, not on HTTP errors (Lane E: generic routers miss non-error
degradation).

**Candidate models.**

| Candidate | Where | Speed | Evidence |
|---|---|---|---|
| Qwen3-Coder-30B-A3B | local machine 8 GB, expert offload | ~32 t/s (community, 3060 Ti 8GB) | Proven in Cline/aider/OpenHands/goose; ~55.4% SWE-bench Verified |
| Qwen3-Coder-Next 80B | desktop, 64 GB RAM | ~25 t/s on exactly this desktop class | llama.cpp #19480; vendor agentic claims unverified |
| LFM2.5-2.6B | local machine, fully in GPU | 30–90 t/s | BFCL 56.9% vendor; zero public shell-routing reports |

**Format fit.** The shell-routing contract survives by construction: omit the
`tools` parameter and the chat-template tool branch never fires; fenced bash
is plain text the existing parser already handles. aider's edit-format swing
(8% → 33.3%) shows text protocols are steerable. The real risk is inverse
leakage: think tags, JSON fragments, or scaffolding leaking into plain-text
mode (Lane E).

**Safety constraint.** Local fallback output MUST pass the same fail-closed
execution-intent gate — necessary but NOT sufficient. The verifier's frozen
prompt decides execution intent only; it does not assess authorization,
provenance, path scope, or harmfulness. A prompt-injection payload in
untrusted repo or tool output could steer the local generator into a
destructive fenced command that the verifier correctly clears. The fallback
design needs an explicit untrusted-tool-output threat model, an adversarial
multi-turn bake-off, and a policy boundary that owns dangerous commands.

**Scope guard.** This is a continuity lane for throttle lulls, not a second
primary backend. Keep it opt-in (`M365_LOCAL_FALLBACK=1`) and label its
responses so the client knows quality degraded.

### Option 3 — Custom-instructions lever (cheap experiment, high upside)

See §8. This is an experiment on the M365 side, not a local-model option, but
it interacts with everything above: if account-level custom instructions make
the agent-less path emit fences reliably, the fallback lane becomes stronger
and the agent path's Disengaged exposure shrinks.

### Rejected options

Local primary backend, general LLM router, local parsing/repair in the hot
path, native tool-calling — see §6.3.

---

## 8. Experiment candidates

1. **Verifier bake-off.** Screen Bonsai-27B thinking-off, Bonsai-8B,
   Ministral-3-3B-Instruct, Nemotron-3-Nano-4B, Gemma 4 E2B (plus the
   logprob/grammar scorer) on the 28-case DEV corpus. Freeze one candidate.
   Run the 32 held-out cases once for the frozen choice. Do not compare
   candidates on the held-out split (ADR-0002). Configure thinking-off
   server-side where needed; the env contract alone cannot do it.
2. **Fallback bake-off — two stages.** Stage 1 (offline, `--network none`):
   serve Qwen3-Coder-30B-A3B and LFM2.5-2.6B through the fenced contract;
   measure fence emission, leakage rate, solve rate on unfakeable tasks;
   include an adversarial arm with injected tool output. Stage 2 (routing
   simulation): replay representative multi-turn transcripts through the
   degradation state machine; verify activation, context hand-off, no
   duplicate side effects, degraded-response labelling, M365 recovery probes.
   Before building, quantify observed throttle frequency/duration — if lulls
   are rare, the lane is not worth its complexity.
3. **Custom-instructions probe (user-proposed).** Custom Instructions is part
   of Copilot Memory, stored in the Exchange mailbox and retrieved server-side
   by oid. Two independent wire captures show the `add_custom_instructions`
   optionsSets flag on agent-less turns of this exact endpoint, and the kuchris
   reference proxy sends it on every API turn. This proxy sends none of these
   flags today, but the override plumbing already exists
   (`M365_EXTRA_OPTIONSSETS` / `_probe-chat.mjs`). Design is corrected per the
   judge: Lane F's 4-thread draft is a PILOT only — n=1 arms cannot conclude
   anything (AGENTS.md; F24 correction). The real experiment: repeated
   flag-on/flag-off pairs, rotated order, rested account, throttle onset
   treated as inconclusive; tone and full-triplet questions get separate
   replicated runs. Zero-thread admin pre-flight first (greyed GUI toggle =
   tenant disabled it). Needs execution authorization (NEXT.md).

---

## 9. Risks and open questions

- Community throughput figures may not transfer to this exact hardware.
  Confirm with one llama-bench run before buying any latency claim.
- Verifier safety evidence is tiered, not binary: held-out (Bonsai only),
  dev-only positive (qwythos-9b, Qwen3.5-4B), dev-disqualified (LFM2.5-2.6B).
  Every other candidate has none. The corpus gate is mandatory.
- NVFP4 llama.cpp support is contradicted between Lane A and Lane C. Resolve
  before any NVFP4 dependency. Stay on GGUF Q4–Q6 regardless.
- Qwen3-Coder-Next needs ~46–51 GB RAM at Q4. It fits the 64 GB desktop only.
- The custom-instructions injection point is unverified for API-driven turns.
  Lane F lists what is confirmed vs inferred.
- Fallback-lane value is unquantified. Measure real throttle-lull frequency
  before committing to the build.

## 10. Recommended next steps

1. Run the verifier bake-off (Option 1). Highest value per hour of work.
2. Write up results in `docs/hypotheses.md` with sample sizes and evidence
   pointers, per repo convention.
3. If a candidate passes the gate, flip `M365_INTENT_VERIFIER_MODEL` in the
   local machine deployment and re-measure live latency.
4. Decide on the fallback lane (Option 2) after the verifier win lands.
5. Schedule the custom-instructions probe (Option 3) for a rested account.
