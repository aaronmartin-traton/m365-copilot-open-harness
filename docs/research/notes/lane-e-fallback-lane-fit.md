# Lane E — Local fallback lane fit (keeping the agent loop alive when M365 throttles or Disengages)
> Snapshot as of 2026-08-09.


- **Research date:** 2026-08-09 (all "current" claims as of this date)
- **Question:** when M365 Copilot throttles (thread-rate degradation backoff) or Disengages, can the coding-agent loop keep running on a LOCAL model instead of idling — and what prior art, models, and operational shape fit this project?
- **Target hardware:** local machine RTX 5060 Laptop 8 GB (sm_120, 448 GB/s GDDR7) + desktop Ryzen 9 7900X / RX 9070 XT 16 GB / 64 GB DDR5, Windows both. Local serving via llama.cpp / LM Studio / Ollama (per Lane C).
- **Evidence labels:** [vendor] = model/runtime maker's own claim · [primary] = official docs/source of the tool in question · [community] = user reports (Reddit/HN/forum snippets; Reddit blocks direct retrieval, so Reddit items are search-snippet-derived and marked) · [computed] = arithmetic done in this note. Cross-lane findings cite Lane A/B/C rather than re-deriving them.

---

## 0. Bottom line

1. **Failure-driven remote→local fallback is a solved problem at the proxy layer** (LiteLLM `fallbacks`, OpenRouter `models` arrays) and is now emerging inside agent harnesses (OpenClaw's turn-local model failover is the most complete documented semantics). The project's OpenAI-compatible proxy is the natural insertion point; no harness-side change is strictly required because fallback is **request-scoped** — the conversation state lives client-side and any OpenAI-compatible endpoint can serve the next request. (§1)
2. **Qwen3-Coder-30B-A3B is the proven local agent**: official Cline support via LM Studio (256K context, dedicated compact prompt), community reports in Cline/Roo Code/Aider/OpenHands/goose, ~30–32 t/s with experts on CPU on 8 GB GPUs, and it follows non-JSON protocols (Cline XML prompt, aider `diff` edit format). (§2.1)
3. **Qwen3-Coder-Next (80B-A3B) fits the desktop, not the local machine**: ~46–51 GB at 4-bit, ~25 t/s on *exactly* the project's desktop class (64 GB DDR5 + RX 9070 XT 16 GB, experts on CPU) — but pure-CPU inference is pathologically slow (~7–12 t/s) due to unoptimized Gated-DeltaNet kernels. (§2.2)
4. **LFM2.5-2.6B is a credible *tiny* fallback agent** (BFCL v4 56.9, trained inside real harnesses, <2.5 GB, ~90–220 t/s depending on hardware), but its base chat template has no thinking toggle, early llama.cpp reports show think-tag leakage/tool-call breakage in the family, and nobody has demonstrated it in fenced-bash shell-routing mode. (§2.3)
5. **Tool-format fit favors the project's shell-routing design**: when no `tools` parameter is sent, all candidates are plain completion models and fenced ```bash is just text generation. Harness evidence (Cline XML, aider edit formats, BFCL format-sensitivity, Natural-Language-Tools +18.4 pp) shows text/code-style protocols beat strict JSON for local models. The risk is the inverse: RL'd tool scaffolding (JSON/think tags) leaking INTO plain-text mode. (§3)
6. **Desktop→local machine LAN serving is a documented first-class pattern** (LM Studio "Serve on Local Network", `llama-server --host 0.0.0.0`, Ollama `OLLAMA_HOST`); DDR5 dual-channel gives ~65–90 GB/s practical bandwidth, i.e. a ~20–35 t/s ceiling for 30B-A3B expert-offload. (§4)

---

## 1. Prior art: hybrid remote/local routing

### 1.1 LiteLLM — request-level failover semantics [primary]

LiteLLM's router is the reference implementation of fallback chains in OpenAI-compatible stacks (<https://docs.litellm.ai/docs/proxy/reliability>, <https://docs.litellm.ai/docs/routing>):

| Feature | Semantics | Relevance to this project |
|---|---|---|
| `fallbacks=[{"model-a": ["model-b"]}]` | After `num_retries` fails on a model group, retry the same request on the next group, in order | Directly maps M365-throttled → local lane |
| 3 fallback classes | `fallbacks` (all remaining errors incl. RateLimitError), `content_policy_fallbacks`, `context_window_fallbacks` | Throttling hits the generic class; context-window class matters because the local model's context is smaller |
| `default_fallbacks` | Catch-all when a group is misconfigured | Safety net for the fallback lane itself |
| Retries + cooldowns | `num_retries`, `allowed_fails`, `cooldown_time` per deployment | Matches thread-rate backoff design: cooldown M365, serve local, probe back |
| Pre-call checks | `enable_pre_call_checks: true` + per-deployment `max_input_tokens` rejects oversized prompts BEFORE hitting the fallback | Required guard: M365 sessions can exceed the local model's 32–128K budget |
| Client-side fallbacks | `fallbacks` field on the request body; per-model messages/params overrides | Lets the harness steer prompt variants per lane |
| Fallback management endpoints | CRUD fallbacks without redeploying config (<https://docs.litellm.ai/docs/proxy/fallback_management>) | Runtime-mutable chains |
| Per-request/per-key disable | `disable_fallbacks: true` | Escape hatch |

**Known sharp edge:** if the fallback model has a smaller `max_input_tokens` than the primary and the request exceeds it, the fallback chain can fail silently/raise from inside the fallback (GitHub issue #31557, <https://github.com/BerriAI/litellm/issues/31557>). For an M365→local handoff this is the #1 integration hazard: compact/summarize context before switching, or pre-call-check.

LiteLLM treats local servers as ordinary deployments (`huggingface/…`, `ollama/…`, or raw `api_base` OpenAI-compatible entries), and a llama.cpp-community reply explicitly recommends "fronting 2 different llama-server instances with litellm" as a workaround pattern (<https://github.com/ggml-org/llama.cpp/discussions/14758>) — remote+local mixed pools behind one router is everyday practice.

### 1.2 OpenRouter — two-layer failover, opt-in model fallbacks [primary]

- **Provider failover** (automatic, no config): one model served by many providers reroutes on 5xx/rate-limit (<https://openrouter.ai/blog/insights/reliability-failover>).
- **Model fallbacks** (opt-in): `models: ["primary", "backup-1", "backup-2"]` array in priority order; triggers on context-length validation errors, moderation flags, rate limiting, and downtime; the response's `model` field reports what actually served it; billed by the model that ran (<https://openrouter.ai/docs/guides/routing/model-fallbacks>, <https://openrouter.ai/blog/insights/model-routing/>).
- **Presets** package the fallback chain server-side (`@preset/slug`), versioned and roll-back-able — written explicitly for the "provider restricts a model mid-project" scenario (<https://openrouter.ai/blog/tutorials/keep-your-agent-running-when-models-disappear/>).
- Anthropic-Messages-API compatibility: `fallbacks` param, ≤3 entries, model-only (no per-attempt param overrides).
- Community-reported limitation: fallback does NOT fire when the primary returns *truncated/incomplete-but-successful* output (r/openrouter snippet, <https://www.reddit.com/r/openrouter/comments/1pi0r8j/>) — i.e. degradation without an error code escapes both OpenRouter's and LiteLLM's triggers. **This project's thread-rate-degradation signal is exactly such a non-error degradation, so the trigger logic must live in this proxy, not be delegated to a generic router.** [community]

### 1.3 RouteLLM — cost/quality routing, incl. to local models [primary + vendor]

RouteLLM (lm-sys, arXiv 2406.18665) routes each query between a strong/expensive and weak/cheap model using trained classifier routers (`mf` recommended), with a per-request threshold; claims up to 85% cost reduction at 95% of GPT-4 quality on MT Bench (<https://github.com/lm-sys/routellm>, <https://arxiv.org/abs/2406.18665>). It is a drop-in OpenAI client/server built on LiteLLM, and ships a documented path for **routing strong→local-weak models via Ollama** (`examples/routing_to_local_models.md`). It is *not* failure-driven (it's cost-driven), but it proves the remote→local mixing point works as an OpenAI-compatible server.

### 1.4 OpenClaw — the most complete in-harness failover semantics [primary]

OpenClaw (agent harness) documents precisely the behavior this project wants (<https://docs.openclaw.ai/concepts/model-failover>):

- Two stages: **auth-profile rotation** within a provider, then **model fallback** down `agents.defaults.model.fallbacks`.
- **Fallback is turn-local**: the winning fallback answers the current turn but does NOT become the session's selected model; the harness probes the original and reports "Model Fallback cleared" when it recovers (auto-selected overrides are probed every 5 minutes). → The exact "keep working during throttle, snap back after backoff expires" semantics.
- Explicit user model selections are **strict** (no silent substitution); configured defaults and cron primaries use fallback chains.
- Error taxonomy that advances fallback: auth failures, rate limits/cooldown exhaustion, overloaded/provider-busy, timeout-shaped errors, billing disables; format/invalid-request errors are terminal (retrying the same payload would fail again) — a good rule to copy.
- Cooldowns escalate 30 s → 1 min → 5 min; overloaded-only exhaustion retries the whole chain up to 10× with exponential backoff (2.5 s → 30 s cap), only before tool execution starts (avoids duplicate side effects), with a user-visible status notice after 30 s.
- Local models are named as ordinary fallback candidates in its docs (e.g. `/model ollama/qwen3.5:27b` example), so **remote→local mid-session degradation is documented practice in a real harness**.

### 1.5 Coding harnesses: multi-provider configs yes, per-model fallback chains mostly no

| Harness | Multi-provider | Fallback chain? | Notes |
|---|---|---|---|
| **pi** (pi.dev / badlogic pi-mono) | ✅ 15+ providers + custom providers via `models.json` (Ollama, LM Studio, vLLM, any OpenAI/Anthropic-style API) and **first-class llama.cpp router server** (`/login llama.cpp`, `/llama` to manage loaded models) [primary: <https://pi.dev/docs/latest/providers>] | ❌ none documented (providers doc has no fallback/failover concept; switching is manual `/model`) | pi is the closest match to this project's shell-routing style (minimal harness, plain completions) and its llama.cpp integration is a template for wiring the local lane |
| **OpenCode** | ✅ AI SDK + models.dev (75+ providers) + local models; `provider`/`model`/`small_model` config [primary: <https://opencode.ai/docs/config/>] | ❌ core has only `small_model` (lightweight tasks; falls back to main model if none); no failure fallback | Community plugin **oh-my-opencode** adds "Provider Fallback: automatic fallback by predefined priority chains" per agent/category [community: <https://lzw.me/docs/opencodedocs/code-yeongyu/oh-my-opencode/platforms/model-resolution/>] — evidence of demand, implemented outside the core |
| **Codex CLI** | ✅ `[model_providers]` in `config.toml` + profiles; any OpenAI-compatible endpoint incl. local llama-server/Unsloth guides [primary: <https://learn.chatgpt.com/docs/config-file/config-advanced>; community: <https://www.morphllm.com/codex-provider-configuration>] | ❌ switching is manual (`/model`, profile selection); no auto-failover documented | Codex CLI is the harness Unsloth documents for driving Qwen3-Coder-Next locally (§2.2) |
| **Cline** | ✅ per-mode provider configs (OpenAI-compatible for LM Studio/llama.cpp) | ❌ native; community feature request #10649 for fallback API profiles [community: <https://github.com/cline/cline/discussions/10649>]; fallbacks achievable via gateways (Requesty blog shows Cline+fallback models via gateway [vendor-gateway: <https://www.requesty.ai/blog/supercharging-cline-with-requesty-models-fallbacks-and-optimizations>]) | Cline instead ships the *model-fit* side: official local-model stack (§2.1) |
| **claude-code-router** | ✅ routes Claude Code traffic per route-type (`default`/`background`/`think`/`longContext`) to arbitrary OpenAI-compatible servers incl. llama-server [community: referenced from <https://github.com/ggml-org/llama.cpp/discussions/14758>; <https://github.com/musistudio/claude-code-router>] | Partial: per-request-type routing, not failure-driven | Prior art for "different lanes per request kind" — analogous to this project's verifier vs generator split |

**Synthesis for Lane E:** nobody in the coding-harness mainstream offers "degrade from subscription/cloud model to local model on throttle" as a built-in; the pieces exist at the proxy layer (LiteLLM/OpenRouter semantics) and in one agent harness (OpenClaw). The project's proxy owning the trigger (its own throttle/Disengage signals) + cooldown/probe-back bookkeeping (OpenClaw pattern) + request-scoped substitution (LiteLLM pattern) is the validated architecture. Because fallback re-executes a request against a different backend, **the two lanes must accept the same wire format** — this project's shell-routing prompt contract is plain chat-completions text, which every candidate model serves.

---

## 2. Candidate models for the fallback lane

### 2.1 Qwen3-Coder-30B-A3B — the proven 8 GB-class agent [mixed evidence]

**Benchmarks:** ~55.4% SWE-bench Verified (vendor-reported at launch, carried from batch-1); absent from the BFCL v4 snapshot (Lane B). On Aider Polyglot the model scores 33.3% with the correct `diff` edit format but only ~8% with the wrong (`whole`) format — see §3.

**Driving REAL harnesses — evidence:**

| Harness | Evidence | Label |
|---|---|---|
| Cline + LM Studio | Official Cline blog: fully offline Cline with Qwen3-Coder-30B-A3B; 262,144 ctx config; "Use compact prompt" (≈10% the size of Cline's full system prompt, built for local models; trades away MCP/Focus Chain); warns long-context ingestion slows over time, suggests halving context or reloading on degradation | [vendor-harness] <https://cline.bot/blog/local-models> |
| Cline (community) | "Cline + Qwen3-coder is bliss for LocalLLM … Match made in heaven. Had too many troubles with roocode and kilocode with Qwen3 due to …" (snippet cut) | [community-snippet] <https://www.reddit.com/r/CLine/comments/1mt14x9/> |
| Roo Code | "it does ~90 token/sec and it's super good to be used with Roo Code" (Apple-hardware context) | [community-snippet] <https://www.reddit.com/r/CLine/comments/1mexlpg/> |
| llama-server + Cline/Roo/Aider/OpenHands/goose/Claude-Code(via claude-code-router) | Official llama.cpp tutorial "Offline Agentic coding with llama-server" (updated 2026-01-07): lists these harnesses as working with llama-server; concrete Cline/Roo setup steps; Qwen3-Coder(-Flash) called the author's "new favorite"; recipe `-ot ".ffn_.*_exps.=CPU" -ctk q4_0 -ctv q4_0 --jinja` | [community, primary host] <https://github.com/ggml-org/llama.cpp/discussions/14758> |
| Serena (MCP agent) | Failure mode: Qwen3-Coder-30B-A3B-Instruct "caught in `think_about_collected_information` loop" — multi-turn agent loops can hang in the model's internal scaffolding | [community] <https://github.com/oraios/serena/discussions/539> |
| General sentiment | "quality dropped drastically when I was using the 30b-a3b coder, and when I swapped to the standard 30b-a3b instruct 2507 it got …" (counter-point: Coder variant vs Instruct-2507 debate) | [community-snippet] <https://www.reddit.com/r/LocalLLaMA/comments/1odf4ei/> |

**Context handling at 256K:**
- 256K native; YaRN rope scaling required beyond 256K toward 1M [primary: vLLM Ascend tutorial <https://docs.vllm.ai/projects/ascend/en/latest/tutorials/models/Qwen3-Coder-30B-A3B.html>; Unsloth long-context guide].
- llama.cpp tutorial author: 80–100K tokens in context is routine in agent sessions, "32k seems to be too small"; KV-cache quant (q4_0) trades quality; `-nkvo` (KV in RAM) restores quality at heavy speed cost. Speed degrades with depth: same 4070 SUPER rig did **~30 t/s tg / ~400 t/s pp initially → ~15 t/s tg / ~300 t/s pp at ~100K context**. [community]
- Cline blog corroborates: long sessions degrade; mitigate by halving context or reloading. [vendor-harness]
- Ollama defaults to a small context window (~32K "theoretical limit" per one user), must be raised explicitly. [community-snippet] <https://medium.com/@pixipace/i-ran-qwen3-coder-locally-for-a-week-instead-of-paying-75-for-claude-heres-what-i-got-wrong-90371c1367ce>

**Tool-call emission:** native JSON function calling through its chat template (`--jinja` in llama.cpp; `--tool-call-parser qwen3_coder` in vLLM — see §3), BUT the same model simultaneously drives XML-tag (Cline) and diff-block (aider) protocols, i.e. its tool behavior is prompt-steerable rather than hard-locked. (§3.2)

**8 GB fit:** Lane A: UD-Q4_K_XL 17.67 GB, `--n-cpu-moe 40` on RTX 3060 Ti 8 GB → **32.5 t/s gen / 51.6 t/s prefill** (community-measured); needs 32 GB+ system RAM.

### 2.2 Qwen3-Coder-Next (80B-A3B) — desktop-tier fallback [mixed evidence]

**Specs** [vendor: <https://huggingface.co/Qwen/Qwen3-Coder-Next>, Unsloth guide]: 80B total / ~3B active; 512 experts, top-10 + shared expert; hybrid Gated-DeltaNet + MoE + gated attention; 256K native (1M via YaRN); **non-reasoning by design — no `<think>` mode**; recommended sampling temp 1.0 / top_p 0.95 / top_k 40 / min_p 0.01.

**Vendor benchmarks** (via Unsloth guide): SWE-Bench Verified 70.6 (w/ SWE-Agent), Multilingual 62.8, Pro 44.3, Terminal-Bench 2.0 36.2, **Aider 66.2** — framed as "comparable to models with 10–20× more active parameters" [vendor]. A dev.to guide claims SWE-bench Verified 42.8% for the same model — contradictory; treat dev.to numbers as low-confidence (likely AI-generated content, last-updated 2026-08-08) [community, low confidence: <https://dev.to/sienna/qwen3-coder-next-the-complete-2026-guide-to-running-powerful-ai-coding-agents-locally-1k95>].

**RAM for full expert-offload** [vendor + community]:
| Quant | Memory needed | Source |
|---|---|---|
| Q4_K_M (official GGUF) | ~48.4 GB (Lane A verified) / ~45–51 GB depending on build | [vendor] Unsloth: "runs on 46 GB RAM/VRAM/unified memory (85 GB for 8-bit)" <https://unsloth.ai/docs/models/qwen3-coder-next>; llama.cpp issue table: Q4_K_M = 51 GB, Q8_0 = 85 GB |
| Q8_0 | ~85 GB → does NOT fit 64 GB | [community] <https://github.com/ggml-org/llama.cpp/issues/19480> |
| Q2_K / Q3 | ~26–40 GB | [community, low confidence] dev.to table |

**64 GB-RAM throughput reports** [community unless noted]:
- **Exact desktop-class data point:** "64GB DDR5 RAM and an AMD Radeon 9070 XT 16GB … offload everything to the GPU but force experts into CPU (39 layers) → **25 tokens/second**" (vs ~10 t/s with 13 layers offloaded). llama.cpp maintainer confirms this is `--n-cpu-moe` semantics. <https://github.com/ggml-org/llama.cpp/issues/19480>
- "64 GB RAM is enough for Qwen3 Coder Next at Q4" <https://www.reddit.com/r/LocalLLaMA/comments/1r2slnz/> [community-snippet]
- "first usable coding model < 60 GB for me … works well with 24 GB VRAM and 64 GB system RAM … 10 tokens per second" <https://www.reddit.com/r/LocalLLaMA/comments/1qz5uww/> [community-snippet]
- RTX 5090 + Unsloth Q4_K_S: ~26 tok/s <https://www.reddit.com/r/LocalLLaMA/comments/1qx2teh/>; two P102-100 GPUs + 128 GB DDR4-2666: 23–24 t/s (same thread) [community-snippet]
- RTX 5060 Ti 16 GB: 15.1 GB VRAM + 30.2 GB RAM when loaded <https://www.reddit.com/r/LocalLLaMA/comments/1qwbmct/>; 64 GB DRAM hybrid: 665 t/s pp / ~36 t/s tg reported <https://www.reddit.com/r/LocalLLaMA/comments/1qxs34w/> [community-snippets]
- Medium: "runs locally on ~46 GB RAM" (member-only, intro only visible) <https://medium.com/coding-nexus/qwen3-coder-next-running-an-80b-coding-model-locally-on-46gb-ram-618cf1cba4be> [community]

**⚠️ The CPU-path anomaly (decisive for this project):** llama.cpp issue #19480 ("CPU inference ~5x slower than expected", closed 2026-03):
- Ryzen AI 9 HX PRO 370 (Zen 5) + 96 GB DDR5-5600, CPU-only: **7.74 t/s** for Next-Q4_K_M vs bandwidth-math expectation of 20–30 t/s; EPYC 9454P: Next 11.76 t/s vs Qwen3-MoE-30B 63.10 t/s at identical active params. Cause: the Gated-DeltaNet/hybrid CPU path reads far more than the 3B active weights; a dedicated DeltaNet op is in progress (#19504). Zen4 with 12-channel DDR5 also reports ~7 t/s; DDR4-3200 CPU mode also ~7 t/s (uses 91 GB RAM).
- Consequence: **Qwen3-Coder-Next is only viable here with a GPU doing routing/attention** (the desktop RX 9070 XT 16 GB, experts-in-CPU pattern → 25 t/s). The local machine's 8 GB card cannot hold enough of Next for that trick at 256K-class context; Next is the desktop fallback, not the local machine's.
- Quant tolerance (same issue, measured PPL): Q4_K_M 8.38 vs Q6_K 8.23 vs Q8_0 8.23 — "Q4_K_M is essentially free quality-wise" for this MoE [community-measured].
- Reliability caveat from the release window: llama.cpp needed a `vectorized key_gdiff` bugfix for "looping and output issues" (Feb 4) and a tool-call parsing fix (Feb 19) — use current llama.cpp builds and current GGUFs [vendor-guide: Unsloth].

**Harness wiring:** Unsloth publishes explicit Codex & Claude Code setup against llama-server (`--alias` must match the model id sent) — real-harness driving of Next is documented, with the usual context-exceeded 400s when `--ctx-size` is too small.

### 2.3 LFM2.5-2.6B — tiny fallback agent [mixed evidence]

**Vendor claims** (Liquid AI, 2026-08): 2.6B dense, 128K context, native tool calling, "trained to work reliably inside agent harnesses like **Hermes Agent, OpenClaw, and Pi**" [vendor: <https://docs.liquid.ai/lfm/models/lfm25-2.6b>]; 220 tok/s on M5 Max in <2.5 GB; BFCL v4 56.9 (vendor table) with 56.9 confirmed on the BenchLM mirror (Lane B) [secondary]; τ³-Bench Banking 5.67 beating 2–4× larger models (vendor, Lane B); four-stage agentic post-training incl. on-policy distillation (Lane B).

**Independent evidence:**
- "Tested LFM2.5 (2.6B dense) on agentic work (tool calling) & coding with llama.cpp — ~90 t/s with Q8 on M5 Pro, ~4 GB" [community-snippet] <https://www.reddit.com/r/LocalLLaMA/comments/1vgfawf/>
- "A 2.6B model with tool calling and 128K context now runs at 30 tok/s …" (desktop-class) [community-snippet] <https://www.reddit.com/r/LocalLLaMA/comments/1vfn9vc/>
- "LFM 2.6B is a lot of fun … fastest model we tested, 220 tokens/s on M5 Max and 113 …" (second number cut, likely phone) [community-snippet] <https://www.reddit.com/r/LocalLLaMA/comments/1vjgp6r/>
- OnePlus 13, pure CPU: ~17 t/s [community-snippet, via <https://www.reddit.com/r/LocalLLaMA/comments/1v6e0uq/>]
- Nous connected it to Hermes Agent [vendor-adjacent: Instagram/Nous]
- HF card: "competitive with models 4x larger on tool use" [vendor: <https://huggingface.co/LiquidAI/LFM2.5-2.6B>]
- VentureBeat framed it as on-device agent model for "high-volume, well-defined agentic tasks" (tool calling, workflows) — independent press, but page now 429s; headline claims per search snippet [independent press] <https://venturebeat.com/technology/no-cloud-no-gpus-no-problem-liquid-ais-new-model-lfm2-5-2-6b-brings-powerful-ai-agents-to-devices-as-small-as-a-raspberry-pi>

**Thinking-mode handling:**
- The base LFM2.5 chat template implements **no thinking toggle** — "cooperates with llama.cpp's history-preservation feature but implements no thinking toggle" [community: <https://github.com/Helldez/BigMoeOnEdge/issues/82>].
- Reasoning is offered as a *separate* model, LFM2.5-1.2B-Thinking [vendor: <https://www.liquid.ai/blog/lfm2-5-1-2b-thinking-on-device-reasoning-under-1gb>].
- Early-integration bug report on the family's GGUFs in llama.cpp: "think tags are being output as general output, not reasoning trace; tool calling is not working" (LFM2.5-8B-A1B-GGUF discussions/1, snippet) [community] — for a verifier-gated execution loop, leaked scaffolding tokens are exactly the failure this project cannot afford; test before adopting.

**Runtimes with working tool support reachable on Windows:**
- **llama.cpp** — official quick-start from Liquid docs (`llama-cli -hf LiquidAI/LFM2.5-2.6B-GGUF`), Unsloth LFM2.5 guide [vendor/primary]. Best OpenAI-tools surface per Lane C (`--jinja` default-on, tool_choice).
- **Ollama** — community GGUF exists (Q4_K_M ~1.7 GB) [community: <https://ollama.com/oamazonasgabriel/lfm2.5-2.6b>]; Lane C: Ollama lacks tool_choice → weaker for structured tool lanes, fine for shell-routing.
- **LM Studio** — LFM2.5 family listed in catalog (1.2B entry verified; 2.6B via GGUF import per HF card "llama.cpp, Ollama, LM Studio, or any compatible app") [vendor].
- **SGLang** `--tool-call-parser lfm2`, **vLLM 0.14** — documented by Liquid, but WSL2-only on Windows (Lane C).
- Recommended sampling [vendor]: temp 0.1, top_k 50, repetition_penalty 1.1.

**Project fit note:** this model was previously DISQUALIFIED as the *intent verifier* (2 unsafe FPs, always-on `<think>`, agentic tool RL — batch-1 frozen corpus). As the *fallback generator* those traits invert: agentic tool RL and harness training are assets, and the verifier (a separate model) still gates every execution. Its 128K context and ~4 GB footprint make it the only candidate that fits fully inside the local machine's 8 GB GPU with context headroom (Lane A: LFM2.5-8B-A1B Q4_K_M 5.16 GB fits fully; 2.6B is smaller still).

---

## 3. Tool-FORMAT fit: fenced ```bash shell-routing vs JSON tool calls

### 3.1 Mechanism — why this works at all

Shell-routing sends a normal chat-completions request with **no `tools`/`functions` parameter**. Chat-template tool branches (jinja `{% if tools %}` blocks in Qwen3-Coder, vLLM parsers, LM Studio tool rendering) only activate when tools are declared. Without them, every candidate is a plain completion model: a fenced ```bash block is just markdown text generation, which coding models do natively. The format question therefore splits into:

1. **Can they stay in plain-text mode** (no JSON/tool-token leakage when they "want" to call a tool)?
2. **Do their RL'd protocols degrade their plain coding output** (format-sensitivity in reverse)?

### 3.2 Evidence per model

**Qwen3-Coder / Qwen3-Coder-Next:**
- Drives Cline's **XML-tag compact prompt** (official stack) — a non-JSON, text-embedded protocol — and Roo Code's XML protocol [vendor-harness + community].
- **aider edit-format data is the cleanest experiment:** Qwen3-Coder-30B-A3B-Instruct on Aider Polyglot scores **8% with `whole` edit format → 33.3% with `diff`** (search/replace blocks) — a 4× swing from format choice alone [community: <https://www.reddit.com/r/LocalLLaMA/comments/1me3vpe/>]; aider's own Qwen3 post presents results split by `diff` vs `whole` edit formats as first-class config [primary: <https://aider.chat/2025/05/08/qwen3.html>]. Aider's formats are fenced/search-replace text, not JSON tools — direct proof strong local coding models follow text-block protocols when asked.
- Native JSON tool mode exists and is well-supported (`--jinja`, vLLM `qwen3_coder` parser, Unsloth tool-calling demo with tool_choice auto) — so the model is **bilingual**: JSON tools when tools are declared, text protocols otherwise.
- Leakage risk is scaffolding loops, not JSON: the Serena `think_about_collected_information` hang (§2.1) — monitor for repeated internal-state blocks in long local sessions.

**LFM2.5-2.6B:**
- RL-trained for JSON/native tool calling inside harnesses (vendor) — when tools ARE declared, it's locked to its tool format; when they are not, it emits plain text. No public evidence of it being prompted into fenced-bash shell-routing specifically — **untested fit**, needs a 28-corpus trial like the verifier bake-off.
- Known leakage: think-tag emission as general output in early llama.cpp builds (family GGUF report) — exactly the class of failure that would poison shell-routing; mitigated by updated builds/templates but must be re-verified.

**GPT-OSS (20b/120b):**
- Harmony protocol is unusually strict: tool calling "works only when the system prompt/history follows Harmony exactly" (Lane B, community). For shell-routing it would again be a plain-text model, but it does not fit 8 GB (Lane A: min ~11.5–12.9 GB) and its post-training is the most format-locked of the three — weakest fit for this lane.

**BFCL format-sensitivity context (Lane B):** small/local models swing **50–81.5 accuracy points** across tool-call formats (flagships only 8.5–23.5); the Natural-Language-Tools study (arXiv 2510.14453) found **+18.4 pp tool-call accuracy** (69.1→87.5%) replacing JSON with natural-language outputs. Lane B's conclusion stands: "strict JSON fails, fenced blocks work" is expected behavior for local models. Shell-routing is on the right side of that asymmetry.

### 3.3 Practical rules for the fallback lane

1. Keep the fallback on the **identical system prompt + shell-routing contract** as the M365 lane; do NOT declare `tools` to the local model (avoids JSON mode entirely).
2. Format-sensitivity cuts both ways: never switch models mid-turn with a different prompt contract; the substitution must be request-scoped with unchanged messages (which is exactly what LiteLLM/OpenRouter fallback semantics do).
3. Budget for scaffolding leakage (think tags, JSON fragments, internal-state loops) in the verifier corpus — the fail-closed intent verifier already catches EXECUTE-shaped garbage, but leakage inflates latency and token spend.
4. If native tool calling is ever wanted (e.g. parallel structured tools later), all three candidates support it through llama.cpp `--jinja` + grammar-constrained decoding (Lane C) without retraining — the shell-routing choice is a policy choice, not a capability ceiling.

---

## 4. Operational shape: desktop vs local machine, DDR5 expert-offload, LAN serving

### 4.1 What the desktop adds over the local machine

| Resource | Laptop (RTX 5060 8 GB) | Desktop (7900X + RX 9070 XT 16 GB + 64 GB DDR5) |
|---|---|---|
| GPU bandwidth | 448 GB/s GDDR7 (8 GB) [primary: TechPowerUp] | ~512 GB/s GDDR6 (RX 9070 XT, 16 GB) |
| VRAM budget for weights | ~6.5–7.0 GiB practical (Lane A) | 16 GB → full attention/embeddings/KV on GPU for 30B-A3B; routing+attention for Next |
| System RAM | limited | 64 GB DDR5 dual-channel → holds Q4 experts of BOTH candidates |
| RAM bandwidth | — | 83.2 GB/s theoretical @DDR5-5200, 89.6 @5600, 96 @6000 [computed: MT/s × 2 channels × 8 B]; practical ≈ 65–80 GB/s (issue #19480 measured ~65 GB/s effective for DDR5-5600 in-bandwidth-math) |
| CPU | local machine-class | 12c/24t Zen4 (physical-core-bound llama.cpp decoding prefers 12 threads; SMT off per #19480 thread-scaling data — note that table measured a dense model, treat as heuristic) |

### 4.2 Expected tokens/s for Qwen3-Coder-30B-A3B on DDR5 dual-channel

Bandwidth model [computed]: decode reads ≈ active params per token ≈ 3.3B × ~4.85 bits/8 ≈ **~2.0 GB/token (Q4_K_M)**.

| Config | Ceiling | Community anchors |
|---|---|---|
| Experts on CPU, attention on RX 9070 XT | 65 GB/s ÷ 2.0 GB ≈ **~32 t/s ceiling** → expect **20–30 t/s** | 4070 SUPER + `-ot .ffn_.*_exps.=CPU`: **30 t/s tg / 400 t/s pp** (#14758); RTX 3060 Ti + i5-14600KF DDR5 + `--n-cpu-moe 40`: **32.5 t/s tg / 51.6 pp** (Lane A) |
| Pure CPU (no GPU) | same bandwidth math minus GPU attn offload → ~15–25 t/s [computed, lower bound] | CPU-only Qwen3-30B-A3B IQ4_XS: 4.76 t/s on the #14758 author's older box; EPYC 48c multi-channel: 63 t/s (#19480 table) — dual-channel desktop lands between |
| Prefill | CPU expert path hurts pp more than tg | #19480: "DDR5-6000 RAM is faster for expert routing"; expect pp ≪ GPU-full numbers; mitigate with KV quant + prompt caching (`-kvu`, #14758) |

So: **desktop expert-offload ≈ 20–30 t/s sustained generation for 30B-A3B** — comparable to the 8 GB-local machine GPU-hybrid numbers but with far more context headroom in 64 GB RAM (KV for 100K+ tokens at q8/q4 KV off-GPU).

### 4.3 Qwen3-Coder-Next on the same desktop

- Q4_K_M (~46–51 GB) fits 64 GB with ~13–18 GB left for KV/OS — tight at 256K context; plan on 32–128K ctx or q4 KV (Unsloth: "set 32,768 for less memory").
- Throughput: **~25 t/s** with full-GPU-offload + experts-on-CPU (RX 9070 XT 16 GB, #19480 — same box class); ~10 t/s with naive 13-layer offload; ~7 t/s CPU-only (do not do this).
- Q8_0 (85 GB) doesn't fit; Q4_K_M PPL ≈ Q8_0 PPL (8.38 vs 8.23) makes 4-bit the rational choice.

### 4.4 Serving the fallback from the desktop to the local machine over LAN — documented pattern

| Runtime | Mechanism | Source |
|---|---|---|
| LM Studio | GUI "Serve on Local Network" (binds non-localhost); CLI `lms server start --bind 0.0.0.0`; docs' stated use case is literally "use a local LLM on your other less powerful devices by connecting them to a more powerful machine"; auth recommended when bound | [primary] <https://lmstudio.ai/docs/developer/core/server/serve-on-network>, <https://lmstudio.ai/docs/cli/serve/server-start> |
| llama-server | `--host 0.0.0.0 --port …` (server README; Lane C: best OpenAI-tools surface, `--jinja` default-on, tool_choice) | [primary] <https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md> |
| Ollama | `OLLAMA_HOST` env var changes bind from default 127.0.0.1:11434 ("How can I expose Ollama on my network?") | [primary] <https://docs.ollama.com/faq> |

Latency check [computed]: home LAN RTT ~0.5–2 ms is negligible against ~50 ms/token at 20 t/s; streaming (SSE) keeps the agent loop's UX identical. Operational notes: Windows Firewall inbound rule for the port; LM Studio warns to enable authentication for non-loopback binds; prefer llama-server on the desktop for headless operation (Lane C verdict: LM Studio "less suited to headless/proxy deployments").

### 4.5 Recommended topology

1. **Desktop** runs `llama-server --host 0.0.0.0` with Qwen3-Coder-30B-A3B (experts on CPU, attention/KV headroom on RX 9070 XT) as the primary fallback endpoint; optionally Qwen3-Coder-Next-Q4 as a second loaded slot when RAM allows (or swap on demand).
2. **Laptop** keeps the verifier (Bonsai-27B-Q1) and can additionally serve LFM2.5-2.6B fully on-GPU as an ultra-fast degraded tier (<2.5 GB, ~30–90+ t/s class).
3. The proxy implements LiteLLM-style `fallbacks` + cooldowns for `M365-model → desktop-lane → local machine-lane`, OpenClaw-style **turn-local** substitution with probe-back to M365, and pre-call context checks (LiteLLM #31557 hazard) with compaction before handoff.

---

## 5. Open questions (for a future bake-off, not resolvable from sources)

- LFM2.5-2.6B in shell-routing mode: zero public reports; needs the project's 28-case style trial (unsafe-FP history as verifier ≠ generator risk, but think-tag leakage must be measured).
- Qwen3-Coder-30B-A3B-Instruct vs -Coder variant for multi-turn agent loops (community split, §2.1).
- Exact tg/pp on THIS desktop (7900X, DDR5 speed unknown from sources — user's DIMMs may be 5200–6000); the 20–30 t/s band is anchored to adjacent rigs, not this one.
- Whether OpenClaw's failover code is reusable/licensable, or merely a design reference.

---

## Sources

Primary (vendor/official):
- <https://docs.litellm.ai/docs/proxy/reliability> · <https://docs.litellm.ai/docs/routing> · <https://docs.litellm.ai/docs/proxy/fallback_management> · <https://github.com/BerriAI/litellm/issues/31557>
- <https://openrouter.ai/docs/guides/routing/model-fallbacks> · <https://openrouter.ai/blog/insights/reliability-failover> · <https://openrouter.ai/blog/insights/model-routing/> · <https://openrouter.ai/blog/tutorials/keep-your-agent-running-when-models-disappear/>
- <https://github.com/lm-sys/routellm> · <https://arxiv.org/abs/2406.18665> (examples/routing_to_local_models.md)
- <https://docs.openclaw.ai/concepts/model-failover>
- <https://pi.dev/docs/latest/providers> (llama.cpp router, custom providers, no fallback) · <https://opencode.ai/docs/config/> · <https://learn.chatgpt.com/docs/config-file/config-advanced> · <https://github.com/cline/cline/discussions/10649> · <https://www.requesty.ai/blog/supercharging-cline-with-requesty-models-fallbacks-and-optimizations> · <https://github.com/musistudio/claude-code-router>
- <https://cline.bot/blog/local-models> · <https://github.com/ggml-org/llama.cpp/discussions/14758> · <https://docs.vllm.ai/projects/ascend/en/latest/tutorials/models/Qwen3-Coder-30B-A3B.html> · <https://aider.chat/2025/05/08/qwen3.html>
- <https://huggingface.co/Qwen/Qwen3-Coder-Next> · <https://unsloth.ai/docs/models/qwen3-coder-next> (RAM figures, Codex/Claude Code wiring, vendor benchmark table, quant benchmarks) · <https://github.com/ggml-org/llama.cpp/issues/19480>
- <https://docs.liquid.ai/lfm/models/lfm25-2.6b> · <https://www.liquid.ai/blog/lfm2-5-2-6b> · <https://huggingface.co/LiquidAI/LFM2.5-2.6B> · <https://huggingface.co/LiquidAI/LFM2.5-2.6B-GGUF> · <https://www.liquid.ai/blog/lfm2-5-1-2b-thinking-on-device-reasoning-under-1gb> · <https://unsloth.ai/docs/models/tutorials/lfm2.5> · <https://benchlm.ai/benchmarks/bfcl-v4>
- <https://lmstudio.ai/docs/developer/core/server/serve-on-network> · <https://lmstudio.ai/docs/cli/serve/server-start> · <https://docs.ollama.com/faq> · <https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md>
- Cross-lane: Lane A (8 GB fit, `--n-cpu-moe` numbers, gpt-oss size) · Lane B (BFCL v4 format-sensitivity, arXiv 2510.14453, LFM2.5 post-training, Harmony strictness) · Lane C (runtime tool surfaces, `--jinja` default, vLLM WSL-only, LM Studio headless verdict)

Community (labeled in text; Reddit items are search-snippet-derived because Reddit blocks direct retrieval):
- <https://www.reddit.com/r/CLine/comments/1mt14x9/> · <https://www.reddit.com/r/CLine/comments/1mexlpg/> · <https://www.reddit.com/r/LocalLLaMA/comments/1odf4ei/> · <https://github.com/oraios/serena/discussions/539> · <https://www.reddit.com/r/LocalLLaMA/comments/1me3vpe/>
- Qwen3-Coder-Next: <https://www.reddit.com/r/LocalLLaMA/comments/1r2slnz/> · <https://www.reddit.com/r/LocalLLaMA/comments/1qz5uww/> · <https://www.reddit.com/r/LocalLLaMA/comments/1qx2teh/> · <https://www.reddit.com/r/LocalLLaMA/comments/1qwbmct/> · <https://www.reddit.com/r/LocalLLaMA/comments/1qxs34w/> · <https://www.reddit.com/r/LocalLLaMA/comments/1r9uu5h/> · <https://medium.com/coding-nexus/qwen3-coder-next-running-an-80b-coding-model-locally-on-46gb-ram-618cf1cba4be> · <https://dev.to/sienna/qwen3-coder-next-the-complete-2026-guide-to-running-powerful-ai-coding-agents-locally-1k95> (low confidence)
- LFM2.5: <https://www.reddit.com/r/LocalLLaMA/comments/1vgfawf/> · <https://www.reddit.com/r/LocalLLaMA/comments/1vfn9vc/> · <https://www.reddit.com/r/LocalLLaMA/comments/1vjgp6r/> · <https://www.reddit.com/r/LocalLLaMA/comments/1v6e0uq/> · <https://github.com/Helldez/BigMoeOnEdge/issues/82> · <https://huggingface.co/LiquidAI/LFM2.5-8B-A1B-GGUF/discussions/1> · <https://ollama.com/oamazonasgabriel/lfm2.5-2.6b> · <https://venturebeat.com/technology/no-cloud-no-gpus-no-problem-liquid-ais-new-model-lfm2-5-2-6b-brings-powerful-ai-agents-to-devices-as-small-as-a-raspberry-pi>
- OpenCode plugin fallback: <https://lzw.me/docs/opencodedocs/code-yeongyu/oh-my-opencode/platforms/model-resolution/> · OpenRouter fallback edge case: <https://www.reddit.com/r/openrouter/comments/1pi0r8j/> · Codex providers: <https://www.morphllm.com/codex-provider-configuration> · Ollama LAN: <https://github.com/ollama/ollama/issues/703>
