import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piHome = resolve(root, ".pi-local");
const port = process.env.PORT || "4141";
const model = process.env.MODEL || "m365-copilot";
const baseUrl = `http://localhost:${port}/v1`;
const agentDir = resolve(piHome, ".pi", "agent");

const displayNames = {
  "m365-copilot": "M365 Copilot (default / magic)",
  auto: "Auto (magic)",
  quick: "Quick",
  "think-deeper": "Think Deeper (reasoning)",
};
let models = [...new Set(["m365-copilot", model])].map((id) => ({ id, name: displayNames[id] ?? id }));
try {
  const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload.data)) throw new Error("Invalid model list");
  models = payload.data
    .filter((entry) => typeof entry.id === "string" && entry.id.length > 0)
    .map((entry) => ({
      id: entry.id,
      name: displayNames[entry.id] ?? entry.id,
      ...(Number.isInteger(entry.context_window) && entry.context_window > 0
        ? { contextWindow: entry.context_window }
        : {}),
    }));
} catch {
  // The launcher still works without the proxy; the default and requested model
  // stay available until the live catalog can be loaded on the next launch.
}

await mkdir(agentDir, { recursive: true });
await writeFile(
  resolve(agentDir, "models.json"),
  `${JSON.stringify(
    {
      providers: {
        m365: {
          api: "openai-completions",
          apiKey: "m365",
          baseUrl,
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            supportsUsageInStreaming: false,
          },
          models,
        },
      },
    },
    null,
    2,
  )}\n`,
);
await writeFile(
  resolve(agentDir, "settings.json"),
  `${JSON.stringify(
    {
      defaultModel: model,
      defaultProvider: "m365",
      enableInstallTelemetry: false,
      compaction: { enabled: true },
    },
    null,
    2,
  )}\n`,
);

try {
  const response = await fetch(`http://localhost:${port}/health`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
} catch {
  console.warn(`[pi-local] no proxy answering on :${port} — start it with 'bun run proxy' (or set PORT=...)`);
}

console.log(`[pi-local] proxy=${baseUrl}  model=${model}  home=${piHome}`);
const homeEnv = process.platform === "win32" ? { HOME: piHome, USERPROFILE: piHome } : { HOME: piHome };
const child = Bun.spawn(["pi", "--provider", "m365", "--model", model, ...process.argv.slice(2)], {
  cwd: root,
  env: { ...process.env, ...homeEnv, PI_OFFLINE: "1" },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exitCode = await child.exited;
