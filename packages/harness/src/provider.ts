import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { getAvailableModels } from "@m365-copilot/core";
import { z } from "zod";

/**
 * Pi provider entry for the local M365 Copilot proxy. The proxy serves the
 * OpenAI Chat Completions API, so the entry uses `openai-completions` and a
 * placeholder key: the proxy authenticates the browser session, not Pi.
 *
 * Reference: https://pi.dev/docs/latest/models
 */

export const DEFAULT_PROVIDER_ID = "m365-copilot";

export const DEFAULT_PROXY_BASE_URL = "http://127.0.0.1:4141/v1";

export const DEFAULT_CONTEXT_WINDOW = 32000;

const DEFAULT_API_KEY = "m365-local-proxy";

const DEFAULT_MODELS_PATH = path.join(homedir(), ".pi", "agent", "models.json");

const modelsFileSchema = z.object({ providers: z.record(z.string(), z.json()) }).loose();

type ModelsFile = z.infer<typeof modelsFileSchema>;

export interface M365ProviderOptions {
  readonly configPath?: string;
  readonly providerId?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly contextWindow?: number;
  readonly models?: readonly string[];
}

export interface M365ProviderResult {
  readonly configPath: string;
  readonly providerId: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly models: readonly string[];
  readonly written: boolean;
}

/**
 * Merge the M365 Copilot provider into Pi's `models.json`, preserving every
 * other provider, and report whether the file changed. The write goes through
 * a staging file and a rename so an interrupted setup cannot leave a truncated
 * `models.json` behind.
 */
export function writeM365ProviderConfig(options: M365ProviderOptions = {}): M365ProviderResult {
  const configPath = options.configPath ?? DEFAULT_MODELS_PATH;
  const providerId = options.providerId ?? DEFAULT_PROVIDER_ID;
  const baseUrl = options.baseUrl ?? DEFAULT_PROXY_BASE_URL;
  const apiKey = options.apiKey ?? DEFAULT_API_KEY;
  const contextWindow = options.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const modelIds = options.models ? [...options.models] : getAvailableModels();

  const previous = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";

  const existing: ModelsFile =
    previous.trim().length === 0
      ? { providers: {} }
      : modelsFileSchema.parse(JSON.parse(previous));

  const entry = {
    baseUrl,
    api: "openai-completions",
    apiKey,
    models: modelIds.map((id) => ({ id, contextWindow })),
  };

  const next: ModelsFile = {
    ...existing,
    providers: { ...existing.providers, [providerId]: entry },
  };

  const text = `${JSON.stringify(next, null, 2)}\n`;
  const written = text !== previous;

  if (written) {
    mkdirSync(path.dirname(configPath), { recursive: true });

    const staging = `${configPath}.staging-${process.pid}`;

    writeFileSync(staging, text, "utf8");
    renameSync(staging, configPath);
  }

  return { configPath, providerId, baseUrl, apiKey, models: modelIds, written };
}
