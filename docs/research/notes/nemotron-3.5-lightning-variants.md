# Nemotron 3.5 Lightning — variant research (2026-08-14)

> Research note: HF search, community verification, and ChatGPT consensus
> for the the local machine / RTX PRO Blackwell 8 GB + 32 GB RAM local machine.

---

## 1. Base model

NVIDIA Nemotron 3.5 Lightning is a 30B-total / 3B-active hybrid MoE
(Mamba2 + Attention). 128 routed experts, 6 active per token. Built for
the agent execution layer: tool calling, output validation, RAG retrieval,
summarization, subagent delegation. 1M context, OpenMDW-1.1 license.

Ships speculative decoding support: MTP (multi-token prediction), DFlash,
DSpark.

**HF repos (official):**
- `nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16` (full BF16)
- `nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4` (NVFP4 quant)
- `nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4-DSpark` (draft)
- `ggml-org/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF` (BF16 + Q4 + Q8)
- `unsloth/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF` (19 quants)
- `bartowski/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF` (community)

## 2. Architecture constraint — block-32 floor

hidden=2688, moe_intermediate=1856. Neither is divisible by 256.
llama.cpp GGUF K/IQ quant formats have 256-element superblocks.
Unrepresentable dimensions fall back to block-32 formats (~4.5 bpw
floor) regardless of requested bit width.

At 30B total params: ~18 GB floor
At 20B total params: ~11.5 GB floor (the REAP-20B target)

## 3. Variants found

| Variant | Total params | Active | Size | Type |
|---|---|---|---|---|
| Full 30B-A3B (IQ1_M) | 31.6B | ~3B | 19.4 GB | GGUF, smallest unsloth quant |
| Full 30B-A3B (Q4) | 31.6B | ~3B | ~25 GB | GGUF, recommended balance |
| Full 30B-A3B (NVFP4) | 31.6B | ~3B | ~22.5 GB | NVFP4 GGUF (ggml-org) |
| **REAP-20B** (IQ4_NL) | **19.87B** | **~3B** | **11.5 GB** | Expert-pruned 128→77 experts |
| REAP-20B + LoRA + IQ4NL | 19.87B | ~3B | 11.5 GB + LoRA | Recovery pass included |
| Global-Pruned-15 (NVFP4) | ~26B | ~3B | ~15+ GB | 15% global pruning, 52 safetensors |

**No smaller native variants exist.** There is no 8B, 4B, or dense Nemotron
3.5 Lightning. The only way to reduce memory is pruning or deep quantization.

### 3.1 REAP-20B (sleepyeldrazi, 2026-08-12)

The most interesting variant for the 8 GB + 32 GB local machine.

**What it is:** Expert pruning via REAP (Router-weighted Expert Activation
Pruning, Cerebras, arXiv 2510.13999). 128 routed experts → 77 (40%
sparsity). Total params 31.6B → 19.87B. Active params stay ~3B.

**File sizes:**
- BF16 safetensors: 2 × ~20 GB = ~40 GB (not practical)
- IQ4_NL GGUF: **11.5 GB** (the LoRA+IQ4NL repo)
- IQ4_NL GGUF + LoRA adapter: 11.5 GB

**Memory budget on 32 GB RAM local machine:**
- 11.5 GB weights
- ~6 KB/token KV (6 attention layers, 2 KV heads)
- 128K context ≈ 0.8 GB KV
- ~20 GB remaining for OS, llama.cpp, OMP/Pi, buffers

**KV cache is unusually cheap:** 6 attention layers × 2 KV heads × 2 bytes
× 128 dimension ≈ 6 KB/token. 128K context = ~0.8 GB (vs ~8 GB for a
dense 30B model with full attention).

**Status:** Alpha. Author says "pre-LoRA base; domain LoRA (subagent
orchestration + coding/tool-calling) is the intended next step." The
IQ4_NL GGUF includes a LoRA recovery pass. Full benchmarks not run.

