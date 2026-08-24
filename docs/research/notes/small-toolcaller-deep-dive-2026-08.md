# Small Tool-Caller Deep Dive — resolving open questions (2026-08-24)

> Second pass after `local machine-small-toolcaller-2026-08.md`. Envelope unchanged:
> RTX PRO 1000 Blackwell Laptop GPU, **8151 MiB**, llama.cpp/LM Studio.
> Provenance note: this pass was assembled by the orchestrator from a
> research agent's collected primary sources after the agent hit its
> runtime cap mid-write. Items the sources did not settle are marked
> **UNVERIFIED** rather than guessed.

## 1. Tool-calling support of the on-device set

| Model | Native tool calling? | Evidence |
|---|---|---|
| **LFM2.5-8B-A1B** | **YES — documented, 4-step function calling** (tools as JSON in system prompt or `apply_chat_template`) | Official card: model is purpose-positioned for *"agentic workflows, tool use, structured outputs"* ([LiquidAI/LFM2.5-8B-A1B](https://huggingface.co/LiquidAI/LFM2.5-8B-A1B)) |
| Ministral-3-3B-Instruct-2512 | **UNVERIFIED** — card read but no tool-calling section captured | [mistralai/Ministral-3-3B-Instruct-2512](https://huggingface.co/mistralai/Ministral-3-3B-Instruct-2512) |
| NVIDIA-Nemotron3-Nano-4B | **UNVERIFIED** | [nvidia/NVIDIA-Nemotron-3-Nano-4B-BF16](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-4B-BF16) |
| Gemma-4-E2B | **UNVERIFIED** | [google/gemma-4-E2B](https://huggingface.co/google/gemma-4-E2B) |

**Consequence:** LFM2.5-8B-A1B is the only on-device model with *documented*
tool calling. It becomes the primary zero-download bake-off control.

## 2. Licenses of the on-device set (verified via HF API + license pages)

| Model | License | Commercial use |
|---|---|---|
| LFM2.5-8B-A1B (+GGUF) | **LFM Open License v1.0 (`lfm1.0`)** — NOT Apache; terms must be read before any non-private use ([LICENSE](https://huggingface.co/LiquidAI/LFM2.5-8B-A1B/raw/main/LICENSE)) | Check lfm1.0 text |
| Nemotron3-Nano-4B family | **NVIDIA Nemotron Open Model License** (2025-12-15): *"Works are commercially usable"*, derivatives allowed ([terms](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-nemotron-open-model-license/)) | Yes |
| Gemma-4-E2B | HF metadata `apache-2.0`, but card links a separate Gemma 4 license doc ([ai.google.dev/gemma/docs/gemma_4_license](https://ai.google.dev/gemma/docs/gemma_4_license)) — reconcile before redistribution | Likely yes, verify doc |
| Ministral-3-3B-Instruct-2512 | **Apache 2.0** (HF metadata), gated repo (accept terms to download) | Yes |

## 3. Blackwell (sm_120) runtime reality

- **CUDA ≥ 12.8 is mandatory** for Blackwell; NVIDIA's migration guide covers llama.cpp among affected frameworks ([NVIDIA forum guide](https://forums.developer.nvidia.com/t/software-migration-guide-for-nvidia-blackwell-rtx-gpus-a-guide-to-cuda-12-8-pytorch-tensorrt-and-llama-cpp/321330)).
- **Open llama.cpp bug [#19662](https://github.com/ggml-org/llama.cpp/issues/19662):** CUDA builds fail during PTX assembly for **MXFP4** template instances on sm_120 (*"Instruction 'mma with block scale' not supported"*). Practical rule: **avoid MXFP4 quants on this GPU** until fixed; Q4_K_M/IQ4 class quants are unaffected by that specific bug.
- Community prebuilt llama.cpp wheels for RTX 50-series confirm sm_120 works with CUDA 13.1 toolchains ([r/LocalLLaMA](https://www.reddit.com/r/LocalLLaMA/comments/1qona5k/prebuilt_llamacpppython_wheel_for_rtx_5060/)).
- LM Studio ships its own Blackwell-compatible runtime; version drift between LM Studio's embedded llama.cpp and upstream is a known identity/behavior variable — pin the runtime version per bake-off.

## 4. BFCL rigor

- Current leaderboard is **BFCL V4** ([gorilla.cs.berkeley.edu](https://gorilla.cs.berkeley.edu/leaderboard)); dataset files confirmed in-tree under `berkeley-function-call-leaderboard/bfcl_eval/data/` (v4 live/multi-turn/memory splits).
- **Watt-Tool-8B has an OFFICIAL BFCL entry** — added by [PR #847](https://github.com/ShishirPatil/gorilla/pull/847) (merged Dec 2024). Its scores are leaderboard-official, not vendor-only. Exact current V4 number: **UNVERIFIED here** (leaderboard page renders client-side); pull `total_scores.json` programmatically at bake-off time.
- Prior-note numbers mixing BFCL v3 percentages with v4 overall-accuracy remain incomparable scales — our own fixture run is the arbiter.

## 5. Grammar-constrained tool calls

llama.cpp supports GBNF grammars and JSON-schema→grammar conversion server-side (`response_format: json_schema` / grammar endpoints). Constraint applies to ANY model served by llama.cpp/LM Studio regardless of its native format training, which de-risks candidates with weak native FC formatting. Per-model template quirks still matter for the *prompt* side. **UNVERIFIED detail:** exact JSON-schema feature coverage per LM Studio release — verify against the pinned LM Studio version during bake-off.

## 6. MoE dark horse status

Qwen3-Next-80B-A3B (~3B active): no first-class small-VRAM offload doc found this pass (the attempted `MoE.md` reference 404s). Status stays **UNVERIFIED / deprioritized** — do not plan around it.

## Updated verdict

1. **Zero-download lane:** LFM2.5-8B-A1B Q6_K moves to **primary control** (documented FC, fast 1B-active decode; license check needed beyond private use). Nemotron3-Nano-4B secondary (permissive license, FC support unproven).
2. **Download lane:** Watt-Tool-8B stays top pick — now with confirmed official BFCL provenance. Avoid MXFP4 quants on Blackwell (#19662).
3. Bake-off order unchanged from previous note, minus MoE dark horse.

*Assembled 2026-08-24 from primary sources fetched during this pass: huggingface.co API/cards (google, LiquidAI, mistralai, nvidia, watt-ai, gorilla-llm space), nvidia.com license + forum guide, github.com/ggml-org/llama.cpp #19662 + gorilla PR #847 + bfcl_eval tree. Nothing downloaded, nothing run.*
