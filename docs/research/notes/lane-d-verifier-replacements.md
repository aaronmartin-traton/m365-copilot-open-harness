# Lane D — Execution-intent verifier replacements (faster than Bonsai-27B-Q1)
> Snapshot as of 2026-08-09.


> **Hardware correction (2026-08-14).** The local machine is a the local machine
> with an RTX PRO Blackwell 8 GB (RTX PRO 1000 or 2000, sm_120), not an
> RTX 5060. "RTX 5060 8 GB" here means this local machine GPU.


- **Research date:** 2026-08-09. All "current" claims are as of this date.
- **Problem:** The 8H fail-closed gate currently runs Bonsai-27B-Q1 (PrismML, 1-bit Qwen3.6-27B derivative, 3.54 GB GGUF) under llama.cpp on the local machine RTX 5060 8 GB: **measured median 24.7 s / p95 35.9 s per verdict** (held-out run, n=32, ticket 03). Latency, not safety, is the stated remaining constraint (ADR-0002, NEXT.md). The frozen contract is temp 0, single-token EXECUTE/TEXT/UNCERTAIN, ≤8K context; fail-closed (only literal EXECUTE executes).
- **Why it is slow (repo-measured):** Bonsai ignores the single-token contract and emits `reasoning_content` of **1.2K–8.7K chars (~400–2,900 tokens; median ≈2,400 chars ≈800 tokens)** per verdict (calibration + held-out artifacts). At its ~35 tok/s decode (derived in §1.4), ~800 reasoning tokens ≈ 23 s — thinking tokens, not prefill, dominate. The frozen corpus itself is short; planner inputs are typically 0.5–4K tokens.

**Evidence labels used below:** `[measured]` = number taken from a benchmark artifact (repo results, llama-bench scoreboards, vendor-published measured tables); `[derived]` = computed here from measured anchors with the formula shown; `[estimate]` = engineering extrapolation with stated uncertainty; `[vendor]` = vendor claim without independent measurement; `[community-reported]` = forum/blog number, unverified.

---

## 1. Prefill-bound latency math on RTX 5060-class hardware

### 1.1 Model

```
verdict_latency ≈ input_tokens / pp_rate          (prefill, compute-bound)
                + output_tokens / tg_rate         (decode, bandwidth-bound)
                + fixed_overhead                  (HTTP/template/logits, ~0.2–0.5 s)
```

For a **direct-answer** verifier `output_tokens ≈ 1–5`, so the decode term is ≤0.1 s and **latency ≈ prefill + overhead**. For a thinking model, `output_tokens` = reasoning tokens and decode dominates (this is the current Bonsai failure mode).

### 1.2 Measured throughput anchors for this GPU class

| Hardware | Model / quant | pp512 (tok/s) | tg128 (tok/s) | Source |
|---|---|---|---|---|
| **RTX 5060 desktop 8 GB** (CUDA 13.3, llama.cpp b9715) | Llama-7B Q4_0 | **3,269 ± 45** (fa0) / **3,799 ± 31** (fa1) | **96.7** (fa0) / **100.6** (fa1) | [community-reported] llama.cpp CUDA perf thread, odbguru 2026-06-19 <https://github.com/ggml-org/llama.cpp/discussions/15013> |
| RTX 5060 Ti 16 GB | Llama-2-7B Q4_0 | 3,737 (fa0) / 4,196 (fa1) | 90.9 / 93.5 | [community-reported] same scoreboard |
| RTX 4060 Ti 8 GB | Llama-2-7B Q4_0 | 3,395 (fa0) / 3,803 (fa1) | 63.9 / 64.0 | [community-reported] same scoreboard |
| RTX 5060 Ti 16 GB (b8838, q4_0 KV) | Qwen3.6-35B-A3B (MoE, 3B active) | 1,261–1,585 at 7.5K–108K prompts | 46–89 | [community-reported] <https://njannasch.dev/blog/qwen-3-6-turboquant-local-inference/> |
| Bonsai-27B-Q1 (1-bit) | PP512 | 421 (M5 Pro Metal), 2,755 (H100, launch-limited) | 44.2 (M5 Pro), 104.8 (H100) | [vendor] prism-ml/Bonsai-27B-gguf card |
| Laptop RTX 5060 8 GB (this project) | Bonsai-27B-Q1 | — | **~35 tok/s** [derived in §1.4] | repo-measured verdict latency + reasoning length |

Notes: the local machine RTX 5060 has the same 448 GB/s GDDR7 and core count class as desktop 5060 but lower clocks — expect roughly 10–15% below the desktop rows [estimate]. Lane C's aggregate for this class: **45–60 tok/s decode for dense 7–9B Q4** (docs/research/notes/lane-c-blackwell-runtimes.md §throughput).

### 1.3 Prefill-rate estimates for smaller models

Prefill is compute-bound, so to first order `pp_rate ∝ 1 / active_params`. Anchoring on the measured RTX 5060 7B figure (≈3,300–3,800 t/s):

