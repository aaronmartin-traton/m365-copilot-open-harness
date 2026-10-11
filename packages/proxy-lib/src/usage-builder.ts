/**
 * Constructs OpenAI-compatible `usage` objects.
 *
 * The base token counts stay zero: neither backend exposes them. Everything
 * else is provider telemetry — the backend owns that vocabulary, reports it on
 * `ProviderTurn.usage`, and this function only namespaces it under
 * `x_<providerId>_*` so a client can tell the lanes apart.
 *
 * Pure function - same inputs always produce the same output.
 */
import type { ProviderUsage, ProviderUsageValue } from "@m365-copilot/core";

/** The OpenAI `usage` block: the three required counters plus telemetry. */
export interface UsageBlock {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Namespaced provider telemetry, e.g. `x_m365_tone`. */
  readonly [key: string]: number | ProviderUsageValue;
}

export interface UsageInput {
  /** Backend id; namespacing the telemetry keys (e.g. `m365`, `chatgpt-web`). */
  providerId: string;
  requestedModel?: string;
  routedModel?: string;
  /** The winning turn's provider telemetry, spread verbatim under the prefix. */
  fields?: ProviderUsage;
}

/** Provider telemetry for the winning turn, plus the models this lane served. */
type UsageFields = ProviderUsage & {
  requested_model?: string;
  routed_model?: string;
};

export function buildUsage(input: UsageInput): UsageBlock {
  const base: Record<string, number | ProviderUsageValue> & Pick<UsageBlock, "prompt_tokens" | "completion_tokens" | "total_tokens"> = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };

  const prefix = `x_${input.providerId.replace(/-/g, "_")}_`;

  const fields: UsageFields = { ...input.fields };

  if (input.requestedModel !== undefined) fields.requested_model = input.requestedModel;

  if (input.routedModel !== undefined) fields.routed_model = input.routedModel;

  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) base[`${prefix}${name}`] = value;
  }

  return base;
}
