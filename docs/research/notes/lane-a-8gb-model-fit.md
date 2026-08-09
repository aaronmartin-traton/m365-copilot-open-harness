# Lane A — Open-weight LLM fit on an 8 GB NVIDIA RTX 50-series GPU (Blackwell, sm_120)

- **Research date:** 2026-08-09 (all "current" claims are as of this date; the local-model landscape moved fast in H1 2026)
- **Target hardware:** GeForce RTX 50-series with 8 GB VRAM (e.g. RTX 5060 8 GB: 3,840 CUDA cores, 8 GB GDDR7, 128-bit, **448 GB/s** bandwidth, 145 W, compute capability **sm_120**, CUDA 12.8+ required) — specs: TechPowerUp <https://www.techpowerup.com/gpu-specs/geforce-rtx-5060.c4219>, NVIDIA launch guide <https://www.nvidia.com/en-sg/geforce/news/ultimate-guide-to-5060/>
- **Scope:** which open-weight models fit, in which quantization, with how much usable context, for agentic multi-turn tool use. Community-reported figures are labeled; formulas are labeled "computed".

> Note on freshness: by mid-2026 the relevant new model generations are **Qwen3.5** (hybrid Gated-DeltaNet + attention, multimodal, Apache 2.0; sizes 0.8B/2B/4B/9B/27B dense + 35B-A3B/122B-A10B/397B-A17B MoE) and **Qwen3.6** (27B dense, 35B-A3B MoE), plus **Gemma 4** (E2B/E4B/12B/26B-A4B/31B) and **LFM2.5**. The older 2025 lineup (Qwen3, Llama 3.1, Phi-4-mini, Gemma 3, Ministral 3, Granite 4.0, Nemotron Nano, LFM2) remains fully relevant at 8 GB because it is mature in every runtime.

---

## 1. VRAM budget math

### 1.1 The budget equation

```
VRAM_total = Weights + KV_cache + Runtime_overhead
```

On an 8 GB card (8,192 MiB nominal):

| Component | Size | Source |
|---|---|---|
| Usable VRAM after CUDA context / display | ~7.6–7.85 GiB | measured 7,842 MiB usable on an 8 GB RTX 3070 — localllm.in benchmark <https://localllm.in/blog/best-local-llms-8gb-vram-2025>; CUDA baseline ~200 MiB |
| Runtime/compute buffers (llama.cpp) | 0.5–1.5 GiB | measured 500–1,500 MiB variable compute buffer — localllm.in (same URL); willitrunai.com budgets ~1–3 GB incl. overhead |
| **Practical budget for weights + KV** | **~6.5–7.0 GiB** | computed from the two rows above |

