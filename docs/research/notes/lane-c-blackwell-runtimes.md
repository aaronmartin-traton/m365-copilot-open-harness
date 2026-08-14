# Lane C — Serving/runtime landscape for consumer Blackwell (GeForce RTX 50, sm_120, CUDA 12.8+)
> Snapshot as of 2026-08-09.

> **Hardware correction (2026-08-14).** The local machine is a the local machine
> with an RTX PRO Blackwell 8 GB (RTX PRO 1000 or 2000, sm_120), not an
> RTX 5060. "RTX 5060 class" here means this local machine GPU.


**Research date: 2026-08-09.** Hardware scope: GeForce RTX 5050/5060/5070-class 8 GB cards and the wider RTX 50 family (sm_120, compute capability 12.0). CUDA 12.8 is the first toolkit with native Blackwell support (cc 10.0 / 12.0); driver R570+ required for Blackwell workloads (https://forums.developer.nvidia.com/t/software-migration-guide-for-nvidia-blackwell-rtx-gpus-a-guide-to-cuda-12-8-pytorch-tensorrt-and-llama-cpp/321330). Facts below are time-sensitive; re-verify before acting on anything older than ~2 quarters.

Labeling: **[vendor]** = NVIDIA/project official, **[primary]** = project docs/GitHub, **[community-reported]** = forums/Reddit/blogs (unverified).

---

## 1. Runtime support matrix (sm_120 / GeForce Blackwell)

| Runtime | Current version (2026-08) | sm_120 / Blackwell support added | Windows | Status on GeForce RTX 50 | Known issues |
|---|---|---|---|---|---|
| **llama.cpp** (llama-server) | b10333 (2026-08-09) [primary] | Launch window Jan–Feb 2025 via CUDA 12.8 builds (`CMAKE_CUDA_ARCHITECTURES=…120`) [vendor]; official win CUDA assets ever since [primary] | ✅ native, prebuilt CUDA 12/13 Windows zips in every release (b10333 ships `win-cuda-12.4` + `win-cuda-13.3` bundles) | Mature; NVIDIA actively co-optimizes (CUDA graphs, flash-attn, MTP) [vendor] | MXFP4 kernel template fails to assemble for plain `sm_120` targets (issues [#19662](https://github.com/ggml-org/llama.cpp/issues/19662), [#18447](https://github.com/ggml-org/llama.cpp/issues/18447)); MMQ fastest on CUDA 12.8, CUDA 13.x MMQ slower on Blackwell [community-reported](https://zenn.dev/toki_mwc/articles/rtx5090-blackwell-cuda-toolkit-trap-llama-cpp) |
| **Ollama** | v0.32.6 [primary] | Works on RTX 50xx since early 2025 (cc 12.0 in official hardware table); Vulkan backend now default on Windows [primary] | ✅ native installer/service | Officially supported: "12.0 — GeForce RTX 5060…5090" (https://docs.ollama.com/gpu); driver 550+ | Blackwell-specific bugs still filed (e.g. vision crashes on 5080 [#14446](https://github.com/ollama/ollama/issues/14446)); WDDM virtualization bug on 5090/RTX PRO 6000 [community-reported](https://allenkuo.medium.com/vllm-or-ollama-on-blackwell-benchmarks-landmines-and-what-agents-actually-need-5dc539bb28ef) |
| **LM Studio** | 0.4.16 stable + Bionic agent (2026) [vendor] | **0.3.15 (2025-04-24)**: CUDA 12.8 llama.cpp engines for RTX 50 on Windows/Linux, auto-upgrade if driver ≥551.61 (Win) [vendor] | ✅ native app | Mature; built on llama.cpp engine; NVIDIA-blessed [vendor] | Tied to LM Studio llama.cpp engine cadence; GGUF/MLX only (no NVFP4) |
| **vLLM** | ~v0.20.0 (CUDA 13.0.2 / PyTorch 2.11 wheels) [community-reported]; docs state prebuilt CUDA 12.9 binaries [primary] | Feb 2025: unsupported ([#13306](https://github.com/vllm-project/vllm/issues/13306)); May–Jun 2025: source builds with `torch_cuda_arch_list="12.0 12.1"` (v0.9.x); by v0.13 "SM120 kernels compiled and available in dispatch" ([#31085](https://github.com/vllm-project/vllm/issues/31085)); official cu128/cu129 wheels since | ❌ no native Windows — WSL2 only ([stable docs](https://docs.vllm.ai/en/stable/getting_started/installation/gpu/)) | Works; Docker images/wheels historically lagged sm_120 ([forum](https://discuss.vllm.ai/t/support-for-rtx-6000-blackwell-96gb-card/1707), [#16901](https://github.com/vllm-project/vllm/issues/16901)); FA4 not available on sm_120 (SM120 reports cc 12.0, no FlashAttention-4) [community-reported](https://www.spheron.network/blog/flashattention-4-blackwell-gpu-cloud-guide/) | Attention backend carve-outs on SM120 (99 KiB smem limit, CUTLASS fixes still landing) [community-reported](https://forums.developer.nvidia.com/t/psa-state-of-fp4-nvfp4-support-for-dgx-spark-in-vllm/353069); clock/regression sensitivity on sm_120 ([forum](https://discuss.vllm.ai/t/sm120-rtx-pro-4000-6-5x-throughput-gain-and-v0-18-1-regression-findings/2525)) |
| **SGLang** | v0.5.x line [primary] | Tracker [#5338](https://github.com/sgl-project/sglang/issues/5338) (Jun 2025): GeForce sm_120 needs `120a` builds; v0.5.3rc0 "not wonderfully supported" [community-reported] | ❌ Linux only | Second-class target (focus sm_100 datacenter); runs with manual attention backend selection ([#14814](https://github.com/sgl-project/sglang/issues/14814)); Hopper-only kernels crash sm_120 ([sglang-omni #160](https://github.com/sgl-project/sglang-omni/issues/160)) | SM version detection bugs, flashinfer/PyTorch pinning issues [community-reported] |
| **ExLlamaV3** | v1.4.1 [primary] | cu128 prebuilt wheels shipped from first public releases (v0.0.x, mid-2025) — Blackwell-era project [primary] | ⚠️ yes but from-source/PyPI + VS Build Tools + `triton-windows` [primary] | Consumer-GPU-first design; CUDA 13.2 builds ~5–10% faster on Blackwell [community-reported](https://www.reddit.com/r/LocalLLaMA/comments/1t9voxs/exllamav3_major_updates/) | No ROCm; no DSA support yet; EXL3-only focus |
| **TabbyAPI** | rolling release, ExLlamaV3 backend (`main`; EXL2 on `exl2-checkpoint` branch) [primary] | Inherits ExLlamaV3; Docker tags `latest` = CUDA 12.8, `cu13` = CUDA 13 [primary] | ⚠️ via Python/ExLlamaV3 setup | OpenAI-compatible server for EXL3; hobby project, "not meant for production" [primary] | Same as ExLlamaV3 |
| **TensorRT-LLM** | 1.2 [primary] | 0.17.0: Blackwell support (datacenter B200/GB200); 1.0 (Aug 2025): "Add support for sm121" (DGX Spark); GeForce sm_120 runs per community (FP4 on RTX 5090) but not the validated target [primary]/[community-reported](https://www.reddit.com/r/LocalLLaMA/comments/1o5xkka/rtx_5090_fp4_open_webui_via_tensorrtllm_because/) | ❌ native Windows dropped (community: "stopped supporting native windows as of 0.18") [community-reported](https://www.reddit.com/r/LocalLLaMA/comments/17a12gc/nvidia_tensorrtllm_coming_to_windows/) | Datacenter-first; 1.2 validates NVFP4 models on DGX Spark (sm_121a, same Blackwell consumer-class tensor cores) [primary] | NVFP4 **KV cache** is SM100-only, not SM120 (TRT-LLM issue #5018) [community-reported](https://ai.gopubby.com/i-ran-a-70b-model-on-a-2-000-gaming-gpu-heres-the-code-13dfc854ed0c); TensorRT backend removed in 1.2, PyTorch-only [primary] |
| **TensorRT Model Optimizer (ModelOpt)** | 0.37 (as bundled with TRT-LLM 1.1) [primary] | NVFP4 quantization workflow for Blackwell since 2025 [vendor] | quantization runs where PyTorch runs | Produces the NVFP4 checkpoints that vLLM/TRT-LLM/SGLang load on GeForce sm_120 [vendor](https://developer.nvidia.com/blog/introducing-nvfp4-for-efficient-and-accurate-low-precision-inference/) | — |

Adjacent/official: NVIDIA's own RTX-PC deployment guide recommends **Ollama** and **llama.cpp** as the cross-OS backends, with **Windows ML + TensorRT for RTX (TensorRT-RTX)** for max perf on Windows (ONNX path) (https://forums.developer.nvidia.com/t/how-to-deploy-llms-on-rtx-pcs/317354). TensorRT-RTX (distinct from TensorRT-LLM) ships a filterable support matrix covering RTX 50 through releases 1.0–1.6 (https://docs.nvidia.com/deeplearning/tensorrt-rtx/latest/getting-started/support-matrix.html).

---

## 2. NVFP4 / MXFP4 on consumer Blackwell

**Hardware:** GeForce RTX 50 5th-gen Tensor Cores do FP4. NVFP4 inference on GeForce is *not* datacenter-only — the academic study "Private LLM Inference on Consumer Blackwell GPUs" benchmarks NVFP4 and MXFP4 on RTX 5060 Ti / 5070 Ti / 5090 with vLLM compiled for Blackwell NVFP4 kernels, reporting **NVFP4 = 1.6× throughput vs BF16, 41% energy reduction, 2–4% quality loss** (https://arxiv.org/abs/2601.09527).

| Format | Runtimes that load it on GeForce sm_120 | Notes |
|---|---|---|
| **MXFP4 (GGUF)** — gpt-oss-20b/120b, Devstral, Gemma-4-A4B, etc. | llama.cpp (MMQ MXFP4 kernels), Ollama & LM Studio (via their llama.cpp engines) | Works, but **source-build hazard**: MXFP4 template instances fail ptxas assembly when targeting plain `sm_120` (needs `120a`/`120f` arch handling) — issues [#19662](https://github.com/ggml-org/llama.cpp/issues/19662), [#18447](https://github.com/ggml-org/llama.cpp/issues/18447). Prebuilt official binaries unaffected. HF community quants explicitly target "Blackwell sm_120" MXFP4 GGUF (https://huggingface.co/pirola/gemma-4-26B-A4B-it-MXFP4-GGUF) |
| **NVFP4 (safetensors/ModelOpt checkpoints)** | vLLM (CUDA 12.9 binaries incl. nvfp4 kernels [primary]; community GeForce runs [community-reported](https://www.reddit.com/r/LocalLLaMA/comments/1ngrkpb/vllm_on_consumer_grade_blackwell_with_nvfp4/)), TensorRT-LLM (GeForce runs community-reported; DGX Spark sm_121a officially validated in 1.2 [primary]), SGLang (partial, see §1) | Checkpoints from NVIDIA ModelOpt / LLM-Compressor / Unsloth; e.g. RTX-5090-targeted NVFP4 finetunes exist on HF (https://huggingface.co/AEON-7/Qwen3.6-27B-AEON-Ultimate-Uncensored-Multimodal-NVFP4-MTP) |
| NVFP4 in GGUF/llama.cpp | **No NVFP4 GGUF type in ggml today** (MXFP4 only); NVFP4→GGUF is a community conversion recipe, not a first-class format | Ollama cannot load NVFP4 checkpoints directly (imports → GGUF) |

**VRAM/speed vs GGUF Q4:** no head-to-head NVFP4-vs-Q4_K_M GeForce 8 GB benchmark was found (honestly: the gap in the literature). Proxy evidence: NVFP4 ≈ half the bytes of INT8-class weights and 1.6× BF16 throughput [primary/arxiv]; MXFP4 GGUF is "both the most compressed and the fastest on Blackwell sm_120" per community quant authors (https://huggingface.co/pirola/gemma-4-26B-A4B-it-MXFP4-GGUF). For 8 GB cards the practical win is fitting ~9–12B-class models that don't fit at Q4_K_M (e.g. gpt-oss-20b MXFP4 ≈ 12 GB still doesn't fit fully — needs offload, see §5).

---

## 3. FP8 + KV-cache quantization on 8 GB cards

**KV-cache types (llama.cpp, current master `llama-server` help):** `-ctk/-ctv` accept `f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1` — **no fp8 in the documented server flag list** as of 2026-08 (https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md). ggml-cuda does contain FP8 (e4m3) KV kernels (native `__nv_fp8_e4m3` on SM_89+, software path on SM_70–86 — llama.cpp [#22319](https://github.com/ggml-org/llama.cpp/issues/22319)), but the exposed, supported knobs for 8 GB cards are the integer KV quants, chiefly **Q8_0 (near-lossless) and Q4_0 (max context)**.

**Context math (why this matters at 8 GB):** KV per token = 2 · layers · kv_heads · head_dim · bytes. For an 8B GQA model (32 layers, 8 KV heads, d=128): ≈128 KiB/token at f16 → **≈64 KiB/token at q8_0** (2×), ≈32 KiB at q4_0 (4×). With ~2.5 GB free after a Q4_K_M 8B model (GigaGPU VRAM breakdown: 5.5 GB weights + ~0.8 GB runtime, https://gigagpu.com/llama-3-8b-on-rtx-5060-benchmark/): ~8k tokens f16 KV → ~16k q8_0 → ~32k q4_0. Community validation: "Q4 KV cache fits 32K context into 8GB VRAM" (https://dev.to/plasmon_imp/q4-kv-cache-fit-32k-context-into-8gb-vram-only-math-broke-209k) and an 8 GB RTX 5050 workflow running LLM+RAG+STT+TTI under the VRAM cap (https://github.com/ggml-org/llama.cpp/discussions/19813). Quality caveat: community consensus is q8_0 KV ≈ safe, q4_0 KV measurable degradation on math/reasoning [community-reported](https://www.reddit.com/r/LocalLLaMA/comments/1mhlj69/whats_the_verdict_on_using_quantized_kv_cache/).

**FP8 elsewhere:**
- **vLLM** `--kv-cache-dtype fp8`: first-class, validated April 2026 — halves KV memory, decode ITL slope ~54% of BF16, ~1–2 points accuracy loss uncalibrated; new `--kv-cache-dtype-skip-layers` for hybrid models (https://vllm.ai/blog/2026-04-22-fp8-kvcache). On GeForce this is only reachable via WSL2.
- **ExLlamaV3:** 2–8-bit cache quantization built in (https://github.com/turboderp-org/exllamav3).
- **FP8 weights:** GeForce sm_120 supports FP8 tensor cores; vLLM FP8 checkpoints run on RTX 5090 (with early CUTLASS friction) [community-reported](https://github.com/vllm-project/vllm/issues/13306). Ollama/llama.cpp users get the equivalent via Q8_0 GGUF.

---

## 4. OpenAI-compatible server surface & tools/tool_choice

| Server | Surface | `tools` | `tool_choice` | Template/tool-schema rendering |
|---|---|---|---|---|
| **llama.cpp `llama-server`** | `/v1/chat/completions` (+ OpenAI *responses* + embeddings + Anthropic Messages compat) [primary] | ✅ "Function calling / tool use for ~any model" [primary] | ✅ | **`--jinja` now defaults ON** [primary]; renders model chat templates incl. tool schemas; JSON-schema constrained output (`-j/--json-schema`, grammar); `--reasoning-format` for thinking models; experimental built-in agent `--tools` (read_file/exec_shell_command/…) + MCP config [primary] |
| **Ollama `/v1/...`** | `/v1/chat/completions`, `/v1/completions`, `/v1/models`, `/v1/embeddings`, `/v1/responses` (since v0.13.3) [primary] | ✅ (native since 2024-07-25, https://ollama.com/blog/tool-support) | ❌ **`tool_choice` still unsupported** per docs checklist (https://docs.ollama.com/api/openai-compatibility) | Native per-model tool templating (Llama 3.1+, Qwen, Mistral-Nemo, Command-R, gpt-oss…); `tools` category on model library. Rendering quality depends on model's template |
| **LM Studio server** | OpenAI-like REST on :1234 (+ `lms` CLI) [vendor] | ✅ | ✅ `none`/`auto`/`required` (`required` = llama.cpp engines only) — added **0.3.15** (https://lmstudio.ai/blog/lmstudio-v0.3.15) | Uses llama.cpp engine + jinja templates; fixed `finish_reason: tool_calls` + Llama-4 template bugs in 0.3.15 builds [vendor] |
| **vLLM `serve`** | Full OpenAI API + tool parsers (`--enable-auto-tool-choice --tool-call-parser hermes|llama3_json|…`) [primary] | ✅ | ✅ | Parser-based; best-in-class for multi-request serving; WSL2-only on Windows |
| **TabbyAPI** | OAI-compatible incl. tools, JSON schema/regex/EBNF grammar [primary] | ✅ | ✅ (per toolcall_formats modules: harmony, glm4_5, gemma4, deepseek_v4…) [primary] | Revamped tool calling no longer relies on modified Jinja templates (https://github.com/theroyallab/tabbyAPI, docs/10.-Tool-Calling.md) |
| **SGLang / TRT-LLM** | OpenAI-compatible endpoints | ✅ | ✅ | Linux-only; irrelevant for a Windows-first host |

**Reliability verdict for schema-injection on models without native grammar support:** llama.cpp `llama-server --jinja` + grammar/JSON-schema constrained decoding is the most reliable local path (works for ~any model) [primary]; Ollama renders tool schemas only for models whose templates it supports and offers no `tool_choice` forcing; vLLM is equally capable but WSL-only.

---

## 5. Observed throughput on 8 GB-class Blackwell

Vendor/academic anchors:
- NVIDIA [vendor]: llama.cpp MTP + programmatic-dependent-launch optimizations = **2× throughput Qwen3.6/3.5-27B, 1.6× Qwen3.6/3.5-35B on RTX 5090** (Computex 2026, https://blogs.nvidia.com/blog/rtx-ai-garage-computex-spark-local-agents/); LM Studio CUDA-graphs ~27% speedup on RTX 5080 w/ DeepSeek-R1-Distill-Llama-8B Q4_K_M (https://blogs.nvidia.com/blog/rtx-ai-garage-lmstudio-llamacpp-blackwell/).
- arXiv 2601.09527 [academic]: RTX 5090 = 3.5–4.6× throughput of RTX 5060 Ti across Qwen3-8B / Gemma3-12B / Gemma3-27B / GPT-OSS-20B; budget GPUs win on throughput-per-dollar for API workloads.

8 GB cards (community-reported unless noted):

| GPU | Config | Throughput | Source |
|---|---|---|---|
| RTX 5060 8GB (448 GB/s GDDR7) | Qwen3-8B Q4_K_M / Llama-3.1-8B Q4_K_M / Mistral-7B Q4_K_M | ~50 / ~55 / ~60 tok/s | community aggregate (https://everylocalai.com/hardware/rtx-5060) |
| RTX 5060 8GB | LLaMA-3-8B Q4_K_M, 4k ctx | 18 tok/s single-stream, 23.4 @bs=8 (hosted, likely contended; source also mislabels the arch — low confidence) | hosting vendor (https://gigagpu.com/llama-3-8b-on-rtx-5060-benchmark/) |
| RTX 5050 8GB (~320–384 GB/s) | hot-swap LLM+RAG+STT+TTI under 8 GB | workflow-level demo, no clean tok/s | community (https://github.com/ggml-org/llama.cpp/discussions/19813); specs per https://aiflux.substack.com/p/dont-buy-these-gpus-for-local-ai, https://everylocalai.com/hardware/rtx-5050-mobile |
| Any 8 GB card | **Qwen3-30B-A3B (MoE, offload)** | ~29 tok/s gen | community-reported (Reddit "Poor GPU Club: 8GB VRAM" https://www.reddit.com/r/LocalLLaMA/comments/1nyxmci/poor_gpu_club_8gb_vram_qwen330ba3b_gptoss20b_ts/) |
| Any 8 GB card | **gpt-oss-20b (MXFP4, offload)** | ~17.6 tok/s gen | community-reported (same thread) |
| 8 GB | Qwen3-Coder-30B offload, up to 262k ctx | ~29–41 tok/s | community-reported (https://dev.to/upayanghosh/from-oom-to-262k-context-running-qwen3-coder-30b-locally-on-8gb-vram-1ej1) |
| 6 GB | Qwen3.6-35B-A3B offload | ~30 tok/s | community-reported (https://mychen76.medium.com/run-qwen3-6-35b-a3b-on-6gb-vram-using-llama-cpp-30-tps-a89032e5a60c) |
| consumer GPUs w/ CPU-MoE | Qwen3-Omni-30B | ~42–44 tok/s across 5 GPUs | community-reported (https://github.com/ggml-org/llama.cpp/discussions/18273) |

Pattern: 8 GB Blackwell ≈ **45–60 tok/s for dense 7–9B Q4** (bandwidth-bound, scales with GB/s), and **~18–30 tok/s for 20–35B MoE with expert offload** (`--cpu-moe`/`-ncmoe` in llama.cpp) — usable for single-user agentic loops, latency-sensitive but workable.

---

## 6. Practical recommendation for the Windows/Bun host (m365-copilot-proxy)

1. **Primary: Ollama** — lowest friction on Windows: single native installer, auto-start service, official GeForce RTX 50xx support (cc 12.0) (https://docs.ollama.com/gpu), OpenAI-compatible `/v1/chat/completions` with `tools`, plus `/v1/responses` since v0.13.3. Bun talks to `http://localhost:11434/v1` with the standard `openai` npm package. Caveats: **no `tool_choice`** (implement forcing client-side in the proxy — strip/ignore or emulate via prompt), and GGUF-only (no NVFP4). NVIDIA itself lists Ollama first for Windows LLM developers (https://forums.developer.nvidia.com/t/how-to-deploy-llms-on-rtx-pcs/317354).
2. **Fallback/power path: llama.cpp `llama-server`** — official Windows CUDA builds (b10333 ships CUDA 12 + CUDA 13 assets) (https://github.com/ggml-org/llama.cpp/releases/tag/b10333). Use when you need `tool_choice`, `--jinja` template control, KV quant (`-ctk q8_0`/`q4_0` for 8 GB context headroom), MoE offload flags (`--cpu-moe`, `-ncmoe`, `--fit`), or MXFP4 GGUF models. Spawnable from Bun as a child process; one zip per GPU arch.
3. **LM Studio** is the zero-effort GUI option (CUDA 12.8 engine since 0.3.15, `tool_choice` supported, OpenAI server on :1234) — good for developer local machines, less suited to headless/proxy deployments (closed app).
4. **Avoid for this host:** vLLM/SGLang (no native Windows — WSL2/Docker only; sm_120 support still maturing), TensorRT-LLM (Linux-only, datacenter-first, NVFP4-KV SM100-only), TabbyAPI/ExLlamaV3 (Python toolchain friction; excellent only if you commit to EXL3 quants on this GPU).

**8 GB sizing guidance:** dense Q4_K_M 7–9B with q8_0 KV for ~16k ctx; or A3B-class MoE (Qwen3-30B-A3B / Qwen3-Coder-30B) with expert offload for quality-critical agent turns at ~20–30 tok/s.

---

## Sources

- https://forums.developer.nvidia.com/t/software-migration-guide-for-nvidia-blackwell-rtx-gpus-a-guide-to-cuda-12-8-pytorch-tensorrt-and-llama-cpp/321330 (NVIDIA migration guide, CUDA 12.8/llama.cpp sm_120)
- https://developer.nvidia.com/blog/new-ai-sdks-and-tools-released-for-nvidia-blackwell-geforce-rtx-50-series-gpus/ (NVIDIA launch-day SDK blog)
- https://github.com/ggml-org/llama.cpp/releases and https://github.com/ggml-org/llama.cpp/releases/tag/b10333 (llama.cpp releases/assets)
- https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md (llama-server flags, KV types, jinja default)
- https://github.com/ggml-org/llama.cpp/issues/19662 ; https://github.com/ggml-org/llama.cpp/issues/18447 (MXFP4 sm_120 build issues)
- https://github.com/ggml-org/llama.cpp/issues/22319 (FP8 KV kernel mention)
- https://github.com/ggml-org/llama.cpp/discussions/19813 ; https://github.com/ggml-org/llama.cpp/discussions/18273
- https://docs.ollama.com/gpu (Ollama hardware support)
- https://docs.ollama.com/api/openai-compatibility (Ollama OpenAI surface, tool_choice unsupported, /v1/responses)
- https://ollama.com/blog/tool-support (Ollama native tool support)
- https://github.com/ollama/ollama/releases (v0.32.x) ; https://github.com/ollama/ollama/issues/10402 ; https://github.com/ollama/ollama/issues/14446
- https://lmstudio.ai/blog/lmstudio-v0.3.15 (RTX 50 CUDA 12.8 + tool_choice) ; https://lmstudio.ai/changelog (0.4.16/Bionic)
- https://blogs.nvidia.com/blog/rtx-ai-garage-lmstudio-llamacpp-blackwell/ (NVIDIA/LM Studio perf)
- https://blogs.nvidia.com/blog/rtx-ai-garage-computex-spark-local-agents/ (NVIDIA llama.cpp MTP 2×, vLLM NVFP4)
- https://docs.vllm.ai/en/latest/getting_started/installation/gpu/ ; https://docs.vllm.ai/en/stable/getting_started/installation/gpu/ (vLLM CUDA 12.9 binaries, no native Windows)
- https://github.com/vllm-project/vllm/issues/13306 ; https://github.com/vllm-project/vllm/issues/31085 ; https://github.com/vllm-project/vllm/issues/16901 (vLLM sm_120 history)
- https://vllm.ai/blog/2026-04-22-fp8-kvcache (FP8 KV validation)
- https://github.com/sgl-project/sglang/issues/5338 ; https://github.com/sgl-project/sglang/issues/14814 ; https://github.com/sgl-project/sglang-omni/issues/160 (SGLang Blackwell)
- https://github.com/turboderp-org/exllamav3 (ExLlamaV3 README/releases) ; https://github.com/theroyallab/tabbyAPI (TabbyAPI README, Docker CUDA tags)
- https://nvidia.github.io/TensorRT-LLM/release-notes.html (TRT-LLM 0.17 Blackwell, 1.0 sm121, 1.2 DGX Spark NVFP4)
- https://docs.nvidia.com/deeplearning/tensorrt-rtx/latest/getting-started/support-matrix.html (TensorRT-RTX matrix)
- https://developer.nvidia.com/blog/introducing-nvfp4-for-efficient-and-accurate-low-precision-inference/ (NVFP4/ModelOpt)
- https://arxiv.org/abs/2601.09527 (consumer Blackwell NVFP4/MXFP4 study)
- https://forums.developer.nvidia.com/t/how-to-deploy-llms-on-rtx-pcs/317354 (NVIDIA RTX deployment guidance)
- https://forums.developer.nvidia.com/t/psa-state-of-fp4-nvfp4-support-for-dgx-spark-in-vllm/353069 ; https://discuss.vllm.ai/t/support-for-rtx-6000-blackwell-96gb-card/1707 ; https://discuss.vllm.ai/t/sm120-rtx-pro-4000-6-5x-throughput-gain-and-v0-18-1-regression-findings/2525
- https://www.spheron.network/blog/flashattention-4-blackwell-gpu-cloud-guide/ (FA4 not on sm_120)
- Community throughput: https://www.reddit.com/r/LocalLLaMA/comments/1nyxmci/ (8 GB MoE offload) ; https://dev.to/upayanghosh/from-oom-to-262k-context-running-qwen3-coder-30b-locally-on-8gb-vram-1ej1 ; https://mychen76.medium.com/run-qwen3-6-35b-a3b-on-6gb-vram-using-llama-cpp-30-tps-a89032e5a60c ; https://everylocalai.com/hardware/rtx-5060 ; https://gigagpu.com/llama-3-8b-on-rtx-5060-benchmark/ ; https://dev.to/plasmon_imp/q4-kv-cache-fit-32k-context-into-8gb-vram-only-math-broke-209k ; https://www.reddit.com/r/LocalLLaMA/comments/1mhlj69/ ; https://www.reddit.com/r/LocalLLaMA/comments/1t9voxs/exllamav3_major_updates/ ; https://zenn.dev/toki_mwc/articles/rtx5090-blackwell-cuda-toolkit-trap-llama-cpp ; https://allenkuo.medium.com/vllm-or-ollama-on-blackwell-benchmarks-landmines-and-what-agents-actually-need-5dc539bb28ef ; https://www.reddit.com/r/LocalLLaMA/comments/1o5xkka/ ; https://www.reddit.com/r/LocalLLaMA/comments/17a12gc/ ; https://ai.gopubby.com/i-ran-a-70b-model-on-a-2-000-gaming-gpu-heres-the-code-13dfc854ed0c ; https://huggingface.co/pirola/gemma-4-26B-A4B-it-MXFP4-GGUF ; https://huggingface.co/AEON-7/Qwen3.6-27B-AEON-Ultimate-Uncensored-Multimodal-NVFP4-MTP ; https://aiflux.substack.com/p/dont-buy-these-gpus-for-local-ai
