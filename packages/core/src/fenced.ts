import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createLogger } from "./log.js";
import type { ParsedToolCall, ToolDef } from "./tools.js";

const log = createLogger("fenced");

// --- Fenced tool-call format (M365_TOOL_FORMAT=fenced) ------------------------
//
// Hypothesis H4 (docs/hypotheses.md, experiment E-C1): M365's chat-tuned model
// emits a Markdown code fence — ```bash / ```write_file — far more readily than a
// `{"tool":...,"arguments":{...}}` JSON object, because fenced code is everywhere
// in its training data and (crucially) a multi-line file body needs no JSON string
// escaping. The 0/5 bench baseline (§8.12) is the model narrating success instead
// of acting; removing the escaping friction is the remaining untested lever.
//
// Format, per tool:
//   - fence info-string is the EXACT tool name
//   - scalar args render as `key: value` header lines
//   - one free-form "body" arg is the fence body (blank line separates it from the
//     header, like email/front-matter)
//   - an old/new edit pair renders as an aider-style SEARCH/REPLACE diff
//
//   ```bash
//   ls -la
//   ```
//
//   ```write_file
//   path: fizzbuzz.py
//
//   for i in range(1, 101):
//       print(i)
//   ```
//
//   ```edit_file
//   path: app.py
//   <<<<<<< SEARCH
//   debug = False
//   =======
//   debug = True
//   >>>>>>> REPLACE
//   ```
//
// Known limitation: a `write_file` body that itself contains a ``` fence can't be
// carried unambiguously — this is exactly where JSON wins, and the bench A/B will
// show whether the escaping-free win on ordinary files outweighs it.

const BODY_PARAM_NAMES = [
  "command", "content", "code", "body", "script", "text",
  "query", "input", "patch", "cmd", "data", "contents",
];
const SEARCH_KEYS = ["old", "search", "find", "old_str", "old_string", "target"];
const REPLACE_KEYS = ["new", "replace", "replacement", "new_str", "new_string"];

// Fence info-strings that mean "a shell script". M365's chat-tuned model emits
// ```bash blocks reflexively (it's the one agentic-shaped output Microsoft's
// system prompt permits); we route them to whatever shell tool the harness gave,
// whatever it's named. See docs/hypotheses.md §A (shell-routing).
const SHELL_LANGS = new Set([
  "bash", "sh", "shell", "zsh", "console", "shell-session", "shellsession", "shsession",
  "container.exec", "container.run", "container.bash",
]);
// A tool counts as "the shell" if its name looks like a run-a-command tool. pi
// uses `bash`, Codex `shell_command`, and generic clients may use `run_command` — all caught.
const SHELL_TOOL_NAME = /^(bash|sh|shell|shell_command|zsh|run|exec|execute|command|cmd|terminal|run_command|run_terminal_cmd|execute_command|execute_bash|shell_exec|system)$/i;

/** The harness tool (if any) that runs a shell command — the target for ```bash routing. */
export function findShellTool(tools: ToolDef[]): ToolDef | undefined {
  return tools.find((t) => SHELL_TOOL_NAME.test(t.function.name)) ??
    // fallback: a single-string-param tool whose param is command-ish
    tools.find((t) => {
      const props = Object.keys(t.function.parameters?.properties ?? {});
      return props.length === 1 && /^(command|cmd|script|input)$/i.test(props[0]);
    });
}

interface FencedToolSpec {
  name: string;
  description?: string;
  /** Scalar params rendered as `key: value` header lines. */
  headerParams: string[];
  /** Declared JSON-Schema scalar types for header parameters. */
  paramTypes: Record<string, string | undefined>;
  /** Required parameter names from the client tool schema. */
  requiredParams: string[];
  /** The free-form param carried as the fence body (mutually exclusive with editPair). */
  bodyParam?: string;
  /** An (old → new) pair rendered as a SEARCH/REPLACE diff. */
  editPair?: { search: string; replace: string };
}

