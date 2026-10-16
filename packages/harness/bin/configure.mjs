#!/usr/bin/env node
/**
 * Point Pi and Pi-Bolt at the local M365 Copilot proxy by merging the provider
 * into ~/.pi/agent/models.json. Run after the harness has been built; part of
 * `bun run setup`.
 */
import {
  DEFAULT_PROXY_BASE_URL,
  writeM365ProviderConfig,
} from "../dist/index.mjs";

const baseUrl = process.env.M365_PROXY_URL ?? DEFAULT_PROXY_BASE_URL;

const result = writeM365ProviderConfig({ baseUrl });

console.log(`provider ${result.providerId} -> ${result.baseUrl} (${result.models.length} models)`);

console.log(result.written ? `wrote ${result.configPath}` : `${result.configPath} is already current`);
