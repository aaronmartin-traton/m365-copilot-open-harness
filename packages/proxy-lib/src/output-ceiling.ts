/**
 * Output ceiling utilities for detecting truncated responses.
 */

export const OUTPUT_CHAR_CEILING = process.env.M365_OUTPUT_CHAR_CEILING !== undefined
  ? Number(process.env.M365_OUTPUT_CHAR_CEILING)
  : 12_000;

/**
 * Determine finish_reason based on empirical output ceiling.
 * M365 soft-caps output around ~3k tokens (~12k chars) and concludes early
 * rather than truncating mid-stream, so we flag responses at/over the ceiling.
 */
export function outputFinishReason(text: string): "stop" | "length" {
  if (OUTPUT_CHAR_CEILING > 0 && text.length >= OUTPUT_CHAR_CEILING) {
    return "length";
  }
  return "stop";
}