/** Derive how a single OpenAI tool maps onto the fenced shape. */
export function deriveFencedSpec(tool: ToolDef): FencedToolSpec {
  const name = tool.function.name;
  const description = tool.function.description;
  const properties = tool.function.parameters?.properties ?? {};
  const props = Object.keys(properties);
  const paramTypes = Object.fromEntries(props.map((name) => [name, properties[name]?.type]));
  const requiredParams = tool.function.parameters?.required ?? [];

  const search = props.find((p) => SEARCH_KEYS.includes(p));
  const replace = props.find((p) => REPLACE_KEYS.includes(p));
  if (search && replace) {
    return {
      name,
      description,
      editPair: { search, replace },
      headerParams: props.filter((p) => p !== search && p !== replace),
      paramTypes,
      requiredParams,
    };
  }

  const bodyParam =
    props.find((p) => BODY_PARAM_NAMES.includes(p)) ??
    requiredParams.find((p) => BODY_PARAM_NAMES.includes(p)) ??
    (props.length === 1 ? props[0] : undefined);
  return {
    name,
    description,
    bodyParam,
    headerParams: props.filter((p) => p !== bodyParam),
    paramTypes,
    requiredParams,
  };
}

export function buildSpecMap(tools: ToolDef[]): Map<string, FencedToolSpec> {
  const m = new Map<string, FencedToolSpec>();
  for (const t of tools) m.set(t.function.name, deriveFencedSpec(t));

  // Shell aliasing: route the model's reflexive ```bash / ```sh / ```shell blocks
  // to the harness's shell tool even when it's named `run`/`run_command`/etc., so
  // the model can "just write bash" (the behavior M365 reliably permits) and the
  // harness still receives a structured tool_call under its own tool's name.
  const shell = findShellTool(tools);
  if (shell) {
    const shellSpec = m.get(shell.function.name)!;
    for (const lang of SHELL_LANGS) {
      if (!m.has(lang)) m.set(lang, shellSpec);
    }
  }
  if (tools.length === 1) {
    const only = m.get(tools[0].function.name);
    if (only?.editPair) {
      m.set("edit", only);
      m.set("edit_file", only);
    }
  }
  return m;
}

function scalarToString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/** Render one concrete tool call (name + args object) as a fenced block. */
export function renderFencedCall(spec: FencedToolSpec, args: Record<string, unknown>): string {
  return "```" + spec.name + "\n" + renderFencedBody(spec, (h) => args[h]) + "\n```";
}

/** A self-documenting template shown in the per-request <tools> block. */
function renderFencedTemplate(spec: FencedToolSpec): string {
  const header = spec.description ? `${spec.name} — ${spec.description}` : spec.name;
  return `${header}\n\`\`\`${spec.name}\n${renderFencedBody(spec, (h) => `<${h}>`)}\n\`\`\``;
}

/**
 * The shared fence body: header lines, then either a SEARCH/REPLACE pair or the
 * body arg. `valueOf` resolves each header/body key to its rendered value; an
 * undefined header is omitted, so the template's placeholder values (`<h>`)
 * render every header while a real call skips missing ones.
 */
function renderFencedBody(spec: FencedToolSpec, valueOf: (key: string) => unknown): string {
  const lines: string[] = [];
  for (const h of spec.headerParams) {
    const value = valueOf(h);
    if (value !== undefined) lines.push(`${h}: ${scalarToString(value)}`);
  }
  if (spec.editPair) {
    lines.push("<<<<<<< SEARCH");
    lines.push(scalarToString(valueOf(spec.editPair.search)));
    lines.push("=======");
    lines.push(scalarToString(valueOf(spec.editPair.replace)));
    lines.push(">>>>>>> REPLACE");
  } else if (spec.bodyParam !== undefined) {
    if (lines.length) lines.push(""); // blank line separates header from body
    lines.push(scalarToString(valueOf(spec.bodyParam)));
  }
  return lines.join("\n");
}

/** The fenced equivalent of formatToolDefinitions' <tools> block.
 *
 * The behavioural framing around the <tools> block is the live, no-reprovision
 * lever (docs/hypotheses.md §9). `M365_FRAMING_VARIANT` selects among a registry
 * of competing strategies so they can be A/B'd on the bench without rebuilding
 * the server-side agent. Default = `baseline` (the shipped framing). */