Decode speed on this class is memory-bandwidth-bound: tokens/s ≈ bandwidth ÷ bytes-read-per-token. At 448 GB/s an 8B model at Q4_K_M (~5 GB weights) has a theoretical ceiling of ~80–90 t/s; observed 20–58 t/s depending on runtime and quant (community-reported: 20–35 t/s for 7–8B via Ollama on RTX 5060 — compute-market.com <https://www.compute-market.com/blog/rtx-5060-local-ai-review-2026>; 54–58 t/s for Qwen3.5-9B Q4_K_M on RTX 3070 via llama.cpp — localllm.in).

### 1.2 KV cache per token

KV bytes/token (fp16) = `2 (K+V) × attn_layers × kv_heads × head_dim × 2 bytes`. Values below are **computed from the published `config.json`** of each model (fetched 2026-08-09) unless noted:

| Model | Attention shape | KV fp16 / token | Notes |
|---|---|---|---|
| Qwen3-4B / Qwen3-8B | 36 layers, 8 KV heads, head_dim 128 | **144 KiB** | full-attention; 32K ctx ≈ 4.6 GB fp16 KV — config: <https://huggingface.co/Qwen/Qwen3-8B>, <https://huggingface.co/Qwen/Qwen3-4B> |
| Llama-3.1-8B | 32 layers, 8 KV heads, head_dim 128 | **128 KiB** | <https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct> (gated; arch values per Meta's model card) |
| Phi-4-mini | 32 layers, 8 KV heads, head_dim 128 | **128 KiB** | config fetched from HF |
| Ministral 3 3B | 26 layers, 8 KV heads, head_dim 128 | **104 KiB** | config fetched from HF |
| Gemma 3 4B | 34 layers but sliding-window: 6 global layers (4 KV heads, head_dim 256), 28 local layers capped at 1,024 tokens | **24 KiB + ~117 MiB fixed** | config fetched from HF mirror (unsloth/gemma-3-4b-it); sliding_window=1024, pattern=6 |
| Gemma 3 12B | 48 layers; 8 global (8 KV heads, head_dim 256), 40 local @1,024 | **64 KiB + ~328 MiB fixed** | config fetched from HF mirror (unsloth/gemma-3-12b-it) |
| Qwen3-30B-A3B (MoE) | 48 layers, 4 KV heads, head_dim 128 | **96 KiB** | config fetched from HF |
| gpt-oss-20b (MoE) | 24 layers, alternating sliding(128)/full; 12 full layers, 8 KV heads, head_dim 64 | **~26 KiB** (24 KB full-attn + 2 KB sliding) | config fetched from HF — extremely small KV |
| Nemotron-Nano-9B-v2 | 56 layers, Mamba2–transformer hybrid; only a minority are attention layers (8 KV heads, head_dim 128) | **~56 KiB (estimate, ~14 attn layers)** | config fetched from HF; exact attn-layer count not in config |
| Granite-4.0-H-Tiny | 40 layers: 8 attention (4 KV heads, head_dim 128) + 32 Mamba2 | **16 KiB** | config fetched from HF — tiny KV |
| Qwen3.5-9B | 32 layers: 8×(3×Gated-DeltaNet + 1×Gated Attention); 4 KV heads, head_dim 256 on the 8 full-attn layers | **32 KiB** (formula matches measured 1,024 MiB @ 32K) | card <https://huggingface.co/Qwen/Qwen3.5-9B>; measured KV @32K from localllm.in |
| LFM2.5-8B-A1B | 24 layers: 18 double-gated conv + 6 GQA | very small (6 attn layers) | card <https://huggingface.co/LiquidAI/LFM2.5-8B-A1B> |

### 1.3 How many context tokens fit in 8 GB (representative sizes)

Assumes ~0.75 GiB runtime overhead; weight sizes from GGUF file sizes where verified (HF API, fetched 2026-08-09), otherwise formula estimate (`params × bits/8`):

| Model (quant) | Weights | fp16 KV ctx budget | q8_0 KV | q4/iq4 KV |
|---|---|---|---|---|
| Qwen3-4B (Q4_K_M, ~2.5 GB est.) | ~2.5 GB | ~35–36K tok (≈5 GB KV) | ~72K | capped by model max 32K/131K-YaRN |
| Qwen3-8B (Q4_K_M, ~4.8 GB est.) | ~4.8 GB | ~19K tok | ~39K | ~78K |
| Llama-3.1-8B (Q4_K_M, ~4.9 GB) | ~4.9 GB | ~18–20K tok | ~38K | ~76K |
| Phi-4-mini (Q4_K_M, ~2.4 GB est.) | ~2.4 GB | ~38K tok | ~76K | ~128K (full context!) |
| Gemma 3 4B (Q4_K_M, ~2.7 GB est.) | ~2.7 GB | ~full 128K (24 KiB/tok + 117 MiB fixed ≈ 3.2 GB) | — | — |
| Gemma 3 12B (Q4_K_M, 7.30 GB measured) | 7.30 GB | ~2.3K tok | ~4.7K | ~9.5K — TIGHT fit |
| Nemotron Nano 9B v2 (Q4_K_M, 6.53 GB verified) | 6.53 GB | ~8–15K tok (56 KiB/tok est.) | ~20–30K | more |
| Qwen3.5-9B (Q4_K_M, 5.68 GB verified) | 5.68 GB | ~45K tok (32 KiB/tok) | ~90K | ~180K+ — community-measured full-GPU at 32K with 6.96 GB total and 200K+ claimed (localllm.in) |

**KV-cache quantization is the lever that makes 8 GB workable for 32K+ context on 8B-class dense models.** llama.cpp exposes KV types `f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1` (verified via `llama-server --help` output reproduced in the dev.to 8 GB write-up <https://dev.to/upayanghosh/from-oom-to-262k-context-running-qwen3-coder-30b-locally-on-8gb-vram-1ej1>), plus community TurboQuant builds adding `turbo2/3/4` KV types (same source). vLLM's FP8 KV cache reports >99% accuracy retention on MMLU/HellaSwag/GSM8K and enables 32–64K context on 16 GB cards that otherwise couldn't — arXiv consumer-Blackwell study <https://arxiv.org/html/2601.09527v1>. Qwen states the Qwen3.5 series keeps "near-lossless accuracy under 4-bit weight and KV cache quantization" (vendor claim, relayed via localllm.in).

---

## 2. Quantization formats on consumer Blackwell (GeForce RTX 50, sm_120)

| Format | What it is | Runtimes that consume it on RTX 50 GeForce | Notes |
|---|---|---|---|
| **GGUF Q4_K_M / Q5_K_M / Q6_K / Q8_0** | k-quants, CPU+GPU hybrid friendly | **llama.cpp** (all layers), **Ollama**, **LM Studio** | The default local path; works on every GPU. Q4_K_M ≈ 4.5–4.7 bits/weight is the usual quality/size sweet spot |
| **FP8 (E4M3) weights** | 8-bit float, native on Ada/Blackwell tensor cores | **vLLM** (sm_120 needs torch cu128 builds / vLLM ≥0.12 generation; FP8 docs: <https://docs.vllm.ai/en/latest/features/quantization/llm_compressor/fp8/>), **SGLang**, transformers (weight-only). Ollama uses FP8 on some library tags | vLLM sm_120 support matured through 2025 (issue #13306) and is validated on 5060 Ti/5070 Ti/5090 in the arXiv study (vLLM 0.12, CUDA 12.9). Ministral 3 Instruct ships official FP8 checkpoints (<https://huggingface.co/mistralai/Ministral-3-8B-Instruct-2512>) |
| **NVFP4** | 4-bit FP (E2M1) with FP8 per-block + FP32 global scaling; Blackwell-native | **vLLM ≥0.12 on sm_120** (community-verified: <https://www.reddit.com/r/LocalLLaMA/comments/1pe4xm4/vllm_v0120_supports_nvfp4_for_sm120_rtx_50xx_and/>); **llama.cpp** — NVFP4 GGUF type merged 2026-03 (PR #19769), CUDA kernels 2026-03/04 (PRs #20644, #21074, verified via GitHub commit search on ggml-org/llama.cpp); **Ollama** ships `-nvfp4` library tags (e.g. `gemma4:31b-nvfp4` <https://ollama.com/library/gemma4/tags>); **Unsloth Dynamic NVFP4** (<https://unsloth.ai/docs/basics/nvfp4>); TensorRT Model Optimizer exports NVFP4 to TensorRT-LLM/vLLM/SGLang | NVIDIA's format for Blackwell; NVIDIA reports ~2.3× throughput vs weight-only INT4 at equal accuracy (blog <https://developer.nvidia.com/blog/introducing-nvfp4-for-efficient-and-accurate-low-precision-inference/>). Caveat (community-reported): NVFP4 is not always faster than FP8 on sm_120 yet (<https://www.reddit.com/r/Vllm/comments/1uki6f8/nvfp4_still_isnt_faster_than_fp8_on_blackwell/>); TRT-LLM NVFP4 KV cache is SM100-only, not yet on sm_120 consumer (community report, TRT-LLM issue #5018, via <https://ai.gopubby.com/fp4-quantization-nvfp4-blackwell-tutorial-13dfc854ed0c>) |
| **MXFP4** | OCP microscaling 4-bit, portable | **Native format of gpt-oss-20b/120b** (post-trained with MXFP4 MoE weights; runs vLLM/llama.cpp/Ollama/LM Studio — card <https://huggingface.co/openai/gpt-oss-20b>); vLLM & SGLang serve MXFP4 on Blackwell | MXFP4 checkpoints must be re-quantized to NVFP4+CUTLASS layout for some Blackwell kernels (NVIDIA forum <https://forums.developer.nvidia.com/t/custom-fp4-cuda-kernel-129-tflops-on-dgx-spark-with-pre-quantized-weight-cache/361600>) |
| **MXFP8** | 8-bit microscaling | Ollama ships `-mxfp8` tags for Gemma 4 (<https://ollama.com/library/gemma4/tags>) | emerging middle ground |

**Practical takeaway for 8 GB GeForce:** GGUF Q4_K_M–Q6_K via llama.cpp/Ollama/LM Studio is the robust default; NVFP4 is now usable (vLLM ≥0.12, llama.cpp ≥ mid-2026 builds, Ollama tags) and is the most VRAM-efficient accelerated path on this silicon; FP8 is fine for 8B-class weights (8 GB FP8 ≈ just barely doesn't fit with context — use it for 3–4B models or KV cache, not 8B weights).

---

## 3. Dense models that fit fully in 8 GB

Weight sizes marked ✅ were read from actual GGUF/safetensors file sizes via the HF API (2026-08-09); "est." = formula estimate. Context = trained context. Fit assumes ~0.75 GiB overhead and modest (≤8–16K) context unless noted.

| Model | Params | Quant | Size | Max context | Fit in 8 GB? | Source |
|---|---|---|---|---|---|---|
| Qwen3-4B | 4.0B | Q4_K_M | ~2.5 GB est. | 32K native, 131K YaRN | ✅ full, big KV headroom | <https://huggingface.co/Qwen/Qwen3-4B> |
| Qwen3-8B | 8.2B | Q4_K_M | ~4.8 GB est. | 32K native, 131K YaRN | ✅ full at ≤8–16K ctx; KV-quant for 32K+ | <https://huggingface.co/Qwen/Qwen3-8B> |
| Llama-3.1-8B-Instruct | 8.0B | Q4_K_M | ~4.9 GB | 128K | ✅ full at ≤16K ctx; KV-quant beyond | <https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct> |
| Phi-4-mini-instruct | 3.8B | Q4_K_M | ~2.4 GB est. | 128K | ✅ full; full 128K ctx possible with q4 KV | <https://huggingface.co/microsoft/Phi-4-mini-instruct> |
| Gemma 3 4B IT | 4B (+vision) | Q4_K_M / official QAT 4-bit | ~2.7 GB est. | 128K (sliding window ⇒ tiny KV) | ✅ full incl. long context | <https://huggingface.co/google/gemma-3-4b-it> |
| Gemma 3 12B IT | 12B | Q4_K_M | 7.30 GB ✅ (measured by localllm.in) | 128K | ⚠️ TIGHT: only ~2–4K ctx fp16 KV; heavy offload in practice (4.3–8.6 t/s measured, localllm.in) | <https://huggingface.co/google/gemma-3-12b-it> |
| IBM Granite-4.0-Micro | 3B dense | Q4_K_M | ~2 GB est. | 128K | ✅ full | <https://www.ibm.com/granite/docs/models/granite> |
| Ministral 3 3B (Instruct 2512) | 3.4B + 0.4B vision | FP8 (vendor) ~4 GB / Q4_K_M ~2.2 GB est. | — | 256K | ✅ full | <https://huggingface.co/mistralai/Ministral-3-3B-Instruct-2512> |
| Ministral 3 8B (Instruct 2512) | 8.4B + 0.4B vision | FP8 does NOT fit (vendor: "fits in 12 GB VRAM in FP8"); Q4_K_M ~5 GB est. | — | 256K | ✅ full only when quantized to ≤Q4 | <https://huggingface.co/mistralai/Ministral-3-8B-Instruct-2512> |
| Hermes-3-Llama-3.1-8B / DeepHermes-3-8B | 8B | Q4_K_M | ~4.9 GB | 128K | ✅ full | <https://nousresearch.com/releases/> |
| NVIDIA Nemotron-Nano-9B-v2 | ~8.9B (f16 GGUF 17.79 GB ✅) | Q4_K_M 6.53 GB ✅, Q5_K_M 7.07 GB ✅, Q8_0 9.46 GB ✅ | — | 128K, Mamba2-hybrid ⇒ small KV | ✅ full at Q4/Q5 | GGUF: <https://huggingface.co/second-state/NVIDIA-Nemotron-Nano-9B-v2-GGUF>; card: <https://huggingface.co/nvidia/NVIDIA-Nemotron-Nano-9B-v2> |
| LFM2.5-8B-A1B | 8.3B total / 1.5B active (hybrid conv+attn) | Q4_K_M 5.16 GB ✅, Q5_K_M 6.03 GB ✅, Q6_K 6.96 GB ✅, Q8_0 9.01 GB ✅ | — | 128K | ✅ full at Q4–Q6 | <https://huggingface.co/LiquidAI/LFM2.5-8B-A1B-GGUF> |
| **Qwen3.5-4B** (2026, multimodal) | 4B | Q4_K_M ~2.6 GB est. | — | 262K native, ~1M extensible | ✅ full | <https://huggingface.co/Qwen/Qwen3.5-4B> |
| **Qwen3.5-9B** (2026, multimodal) | 9B | Q4_K_M 5.68 GB ✅ | — | 262K native, ~1M extensible | ✅ full; measured full-GPU @32K (6.96 GB peak, 54–58 t/s on RTX 3070) — localllm.in | <https://huggingface.co/Qwen/Qwen3.5-9B>; GGUF sizes <https://huggingface.co/unsloth/Qwen3.5-9B-GGUF> |
| **Gemma 4 E2B / E4B** (2026) | 5.1B / 8B | Q4_K_M, QAT, NVFP4, MXFP8 tags all published | — | 128K, sliding-window hybrid ⇒ small KV | ✅ full | <https://ollama.com/library/gemma4/tags> |
| **GLM-4.6V-Flash** (2026, Zhipu, vision) | ~9B-class | Q4_K_M 6.17 GB ✅ (localllm.in) | — | — | ✅ full ≤16K ctx (58 t/s measured on RTX 3070; spills at 32K) | localllm.in benchmark |

**Hermes-4-14B** (Qwen3-14B-based, Aug 2025, <https://huggingface.co/NousResearch/Hermes-4-14B>) is ~8.5 GB at Q4_K_M → does **not** comfortably fit 8 GB (needs partial offload; expect PCIe-cliff speeds, cf. §4). NousCoder-14B (Jan 2026) likewise. Newer **Nemotron 3 Nano 4B** (compressed from Nano-9B-v2 via Nemotron Elastic, 2026) is another sub-8 GB option: <https://huggingface.co/blog/nvidia/nemotron-3-nano-4b>. TII **Falcon-H1R 7B** (hybrid) appears in the 8 GB intelligence shortlists (localllm.in) but wasn't VRAM-benchmarked there.

---

## 4. MoE models in 8 GB

### 4.1 Which MoE models fit FULLY in 8 GB? (verified)

| Model | Total/active | Quant | Size | Verdict |
|---|---|---|---|---|
| **Granite-4.0-H-Tiny** (IBM, hybrid Mamba2+MoE) | 7B / 1B active | Q4_K_M 4.30 GB ✅, Q8_0 7.39 GB ✅ | ✅ **fits fully even at Q8**, ~16 KiB/tok KV | <https://huggingface.co/bartowski/ibm-granite_granite-4.0-h-tiny-GGUF> |
| **LFM2.5-8B-A1B** (Liquid AI) | 8.3B / 1.5B active | Q4_K_M 5.16 GB ✅, Q5_K_M 6.03 GB ✅ | ✅ **fits fully** | <https://huggingface.co/LiquidAI/LFM2.5-8B-A1B-GGUF> |
| gpt-oss-20b (OpenAI) | 21B / 3.6B active | native MXFP4 ≈ 12.9 GB; GGUF Q4_K_M 11.62 GB ✅ (experts already ~4-bit, so GGUF can't shrink it much) | ❌ does NOT fit fully; OpenAI's own card targets "within 16 GB" | <https://huggingface.co/openai/gpt-oss-20b>, sizes <https://huggingface.co/unsloth/gpt-oss-20b-GGUF> |
| Qwen3-30B-A3B | 30.5B / 3.3B active (128 experts, top-8) | Q4_K_M 18.56 GB ✅ | ❌ offload required | <https://huggingface.co/unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF> |
| Qwen3.5-35B-A3B / Qwen3.6-35B-A3B | ~35B / ~3B active (256 experts, top-8, 262K ctx) | Q4 ≈ 19–20 GB | ❌ offload required | <https://huggingface.co/Qwen/Qwen3.5-35B-A3B>, <https://huggingface.co/Qwen/Qwen3.6-35B-A3B> |

### 4.2 MoE with CPU expert offload (llama.cpp `--cpu-moe` / `--n-cpu-moe N` / `-ot "\.ffn_(up|down|gate)_exps\.=CPU"`)

Semantics (documented in ik_llama.cpp docs <https://ikawrakow-ik_llama-cpp.mintlify.app/inference/hybrid-cpu-gpu> and confirmed in llama.cpp source discussion <https://www.reddit.com/r/LocalLLaMA/comments/1mngl7i/how_does_ncpumoe_and_cpumoe_params_help_over/>): `--cpu-moe` puts ALL routed expert tensors in RAM; `--n-cpu-moe N` keeps the first N layers' experts on CPU and the rest on GPU — tune N downward until VRAM is nearly full for maximum speed. Attention + shared/embedding layers stay on GPU; only ~3B active params of weights are read per token from RAM, so good DDR5 + a modern CPU make this surprisingly fast.

Measured/reported 8 GB-class results:

| Model | Setup | Result | Source & label |
|---|---|---|---|
| Qwen3-Coder-30B-A3B (UD-Q4_K_XL, 17.67 GB ✅) | RTX 3060 Ti 8GB, i5-14600KF, 32 GB RAM, Docker llama.cpp CUDA | `--cpu-moe`: 13.4 t/s gen / 2.8 t/s prompt-eval; `--n-cpu-moe 40` (7.3 GB VRAM): **32.5 t/s gen / 51.6 t/s prompt-eval**; best `--n-cpu-moe 38`: 33.6 t/s gen; then 262K context achieved with TurboQuant KV (`turbo4`/`turbo3`) + flash-attn | community-reported, dev.to write-up <https://dev.to/upayanghosh/from-oom-to-262k-context-running-qwen3-coder-30b-locally-on-8gb-vram-1ej1> |
| Qwen3-30B-A3B & gpt-oss-20b on 8 GB | llama.cpp, 3 quants tested | OP reports usable speeds with MoE CPU offload ("CPU MoE offloading is a godsend"); visible snippet shows one config at **17.61 t/s** generation. (Reddit blocks full retrieval; numbers from search-indexed snippets only.) | community-reported, r/LocalLLaMA "Poor GPU Club" <https://www.reddit.com/r/LocalLLaMA/comments/1nyxmci/poor_gpu_club_8gb_vram_qwen330ba3b_gptoss20b_ts/> |
| gpt-oss-20b | official llama.cpp guide | full fit (16 GB): ~38 t/s; expert-offload to ~12 GB VRAM + 16 GB RAM: ~42 t/s; ~6 GB VRAM + 16 GB RAM also loads with slower speed | llama.cpp discussion #15396 <https://github.com/ggml-org/llama.cpp/discussions/15396> (community guide); DebuggerCafe <https://debuggercafe.com/gpt-oss-inference-with-llama-cpp/> (community-reported); 12 GB/42 t/s datapoint community-reported <https://www.reddit.com/r/LocalLLaMA/comments/1nrnkji/how_much_memory_do_you_need_for_gptoss20b/> |
| gpt-oss-20b on RTX 4060 8 GB | estimate | ~5.7 t/s (Q4_K_M, heavy offload) — worst case when CPU/RAM are weak | estimate, willitrunai.com <https://willitrunai.com/models/gpt-oss-20b> |
| Qwen3.6-35B-A3B on ~6 GB VRAM | llama.cpp expert offload | ~30 t/s claimed | community-reported, <https://mychen76.medium.com/run-qwen3-6-35b-a3b-on-6gb-vram-using-llama-cpp-30-tps-a89032e5a60c> |
| Qwen3-Coder-Next (80B-A3B, Q4_K_M 48.4 GB ✅) | 8 GB VRAM + large RAM | runs with experts on CPU; no 8 GB t/s figure found — expect single-digit-to-low-teens t/s depending on RAM bandwidth | sizes verified <https://huggingface.co/Qwen/Qwen3-Coder-Next-GGUF>; absence of hard 8 GB numbers noted honestly |

**Key caveat:** expert-offload speed is dominated by system RAM bandwidth and CPU. An RTX 5060 system with DDR5-6000 dual-channel will do markedly better than the DDR4 numbers above; PCIe gen matters little because experts are read from RAM, not streamed across PCIe per-layer (unlike dense layer-offload — see §4.3).

### 4.3 What to avoid

Dense (or attention-heavy) models that don't fit → layer-split offload collapses speed: measured 4–11 t/s for 12–14B models on 8 GB, down to 1.8 t/s at 32K (Phi-4 14B) — localllm.in. Even 4 CPU layers cut GLM-4.6V-Flash from 55 → 17.4 t/s. On 8 GB, choose either a fully-fitting model or an MoE with expert offload; never dense layer offload.

---

## 5. Coding-specialist variants at these sizes

| Model | Params/active | Quant | GB | Context | Fit in 8 GB | Source |
|---|---|---|---|---|---|---|
| Qwen2.5-Coder-7B-Instruct | 7.6B dense | Q4_K_M | ~4.7 GB est. | 128K | ✅ full (older but battle-tested tool-calling/FIM model) | <https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct> |
| Qwen3-Coder-30B-A3B-Instruct | 30.5B / 3.3B | UD-Q4_K_XL 17.67 GB ✅ / Q4_K_M 18.56 GB ✅ | — | 256K | ❌ expert-offload only — 30–34 t/s measured on 8 GB (dev.to, community-reported); Unsloth recommends ≥18 GB for 6+ t/s full-GPU Dynamic-4bit (<https://unsloth.ai/docs/models/tutorials/qwen3-coder-how-to-run-locally>) | <https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct> |
| **Qwen3-Coder-Next** (2026) | 80B / ~3B active (512 experts top-10, hybrid GDN attention) | Q4_K_M 48.4 GB ✅; FP8 official variant | — | 256K native, 1M YaRN (vendor) | ❌ deep expert-offload only; vendor claims "Claude-Sonnet-comparable agentic coding" (vendor claim) | <https://huggingface.co/Qwen/Qwen3-Coder-Next>, GGUF sizes verified |
| Qwen3-Coder-480B-A35B | 480B / 35B | — | — | 256K | ❌ not in scope for 8 GB | <https://github.com/QwenLM/Qwen3-Coder> |
| Devstral Small 2507 | 24B dense (Mistral-Small-3.1 base) | Q4_K_M ~14–15 GB | — | 128K | ❌ partial offload only (slow on 8 GB) | <https://huggingface.co/mistralai/Devstral-Small-2507> |
| Devstral 2 Small / Devstral 2 | 24B / 123B dense | 24B fits ~25 GB (vendor guide) | — | 256K | ❌ needs 24 GB-class GPU; 123B needs ~128 GB | <https://mistral.ai/news/devstral-2-vibe-cli/>, <https://unsloth.ai/docs/models/tutorials/devstral-2> |
| NousCoder-14B | 14B (Qwen3-14B base) | Q4_K_M ~8.5 GB est. | — | — | ⚠️ borderline, needs KV trim + slight offload | <https://huggingface.co/NousResearch/NousCoder-14B> |
| Ministral 3 8B (strong generalist coder at small size) | 8.4B | Q4_K_M ~5 GB est. | — | 256K | ✅ full; LiveCodeBench 0.616 (vendor benchmark) | <https://huggingface.co/mistralai/Ministral-3-8B-Instruct-2512> |
| Nemotron-Nano-9B-v2 | ~8.9B hybrid | Q4_K_M 6.53 GB ✅ | — | 128K | ✅ full; NVIDIA positions it for reasoning+code agents | <https://huggingface.co/nvidia/NVIDIA-Nemotron-Nano-9B-v2> |

**Best coding options on 8 GB (synthesis):** fully-in-GPU → Qwen3.5-9B (strongest 2026 small model, agentic scores like BFCL-v4 66.1 / TAU² 79.1 on the vendor card), Qwen3-8B, Ministral 3 8B, Nemotron Nano 9B v2; agentic-coding with CPU experts → Qwen3-Coder-30B-A3B at ~30+ t/s is the standout (community-measured on an RTX 3060 Ti 8 GB), gpt-oss-20b if you can give it ~12 GB (it does not comfortably offload into 8 GB).

---

## 6. Candidate table (consolidated)

| Model | Params/active | Quant | GB | Context | Fit-mode | Source |
|---|---|---|---|---|---|---|
| Qwen3-4B | 4.0B | Q4_K_M | ~2.5 | 32K/131K | FULL | <https://huggingface.co/Qwen/Qwen3-4B> |
| Qwen3-8B | 8.2B | Q4_K_M | ~4.8 | 32K/131K | FULL (KV-quant for long ctx) | <https://huggingface.co/Qwen/Qwen3-8B> |
| Llama-3.1-8B | 8.0B | Q4_K_M | ~4.9 | 128K | FULL | <https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct> |
| Phi-4-mini | 3.8B | Q4_K_M | ~2.4 | 128K | FULL | <https://huggingface.co/microsoft/Phi-4-mini-instruct> |
| Gemma 3 4B | 4B | Q4_K_M/QAT | ~2.7 | 128K | FULL | <https://huggingface.co/google/gemma-3-4b-it> |
| Gemma 3 12B | 12B | Q4_K_M | 7.3 | 128K | TIGHT (~2–9K ctx) | localllm.in |
| Granite-4.0-Micro | 3B | Q4_K_M | ~2 | 128K | FULL | <https://www.ibm.com/granite/docs/models/granite> |
| Granite-4.0-H-Tiny | 7B/1B MoE-hybrid | Q4_K_M 4.3 / Q8 7.4 | ✅ | 128K | FULL (MoE that fits!) | <https://huggingface.co/bartowski/ibm-granite_granite-4.0-h-tiny-GGUF> |
| Ministral 3 3B | 3.4B | FP8 ~4 / Q4 ~2.2 | ✅ | 256K | FULL | <https://huggingface.co/mistralai/Ministral-3-3B-Instruct-2512> |
| Ministral 3 8B | 8.4B | Q4_K_M ~5 (FP8 ✗ 12 GB) | est. | 256K | FULL at Q4 | <https://huggingface.co/mistralai/Ministral-3-8B-Instruct-2512> |
| Hermes-3-8B / DeepHermes-3-8B | 8B | Q4_K_M | ~4.9 | 128K | FULL | <https://nousresearch.com/releases/> |
| Hermes-4-14B | 14B | Q4_K_M | ~8.5 | 32K | LAYER-OFFLOAD (avoid) | <https://huggingface.co/NousResearch/Hermes-4-14B> |
| Nemotron-Nano-9B-v2 | ~8.9B hybrid | Q4_K_M 6.53 / Q5_K_M 7.07 | ✅ | 128K | FULL | <https://huggingface.co/second-state/NVIDIA-Nemotron-Nano-9B-v2-GGUF> |
| LFM2.5-8B-A1B | 8.3B/1.5A | Q4_K_M 5.16 / Q5 6.03 / Q6 6.96 | ✅ | 128K | FULL (MoE that fits!) | <https://huggingface.co/LiquidAI/LFM2.5-8B-A1B-GGUF> |
| Qwen3.5-4B | 4B | Q4_K_M | ~2.6 | 262K/1M | FULL | <https://huggingface.co/Qwen/Qwen3.5-4B> |
| Qwen3.5-9B | 9B | Q4_K_M 5.68 | ✅ | 262K/1M | FULL (best measured 8 GB all-rounder) | <https://huggingface.co/unsloth/Qwen3.5-9B-GGUF> |
| Gemma 4 E2B / E4B | 5.1B / 8B | Q4/QAT/NVFP4 | ~3–5 | 128K | FULL | <https://ollama.com/library/gemma4/tags> |
| GLM-4.6V-Flash | ~9B | Q4_K_M 6.17 | ✅ | — | FULL ≤16K | localllm.in |
| gpt-oss-20b | 21B/3.6B | MXFP4 12.9 / Q4 11.6 | ✅ | 128K | MOE-OFFLOAD (needs ≥12 GB to shine; 8 GB = slow) | <https://huggingface.co/openai/gpt-oss-20b> |
| Qwen3-30B-A3B | 30.5B/3.3B | Q4_K_M 18.6 | ✅ | 256K | MOE-OFFLOAD (~17–33 t/s community) | <https://huggingface.co/unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF> |
| Qwen3-Coder-30B-A3B | 30.5B/3.3B | UD-Q4_K_XL 17.7 | ✅ | 256K | MOE-OFFLOAD (~32 t/s measured on 8 GB) | dev.to (above) |
| Qwen3.6-35B-A3B | ~35B/~3B | Q4 ~19–20 | est. | 262K | MOE-OFFLOAD | <https://huggingface.co/Qwen/Qwen3.6-35B-A3B> |
| Qwen3-Coder-Next | 80B/~3B | Q4_K_M 48.4 | ✅ | 256K/1M | MOE-OFFLOAD (deep; 8 GB figures not found) | <https://huggingface.co/Qwen/Qwen3-Coder-Next-GGUF> |
| Devstral (24B/123B) | dense | Q4 ~14+ | — | 256K | LAYER-OFFLOAD (avoid on 8 GB) | <https://mistral.ai/news/devstral-2-vibe-cli/> |

Fit-mode legend: **FULL** = weights + working KV on GPU with headroom · **TIGHT** = fits only with small context or KV quantization · **MOE-OFFLOAD** = experts in CPU RAM, attention/shared on GPU (llama.cpp `--n-cpu-moe`) · **LAYER-OFFLOAD** = dense partial offload, severe PCIe penalty — avoid.

---

## 7. Findings & honest gaps

1. **The 2026 meta for 8 GB is hybrid architectures.** Qwen3.5 (Gated DeltaNet), Gemma 4 (sliding window), Granite 4.0 / Nemotron Nano (Mamba2), LFM2.5 (conv+attn) all slash KV cache 4–8× vs 2025 dense models — Qwen3.5-9B Q4_K_M runs full-GPU at 32K context in 6.96 GB (measured, localllm.in), which was impossible for Qwen3-8B-class KV.
2. **Two MoE models genuinely fit fully in 8 GB** with room for context: Granite-4.0-H-Tiny (7B/1B, 4.3 GB Q4) and LFM2.5-8B-A1B (8.3B/1.5B, 5.2 GB Q4). gpt-oss-20b does NOT (min ~11.5–12.9 GB).
3. **Expert offload makes 30B-class coding MoE usable on 8 GB**: Qwen3-Coder-30B-A3B at ~32 t/s gen / ~52 t/s prefill with `--n-cpu-moe 40` on an RTX 3060 Ti 8 GB (community-measured). Needs 32 GB+ system RAM and a decent CPU; speed scales with RAM bandwidth.
4. **Quantization-format path on GeForce RTX 50:** GGUF everywhere; FP8 fine via vLLM ≥0.12; NVFP4 now supported by vLLM (sm_120), llama.cpp (CUDA kernels merged Mar–Apr 2026), and Ollama (nvfp4 tags) — but community reports say NVFP4 isn't consistently faster than FP8 on sm_120 yet, and TRT-LLM NVFP4-KV is not on consumer sm_120.
5. **Lanes that found nothing solid:** (a) exact per-model numbers from the Reddit "Poor GPU Club" 8 GB thread — Reddit blocks retrieval, only search-snippet fragment (17.61 t/s) confirmed; (b) 8 GB + Qwen3-Coder-Next t/s figures — none found; (c) NVIDIA-official RTX 5060 LLM benchmarks — none published; closest primary study is the arXiv consumer-Blackwell paper (5060 Ti/5070 Ti/5090 only).

## Sources

Primary (vendor/official):
- <https://huggingface.co/Qwen/Qwen3-8B> · <https://huggingface.co/Qwen/Qwen3-4B> · <https://huggingface.co/Qwen/Qwen3.5-9B> · <https://huggingface.co/Qwen/Qwen3.5-4B> · <https://huggingface.co/Qwen/Qwen3.5-35B-A3B> · <https://huggingface.co/Qwen/Qwen3.6-35B-A3B>
- <https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct> · <https://huggingface.co/microsoft/Phi-4-mini-instruct> · <https://huggingface.co/google/gemma-3-4b-it> · <https://huggingface.co/google/gemma-3-12b-it>
- <https://huggingface.co/mistralai/Ministral-3-8B-Instruct-2512> · <https://huggingface.co/mistralai/Ministral-3-3B-Instruct-2512> · <https://mistral.ai/news/devstral-2-vibe-cli/> · <https://unsloth.ai/docs/models/tutorials/devstral-2> · <https://huggingface.co/mistralai/Devstral-Small-2507>
- <https://www.ibm.com/granite/docs/models/granite> · <https://www.ibm.com/new/announcements/ibm-granite-4-0-hyper-efficient-high-performance-hybrid-models>
- <https://huggingface.co/nvidia/NVIDIA-Nemotron-Nano-9B-v2> · <https://huggingface.co/blog/nvidia/nemotron-3-nano-4b> · <https://developer.nvidia.com/blog/introducing-nvfp4-for-efficient-and-accurate-low-precision-inference/>
- <https://huggingface.co/LiquidAI/LFM2.5-8B-A1B> · <https://arxiv.org/html/2511.23404v1>
- <https://nousresearch.com/releases/> · <https://huggingface.co/NousResearch/Hermes-4-14B> · <https://huggingface.co/NousResearch/NousCoder-14B>
- <https://huggingface.co/openai/gpt-oss-20b> · <https://github.com/QwenLM/Qwen3-Coder> · <https://huggingface.co/Qwen/Qwen3-Coder-Next>
- GGUF size verifications (HF API): <https://huggingface.co/Qwen/Qwen3-Coder-Next-GGUF> · <https://huggingface.co/LiquidAI/LFM2.5-8B-A1B-GGUF> · <https://huggingface.co/unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF> · <https://huggingface.co/unsloth/Qwen3.5-9B-GGUF> · <https://huggingface.co/unsloth/gpt-oss-20b-GGUF> · <https://huggingface.co/bartowski/ibm-granite_granite-4.0-h-tiny-GGUF> · <https://huggingface.co/second-state/NVIDIA-Nemotron-Nano-9B-v2-GGUF>
- Runtimes/hardware: <https://github.com/ggml-org/llama.cpp> (NVFP4 PRs #19769/#20644/#21074, gpt-oss discussion #15396) · <https://ollama.com/library/gemma4/tags> · <https://docs.vllm.ai/en/latest/features/quantization/llm_compressor/fp8/> · <https://github.com/vllm-project/vllm/issues/13306> · <https://www.techpowerup.com/gpu-specs/geforce-rtx-5060.c4219> · <https://www.nvidia.com/en-sg/geforce/news/ultimate-guide-to-5060/>

Studies & community (labeled in text):
- arXiv 2601.09527, "Private LLM Inference on Consumer Blackwell GPUs" <https://arxiv.org/html/2601.09527v1>
- localllm.in 8 GB benchmarks (RTX 3070) <https://localllm.in/blog/best-local-llms-8gb-vram-2025>
- dev.to Qwen3-Coder-30B on 8 GB <https://dev.to/upayanghosh/from-oom-to-262k-context-running-qwen3-coder-30b-locally-on-8gb-vram-1ej1>
- Reddit: Poor GPU Club 8 GB thread <https://www.reddit.com/r/LocalLLaMA/comments/1nyxmci/poor_gpu_club_8gb_vram_qwen330ba3b_gptoss20b_ts/> · --cpu-moe semantics <https://www.reddit.com/r/LocalLLaMA/comments/1mngl7i/how_does_ncpumoe_and_cpumoe_params_help_over/> · gpt-oss memory <https://www.reddit.com/r/LocalLLaMA/comments/1nrnkji/how_much_memory_do_you_need_for_gptoss20b/> · vLLM NVFP4 sm_120 <https://www.reddit.com/r/LocalLLaMA/comments/1pe4xm4/vllm_v0120_supports_nvfp4_for_sm120_rtx_50xx_and/> · NVFP4 vs FP8 <https://www.reddit.com/r/Vllm/comments/1uki6f8/nvfp4_still_isnt_faster_than_fp8_on_blackwell/>
- <https://willitrunai.com/models/gpt-oss-20b> · <https://debuggercafe.com/gpt-oss-inference-with-llama-cpp/> · <https://mychen76.medium.com/run-qwen3-6-35b-a3b-on-6gb-vram-using-llama-cpp-30-tps-a89032e5a60c> · <https://ikawrakow-ik_llama-cpp.mintlify.app/inference/hybrid-cpu-gpu> · <https://www.compute-market.com/blog/rtx-5060-local-ai-review-2026> · <https://unsloth.ai/docs/models/tutorials/qwen3-coder-how-to-run-locally> · <https://unsloth.ai/docs/basics/nvfp4> · <https://unsloth.ai/docs/models/tutorials/ibm-granite-4.0>