**HF repos:**
- `sleepyeldrazi/Nemotron-3.5-Lightning-30B-A3B-REAP-20B`
- `sleepyeldrazi/Nemotron-3.5-Lightning-30B-A3B-REAP-20B-LoRA-IQ4NL`

### 3.2 Global-Pruned-15 (nota-ai, 2026-08-13)

15% global pruning applied to the NVFP4 weights. 52 safetensors files.
No GGUF published. No model card details on exact param count. Not
practical for this project without a GGUF quant.

## 4. Community/user reports — verified

| Claim | Source | Confirmed |
|---|---|---|
| Q5 + MTP, ~65 tok/s on M5 Pro, good Hermes Agent/tool, weak coding | r/LocalLLaMA (1 day ago) | ✅ Search result #2 |
| 2-bit GGUF ran tool calls 10 min nonstop | r/unsloth | ✅ Search result #4 |
| 485 tokens vs 1,953 for competitor on same agent task | X/SaiyamPathak | ✅ |
| 24 GB RAM on Apple M5 | r/LocalLLM | ✅ |
| DSpark +15.6% single-stream, 53% draft acceptance, 1.59 accepted tokens/draft | NVIDIA developer forum | ✅ Forum post at `forums.developer.nvidia.com/t/new-nemotron-3-5-lighting-30b-a3b/379832` |
| "ideal for high-throughput agent responses" | r/LocalLLaMA | ✅ |
| 80/100 tool-eval vs 100/100 for Qwen3.6-35B-A3B | r/LocalLLaMA | ✅ |
| "Much stronger as agent execution/tool model than standalone coding" | r/LocalLLaMA | ✅ |
| Nemotron Cascade 2 (older gen) on RTX 2060 6 GB, 10-20 tok/s, 4.4 GB VRAM, 15.8 GB RAM, 128K context | r/LocalLLaMA (4 months ago) | ✅ Directionally correct. Older Cascade 2 architecture, but similar MoE 30B-A3B class. |

## 5. ChatGPT consensus (2026-08-14)

From the "LLM stack" custom GPT, conversation "Branch · Qwen3.8-27B Watch".

**Updated ranking for the local machine fallback lane:**

| Rank | Model | Weights | Active | Role |
|---|---|---|---|---|
| 1 | Nemotron REAP-20B IQ4_NL | 11.5 GB | ~3B | Agent execution + memory headroom |
| 2 | Ornith 35B Q3_K_M | ~16.7 GB | ~3B | Best coding-heavy hybrid |
| 3 | Qwen3-Coder-30B-A3B | varies | ~3B | Proven baseline, ~32.5 t/s on 8 GB |
| 4 | Full Nemotron 3.5 Lightning | ~19-20 GB | ~3B | Maximum Lightning quality, now secondary |
| 5 | Ornith 9B mixed-Q4 | ~5-6 GB | 9B | Fast lane, GPU-friendly |
| 6 | Muse Glimmer 30B IQ3 | ~12-15 GB | 30B | Strong agent/reasoning, CPU-offload penalty |

**Key verdict:** The REAP-20B at 11.5 GB is the most interesting candidate
for the fallback lane. It keeps 3B active (fast decode), native tool
calling, 1M context, and leaves ~20 GB of RAM for KV/OS/buffers.
The full 30B-A3B is now secondary.

## 6. Relevance to this project

The m365-copilot-proxy fallback lane needs a local model that can:
- Run when M365 throttles or Disengages
- Handle tool calling reliably (fenced shell-routing contract)
- Keep long context for agentic coding sessions
- Decode fast enough for interactive use

Nemotron 3.5 Lightning's design (agent execution, tool calling, chained
tools, error recovery) matches this role better than the coding-focused
models (Ornith, Qwen). The REAP-20B variant makes the memory fit
practical.

**Next step:** Download the REAP-20B IQ4_NL GGUF and test on the local machine
with llama.cpp expert offload (`--cpu-moe`). Compare against the
Qwen3-Coder-30B-A3B baseline (32.5 t/s measured on 8 GB).