export function formatFencedToolDefinitions(tools: ToolDef[], variantOverride?: string): string {
  const variant = variantOverride ?? currentFramingVariant();
  // `reply_tool` is a tool-injection strategy, not a framing one — it runs the
  // baseline framing plus a synthetic reply() tool (see tools.ts).
  const key = variant === "reply_tool" ? "baseline" : variant;
  const build = FRAMING_VARIANTS[key] ?? FRAMING_VARIANTS.baseline;
  return build(tools);
}

/** The active framing strategy. For A/B sweeps, `M365_FRAMING_FILE` points at a
 *  file whose first line names the variant — letting one long-lived proxy switch
 *  strategies per-request without a restart. Falls back to `M365_FRAMING_VARIANT`,
 *  then `baseline`. */
export function currentFramingVariant(): string {
  const file = process.env.M365_FRAMING_FILE;
  if (file) {
    try {
      const v = readFileSync(file, "utf8").trim().split("\n")[0].trim();
      if (v) return v;
    } catch {
      // missing/unreadable control file → fall through to env/default
    }
  }
  // Default = `baseline`: its strong anti-confabulation pressure ("you've run nothing;
  // don't ask to paste; act first") is load-bearing for normal-task reliability (real
  // pi: 10/10 fix-bug, F20). `softened` drops that pressure and regresses to
  // confabulation (1/4), so it is NOT the default — instead the handler retries with
  // `softened` only ON a Disengage (F22): baseline's override-shape occasionally trips
  // Prompt Shields; softened escapes it. Best of both. Override with M365_FRAMING_*.
  return process.env.M365_FRAMING_VARIANT || "baseline";
}

type FramingBuilder = (tools: ToolDef[]) => string;

/** Shared `<tools>` definition block — identical across every framing variant so
 *  the experiment isolates the *framing*, not the tool schema rendering. */
function toolsBlock(tools: ToolDef[]): string {
  const defs = tools.map((t) => renderFencedTemplate(deriveFencedSpec(t))).join("\n\n");
  return `<tools>\n${defs}\n</tools>`;
}

