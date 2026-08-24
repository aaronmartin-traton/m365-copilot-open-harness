# Nemotron 3.5 Lightning — variant research (2026-08-14)
> Snapshot as of 2026-08-14.
> Research note: HF search, community verification, and ChatGPT consensus
> for the the local machine / RTX PRO Blackwell 8 GB + 32 GB RAM local machine.
> **SUPERSEDED 2026-08-24 (hardware fact + mission).** nvidia-smi confirms
> the local machine GPU is an RTX PRO 1000 Blackwell Laptop with **8151 MiB**
> total. Every §7 candidate (11.5–20 GB) exceeds that without CPU offload,
> and the project goal moved from "big fallback-lane model" to "small
> reliable tool-caller alongside Copilot". The download next-step in §6 is
> VOID. Operative shortlist: `local machine-small-toolcaller-2026-08.md`.

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

**Next step:** ~~Download the REAP-20B IQ4_NL GGUF and test on the local machine
with llama.cpp expert offload (`--cpu-moe`). Compare against the
Qwen3-Coder-30B-A3B baseline (32.5 t/s measured on 8 GB).~~
VOID 2026-08-24: REAP-20B is 11.5 GB — it does not fit the 8151 MiB GPU
without CPU offload, and the mission changed. See the banner above.

## 7. Addendum — 2026-08-21 landscape check

> Online research only; nothing downloaded, LM Studio untouched. The
> 2026-08-14 ranking above is stale in two slots.

**Qwen3.8-27B is out (weights 2026-08-14, dense 27B).** The "Watch" branch
in §5 anticipated it; it shipped three days before this note's snapshot.
Real-world agentic evidence (OVERBRING Labs, 2026-08-17): three bugs fixed
autonomously across three codebases in ~10 min wall-clock on 2×16 GB
Blackwell; ~33 tok/s tg on UD-Q4_K_XL (17.9 GB); no doom loops at `xhigh`
effort; 262K native context. Community consensus: strongest local coding
model available; wall-clock-to-correct beats faster MoEs. This displaces
Qwen3-Coder-30B-A3B and Ornith 35B as the quality ceiling for any lane
with ≥24 GB VRAM+RAM headroom.

**Muse Glimmer 30B is out (2026-08-10, Apache 2.0, official).** First
open-weight model purpose-built for local agents: precise function calling,
failure recovery, multimodal, controllable effort. Ships a DFlash
speculative drafter (3.1× on RTX 5090, 1.8× M5 Max). K-Quant-17GB fits a
24 GB envelope with KV + vision encoder + drafter resident. Official
llama.cpp/MLX/Ollama/LM Studio support landing. §5 ranked it 6th at IQ3
with a CPU-offload penalty — that penalty assumed no drafter; with DFlash
the decode-speed picture changes and it should be re-screened rather than
dismissed.

**Nemotron ecosystem moved too:** nota-ai published an NVFP4
Global-Pruned-15 serving endpoint (FriendliAI listing) — still no GGUF, so
the §3.2 "not practical" verdict stands. REAP-20B remains the only
GGUF-pruned variant.

**Revised candidate set for the fallback-lane bake-off (if opened):**

| Slot | Candidate | Why |
|---|---|---|
| Quality ceiling | Qwen3.8-27B UD-Q4_K_XL (17.9 GB) | Best local coding/agentic quality |
| Agent-native | Muse Glimmer 30B K-Quant-17GB + DFlash | Purpose-built tool calling + speed |
| Memory-lean MoE | Nemotron REAP-20B IQ4_NL (11.5 GB) | 3B active decode speed, cheapest KV |
| Baseline | Qwen3-Coder-30B-A3B | Existing 32.5 t/s measurement |

Screening rules unchanged: DEV corpus first, identity-guard the echoed
model id, one local server at a time.

### 7.1 Availability + architecture corrections (verified on HF, 2026-08-21)

**Qwen3.8-27B — `unsloth/Qwen3.8-27B-GGUF` confirmed** (apache-2.0,
Dynamic v3.0 imatrix quants, ~5.8M downloads). Official card facts that
revise this note's earlier assumptions:

- **NOT a plain dense transformer.** Hybrid layout: 16 × (3 × Gated
  DeltaNet → FFN → 1 × Gated Attention → FFN), 64 layers total. Only the
  16 gated-attention blocks carry growing KV (4 KV heads, head_dim 256);
  DeltaNet blocks carry fixed-size recurrent state. Approx. KV ≈ 64
  KB/token bf16 — ~10× REAP-20B's 6 KB/token but far below a naive
  full-attention dense 27B. The earlier "~2× REAP KV" caveat here was
  wrong in both directions; the hybrid is the truth. Long-context budget
  on the 8 GB + 32 GB local machine is still attention-layer-bound: ~5 GB KV at
  80K context before quantization (`-ctk q8_0 -ctv q4_0` roughly halves
  it).
- MTP trained in-pretrain → llama.cpp `--spec-type draft-mtp` works
  (draft acceptance ~64% per the OVERBRING measurements).
- Native vision-language (image + video). `--no-mmproj` skips it for a
  text-only agent lane.
- Official sampling: thinking mode `temp 1.0, top_p 0.95, top_k 20`;
  instruct mode `temp 0.7, top_p 0.80, presence_penalty 1.5`.
- Unsloth ships "Developer Role Support" + tool-calling parsing fixes —
  relevant to the fenced shell-routing contract.

**Muse Glimmer — official GGUF now exists:** `meta-models/Muse-Glimmer-30B-GGUF`
(k-quants, org-verified, updated 2026-08-17), plus ExecuTorch PTE builds
and quantized DFlash drafter variants in the same org collection
(`Muse-Glimmer-30B-assistant` is a 3B companion). The §5 rank-6 entry
pointed at an IQ3 community quant with CPU-offload penalty; the official
k-quant + drafter stack supersedes that assessment.

**REAP-20B — unchanged, still alpha.** Card re-verified: 11.5 GB IQ4_NL
merged GGUF smoke-tested only; recovery LoRA rank 8 "rough-edges cleanup";
requires llama.cpp ≥ b10326 (`nemotron_h_moe`); KV ~6 KB/token confirmed;
1M context supported, prefill-time-bound on local machines. No new commits or
benchmarks since the 2026-08-12 snapshot.