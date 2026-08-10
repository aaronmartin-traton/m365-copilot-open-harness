# Lane B — Tool-use architectures: what makes open-weight local models good at agentic tool calling
> Snapshot as of 2026-08-09.


**Date of research:** 2026-08-09. **Scope:** evidence review for selecting open-weight models that can run multi-turn, function-calling agent loops on a small local GPU (8 GB class, e.g. RTX 5060). Companion lanes cover VRAM fit and Blackwell runtime support; this note focuses on architectures, training recipes, benchmarks, failure modes, and format sensitivity.

**Method note:** leaderboard figures below were pulled directly from the official BFCL leaderboard CSV (`data_overall.csv`, leaderboard last updated 2026-04-12, models evaluated at commit `f7cf735`, linked from https://gorilla.cs.berkeley.edu/leaderboard.html) on 2026-08-09. Vendor benchmark claims are labeled **vendor claim**; Reddit/forum evidence is labeled **community-reported**. Anything dated after mid-2026 is time-sensitive and may already have moved.

---

## 1. Architecture & training factors that produce good tool use

### 1.1 Function-calling SFT/RL data mixtures

- The dominant 2025–2026 recipe is: broad SFT with heavily re-weighted tool/agentic slices → reinforcement learning with *executable environments* and verifiable rewards. Examples:
  - **Qwen3-Coder** (2025-07): execution-driven "Code RL" plus long-horizon "Agent RL" run against ~20,000 parallel sandboxed environments; Qwen states this is how it reached SOTA-among-open-models on SWE-bench Verified without test-time scaling (vendor claim, https://qwenlm.github.io/blog/qwen3-coder/).
  - **Qwen3-Coder-Next** (2026-02): "agentic training through large-scale synthesis of verifiable coding tasks paired with executable environments, allowing learning directly from environment feedback via mid-training and reinforcement learning" (https://arxiv.org/abs/2603.00729).
  - **LFM2.5-2.6B** (2026-08): four-stage pipeline — SFT (mix ~7× larger than its predecessor, weighted toward tool use / web search / SWE / agent traces) → domain-specialist teacher training with RLVR → on-policy multi-domain distillation (MOPD) → *agentic RL inside real agent harnesses* (OpenClaw, Hermes Agent) with GRPO, an LLM-judge rubric plus programmatic checks (https://www.liquid.ai/blog/lfm2-5-2-6b).
- **Data supply is a recognized bottleneck.** TOUCAN (2025-10) synthesizes 1.5M tool-agentic trajectories from ~500 real MCP servers with actual tool execution; models fine-tuned on it "outperform larger closed-source counterparts on the BFCL V3 benchmark" (https://arxiv.org/abs/2510.01179). Fireworks similarly markets reinforcement fine-tuning specifically for function calling (https://fireworks.ai/blog/reinforcement-fine-tuning).
- Dedicated tool-call model lines exist precisely because generic instruct tuning is insufficient: Salesforce **xLAM-2-*-fc-r**, MadeAgents **Hammer2.1**, Huawei **ToolACE-2**, Bittensor **BitAgent**, katanemo **Arch-Agent** — all appear as FC-specialized entries on BFCL (§2.1).

### 1.2 Reasoning (thinking) modes and switching them off for tool loops

- **Qwen3** unified thinking/non-thinking modes in one model with per-request switching (`enable_thinking`, `/think` `/no_think`) and a "thinking budget" (https://arxiv.org/abs/2505.09388). Its coding-agent descendants went the other way: **Qwen3-Coder-30B-A3B and Qwen3-Coder-Next support only non-thinking mode** and explicitly do not emit `<think>` blocks (https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct, https://huggingface.co/Qwen/Qwen3-Coder-Next). This is a deliberate design choice for agent loops, where reasoning tokens inflate latency and KV usage without always improving tool decisions.
- **gpt-oss** exposes low/medium/high reasoning effort settable in one system-prompt sentence (https://openai.com/index/introducing-gpt-oss/); **Mistral Small 4** exposes per-request `reasoning_effort` ("none"/"high") alongside function calls (https://huggingface.co/mistralai/Mistral-Small-4-119B-2603).
- **IBM split Granite 4.0 into separate Instruct and Thinking variants**, reporting that the split improved instruction following for Instruct and reasoning for Thinking, and simplified chat templates (https://www.ibm.com/new/announcements/ibm-granite-4-0-hyper-efficient-high-performance-hybrid-models, 2025-10-02).
- Independent evidence that heavy reasoning can hurt in tool loops: on τ²-bench, Quesma measured o3 at 58% vs GPT-5 at ~97%; a *non*-reasoning small model (GPT-5-mini) reached 67.5% after a prompt rewrite — beating o3 (https://quesma.com/blog/tau2-benchmark-improving-results-smaller-models/, 2025-09-12). BFCL v3 error analysis documents "LLMs incur unnecessary planning" (re-authenticating an already-authenticated API) as a recurring failure (https://gorilla.cs.berkeley.edu/blogs/13_bfcl_v3_multi_turn.html).
- Reasoning tokens are also a measurable cost: Artificial Analysis' τ²-bench leaderboard splits output tokens per task into reasoning vs answer tokens (https://artificialanalysis.ai/evaluations/tau2-bench). Liquid AI's eval footnote even records that for Qwen3.5 models "greedy decoding degrades performance due to doom looping" inside agent harnesses (https://www.liquid.ai/blog/lfm2-5-2-6b) — thinking-style models can spin in loops inside agent scaffolds.

### 1.3 Chat-template tool syntax differences (JSON-schema vs XML vs Python-style)

- Every family ships its own wire format, and runtimes must match it:
  - **OpenAI-style JSON-schema tools** (tools array + JSON `arguments`) are the de-facto standard: Qwen3-Coder, Mistral, Granite, LFM2, Hermes 4 all consume it via their chat templates.
  - **Python-call syntax** (`[func(a=1)]`) is the BFCL/Gorilla house format and vLLM's "pythonic" style; vLLM's docs note "a growing number of models output a python list to represent tool calls instead of using JSON", which inherently supports parallel calls (https://docs.vllm.ai/en/latest/features/tool_calling/).
  - **XML-ish tags** appear in Anthropic-style templates and in Hermes' original function-calling repo (JSON payload inside `<tool_call>` tags; https://github.com/NousResearch/Hermes-Function-Calling).
  - **Harmony** (gpt-oss): a channel/commentary/response format (`<|channel|>commentary` etc.) with its own renderer; the models were post-trained on it (https://openai.com/index/introducing-gpt-oss/, https://cookbook.openai.com/articles/openai-harmony).
- BFCL v4's format-sensitivity study (§4) shows these syntaxes are *not* interchangeable for a given model: models trained for one return format can collapse to near-zero when asked for another.
- Practical consequence: Qwen ships a **custom tool parser** (`qwen3_coder` in vLLM/SGLang) and warns users to use the updated tokenizer because "we updated both the special tokens and their corresponding token ids" (https://github.com/QwenLM/Qwen3-Coder). Mistral Small 4 similarly needed a patched vLLM build for tool-call parsing at launch (https://huggingface.co/mistralai/Mistral-Small-4-119B-2603).

### 1.4 Native tool tokens / special tokens

- **gpt-oss**: native Harmony special/channel tokens; running it through a generic chat template breaks tool behavior (community-reported: token-ordering mismatch in the shipped chat template, https://huggingface.co/openai/gpt-oss-20b/discussions/218; grammar/tool-token leakage in llama.cpp, https://github.com/ggml-org/llama.cpp/discussions/15341; "To properly use tools, the model requires native Harmony chat format", https://arxiv.org/html/2604.00362v1).
- **Qwen3-Coder/Next**: dedicated tool-call special tokens + dedicated parser (§1.3; the GitHub README explicitly flags the token-id change).
- **Granite 4.0**: chat template returns tool calls inside `<tool_call>` tags per the official Granite docs (https://www.ibm.com/granite/docs/models/granite); llama.cpp-side tooling shows a `<|tool_call|>` special-token variant in Granite 4.0 eval runs (community-reported, https://buttondown.com/weekly-project-news/archive/weekly-github-report-for-llamacpp-september-01-2025/).
- BFCL v4 treats "tool calling tag" (`<TOOLCALL>`) as a first-class evaluation variable because "it is common for modern LLMs to mark function calls with special tokens" (https://gorilla.cs.berkeley.edu/blogs/17_bfcl_v4_prompt_variation.html).

### 1.5 Architectural trends for local agent models (2025–2026)

- **Sparse MoE with tiny active counts** is the main route to agentic capability on consumer GPUs: gpt-oss-20b (21B total / 3.6B active), Qwen3-Coder-30B-A3B (30.5B / 3.3B), Qwen3-Coder-Next (80B / 3B), Mistral Small 4 (119B / 6.5B active), Granite 4.0-H-Small (32B / 9B), LFM2.5-8B-A1B. Active params drive decode speed; total params drive the weight footprint.
- **Hybrid attention/SSM architectures** target the long-context agent regime: Granite 4.0 (Mamba-2 : transformer 9:1, no positional encoding, 512K training context, "over 70% reduction in RAM" for long inputs and concurrent sessions; https://www.ibm.com/new/announcements/ibm-granite-4-0-hyper-efficient-high-performance-hybrid-models) and Qwen3-Coder-Next (Gated DeltaNet + Gated Attention hybrid, 512 experts / 10 active; https://huggingface.co/Qwen/Qwen3-Coder-Next). Long context matters because tool-loop transcripts grow quickly (§3.4–3.5).

---

## 2. Independent benchmark evidence

### 2.1 Berkeley Function Calling Leaderboard (BFCL v4)

Official leaderboard: 109 models; last updated 2026-04-12; data from https://gorilla.cs.berkeley.edu/data_overall.csv (retrieved 2026-08-09). Overall score composition: Agentic (web search + memory) 40%, Multi-Turn 30%, Live 10%, Non-Live 10%, Hallucination 10% (https://gorilla.cs.berkeley.edu/blogs/15_bfcl_v4_web_search.html).

Frontier reference points (same CSV): Claude-Opus-4-5 **77.47%**, Claude-Sonnet-4-5 73.24%, GLM-4.6 (FC thinking) 72.38%, GPT-5.2 55.87%, **GPT-5-mini 55.46%** (multi-turn only 27.5%).

**Best open-weight models in the ≤13B class (BFCL v4 overall):**

| Model (org) | Size | Overall | Multi-turn | Live parallel-multiple | Irrelevance detection | Notes |
|---|---|---|---|---|---|---|
| Nanbeige4-3B-Thinking-2511 (Nanbeige) | 3B | **51.40%** | 51.1% | 70.8% | 83.1% | standout: 3B thinking model near GPT-5-mini overall |
| xLAM-2-8b-fc-r (Salesforce) | 8B | 46.68% | **70.0%** | 54.2% | 63.3% | best 8B overall; multi-turn beats GPT-5-mini by 2.5× |
| BitAgent-Bounty-8B (Bittensor) | 8B | 46.23% | 62.4% | **95.8%** | **97.5%** | parallel calling & irrelevant-call refusal exceptional |
| ToolACE-2-8B (Huawei/USTC) | 8B | 42.44% | 38.4% | 62.5% | 90.8% | but format-sensitivity max delta **81.5** (§4) |
| Qwen3-8B (Qwen) | 8B | 42.57% | 41.8% | 79.2% | 79.1% | generalist, not tool-tuned |
| xLAM-2-3b-fc-r (Salesforce) | 3B | 41.22% | 58.4% | 50.0% | 63.5% | best sub-4B dedicated FC model |
| Qwen3-4B-Instruct-2507 (Qwen) | 4B | 35.68% | 22.1% | 66.7% | 84.9% | best generalist <8B |
| Arch-Agent-3B / 1.5B (katanemo) | 3B / 1.5B | 35.36% / 32.14% | 34.9% / 26.6% | 75.0% / 58.3% | 74.7% / 74.8% | phone-class agent models |
| Hammer2.1-7b (MadeAgents) | 7B | 31.67% | 23.9% | 75.0% | 90.1% | web search 0%, memory 0% |
| Granite-4.0-350m (IBM) | 0.35B | 18.98% | 2.5% | 33.3% | 60.8% | smallest FC entry; trivial calls only |
| Mistral-small-2506 (Mistral) | 24B | 37.15% | 11.5% | 70.8% | 87.9% | family context (>13B); weak multi-turn |

Patterns visible in the full table: (a) tool-tuned small models (xLAM-2, BitAgent, Nanbeige4) beat much larger generalists on multi-turn; (b) the same models collapse on the agentic web-search/memory categories (xLAM-2-8b web search 6.5%, memory 14.0%) — FC-tuning alone does not transfer to full agent behavior; (c) **Qwen3-Coder and GPT-OSS are absent from the current BFCL v4 snapshot**, so BFCL cannot directly arbitrate them as of this date.

Also on the leaderboard but vendor-reported elsewhere: **LFM2.5-2.6B scores BFCL v4 56.88** in Liquid AI's table — ahead of gemma-4-E2B (36.98), gemma-4-E4B (46.39), Qwen3.5-4B (50.56), trailing only Qwen3.5-9B (60.13) (vendor claim, https://www.liquid.ai/blog/lfm2-5-2-6b; a BenchLM mirror of BFCL v4 shows LFM2.5-2.6B at 56.9%, https://benchlm.ai/benchmarks/bfcl-v4, 2026-08-07).

### 2.2 τ-bench / τ²-bench

- **τ-bench** (Sierra, 2024-06; https://arxiv.org/abs/2406.12045): "even state-of-the-art function calling agents (like gpt-4o) succeed on <50% of the tasks, and are quite inconsistent across multiple trials." Its pass^k metric is the key reliability measure: GPT-4o drops to **~25% on pass^8 in τ-retail, a ~60% relative drop** from pass^1 (https://sierra.ai/blog/benchmarking-ai-agents). Reliability across repeated trials — not single-shot accuracy — is the binding constraint for agent loops.
- **τ²-bench** (dual-control telecom domain; https://arxiv.org/abs/2506.07982; code https://github.com/sierra-research/tau2-bench). Independent Artificial Analysis runs (https://artificialanalysis.ai/evaluations/tau2-bench, viewed 2026-08-09): leaders are **JT-35B-Flash 99.1%**, GLM-5.2 (max) 99.1%, GLM-4.7-Flash (Reasoning) 98.8%. **No ≤13B open model appears in the independently benchmarked set** — small open models are effectively untested on τ²-bench by independent labs as of this date.
- The strongest published small-model result on τ²-bench is a prompt-engineering study: GPT-5-mini rose from 55% to **67.5%** pass^1 purely by rewriting domain policies into step-by-step, binary-decision instructions (Quesma, https://quesma.com/blog/tau2-benchmark-improving-results-smaller-models/, 2025-09-12). Takeaway: small-model tool performance is highly prompt/policy-format dependent — directly relevant to §4.
- Vendor-reported adjacent numbers: LFM2.5-2.6B reports τ³-Bench Banking 5.67 vs 3.35–5.45 for 2–4× larger Gemma/Qwen models (vendor claim, https://www.liquid.ai/blog/lfm2-5-2-6b).

### 2.3 SWE-bench Verified

The official leaderboard evaluates every model in the same mini-SWE-agent harness on 500 human-filtered instances (https://www.swebench.com/, viewed 2026-08-09). Relevant open models at ≤30B:

| Model | Size | SWE-bench Verified | Source |
|---|---|---|---|
| Qwen3-Coder-Next | 80B / 3B act | ~70.6–71.3% | vendor claim in tech report tables, https://arxiv.org/abs/2603.00729 |
| Qwen3-Coder-480B-A35B | 480B / 35B act | 69.6% | vendor claim, https://qwenlm.github.io/blog/qwen3-coder/ (context only, far above 13B) |
| Devstral Small 2 | 24B | **68.0%** | vendor claim, https://mistral.ai/news/devstral-2-vibe-cli/ |
| Qwen3-Coder-30B-A3B | 30.5B / 3.3B act | ~55.4% | mini-SWE-agent run by Anyscale, cited at https://github.com/SWE-agent/mini-swe-agent/issues/469 (community-reported secondary) |
| Devstral Small 1.1 | 24B | 53.6% | vendor claim, https://mistral.ai/news/devstral-2507/ |

No ≤13B open model posts a SWE-bench Verified number in the ~50%+ tier as of this writing; the benchmark separates at ~24B+ for open weights. For an 8 GB deployment, BFCL multi-turn and τ²-style harnesses are the more relevant yardsticks.

---

## 3. Documented failure modes of small models in tool loops

### 3.1 Parallel / batched calls break first
BFCL v4 leaderboard columns show Live Parallel-Multiple as a consistent weak point (xLAM-2-1b 25.0%, Llama-3.2-3B 37.5%, Phi-4 41.7% — vs BitAgent-Bounty-8B 95.8%; official CSV). BFCL v4's failure gallery includes models wrapping each parallel call in its own `<functions>`/`<TOOLCALL>` wrapper instead of one batch (https://gorilla.cs.berkeley.edu/blogs/17_bfcl_v4_prompt_variation.html, §5.1). vLLM's docs note python-list call syntax exists partly because it "inherently support[s] parallel tool" calls where JSON variants struggle (https://docs.vllm.ai/en/latest/features/tool_calling/).

### 3.2 JSON schema drift and quote/escape corruption
BFCL v4 documents Llama-3.1-70B emitting broken JSON (`{\"service_id:"\2\"...}`) and Gemma-3-27B over-escaping attributes when asked to embed JSON inside XML (https://gorilla.cs.berkeley.edu/blogs/17_bfcl_v4_prompt_variation.html). "How Good Are LLMs at Processing Tool Outputs?" finds processing structured JSON tool *responses* is a distinct weak skill (https://arxiv.org/html/2510.15955v1).

### 3.3 Hallucinated arguments and invented state
BFCL v3's error analysis shows models skipping prerequisite reads and fabricating values: filling a fuel tank to capacity without checking the current level, re-authenticating with credentials never provided, `mkdir`-ing a directory they are already in (https://gorilla.cs.berkeley.edu/blogs/13_bfcl_v3_multi_turn.html, "Result & Error Analysis"). BFCL v4 web-search analysis adds "avoids tool usage" — answering from parametric memory despite having tools (https://gorilla.cs.berkeley.edu/blogs/15_bfcl_v4_web_search.html). BFCL keeps a dedicated Hallucination Measurement category for this (https://gorilla.cs.berkeley.edu/leaderboard.html).

### 3.4 Forgetting tool syntax / looping mid-conversation
BFCL v3 force-terminates turns after 20 steps because models "get stuck in a loop or are unable to make progress (e.g., repeatedly calling `ls`)" (https://gorilla.cs.berkeley.edu/blogs/13_bfcl_v3_multi_turn.html). Its Long-Context Multi-Turn category exists precisely to measure accuracy decay under growing transcripts, and small models score badly there (Hammer2.1-7b memory 0.0%, Granite-4.0-350m multi-turn 2.5%; official CSV).

### 3.5 Context rot
Chroma's technical report shows performance degrades non-uniformly with input length for every model tested, including GPT-4.1 and Claude 4 (https://www.trychroma.com/research/context-rot, July 2025). NoLiMa: at 32K tokens, **11 of 13 models claiming ≥128K context drop below 50% of their short-context baseline** when literal lexical overlap between needle and haystack is removed — the normal situation in agent transcripts (https://arxiv.org/abs/2502.05167).

### 3.6 Reasoning-token overhead and over-planning
See §1.2: unnecessary planning documented in BFCL v3; reasoning tokens dominating output budgets on τ²-bench (Artificial Analysis); doom-looping of thinking models in harnesses (Liquid AI blog footnote); o3's underperformance vs prompt-tuned GPT-5-mini on τ²-bench (Quesma).

### 3.7 Inconsistency across retries
τ-bench pass^k: GPT-4o ~25% at pass^8 in τ-retail (https://sierra.ai/blog/benchmarking-ai-agents). NLT measured high output variance under JSON tool formats and a 70% variance reduction when the format changed (§4.3) — variance, not mean accuracy, is often what breaks loops.

---

## 4. Format sensitivity: does the tool-call output format change reliability?

**Direct answer: yes. This is one of the best-documented phenomena in function-calling research as of 2026-08, and the parent project's finding (strict JSON failing, shell-style fenced bash blocks producing real agent loops) is consistent with independent evidence.**

### 4.1 BFCL v4 "Format Sensitivity" category
26 prompt configurations × 200 cases, varying return format (python/json/verbose_xml/concise_xml), function-doc format (json/xml/python), `<TOOLCALL>` tags, plaintext vs markdown, and prompt wording (https://gorilla.cs.berkeley.edu/blogs/17_bfcl_v4_prompt_variation.html, released 2025-07-17). Headline findings:
- Return format: "a general trend — particularly for smaller models — where performance is higher when the model is prompted to return function calls in **Python or JSON** format, compared to either of the XML formats."
- Function-doc format: "performance is highest with functions in JSON format, lower with XML, and lowest with Python" across nearly all models.
- Tool-call tags: small penalty on average, but "some small models (e.g., **Llama-3.1-8B-Instruct, BitAgent-8B**) demonstrate significant performance drops."
- Format-locked specialists: "several models that are trained specifically for tool use show significant drops (even to 0 accuracies) when we change the return format" — watt-tool-70B cannot emit JSON at all; CoALM-70B goes near-zero once a `<TOOLCALL>` tag is required.

### 4.2 Official leaderboard format-sensitivity deltas
The leaderboard publishes a "Format Sensitivity Max Delta" column (accuracy swing across formats; measured for prompt-mode runs, https://gorilla.cs.berkeley.edu/leaderboard.html; official CSV retrieved 2026-08-09). Small/local models are dramatically more format-sensitive than flagships:

| Model | Max format delta (points) |
|---|---|
| ToolACE-2-8B | 81.5 |
| Phi-4 | 81.5 |
| CoALM-8B | 79.0 |
| Llama-3.1-8B-Instruct | 74.5 |
| MiniCPM3-4B | 68.0 |
| Gemma-3-12b-it | 67.5 |
| Mistral-Small-2506 | 50.0 |
| GPT-4.1 | 23.5 |
| Claude-Opus-4-5 | 13.0 |
| Gemini-3-Pro | 8.5 |

Caveat: BFCL only measures format sensitivity for non-native-FC ("prompt") runs — but that is exactly the regime a proxy exercises when it asks a base model for tool calls in a custom text format.

### 4.3 Natural-language and code-style formats beat JSON for open weights
- **Natural Language Tools** (https://arxiv.org/abs/2510.14453, 2025-10; 10 models, 6,400 trials): replacing programmatic JSON tool calling with natural-language outputs improved tool-call accuracy by **+18.4 points (69.1%→87.5%)** and cut output variance by 70%; "**open-weight models see the largest gains**, surpassing flagship closed-weight alternatives", and gains persist under prompt perturbation. (Community discussion: community-reported, https://www.reddit.com/r/MachineLearning/comments/1o8szk0/r_plain_english_outperforms_json_for_llm_tool/.)
- **Code-as-action**: reporting on pseudocode-tool-calling work — "All five Anthropic models and the three newest GPT generations matched or beat the JSON baseline" (https://www.arxivnews.org/en/articles/e8533b57-1d34-4b7c-906a-d989c5d0f575); CodeAct-style reasoning is discussed in https://substack.com/home/post/p-167344254. Models have far more bash/code in pretraining than JSON-schema tool calls, which plausibly explains why fenced shell blocks out-performed strict JSON in the parent project.
- **Native-format fragility**: gpt-oss needs its Harmony renderer; with generic templates or grammars it leaks raw Harmony tokens or misorders function-call tokens (community-reported: https://huggingface.co/openai/gpt-oss-20b/discussions/218, https://github.com/ggml-org/llama.cpp/discussions/15341, https://arxiv.org/html/2604.00362v1).
- **Prompt/policy format alone moves small models 20+ points** on τ²-bench (Quesma, §2.2), and Qwen3-8B's BFCL accuracy swings 16.5 points across prompt formats (official CSV).

### 4.4 Implication for m365-copilot-proxy
The "strict JSON fails, fenced bash blocks work" observation is the *expected* behavior for small/local models, not a bug: (a) JSON-schema tool calling is a thin post-training artifact that degrades first under format perturbation; (b) fenced/shell-style output lives in high-density pretraining territory; (c) variance — not mean accuracy — is where JSON hurts most. Practical guidance when putting a local model behind the proxy: (i) let the model emit the format its own chat template was trained with instead of re-templating it into JSON; (ii) parse defensively with repair/regex fallbacks; (iii) for ≤8B models, prefer natural-language or code-style action formats; (iv) never mix a model's native special-token format with a generic chat template (see gpt-oss/Harmony).

---

## 5. Model families tuned for tool/coding agents (state of play 2026-08)

### Qwen3 / Qwen3-Coder (Alibaba)
- **Claims:** Qwen3 (2025-05) integrates thinking/non-thinking modes + thinking budget; "state-of-the-art results across ... agent tasks" (https://arxiv.org/abs/2505.09388); the same tech report claims Qwen3-235B-A22B scored 70.8 on BFCL v3 (vendor claim). Qwen3-Coder-480B-A35B: "state-of-the-art among open models on Agentic Coding, Agentic Browser-Use, and Agentic Tool-Use, comparable to Claude Sonnet 4", SWE-bench Verified 69.6% (vendor claim, https://qwenlm.github.io/blog/qwen3-coder/). Qwen3-Coder-30B-A3B: non-thinking only, 256K native context, "specially designed function call format" (https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct). Qwen3-Coder-Next (2026-02, 80B total / 3B active, Gated-DeltaNet hybrid): built "specifically for coding agents and local development"; "excels at long-horizon reasoning, complex tool usage, and recovery from execution failures"; the tech report reports SWE-bench Verified in the ~70.6–71.3% range (vendor claim, https://arxiv.org/abs/2603.00729, https://huggingface.co/Qwen/Qwen3-Coder-Next, https://github.com/QwenLM/Qwen3-Coder).
- **Independent evidence:** BFCL v4 lists generalist Qwen3-8B 42.57% / Qwen3-4B 35.68% (official CSV) — solid but below the dedicated FC models; Qwen3-Coder variants are absent from the BFCL v4 snapshot. Qwen3-Coder-30B-A3B ~55.4% SWE-bench Verified via Anyscale's mini-SWE-agent run (community-reported secondary, https://github.com/SWE-agent/mini-swe-agent/issues/469). Liquid AI's comparison table puts Qwen3.5-9B at BFCLv4 60.13 (vendor-of-Liquid table, https://www.liquid.ai/blog/lfm2-5-2-6b).

### GPT-OSS-20B / 120B (OpenAI)
- **Claims:** "demonstrate strong tool use capabilities"; post-trained "to apply CoT reasoning and tool use before producing its answer"; strong on the τ-bench agentic suite; native MXFP4 (20b fits 16 GB; the 20b MXFP4 checkpoint is ~12.8 GiB, so it does **not** fit an 8 GB GPU); 128K context; MoE 21B total / 3.6B active (https://openai.com/index/introducing-gpt-oss/, 2025-08-05; model card https://arxiv.org/abs/2508.10925). The model card's τ-bench retail numbers (vendor claim, high reasoning effort): gpt-oss-120b 67.8%, gpt-oss-20b 54.8% — i.e., the 8GB-adjacent variant is materially weaker at agent loops.
- **Independent evidence:** OpenAI's τ-bench numbers are the main published metric; no BFCL v4 entry in the current snapshot. Community experience: tool calling works but **only when the system prompt/history follows Harmony exactly** (community-reported: https://www.reddit.com/r/LocalLLaMA/comments/1n0aijh/gpt_oss_120b/, https://huggingface.co/openai/gpt-oss-20b/discussions/218, https://arxiv.org/html/2604.00362v1). This is itself a strong format-sensitivity datapoint for the proxy design question.

### Nous Research Hermes
- **Claims:** Hermes 2 Pro onward shipped JSON-in-XML-tag function calling plus an agent scaffold (https://github.com/NousResearch/Hermes-Function-Calling; https://nousresearch.com/hermes3/). **Hermes 4** (14B/70B/405B on Llama-3.1, 2025-08) is a hybrid-reasoning family with a native `<tool_call>`/`</tool_response>` function-calling template; tool behavior was trained in Nous' Atropos tool-use RL environment (https://arxiv.org/abs/2508.18255, tech report 2025-08-25; https://huggingface.co/NousResearch/Hermes-4-70B). **Hermes 4.3-36B** (2025-12, post-trained from ByteDance Seed-OSS-36B on Nous' Psyche decentralized network, 512K context, native `<tool_call>`) is the current small agent-capable entry (https://huggingface.co/Doradus-AI/Hermes-4.3-36B-FP8; community-reported: https://localaimaster.com/blog/hermes-agent-ollama). No Hermes 5 has shipped as of 2026-08. The Hermes tool-call format has become a de-facto standard reused by other stacks (community-reported: https://localaimaster.com/blog/hermes-agent-ollama), and Nous' "Hermes Agent" harness is what Liquid AI used as an agentic-RL environment (https://www.liquid.ai/blog/lfm2-5-2-6b).
- **Independent evidence:** no Hermes 4 entries on the official BFCL v4 / τ² leaderboards; a secondary source reports ~81.7% BFCL for Hermes-4-70B (community-reported, Presenc, 2026-05-23 — unverified against the official leaderboard, where no such row exists in the current snapshot). Treat tool-use claims as vendor-only until independently reproduced.

### Firefunction V2 (Fireworks AI)
- **Claims:** "function calling capability on par with GPT-4o at 2.5x the speed and 1/10 the cost"; tuned from Llama-3-70B; optimized for multi-turn conversation, instruction following, and **parallel function calling** (https://fireworks.ai/blog/firefunction-v2-launch-post, 2024-06-17; https://ollama.com/library/firefunction-v2; card https://huggingface.co/fireworks-ai/llama-3-firefunction-v2). Fireworks' RFT product targets function calling (https://fireworks.ai/blog/reinforcement-fine-tuning).
- **Independent evidence:** dated (2024). The launch post reports a vendor-run medley (Gorilla/Nexus/MT-Bench-style) average of 0.81 vs GPT-4o's 0.80, with 8K context (https://fireworks.ai/blog/firefunction-v2-launch-post). No V3 exists; absent from the current BFCL v4 snapshot; superseded by the 2025–26 dedicated FC models in §2.1.

### IBM Granite 4.0
- **Claims:** hybrid Mamba-2/transformer + MoE, Apache 2.0; h-Small (32B total / 9B active) positioned for "multi-tool agents and customer support automation"; Tiny/Micro as low-latency building blocks "for fast execution of key tasks such as function calling"; Granite-4.0-H-Small "keeps pace with much larger models ... on the Berkeley Function Calling Leaderboard v3 benchmark (BFCLv3)" (vendor claim + vendor chart, https://www.ibm.com/new/announcements/ibm-granite-4-0-hyper-efficient-high-performance-hybrid-models, 2025-10-02). Tool calls via `<tool_call>` template tags (https://www.ibm.com/granite/docs/models/granite).
- **Independent evidence:** BFCL v4 official snapshot lists only Granite-4.0-350m — overall 18.98%, multi-turn 2.5% (official CSV) — and legacy Granite-3.x-8B at 27.1–27.6%. The BFCLv3 comparison in IBM's announcement is vendor-run. Community fine-tunes (e.g., Toucan-trained h-micro, https://huggingface.co/Shumatsurontek/granite-4.0-h-micro-Toucan-120k) indicate tool calling is a recognized use case (community-reported).

### Mistral Small (3.x / 4) and Devstral
- **Claims:** Mistral Small 3/3.1/3.2 marketed on "low-latency function calling" for agentic workflows (https://mistral.ai/news/mistral-small-3/, https://mistral.ai/news/mistral-small-3-1/). **Mistral Small 4** (119B total / 6.5B active, MoE 128 experts / 4 active, 256K context, released ~Feb–Mar 2026) unifies Instruct + Reasoning + Devstral lines with "best-in-class agentic capabilities with native function calling and JSON output" and per-request reasoning toggle (https://huggingface.co/mistralai/Mistral-Small-4-119B-2603). **Devstral** is Mistral's agentic-coding line: Devstral Small 1.1 (24B) claims 53.6% SWE-bench Verified, "a new state-of-the-art for open models without test-time scaling" (https://mistral.ai/news/devstral-2507/, 2025-07); Devstral Small 2 claims 68.0% and Devstral 2 (123B) 72.2% (https://mistral.ai/news/devstral-2-vibe-cli/).
- **Independent evidence:** BFCL v4 snapshot shows mistral-small-2506 at 37.15% overall with multi-turn only 11.5% — well below its marketing and below Qwen3-8B; its prompt-mode format delta is 50.0 points (official CSV). Devstral SWE-bench numbers are vendor-reported (the official swebench.com table uses one harness; Devstral entries there should be re-checked when needed).

### NVIDIA Nemotron
- **Claims:** Nemotron 3 family (Nano/Super/Ultra, 2025-12-15): "the most efficient family of open models with leading accuracy for building agentic AI applications", trained with "advanced reinforcement learning techniques with concurrent multi-environment post-training at scale"; Nano is a hybrid-MoE throughput play for multi-agent systems (https://investor.nvidia.com/news/press-release-details/2025/NVIDIA-Debuts-Nemotron-3-Family-of-Open-Models/default.aspx; developer blog https://forums.developer.nvidia.com/t/introducing-nemotron-3-open-models-for-agentic-ai/354733). Earlier Nemotron Nano 2 marketed function calling for agents.
- **Independent evidence:** the BFCL v4 snapshot contains Llama-3.1-Nemotron-Ultra-253B-v1 at an anomalous 10.0% overall (official CSV) — likely a harness/template mismatch rather than a fair result; treat as a warning that Nemotron templates are fragile outside NVIDIA runtimes. No ≤13B Nemotron rows in the snapshot.

### Liquid AI LFM2 / LFM2.5
- **Claims:** LFM2.5-2.6B (2026-08-04): "an agentic model that runs entirely on-device ... planning, calling tools, and tackling multi-step tasks", 220 tok/s on M5 Max under 2.5 GB, 34T-token pretrain, 128K context, four-stage post-training ending in agentic RL inside real harnesses; vendor BFCLv4 **56.88**, ToolSandbox 77.83, τ³-Bench Banking 5.67 (https://www.liquid.ai/blog/lfm2-5-2-6b). The LFM2.5 line is explicitly "recommended for agentic tasks, data extraction, RAG, and tool use" (https://unsloth.ai/docs/models/tutorials/lfm2.5).
- **Independent evidence:** BenchLM's BFCL v4 mirror lists LFM2.5-2.6B at 56.9% and LFM2.5-8B-A1B at 49.7% (https://benchlm.ai/benchmarks/bfcl-v4, 2026-08-07) — consistent with vendor numbers, though BenchLM is a secondary mirror. For an 8 GB GPU this is currently one of the strongest independently-visible small-model tool-use data points.

### Newer (2026) small releases worth tracking
- **Ling 3.0 Flash** (InclusionAI): tops the BenchLM BFCL v4 public snapshot among open weights at 73.0% (https://benchlm.ai/benchmarks/bfcl-v4) — secondary source; verify on the official leaderboard before relying on it.
- **JetBrains Mellum2-12B-A2.5B** (Thinking 45.6 / Instruct 44.2 on the BenchLM BFCL v4 mirror; https://benchlm.ai/benchmarks/bfcl-v4) — a coding-assistant vendor entering open weights.
- **Zyphra ZAYA1-8B** (39.2 on the same mirror), **OpenBMB MiniCPM5-1B** (25.1) — sub-8B agentic entries.
- **Nanbeige4-3B-Thinking-2511**: already on the official BFCL v4 leaderboard at 51.40% overall (§2.1) — the most credible sub-4B tool-use result currently visible.
- **gemma-4-E2B/E4B and Qwen3.5-4B/9B**: appear in Liquid AI's BFCLv4 comparison table (36.98 / 46.39 / 50.56 / 60.13; vendor-of-Liquid table, https://www.liquid.ai/blog/lfm2-5-2-6b).

---

## Sources

Official leaderboards & benchmarks
- BFCL leaderboard (V4), last updated 2026-04-12: https://gorilla.cs.berkeley.edu/leaderboard.html — and the underlying CSV used above: https://gorilla.cs.berkeley.edu/data_overall.csv (retrieved 2026-08-09)
- BFCL v4 web search (score composition + failure modes): https://gorilla.cs.berkeley.edu/blogs/15_bfcl_v4_web_search.html
- BFCL v4 format sensitivity: https://gorilla.cs.berkeley.edu/blogs/17_bfcl_v4_prompt_variation.html
- BFCL v3 multi-turn (methodology + error analysis): https://gorilla.cs.berkeley.edu/blogs/13_bfcl_v3_multi_turn.html
- BFCL paper (Patil et al., ICML 2025): https://openreview.net/forum?id=2GmDdhBdDk
- τ-bench paper: https://arxiv.org/abs/2406.12045 — Sierra blog incl. pass^8: https://sierra.ai/blog/benchmarking-ai-agents
- τ²-bench paper: https://arxiv.org/abs/2506.07982 — code: https://github.com/sierra-research/tau2-bench — Artificial Analysis leaderboard: https://artificialanalysis.ai/evaluations/tau2-bench
- Quesma τ²-bench prompt rewrite (+22% for GPT-5-mini): https://quesma.com/blog/tau2-benchmark-improving-results-smaller-models/
- SWE-bench leaderboards: https://www.swebench.com/ — Devstral updates: https://mistral.ai/news/devstral-2507/, https://mistral.ai/news/devstral-2-vibe-cli/
- BenchLM BFCL v4 mirror (secondary): https://benchlm.ai/benchmarks/bfcl-v4

Model releases & vendor docs
- Qwen3 Technical Report: https://arxiv.org/abs/2505.09388
- Qwen3-Coder blog: https://qwenlm.github.io/blog/qwen3-coder/ — GitHub: https://github.com/QwenLM/Qwen3-Coder — 30B card: https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct
- Qwen3-Coder-Next tech report: https://arxiv.org/abs/2603.00729 — card: https://huggingface.co/Qwen/Qwen3-Coder-Next
- OpenAI gpt-oss announcement: https://openai.com/index/introducing-gpt-oss/ — model card: https://arxiv.org/abs/2508.10925 — Harmony cookbook: https://cookbook.openai.com/articles/openai-harmony — Harmony repo: https://github.com/openai/harmony
- IBM Granite 4.0 announcement: https://www.ibm.com/new/announcements/ibm-granite-4-0-hyper-efficient-high-performance-hybrid-models — Granite docs (tool_call tags): https://www.ibm.com/granite/docs/models/granite
- Mistral Small 3: https://mistral.ai/news/mistral-small-3/ — Small 3.1: https://mistral.ai/news/mistral-small-3-1/ — Mistral Small 4 card: https://huggingface.co/mistralai/Mistral-Small-4-119B-2603
- NVIDIA Nemotron 3 press release: https://investor.nvidia.com/news/press-release-details/2025/NVIDIA-Debuts-Nemotron-3-Family-of-Open-Models/default.aspx — developer forum: https://forums.developer.nvidia.com/t/introducing-nemotron-3-open-models-for-agentic-ai/354733
- Liquid AI LFM2.5-2.6B: https://www.liquid.ai/blog/lfm2-5-2-6b — Unsloth LFM2.5 guide: https://unsloth.ai/docs/models/tutorials/lfm2.5
- Firefunction V2: https://fireworks.ai/blog/firefunction-v2-launch-post — Fireworks RFT: https://fireworks.ai/blog/reinforcement-fine-tuning — Ollama card: https://ollama.com/library/firefunction-v2
- Nous Hermes function calling repo: https://github.com/NousResearch/Hermes-Function-Calling — Hermes 3: https://nousresearch.com/hermes3/ — Hermes 4 70B card: https://huggingface.co/NousResearch/Hermes-4-70B — Hermes 4 tech report: https://arxiv.org/abs/2508.18255 — Hermes 4.3 36B FP8 card: https://huggingface.co/Doradus-AI/Hermes-4.3-36B-FP8 — Hermes tool-calling facts (community-reported): https://localaimaster.com/blog/hermes-agent-ollama

Format sensitivity & failure-mode research
- Natural Language Tools (+18.4pp vs JSON): https://arxiv.org/abs/2510.14453
- TOUCAN 1.5M tool-agentic trajectories: https://arxiv.org/abs/2510.01179
- Processing tool outputs (JSON): https://arxiv.org/html/2510.15955v1
- NoLiMa long-context degradation: https://arxiv.org/abs/2502.05167
- Chroma "Context Rot": https://www.trychroma.com/research/context-rot
- Pseudocode/code tool calling vs JSON (report): https://www.arxivnews.org/en/articles/e8533b57-1d34-4b7c-906a-d989c5d0f575 — CodeAct discussion: https://substack.com/home/post/p-167344254
- vLLM tool calling docs: https://docs.vllm.ai/en/latest/features/tool_calling/

Community-reported (secondary)
- GPT-OSS tool calling on r/LocalLLaMA: https://www.reddit.com/r/LocalLLaMA/comments/1n0aijh/gpt_oss_120b/
- gpt-oss-20b chat-template token mismatch: https://huggingface.co/openai/gpt-oss-20b/discussions/218
- llama.cpp gpt-oss grammar discussion: https://github.com/ggml-org/llama.cpp/discussions/15341
- Harmony requirement analysis: https://arxiv.org/html/2604.00362v1
- Qwen3-Coder-30B mini-SWE-agent 55.4%: https://github.com/SWE-agent/mini-swe-agent/issues/469
- NLT discussion: https://www.reddit.com/r/MachineLearning/comments/1o8szk0/r_plain_english_outperforms_json_for_llm_tool/
- Granite 4.0 Toucan fine-tune: https://huggingface.co/Shumatsurontek/granite-4.0-h-micro-Toucan-120k
- llama.cpp Granite `<|tool_call|>` eval bug report: https://buttondown.com/weekly-project-news/archive/weekly-github-report-for-llamacpp-september-01-2025/