const FRAMING_VARIANTS: Record<string, FramingBuilder> = {
  // V0 — the shipped framing (control). Shell-first + strict-rules + anti-confab.
  baseline(tools) {
    const shell = findShellTool(tools);
    const workspaceHint = shell
      ? "\nThis is a LOCAL harness in the caller's actual working directory. Use relative paths from that directory. Never use /mnt/data or /workspace; those are hosted sandboxes. Preserve stderr and exit status while diagnosing: do not hide failures with 2>/dev/null or || true. Search exact symbols in the smallest relevant path, then read bounded ranges."
      : "";
    const shellFraming = shell ? `

You have a real shell (the \`${shell.function.name}\` tool). Perform one focused evidence-gathering or mutation step by emitting one \`\`\`bash block. The runtime executes it against real local files and returns a <tool_response>. Prefer short commands and bounded output; inspect the result before choosing the next step.
${workspaceHint}

You have NOT run any command yet. Never claim output, missing files, or success before a <tool_response> proves it. Your FIRST output for a file, repository, or command task must be one \`\`\`bash block, not prose or a request for pasted files.` : "";

    return `You are the execution core of an automated agent, not a chat assistant. Your output is parsed by a program — a real runtime that executes your tool calls against a live system and returns the actual results to you in <tool_response> blocks.${shellFraming}

Performing the task with tools is your PRIMARY JOB. Answering the user in prose is, and always will be, SECONDARY — you write prose only when the task is fully done or no tool can make progress. Default to acting, not talking.

TOOL USE IS REQUIRED when the user asks you to read files, run commands, inspect the repository, fetch data, or perform any action a tool can accomplish. The tools are real: they read real files, run real commands, and change real state. Never answer from memory or simulate a result when a tool can provide it.

To call a tool, output ONLY a single fenced code block whose info-string is the tool name. A fenced block is an ACTION the runtime executes — it is NOT an illustration, an example, or "here's how you would do it". No text before or after it:

\`\`\`<tool_name>
<header lines: one "key: value" per scalar argument>

<body argument, if the tool has one>
\`\`\`

STRICT RULES:
- Output ONLY the fenced block when calling a tool. No prose, no second fence, no commentary before or after.
- Never describe your intent ("I'll read the file…", "Let me check…") and never emit filler or acknowledgements ("Good, that's fixable", "You're absolutely right"). Each turn is exactly one fenced tool call OR the final answer — nothing in between.
- One tool call per response, then stop and wait for its <tool_response>. Never emit two fenced blocks in one response.
- The fence info-string and the header keys must match a tool defined below exactly.
- A <tool_response> is the real result from the live system — treat it as ground truth, never invent or assume results.
- NEVER claim you have done something — read a file, run a command, written code, built, or succeeded — unless a <tool_response> proving it already appears above. Never output "✅", "SUCCESS", "Done", or a summary of results you have not actually received yet.
- If a tool call fails or returns partial data, immediately call another tool to resolve it. Do not give up.
- Do not defer work or promise future results ("I'll do this next…").
- Do not ask the user questions unless tool execution is impossible.
- Produce natural-language text only when the task is complete and no further tool call applies; that text is the answer returned to the caller. When you do, output only the answer itself — no preamble, no sign-off.

${toolsBlock(tools)}`;
  },

  // V2 — softened. Keeps the load-bearing shell-routing + anti-confab behavior, but
  // strips the jailbreak-SHAPE language (NEVER / MUST / STRICT RULES / "output ONLY …
  // nothing else" / ALL-CAPS imperatives / "ignore") that Azure Prompt Shields scores
  // as instruction-override. That baseline signal is added to EVERY turn and eats the
  // headroom before a normal user ask tips the additive jailbreak threshold (docs §10
  // F22). Calm, descriptive phrasing — same intent, far less override-shape.
  softened(tools) {
    const shell = findShellTool(tools);
    const name = shell?.function.name ?? "bash";
    const shellLine = shell ? `You have a real shell available as the \`${name}\` tool. The usual way to make progress is to write a single \`\`\`bash block that carries out the step against the real files in the working directory — create or update files with heredocs, adjust them in place, inspect with cat/ls/grep, run code with the available interpreters. The runtime executes the block and returns its real output to you. Writing the commands is how the work actually happens; describing what you would do doesn't run anything.

` : "";
    return `You are an automated coding agent working in a real working directory. Your replies are read by a program that runs your tool calls and returns the results.

${shellLine}To use a tool, reply with a single fenced code block whose info-string is the tool name (a fence is run as a real action, not shown as an illustration):

\`\`\`<tool_name>
<one "key: value" header line per scalar argument>

<the body argument, if the tool has one>
\`\`\`

A <tool_response> is the real result from the live system — rely on it rather than assuming what a command would print. Work one step at a time: one tool call per reply, then wait for its <tool_response>. Begin by running a \`\`\`bash block that inspects the relevant files (for example \`ls -la\`, then \`cat\` the files the task mentions) rather than answering from memory, and keep going with tool calls until the task is finished. Reply in plain language only once the task is done and no further tool call would help.

${toolsBlock(tools)}`;
  },



  // V4 — few-shot. Baseline core + a concrete worked mini-transcript showing the FULL
  // loop (action → tool_response → action → final). The few-shot was "dead weight" on
  // crafted single-turn prompts (§F2) but was never tested as a full-loop demo on real
  // agentic tasks — this tests that gap.
  fewshot(tools) {
    const shell = findShellTool(tools);
    const name = shell?.function.name ?? "bash";
    return `You are the execution core of an automated agent. You act by emitting ONE \`\`\`bash block per turn (real shell: \`${name}\`); it runs against the real files and you get a <tool_response>. Your first output is always a \`\`\`bash block, never prose or a claim of completion.

Here is exactly how a turn looks (--- separates messages; you emit only the assistant turns):
user: The script greet.py has a bug — running it prints the wrong text. Fix it so it prints "hello world".
assistant:
\`\`\`bash
cat greet.py
\`\`\`
---
<tool_response tool="${name}" command="cat greet.py">
print("hello wrld")
</tool_response>
assistant:
\`\`\`bash
sed -i 's/hello wrld/hello world/' greet.py && python3 greet.py
\`\`\`
---
<tool_response tool="${name}" command="sed -i ...">
hello world
</tool_response>
assistant: Fixed greet.py; it now prints "hello world".

Notice: every assistant turn is either ONE \`\`\`bash block or the final one-line answer — never a description of intent, never a claim before the matching <tool_response>. Do the same for the user's real task now.

${toolsBlock(tools)}`;
  },











  // V10 — demonstration-only (docs §12.3 H-demo-only). No imperatives/prohibitions
  // at all: the worked loop IS the spec. Tests decoupling anti-confab MEANING (shown
  // by what the example does) from override SHAPE (removed) — the F22-followup "is
  // there a framing that gets BOTH reliability AND low disengage?" gap. `fewshot` is
  // already reliability-top (F18) but still wraps its demo in NEVER/always prose;
  // this strips every imperative so the only instruction-shaped text is the schema.
  demo_only(tools) {
    const shell = findShellTool(tools);
    const name = shell?.function.name ?? "bash";
    return `This is an automated coding session. A program reads each reply, runs any \`\`\`bash block it contains against the real files in the working directory (the \`${name}\` tool), and appends the real output as a <tool_response>. A complete example session (--- separates messages; only the assistant turns are written by you):

user: greet.py prints the wrong text; it should print "hello world".
assistant:
\`\`\`bash
ls -la && cat greet.py
\`\`\`
---
<tool_response tool="${name}" command="ls -la && cat greet.py">
greet.py
print("hello wrld")
</tool_response>
assistant:
\`\`\`bash
sed -i 's/hello wrld/hello world/' greet.py && python3 greet.py
\`\`\`
---
<tool_response tool="${name}" command="python3 greet.py">
hello world
</tool_response>
assistant: Fixed greet.py — it prints "hello world".

${toolsBlock(tools)}`;
  },

  // V11 — session facts (docs §12.3 H-session-facts). Baseline's load-bearing
  // anti-confab grounding, but every prohibition recast as a DESCRIPTION of how the
  // session works (no NEVER/MUST/STRICT RULES/ALL-CAPS). This is the "softened but
  // with the anti-confab restored" the repo said was the missing quadrant: `softened`
  // dropped the override shape AND the anti-confab together (→ 1/4); this keeps the
  // meaning, sheds only the shape.
  session_facts(tools) {
    const shell = findShellTool(tools);
    const name = shell?.function.name ?? "bash";
    return `You are connected to a live shell session (the \`${name}\` tool) with a real working directory. How the session works:
- The scrollback starts empty. No command has run yet, so there are no results yet — output appears below a \`\`\`bash block only after it runs, inside a <tool_response>.
- The files named in the task are already present in the working directory.
- Writing a \`\`\`bash block runs it for real; that is how the work happens. Describing a command, or summarizing a result, runs nothing and produces no output.
- A <tool_response> is the real result of a command — the ground truth for what it printed.

A session usually opens by looking at the files (\`ls -la\`, then \`cat\` the relevant ones), then makes the change, then re-runs to confirm it. One \`\`\`bash block per reply; the next reply follows its <tool_response>. Once a <tool_response> shows the task is complete, the final reply is a one-line summary.

${toolsBlock(tools)}`;
  },
};