```
pp_rate(model) ≈ 3,500 t/s × (6.74 B / P_effective)      [estimate, ±50%]
```

| Model (quant) | P_effective for prefill | pp_rate [estimate] | Prefill time @1K / 2K / 4K input [derived] |
|---|---:|---:|---|
| Qwen3.5-0.8B (Q4) | 0.87 B | capped ~5,000–8,000 (kernel overhead) | 0.13–0.2 / 0.25–0.4 / 0.5–0.8 s |
| LFM2.5-1.2B-Instruct (Q4) | 1.17 B | capped ~5,000–7,000 | 0.14–0.2 / 0.3–0.4 / 0.6–0.8 s |
| Qwen3.5-2B (Q4) | 2.0 B | ~8,000–10,000, capped ~6,000–8,000 | 0.13–0.17 / 0.25–0.33 / 0.5–0.7 s |
| Gemma 4 E2B (QAT Q4_0) | **2.3 B effective** (PLE embeddings are lookup-only) | ~7,000–9,000 | 0.11–0.14 / 0.22–0.29 / 0.45–0.6 s |
| Ministral 3 3B (Q4_K_M) | 3.4 B (vision tower not loaded) | ~6,000–7,500 | 0.13–0.17 / 0.27–0.33 / 0.55–0.7 s |
| Nemotron-3-Nano-4B (Q4_K_M, Mamba2 hybrid) | 3.97 B | ~5,500–6,500 | 0.15–0.18 / 0.3–0.36 / 0.6–0.75 s |
| Qwen3.5-4B (Q4_K_M) | 4.0 B | ~5,500–6,400 | 0.16–0.18 / 0.31–0.36 / 0.63–0.73 s |
| Granite-4.0-H-Tiny (MoE, 7B/1B active, Q4) | ~1 B active | ~3,500–7,000 (MoE prefill less efficient than dense at b1) | 0.15–0.3 / 0.3–0.6 / 0.6–1.1 s |
| Ternary-Bonsai-8B (Q2_0) | 8.19 B | ~2,800–3,400 | 0.3–0.36 / 0.6–0.7 / 1.2–1.4 s |
| Qwen3.5-9B (Q4_K_M) | 9–10 B | ~2,500–2,900 | 0.35–0.4 / 0.7–0.8 / 1.4–1.6 s |
| Bonsai-27B-Q1 (27.3 B, ~75% linear attention) | 27.3 B (linear-attn cheaper) | ~700–1,200 | 0.8–1.4 / 1.7–2.9 / 3.3–5.7 s |

### 1.4 Validation of the model against the measured Bonsai numbers

Held-out Bonsai run [measured, repo]: median latency 24,661 ms; median reasoning ≈2,400 chars ≈ 800 tokens.

```
decode_rate ≈ 800 tokens / (24.7 s − prefill(~2 s @ ~900 t/s)) ≈ 35 tok/s   [derived]
```

This is consistent with a 27B-class model reading ~3.9 GB of weights per token at realistic 5060-local machine bandwidth, and with Lane C's observation that low-bit decode stays bandwidth-bound. It also confirms the decomposition: **~23 s of the 24.7 s median is thinking-token decode, ~2 s is prefill.**

### 1.5 Is a sub-3-second median verdict plausible?

**Yes — with a direct-answer model it is not even close.** For any 1–4B direct-answer model (or the Bonsai family ≤8B), the entire verdict is prefill + a 1-token decode:

- **1–4B, 1K input:** ≈ **0.3–0.7 s** median [derived, ±50%]
- **1–4B, 4K input:** ≈ **0.8–1.6 s** median [derived]
- **9B, 4K input:** ≈ **1.6–2.4 s** median [derived]
- **Bonsai-27B-Q1 with thinking OFF:** ≈ **2.5–4 s @ 2K, 4–6 s @ 4K** [derived] — only borderline sub-3 s for ≤1–1.5K inputs
- **Bonsai-27B-Q1 with thinking ON (today):** 24.7 s [measured]

The sub-3-second target fails today purely because a thinking model spends ~800 tokens of decode on reasoning that the frozen single-token contract never reads. Every candidate in §2 that is direct-answer (or has a verified thinking-off switch) clears 3 s with 3–20× of margin at the 8K context ceiling, before any safety evaluation.

Two honest caveats: (a) all sub-3 s figures above are derived/estimated — they rest on measured 7B anchors plus parameter-count scaling, and must be confirmed with `run-latency-10a.mjs`-style measurement on the local machine; (b) latency buys nothing without safety — every candidate needs the frozen 28 dev + 32 held-out corpus (§6).

---

## 2. Candidate models (newer or different from the prior shortlist)

Prior shortlist for context: Qwen3.5-4B (bench: safe, 0 unsafe FP, but exe recall 0.167 — over-cautious), LFM2.5-1.2B-Instruct, SmolLM3-3B /no_think, qwythos-9b (Qwen3.5-9B FT; 0 unsafe FP, selAcc 0.808, stability 1.0). LFM2.5-2.6B was DISQUALIFIED (2 unsafe FPs + tool-call emissions). Below are the 2026 additions/updates, all ≤9B and 8 GB-fit.

