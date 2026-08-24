# Small Tool-Caller Models for the Laptop — Primary-Source Research (2026-08-24)

> **Mission:** a lightweight model that fits on the local machine GPU *alongside* other work and reliably emits the tool calls that M365 Copilot struggles with.
> **Hard envelope:** NVIDIA RTX PRO 1000 Blackwell Laptop GPU, **8151 MiB total** VRAM (user-stated, nvidia-smi-confirmed). Weights ≤ ~6 GB so weights + KV@16K + overhead fit ≤ ~7.5 GB.
> **Method:** BFCL leaderboards, official HF model cards / GitHub repos, llama.cpp support checks. Third-party composites flagged as such. No bake-off run (deferred).
> Companion note (landscape reference only, wrong hardware assumption): `local machine-models-refresh-2026-08.md`.

## TL;DR

| Rank | Model | Params | License | FC evidence | Total VRAM est. | On device? |
|---|---|---|---|---|---|---|
| 1 | **Watt-Tool-8B** | 8B (Llama 3.1 base) | Apache 2.0 | Dedicated FC fine-tune; claims BFCL SOTA ([card](https://huggingface.co/watt-ai/watt-tool-8B)) | ~6.0 GB | No |
| 2 | **Phi-4-mini-instruct** | 3.8B | MIT | Native tool tokens; composite scores low-to-mid 80s ([ertas.ai](https://www.ertas.ai/blog/on-device-tool-calling-2026-qwen3-gemma4-phi4)) | ~3.1 GB | No |
| 3 | **Granite 3.3 8B-Instruct** | 8B | Apache 2.0 | BFCL v3 ~82.1% (third-party [presenc.ai](https://presenc.ai/research/open-weight-function-calling-tool-use-2026)); generalist, not FC-dedicated | ~6.0 GB | No |
| 4 | **Nemotron3-Nano-4B** (Q4_K_M) | 4B | OPEN? verify | No independent FC number found | ~2.5–3.1 GB | **Yes** |
| 5 | **LFM2.5-8B-A1B** (Q6_K) | 8B MoE, 1B active | verify | No independent FC number found | ~6.6–7 GB | **Yes** |
| 6 | xLAM-7B-fc-r | 6.91B | **CC-BY-NC** | BFCL ~78% (07/2024 era); 4K ctx max | ~5.0 GB | No |

Dark horse: **Qwen3-Next-80B-A3B** — only 3B active params (MoE), BFCL v3 0.720 top-open score ([Gorilla leaderboard](https://gorilla.cs.berkeley.edu/leaderboard)), est. ~2.6 GB resident **if** llama.cpp's MoE offloading handles it; unverified on this runtime.

**Zero-download best bet:** Nemotron3-Nano-4B or LFM2.5-8B-A1B (both already GGUF-on-device via LM Studio). **Download-required best bet:** Watt-Tool-8B.

## Candidates that FIT (VRAM math: weights + KV@16K + overhead vs 8151 MiB)

1. **Watt-Tool-8B** — Q4_K_M ≈ 4.7 GB + KV ≈ 0.6 GB + overhead ≈ 0.7 GB = **~6.0 GB ✓**. Dedicated function-calling fine-tune of Llama 3.1 8B by Watt-AI; card claims state-of-the-art BFCL. GGUF available.
2. **Granite 3.3 / 4.1 8B-Instruct (IBM)** — same math = **~6.0 GB ✓**. Granite 4.1 uses Mamba-hybrid attention (low KV). BFCL v3: 82.1% (Granite 3.3, third-party) / 68.27% (Granite 4.1, [d-central](https://d-central.tech/local-llm-agent-capability/)). Generalists with FC capability, not FC-dedicated fine-tunes. Apache 2.0.
3. **Phi-4-mini-instruct (Microsoft)** — Q4_K_M ≈ 2.3 GB + 0.3 + 0.5 = **~3.1 GB ✓**. MIT license. Native tool-call tokens in template; fastest decode of the 4B class. Composite FC scores low-to-mid 80s (third-party Ertas eval).
4. **Qwen3-4B-Instruct-2507** — **~3.1 GB ✓**. Apache 2.0. Hermes-style tool format natively. Atlas BFCL v4 35.7 vs Ertas composite high-80s — measurement disagreement flagged; resolve empirically in bake-off.
5. **Qwen3-8B** — **~6.0 GB ✓** but BFCL v4 only 42.6 ([atlas.kevinhu.io](https://atlas.kevinhu.io/benchmarks/bfcl-v4-overall-accuracy)) — larger ≠ better at FC.
6. **xLAM-7B-fc-r / xLAM-1B-fc-r (Salesforce)** — ~5.0 GB / ~1.2 GB ✓. Strong dedicated-FC pedigree (BFCL ~78–79%, mid-2024 numbers) but **CC-BY-NC license** (non-commercial) and 4K context cap on 7B. Usable privately; flag licensing.
7. **On-device set (zero download):** Nemotron3-Nano-4B Q4_K_M (~2.5–3.1 GB), Ministral-3-3B Q4_K_M (~1.9 GB), LFM2.5-8B-A1B Q6_K (~6.6–7 GB, 1B-active MoE = fast decode), Gemma-4-E2B (~1.6 GB). No published BFCL numbers located for these specific variants — that gap is what the bake-off must close.

## Does NOT fit

- **Hermes-4-14B** — Q4_K_M weights alone ≈ 8.5 GB ✗
- **Watt-Tool-70B**, any 14B+ specialist ✗
- **Qwen3.8-27B crush-quants on device:** Q2_K_XL ≈ 10+ GB ✗ doesn't fit at all; IQ1_S ≈ 4 GB fits but 1-bit quality cannot be trusted for reliable structured output ✗
- Functionary small series (v2.x/v3.x, Llama 3.1 8B base): repos marked deprecated, no current BFCL entries ([meetkai/functionary](https://github.com/MeetKai/functionary)) — skip.

## Integration patterns (small tool-model + Copilot chat model)

Two seams exist in this proxy today (`packages/proxy-lib/src/handler.ts` → `tool-path.ts`):

1. **Repair pass (recommended first):** after `runTurn`, when the deterministic parse finds NO tool call but confab/refusal patterns fire (`tools.ts` detectors), hand the visible transcript to the small model over its OpenAI-compatible endpoint and require a strict fenced call (llama.cpp grammar/JSON-schema constraint). Env-gated like `M365_STEERING`, default off, contract-testable byte-identical when off. The old `intent-verifier.ts` HTTP plumbing (fail-closed timeout/model-mismatch identity guard) is reusable scaffolding.
2. **Fallback lane:** on empty reply / Disengaged-shaped failure, route the whole turn to the small model. Bigger behavioral change; pairs with the throttle-telemetry gate.

Pattern 1 attacks exactly the bench failure mode (turn-1 canned refusals on `ec-*` tasks, SOLVED 6/10).

## Recommended bake-off order (DEFERRED until user opens it)

1. Watt-Tool-8B Q4_K_M (download ~4.7 GB) — primary hypothesis
2. Nemotron3-Nano-4B Q4_K_M (on device) — zero-download control
3. Phi-4-mini-instruct Q4_K_M (download ~2.3 GB)
4. LFM2.5-8B-A1B Q6_K (on device) — speed ceiling probe
5. Granite 3.3 8B Q4_K_M — only if 1–3 disappoint

Harness: llama-server on local machine :1234, BFCL-style fixture set from `scripts/bench/` tasks, one model resident at a time, identity-guard echoed model id (LM Studio echoes loaded id — see AGENTS.md gotcha).

## Open questions

- BFCL version mixing: v3 percentages vs v4 overall-accuracy are NOT comparable scales; third-party composites add noise. Resolve by measuring our own fixtures.
- llama.cpp MoE quality/offload for Qwen3-Next-80B-A3B on an 8 GB card: unverified.
- Watt-Tool-8B "SOTA" is the vendor's own claim; no independent leaderboard entry found — treat as hypothesis.
- Exact licenses for on-device Nemotron3-Nano-4B / LFM2.5 variants: check LM Studio source pages before commercial use.

*Research completed 2026-08-24. Nothing downloaded, nothing run. Primary sources: gorilla.cs.berkeley.edu, huggingface.co model cards (watt-ai, ibm-granite, Salesforce, meetkai, NousResearch, Microsoft), github.com/ggml-org/llama.cpp, presenc.ai, d-central.tech, ertas.ai, atlas.kevinhu.io, benchlm.ai.*