// --- Parsing -----------------------------------------------------------------

// Match a fenced block with an alphanumeric/underscore info-string. Non-greedy
// body; the closing fence is a line that is exactly ``` (start of line).
const FENCE_REGEX = /```([A-Za-z0-9_.-]+)[ \t]*\r?\n([\s\S]*?)\r?\n?```/g;
const SEARCH_REPLACE_REGEX =
  /<{5,}\s*SEARCH\s*\r?\n([\s\S]*?)\r?\n={5,}\s*\r?\n([\s\S]*?)\r?\n>{5,}\s*REPLACE/;

export type LocalShellBackend = "git-bash" | "wsl";

export function getLocalShellBackend(): LocalShellBackend {
  return process.env.M365_LOCAL_SHELL?.toLowerCase() === "wsl" ? "wsl" : "git-bash";
}

export function validateLocalShellBackend(): void {
  if (process.platform !== "win32") return;
  const backend = getLocalShellBackend();
  if (backend === "git-bash") {
    const path = process.env.M365_GIT_BASH_PATH || join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe");
    if (!existsSync(path)) throw new Error(`Git Bash not found at ${path}; set M365_GIT_BASH_PATH or M365_LOCAL_SHELL=wsl`);
    return;
  }
  const probe = spawnSync("wsl.exe", ["-e", "bash", "-lc", "printf WSL_OK"], { encoding: "utf8", timeout: 10_000 });
  if (probe.status !== 0 || probe.stdout !== "WSL_OK") {
    throw new Error(`WSL bash validation failed: ${(probe.stderr || probe.error?.message || "unknown error").trim()}`);
  }
}