| Candidate | Released | Thinking default → off-switch evidence | IF evidence | GGUF size | Runtime notes | Source |
|---|---|---|---|---|---|---|
| **Nemotron-3-Nano-4B** (NVIDIA) | 2026-03-16 | Hybrid reasoning; **reasoning controlled via system prompt / `enable_thinking=False`**, documented in card; "excels at task solving even without explicit thinking" [vendor] | **IFEval-Instr 88.0 / IFEval-Prompt 82.8 reasoning-OFF**; 92.0/87.9 reasoning-on; IFBench 43–44; BFCL v3 61.1 [vendor card] | **Q4_K_M 2.84 GB official GGUF** (nvidia/NVIDIA-Nemotron-3-Nano-4B-GGUF) | Mamba2 hybrid (42 layers, only 4 attention), 262K ctx; vendor measured lowest TTFT + peak VRAM in class on **RTX 4070 + llama.cpp Q4_K_M** [vendor]; NVIDIA open-model license (not Apache); Lane B flags Nemotron template fragility outside NVIDIA runtimes | <https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-4B-BF16> · <https://huggingface.co/blog/nvidia/nemotron-3-nano-4b> |
| **Ministral 3 3B Instruct 2512** (Mistral) | 2025-12 (2512) | **Non-reasoning by design** — family splits Instruct (direct) vs separate Reasoning checkpoint; no think mode in the Instruct model [card] | IFEval not on vendor card; IFEval 73.1 in PrismML's H100 EvalScope table [vendor-of-PrismML, secondary]; WildBench 56.8, "native function calling + JSON" [vendor] | **Q4_K_M 2.15 GB official** (mistralai/Ministral-3-3B-Instruct-2512-GGUF); FP8 fits 8 GB | 3.4B LM + 0.4B vision (skip mmproj), 256K ctx, Apache 2.0, temp ≤0.1 recommended — matches verifier temp 0 | <https://huggingface.co/mistralai/Ministral-3-3B-Instruct-2512> |
| **Qwen3.5 small members** (0.8B / 2B / 4B) | 2026-02/03 | Hybrid thinking family; GGUF chat template defaults **thinking OFF** unless `enable_thinking:true` (verified template text in GGUF metadata); under LM Studio the applied template may re-enable thinking — the repo already observed qwen3.5-4b reasoning 1.9K–9K chars there, so runtime template must be controlled (llama-server `--jinja` + `chat_template_kwargs`, see §5) | Qwen3.5-4B: IFEval 89.8, IFBench 59.2 [vendor card, mode as printed]; Qwen3.5-2B: IFEval 61.2 non-think / 78.6 think; Qwen3.5-0.8B: 52.1 non-think / 44.0 think [vendor card] | Q4_K_M: 0.8B **0.53 GB**, 2B **1.28 GB**, 4B **2.74 GB** (unsloth GGUF, sizes verified via HF API) | Gated DeltaNet hybrid (tiny KV), 262K ctx, Apache 2.0; prior bench: 4B safe but over-cautious on this corpus | <https://huggingface.co/Qwen/Qwen3.5-4B> · <https://huggingface.co/Qwen/Qwen3.5-2B> · <https://huggingface.co/Qwen/Qwen3.5-0.8B> |
| **Gemma 4 E2B** (Google DeepMind) | 2026 Q1–Q2 | "Configurable thinking modes"; card documents **`enable_thinking=False`** in `apply_chat_template` [vendor] | **IFEval 94.6, IFBench 38.0** (tech-report table; thinking-mode column not labeled — treat as vendor-reported) [vendor] | **official QAT Q4_0 GGUF 3.35 GB** (google/gemma-4-E2B-it-qat-q4_0-gguf, +0.99 GB mmproj optional) | 2.3B **effective** params (5.1B total; Per-Layer Embeddings are lookup-only → prefill/decode compute ≈2.3B), 128K ctx, sliding-window hybrid attention (tiny KV), Apache 2.0 | <https://huggingface.co/google/gemma-4-E2B-it> · <https://arxiv.org/abs/2607.02770> |
| **Granite-4.0-H-Tiny** (IBM) | 2025-10-02 | **No thinking mode** — direct instruct model (Mamba2-hybrid MoE) [card] | IFEval-Instruct-strict **84.78**, prompt-strict 78.1, avg 81.44 [vendor card] | Q4 ≈ **4.3 GB** (Lane A verified; 7B total / **1B active**, fits fully in 8 GB) | Tool-calling trained ("fast execution of key tasks such as function calling" [vendor]); Apache 2.0; BFCL v4 snapshot only has 350m sibling (18.98%) — Tiny's tool scores are vendor-run | <https://huggingface.co/ibm-granite/granite-4.0-h-tiny> |
| **Nanbeige4.2-3B** | 2026-07 | Thinking default; **`enable_thinking=False` documented** (also `preserve_thinking`) [card] | IF-Bench 54.6, Agent-IF-Oneday 67.5; IFEval not reported; SWE-bench Verified 63.6 [vendor card] | Q4_K_M **2.57 GB** (community gkraker04 GGUF, verified via HF API) | **Looped Transformer** (layer reuse) — compute-per-token is loop-count-dependent, latency estimate uncertain; needs **vendor llama.cpp fork branch `nanbeige42`** + trust_remote_code; Apache 2.0 | <https://huggingface.co/Nanbeige/Nanbeige4.2-3B> |
| **Falcon-H1R-7B** (TII) | 2026-01 | **Reasoning-specialized, always-on `<think>`**; no documented off switch in card (think block is the model's whole design) | IFBench 53.4; IFEval not reported (gap) [card/blog] | Q4_K_M **4.60 GB** (unsloth GGUF, verified) | Hybrid Transformer+Mamba2, fits 8 GB; Falcon-LLM license (non-Apache); **poor fit**: same thinking-budget failure class as Bonsai/LFM2.5-2.6B | <https://huggingface.co/tiiuae/Falcon-H1R-7B> · <https://falcon-lm.github.io/blog/falcon-h1r-7b> |
| **LFM2.5-1.2B-Instruct** (Liquid AI) — shortlist update | 2025-11/12 (LFM2.5) | **Direct-answer Instruct checkpoint** (Thinking is a separate 1.2B model) [card] | **IFEval 86.23** (avg strict/loose, prompt+instruction), IFBench 47.33, BFCLv3 49.12 [vendor card] — strongest published sub-2B IF number found | official GGUF repo (LiquidAI/LFM2.5-1.2B-Instruct-GGUF); <1 GB at Q4 | 16 layers (10 conv + 6 GQA), 32K ctx, llama.cpp day-one support; vendor recommends it for "agentic tasks, data extraction" but NOT knowledge-heavy tasks; license "lfm1.0" (other) | <https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct> |

Not pursued: **Qwen3.5-0.8B** (IFEval 52.1 non-thinking — weakest IF of the set; keep only as a <1 s tie-breaker option); **SmolLM3-3B** (unchanged since prior shortlist, no new IF evidence found this pass).

---

## 3. Fine-tuned-classifier route: bidirectional encoders

### 3.1 What shipped in 2026 that is relevant

| Model | Params | Context | Task fit | Runtime | Source |
|---|---|---|---|---|---|
| **LiquidAI LFM2.5-Encoder-350M / 230M** | 350M / 230M | **8,192 tokens** (exactly the verifier budget) | Bidirectional LFM2 hybrid encoders, masked-LM pre-trained, "classifiers, intent routers, and safety filters are all built on encoders" — 350M ranks 4th/14 on 17 GLUE/SuperGLUE/classification tasks; 230M beats ModernBERT-base [vendor] | transformers (trust_remote_code), ONNX export; fine-tune tutorial for classification (Liquid4All/cookbook) | <https://www.liquid.ai/blog/lfm2-5-encoders> · <https://huggingface.co/LiquidAI/LFM2.5-Encoder-350M> |
| **LiquidAI LFM2.5-Encoder-350M-Prompt-Router** | 350M | 8K | Fine-tune with a **zero-shot routing head**: `model.route(prompt, lanes)` scores a prompt against free-text lanes in one pass — lanes could literally be "the assistant intends the harness to execute this now" / "this is documentation, not execution" / "unclear" | transformers only | <https://huggingface.co/LiquidAI/LFM2.5-Encoder-350M-Prompt-Router> |
| LiquidAI LFM2.5-Encoder-350M-Policy-Linter / PII-Detector | 350M | 8K | Same family; evidence that task fine-tunes on policy-style data work | transformers | <https://huggingface.co/LiquidAI/LFM2.5-Encoder-350M-Policy-Linter> |
| **ModernBERT base / large** (answerdotai) | 149M / 395M | 8,192 | The incumbent bidirectional encoder; 3-class head is a standard fine-tune | **llama.cpp since b8100** (see 3.2), ONNX, transformers | <https://github.com/answerdotai/ModernBERT> |
| DeBERTa-v3 NLI encoders (microsoft/DeBERTa-v3-*) | 86M–435M | 512 (too short for 8K planner text without truncation) | Zero-shot 3-way via NLI entailment framing — but 512-token ceiling is a hard mismatch with the 8K contract | ONNX/transformers | <https://huggingface.co/microsoft/deberta-v3-large> |

### 3.2 Can encoders run via llama.cpp / Ollama / LM Studio (status 2026-08)?

- **llama.cpp: yes for ModernBERT/BERT-class embeddings, partially.** Full ModernBERT support (HF→GGUF conversion + inference) merged in **b8100 ("full modern bert support", PR #18330, Dec 2025–Feb 2026)** on top of granite-embd support (#15641) [primary: llama.cpp CHANGELOG/PR]. Runs via `llama-embedding` / `llama-server --embed` with `--pooling mean|last`, and `--pooling rank` reproduces reranker heads (verified cosine ≥0.997 vs HF in the PR). **But there is no arbitrary classification-head support**: a 3-way classifier needs either (a) embeddings out of llama.cpp + a small external head (logistic/MLP, trivial in Bun/Node), or (b) ONNX/transformers for the whole model.
- **LFM2.5-Encoders in llama.cpp: no.** llama.cpp supports causal LFM2; the bidirectional variants are `custom_code` transformers models with non-causal convs/attention — no GGUF path published as of 2026-08 [primary: HF cards; absence on llama.cpp]. Use transformers (CPU is their advertised path) or ONNX.
- **Ollama: no** — supports a fixed list of embedding models only (ollama.com/blog/embedding-models); no ModernBERT/classification models as of 2026-08 [primary].
- **LM Studio: no** meaningful encoder/classifier support (GGUF generative models + limited embeddings only) [community-reported; consistent with Lane C findings].

### 3.3 What it would take for this project

1. **Corpus:** 28 dev + 32 held-out frozen cases + policy versioning. That is far too small to train a classifier from scratch, but fine for (a) **zero-shot** (Prompt-Router lanes, or NLI-style scoring) or (b) fine-tuning a pre-trained encoder with augmentation. Realistic recipe: take the 28 dev cases + their near-pair transformations (the held-out construction shows 8 phenomena × wording variants — synthetically generate ~500–2,000 paraphrases with a larger model, as the corpus generator already did for near-pairs), keep the 32 held-out untouched, validate split with `validate-split.mjs` semantics.
2. **Effort:** ModernBERT-base or LFM2.5-Encoder-350M + 3-class head, full fine-tune on the desktop (Ryzen 9 7900X + RX 9070 XT or the 5060 local machine): hours of work including data augmentation; encoder fine-tunes at this scale converge in minutes-to-an-hour of GPU time [estimate; cf. HN report of ModernBERT winning a Qwen3-0.6B-vs-ModernBERT classification bake-off <https://news.ycombinator.com/item?id=48623434>].
3. **Expected latency:** one forward pass, no autoregression. GPU (RTX 5060) at 4–8K tokens: **~0.05–0.3 s** [estimate: 2×0.35B×8K ≈ 6 GFLOP + attention, on a ~125 TFLOPS-class fp16 card]. Liquid's own CPU numbers show why GPU matters: at 8,192 tokens **ModernBERT-base >90 s vs LFM2.5-Encoder-230M ~28 s per pass on CPU** [vendor-measured CPU] — CPU-only is not viable at full context; GPU or ≤1K inputs only.
4. **Risk:** the verifier is the safety authority under 8H. A 60-case-trained encoder is an interpolator — it will be confidently wrong on shapes outside the corpus (the 9H positive-evidence override was rejected exactly because of unresolved shapes like `execution_intent-010`). Any encoder deployment must keep the fail-closed arbitration (encoder replaces Bonsai as the "verifier" only after passing held-out with 0 unsafe FP), and arguably should emit calibrated confidence so UNCERTAIN abstention stays meaningful.

**Bottom line:** encoders are the lowest-latency option (~100 ms) and llama.cpp can now host ModernBERT embeddings (b8100), but the classification head and/or the best encoder (LFM2.5-Encoder) need a second runtime (ONNX/transformers sidecar), a data-augmentation step, and a policy conversation about whether a non-LLM classifier may authorize EXECUTE under the frozen 8H wording ("only the verifier may authorize execution" — the verifier is currently pinned as Bonsai + p4-minimal in ticket 04's disposition).

---

## 4. Bonsai-family alternatives (PrismML)

Family state as of 2026-08 (all Apache 2.0; HF repos verified via API):

| Variant | Params | Disk | Context | IFEval / IF evidence | Throughput anchors |
|---|---|---|---|---|---|
| Bonsai-1.7B (1-bit Q1_0) | 1.7 B | **0.25 GB** | 16K native | none published | docs: smallest, for tightest budgets [vendor] |
| Bonsai-4B (1-bit / ternary) | ~4 B | **0.57 GB / 1.07 GB** | 32K (8K native) | Ternary 4B: IFEval **72.1**, BFCLv3 67.8; 1-bit 4B: IFEval 69.6 [vendor tables in Ternary-4B card] | M4 Pro Metal: PP512 826 / TG128 120 (4B ternary) [vendor] |
| Bonsai-8B (1-bit / ternary) | 8.2 B | **1.16 GB / 2.18 GB** | 65K | Ternary 8B: IFEval **81.8**, BFCL 73.9 (beats FP16 Qwen3-8B's 81.5 IFEval in PrismML's table); 1-bit 8B: IFEval 79.8 [vendor] | docs: "up to 368 tok/s" on local machines [vendor]; Q1_0 runs on **upstream** llama.cpp (Q1_0 merged upstream; only ternary Q2_0 needs the Prism fork) [primary: docs.prismml.com] |
| Bonsai-27B (1-bit / ternary) | 27.3 B | 3.9 GB / 5.9 GB | 262K | 1-bit: IFEval **79.11** thinking-mode (vs 88.91 FP16) [vendor card] | RTX 5090: 163 t/s 1-bit; DSpark drafter 1.37× decode on CUDA [vendor] |

**Thinking control (verified from the GGUF chat template in `prism-ml/Bonsai-27B-gguf` metadata):** thinking is **ON by default** (`<|im_start|>assistant\n<think>\n` at the generation prompt) with an explicit escape hatch — `enable_thinking is false` makes the template pre-fill a closed `<think>\n\n</think>` block, i.e. direct-answer mode. Mechanism on the project's stack: llama-server `--jinja` + per-request `chat_template_kwargs: {"enable_thinking": false}` (the njannasch 5060-Ti benchmark uses exactly this with Qwen3.6); LM Studio exposes the equivalent template kwarg. The ticket's "`thinking_budget_tokens:0`" phrasing maps to this template switch — no separate budget parameter was found in PrismML docs or the fork; the template kwarg is the evidenced mechanism. Note: Bonsai's published IFEval (79.11) is a **thinking-mode** number; direct-answer quality is unmeasured by PrismML — and the repo's own history shows thinking-off behavior must be validated per-runtime (qwen3.5-4b's template handling changed behavior under LM Studio).

**KV4 mode (the ticket's other question):** `BONSAI_KV4=1` (= `--cache-type-k q4_0 --cache-type-v q4_0`) stores KV in Q4_0, cutting KV memory ~3.5× (64→18 KiB/token on the 27B). PrismML's own docs are explicit: "**A memory tool, not a speed tool: decode is slightly slower** than the default FP16 KV cache." At 8K context on 8 GB, memory is not the bottleneck for Bonsai — **KV4 buys nothing for verifier latency** [primary: Bonsai-demo KV-CACHE.md].

**DSpark drafter:** speculative-decoding drafter bundled with Bonsai-27B (1.79 GB Q4_1), **1.37× decode** on CUDA (H100, τ≈3.6) [vendor]. Decode-only — it does not touch prefill, and it would shave a thinking-on Bonsai verdict from ~25 s to ~18 s [derived]. Irrelevant to a direct-answer replacement; marginal even for thinking-on Bonsai.

**Verdict on staying in-family:** the latency-optimal Bonsai move is **Bonsai-8B (1-bit, 1.16 GB, upstream llama.cpp compatible) or Ternary-Bonsai-8B (2.18 GB, Prism fork)** with thinking off: ≈ **0.8–1.5 s @ 2–4K input** [derived §1.3], keeping the same vendor and threat model as today. Bonsai-27B with thinking off lands at ~2.5–4 s @ 2K [derived] — it *can* beat the 3 s bar at short inputs, but it cannot beat a 4B direct model (~0.5–1 s) on latency, and its direct-answer safety on this task is unmeasured. The 27B's only remaining advantages (vision, 262K context, reasoning depth) are not used by the frozen single-token contract.

---

## 5. Recommendation table

Latency column = median verdict estimate on local machine RTX 5060 8 GB at 2K-token input (typical), derived per §1 unless marked measured. **Safety status for every row except the first two legacy entries: needs the frozen 28 dev + 32 held-out corpus run (bench-local.mjs / run-heldout.mjs) before any production claim — no candidate below has been safety-evaluated on this project's corpus.**

| # | Candidate | Est. median latency @2K (RTX 5060-8GB) | Safety-evidence status | Integration effort |
|---|---|---|---|---|
| 1 | **Bonsai-27B-Q1 (current, thinking on)** | **24.7 s** [measured] | Passed held-out: 0 unsafe FP, selAcc 0.969 [measured] | baseline |
| 2 | qwythos-9b (prior shortlist) | ~1.5–2.5 s thinking-on (was run thinking) | Dev corpus: 0 unsafe FP, selAcc 0.808, stability 1.0 [measured]; held-out not run | env-var swap |
| 3 | **Nemotron-3-Nano-4B, reasoning-off** | **~0.5–0.9 s** [derived] | needs frozen-corpus run; vendor IFEval-off 88 | **env-var swap** (official Q4_K_M GGUF, stock llama.cpp, chat_template_kwargs); license check (NVIDIA open-model license) |
| 4 | **Ministral 3 3B Instruct 2512** | **~0.5–0.8 s** [derived] | needs frozen-corpus run; no thinking mode by construction | env-var swap (official Q4_K_M GGUF, Apache 2.0) |
| 5 | **Gemma 4 E2B, enable_thinking=False** | **~0.4–0.8 s** [derived] | needs frozen-corpus run; vendor IFEval 94.6 | env-var swap (official QAT Q4_0 GGUF); verify llama.cpp gemma4 thinking-kwarg path |
| 6 | **Qwen3.5-4B, thinking off** | ~0.6–1.0 s [derived] | prior dev run safe but over-cautious (exe recall 0.167) [measured]; retry with thinking explicitly off + recalibrated prompt | env-var swap (GGUF verified) |
| 7 | **LFM2.5-1.2B-Instruct** | **~0.4–0.7 s** [derived] | needs frozen-corpus run; vendor IFEval 86.23 | env-var swap (official GGUF, <1 GB); license "lfm1.0" |
| 8 | Granite-4.0-H-Tiny | ~0.6–1.2 s [derived] | needs frozen-corpus run; vendor IFEval 84.8 | env-var swap; MoE 1B-active, 4.3 GB Q4 |
| 9 | Ternary-Bonsai-8B (or Bonsai-8B Q1), thinking off | ~0.9–1.5 s [derived] | needs frozen-corpus run; vendor IFEval 81.8 (ternary) | near env-var swap: ternary needs Prism fork build (Windows CUDA binaries published; project likely already has the fork for 27B-Q1); 1-bit variant runs on stock llama.cpp |
| 10 | Qwen3.5-2B / 0.8B | ~0.4–0.7 s [derived] | needs frozen-corpus run; IFEval 61.2/52.1 (weak) — fallback tier only | env-var swap |
| 11 | Bonsai-27B-Q1 **thinking off** | ~2.5–4 s [derived] | needs frozen-corpus run (direct-answer Bonsai untested anywhere) | config change only (template kwarg) — cheapest experiment available |
| 12 | Nanbeige4.2-3B, enable_thinking=False | ~0.6–1.0 s [derived, loop-count uncertainty] | needs frozen-corpus run | **runtime work**: vendor llama.cpp fork branch + custom chat template |
| 13 | Falcon-H1R-7B | ~1.2 s prefill + unbounded thinking decode | **not recommended** — no documented thinking-off; same failure class as today | runtime work; skip |
| 14 | **Encoder route** (ModernBERT-base/large via llama.cpp b8100 embeddings + head, or LFM2.5-Encoder-350M(-Prompt-Router) via ONNX/transformers sidecar) | **~0.05–0.3 s** [estimate] | needs frozen-corpus run + augmentation pipeline; 8H policy ruling needed (non-LLM verifier authorizing EXECUTE) | **runtime work**: second runtime (ONNX sidecar or llama-embedding + head), fine-tune effort (§3.3), cache/DRIFT-guard reuse mostly unchanged |

### Sequencing suggestion (cheap → expensive)

1. **Same-day, zero-risk experiments:** (a) Bonsai-27B + `enable_thinking:false` template kwarg through the existing harness (row 11) — quantifies how much of the 24.7 s is thinking; (b) Ministral-3-3B-Instruct or Nemotron-3-Nano-4B env-var swap on the dev corpus (rows 3–4) — both are direct-answer by construction with official GGUFs.
2. **Week-1 shortlist:** the row 3–7 models through `run-heldout.mjs` (32 held-out, 16 near-pairs) — the gate is 0 unsafe FP first, then selAcc ≥0.95 parity with Bonsai, then measured median latency.
3. **Strategic:** encoder route (row 14) only if sub-0.5 s becomes a hard requirement or the 8H policy is amended to admit non-LLM verifiers — it is a fine-tune + second-runtime project, not a swap.

---

## 6. Honest gaps

1. No sub-3 s figure in this note is measured on the project local machine; §1.3 scales measured 7B anchors by parameter count (±50%). A 30-minute `llama-bench -p 512,2048,4096` pass per finalist would replace every estimate.
2. Gemma 4 E2B IFEval 94.6 is from the tech-report table whose thinking-mode column is unlabeled; IFBench for all E2B/E4B is weak (38/44) — strict-format adherence deserves a frozen-corpus check.
3. Bonsai direct-answer (thinking-off) quality is unmeasured by anyone — PrismML benchmarks everything in thinking mode.
4. Nanbeige4.2-3B effective FLOPs/token (Looped Transformer loop count) not extracted from the tech report (arXiv 2607.22083); latency row has extra uncertainty.
5. Falcon-H1R-7B IFEval not published in card/blog (IFBench 53.4 only).
6. LFM2.5-Encoder-350M has no GGUF/llama.cpp path (verified absence); ONNX export feasibility for the bidirectional LFM2 conv blocks not tested here.
7. Ollama remains unusable for this lane (no tool_choice, no encoders, no thinking kwargs — Lane C/B findings), included only to rule it out.

---

## Sources

Primary / vendor (model cards & docs, fetched 2026-08-09 via HF API):
- <https://huggingface.co/prism-ml/Bonsai-27B-gguf> (1-bit card: sizes, PP512/TG128, DSpark, IFEval 79.11; GGUF metadata chat template with `enable_thinking` switch) · <https://huggingface.co/prism-ml/Ternary-Bonsai-27B-gguf>
- <https://docs.prismml.com/models/bonsai-8b.md> · <https://docs.prismml.com/models/bonsai-4b.md> · <https://docs.prismml.com/models/bonsai-1-7b.md> · <https://docs.prismml.com/run/llamacpp.md> (Q1_0 upstream vs Q2_0 fork; Windows CUDA binaries) · <https://docs.prismml.com/llms.txt>
- <https://raw.githubusercontent.com/PrismML-Eng/Bonsai-demo/main/KV-CACHE.md> (BONSAI_KV4 semantics: memory, not speed)
- <https://prismml.com/news/bonsai-27b> (family announcement, RTX 5090 163 t/s)
- <https://huggingface.co/prism-ml/Ternary-Bonsai-8B-gguf> (IFEval 81.8, M4 Pro PP512 455/TG 76) · <https://huggingface.co/prism-ml/Ternary-Bonsai-4B-gguf> (IFEval 72.1, PP512 826)
- <https://huggingface.co/Qwen/Qwen3.5-4B> (IFEval 89.8, BFCL-V4 50.3, template `enable_thinking`) · <https://huggingface.co/Qwen/Qwen3.5-2B> (IFEval 61.2/78.6 split, Qwen3.5-0.8B columns) · <https://huggingface.co/Qwen/Qwen3.5-0.8B>
- GGUF sizes verified via HF tree API: <https://huggingface.co/unsloth/Qwen3.5-4B-GGUF> · <https://huggingface.co/unsloth/Qwen3.5-2B-GGUF> · <https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF> · <https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-4B-GGUF> · <https://huggingface.co/mistralai/Ministral-3-3B-Instruct-2512-GGUF> · <https://huggingface.co/google/gemma-4-E2B-it-qat-q4_0-gguf> · <https://huggingface.co/unsloth/Falcon-H1R-7B-GGUF> · <https://huggingface.co/gkraker04/Nanbeige4.2-3B-GGUF>
- <https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-4B-BF16> (IFEval reasoning-off/on tables, enable_thinking, RTX 4070 efficiency claims) · <https://huggingface.co/blog/nvidia/nemotron-3-nano-4b>
- <https://huggingface.co/mistralai/Ministral-3-3B-Instruct-2512> (non-reasoning Instruct vs Reasoning split, FP8/8 GB)
- <https://huggingface.co/google/gemma-4-E2B-it> (configurable thinking, enable_thinking=False snippet, PLE/effective params) · <https://arxiv.org/abs/2607.02770> (Gemma 4 tech report; IFEval table incl. E2B 94.6: <https://arxiv.org/html/2607.02770v1>)
- <https://huggingface.co/ibm-granite/granite-4.0-h-tiny> (IFEval 84.78 instruct-strict; tool-calling focus)
- <https://huggingface.co/Nanbeige/Nanbeige4.2-3B> (enable_thinking/preserve_thinking, SWE-bench V 63.6, llama.cpp fork branch `nanbeige42`) · arXiv:2607.22083
- <https://huggingface.co/tiiuae/Falcon-H1R-7B> + <https://falcon-lm.github.io/blog/falcon-h1r-7b> (IFBench 53.4, thinking-only design)
- <https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct> (IFEval 86.23, GGUF/ONNX/MLX formats)
- <https://www.liquid.ai/blog/lfm2-5-encoders> (LFM2.5-Encoder-230M/350M: 8K ctx, CPU/GPU inference charts, ModernBERT comparison) · <https://huggingface.co/LiquidAI/LFM2.5-Encoder-350M-Prompt-Router> · <https://huggingface.co/LiquidAI/LFM2.5-Encoder-350M-Policy-Linter>
- <https://github.com/ggml-org/llama.cpp/pull/18330> ("full modern bert support", merged; llama.cpp CHANGELOG b8100) · <https://github.com/ggml-org/llama.cpp/pull/15641> (granite-embd)

Community-reported (latency anchors):
- <https://github.com/ggml-org/llama.cpp/discussions/15013> (CUDA scoreboard: RTX 5060 Ti / 4060 Ti / 5070 pp512+tg128 for Llama-2-7B Q4_0; RTX 5060 desktop row by odbguru, 2026-06-19, build 3a3edc9/b9715, CUDA 13.3)
- <https://njannasch.dev/blog/qwen-3-6-turboquant-local-inference/> (RTX 5060 Ti 16 GB: Qwen3.6-35B-A3B prefill 1,261–1,585 t/s, KV-type effects; `chat_template_kwargs: {enable_thinking: false}` with llama-server)
- <https://ollama.com/blog/embedding-models> (Ollama embedding support scope)
- <https://news.ycombinator.com/item?id=48623434> (ModernBERT vs Qwen3-0.6B classification fine-tune anecdote)

Repo-internal (measured baseline):
- `.scratch/execution-intent-verifier/issues/03-held-out-eval.md` (24.7 s median / 35.9 s p95, selAcc 0.969, 0 unsafe FP, n=32)
- `.scratch/execution-intent-verifier/issues/04-latency-engineering.md` (cache-reuse rejection, pipelining impossibility, Bonsai+p4-minimal pin)
- `experiments/tool-decision/execution-intent/results/` (reasoning_chars 1.2K–8.7K per verdict; calibration-bonsai.json ms traces)
- `docs/research/notes/lane-a-8gb-model-fit.md` · `lane-b-tool-use-architectures.md` · `lane-c-blackwell-runtimes.md` (8 GB fit, BFCL v4, runtime support matrix; Granite-4.0-H-Tiny 4.3 GB Q4)
