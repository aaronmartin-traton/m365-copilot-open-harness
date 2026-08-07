/**
 * Response construction helpers for OpenAI-compatible API responses.
 *
 * All helpers produce Response objects with proper headers and formatting
 * expected by OpenAI client libraries.
 */

/**
 * Standard JSON response with Content-Type: application/json.
 */
export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * SSE (Server-Sent Events) streaming response.
 */
export function sseResponse(stream: ReadableStream): Response {
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

/**
 * Human-readable rate limit message for M365 Copilot.
 */
export function rateLimitMessage(throttle: { current: number; max: number } | null): string {
  return throttle
    ? `M365 Copilot rate limited (${throttle.current}/${throttle.max} messages used). Please wait and try again.`
    : "M365 Copilot returned an empty response. You may be rate limited. Please wait and try again.";
}

/**
 * 429 Rate Limit response with OpenAI-compatible error format.
 */
export function rateLimitResponse(throttle: { current: number; max: number } | null): Response {
  return jsonResponse(429, { error: { message: rateLimitMessage(throttle), type: "rate_limit_error" } });
}

/**
 * 429 response for scheduler queue full (with Retry-After header).
 */
export function schedulerBusyResponse(error: { message: string; retryAfterSeconds: number }): Response {
  return new Response(JSON.stringify({
    error: {
      message: error.message,
      type: "rate_limit_error",
      code: "m365_queue_full",
    },
  }), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": String(error.retryAfterSeconds),
    },
  });
}

/**
 * 502 response for empty upstream replies that aren't throttles.
 * Distinguishes content-filter/transient errors from at-limit throttles.
 */
export function emptyResponseResponse(throttle: { current: number; max: number } | null): Response {
  const detail = throttle ? ` (throttle ${throttle.current}/${throttle.max})` : "";
  return jsonResponse(502, {
    error: {
      message: `M365 Copilot returned an empty response${detail} — likely a content filter, an invalid agent/session, or a transient upstream error.`,
      type: "upstream_empty_response",
    },
  });
}