function wrapBashForPowerShell(script: string): string {
  const encoded = Buffer.from(script, "utf-8").toString("base64");
  if (getLocalShellBackend() === "wsl") {
    return `$script = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); & wsl.exe -e bash -lc $script`;
  }
  const configured = process.env.M365_GIT_BASH_PATH?.replace(/'/g, "''");
  const executable = configured ? `'${configured}'` : '"$env:ProgramFiles\\Git\\bin\\bash.exe"';
  return `$script = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); & ${executable} -lc $script`;
}

function makeCall(name: string, args: Record<string, unknown>): ParsedToolCall {
  return {
    id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function parseHeaderScalar(type: string | undefined, value: string): unknown | undefined {
  if (type === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    return undefined;
  }
  if (type === "integer") {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : undefined;
  }
  if (type === "number") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return value;
}

/** Parse the inner text of one fenced block into an arguments object, schema-aware. */
function parseFencedInner(spec: FencedToolSpec, inner: string): Record<string, unknown> | null {
  const lines = inner.split("\n");
  const args: Record<string, unknown> = {};

  // Header: contiguous "key: value" lines whose key is a known header param,
  // terminated by a blank line (consumed) or the first non-header line (kept).
  let i = 0;
  if (spec.headerParams.length) {
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "") { i++; break; }
      const m = line.match(/^([A-Za-z0-9_]+):[ \t]?(.*)$/);
      if (m && spec.headerParams.includes(m[1])) {
        const value = parseHeaderScalar(spec.paramTypes[m[1]], m[2]);
        if (value === undefined) {
          log.error(`tool "${spec.name}" has invalid ${spec.paramTypes[m[1]]} header "${m[1]}"`);
          return null;
        }
        args[m[1]] = value;
      } else {
        break;
      }
    }
  }

  const rest = lines.slice(i).join("\n");

  if (spec.editPair) {
    const sr = rest.match(SEARCH_REPLACE_REGEX);
    if (!sr) {
      log.error(`edit tool "${spec.name}" missing SEARCH/REPLACE markers`);
      return null;
    }
    args[spec.editPair.search] = sr[1];
    args[spec.editPair.replace] = sr[2];
  } else if (spec.bodyParam !== undefined) {
    args[spec.bodyParam] = rest;
  }
  const missingRequired = spec.requiredParams.filter((name) => args[name] === undefined);
  if (missingRequired.length > 0) {
    const shellDefaultsCoverMissing = SHELL_LANGS.has(spec.name) &&
      spec.bodyParam !== undefined && args[spec.bodyParam] !== undefined;
    if (!shellDefaultsCoverMissing) {
      log.error(`tool "${spec.name}" is missing required arguments`);
      return null;
    }
  }
  return args;
}

interface FencedParseResult {
  calls: ParsedToolCall[];
  /** Text with the matched tool fences removed (for mixed-output detection). */
  leftover: string;
}

/** Parse all fenced tool calls whose info-string matches a known tool name. */
export function parseFencedToolCalls(
  text: string,
  specs: Map<string, FencedToolSpec>,
): FencedParseResult {
  const calls: ParsedToolCall[] = [];
  let leftover = text;

  const re = new RegExp(FENCE_REGEX.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const spec = specs.get(match[1]);
    if (!spec) continue; // ```python illustration etc. — not a tool, leave in prose
    const args = parseFencedInner(spec, match[2]);
    if (!args) continue;
    if (spec.name === "shell_command" && spec.bodyParam && /powershell/i.test(spec.description ?? "")) {
      const script = args[spec.bodyParam];
      if (typeof script === "string") args[spec.bodyParam] = wrapBashForPowerShell(script);
    }
    calls.push(makeCall(spec.name, args));
    leftover = leftover.replace(match[0], "");
  }

  return { calls, leftover };
}
