import { timingSafeEqual } from "node:crypto";

/** OpenAI-shaped 401 body sent when `M365_API_KEY` is set and the request lacks it. */
export const API_KEY_ERROR_BODY = {
  error: {
    message: "Incorrect API key provided. Pass `Authorization: Bearer <M365_API_KEY>` or `x-api-key: <M365_API_KEY>`.",
    type: "invalid_request_error",
    code: "invalid_api_key",
  },
};

/**
 * The key configured for this process, or null when `M365_API_KEY` is unset or
 * blank — the default, and the only state in which the check is a no-op.
 */
export function configuredApiKey(): string | null {
  const value = process.env.M365_API_KEY?.trim();

  return value === undefined || value.length === 0 ? null : value;
}

/** Length-safe constant-time comparison, so a key check does not leak via timing. */
function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf-8");
  const b = Buffer.from(right, "utf-8");

  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

/** Every credential a request presents, in the order the accepted headers define. */
function presentedKeys(authorization: string | null, xApiKey: string | null): string[] {
  const keys: string[] = [];
  const bearer = authorization === null ? null : /^\s*Bearer\s+(.+?)\s*$/i.exec(authorization);

  if (bearer !== null && bearer[1].length > 0) keys.push(bearer[1]);

  const direct = xApiKey?.trim();

  if (direct !== undefined && direct.length > 0) keys.push(direct);

  return keys;
}

/**
 * Decide whether a request may proceed.
 *
 * A null `configured` key is a no-op: every request is allowed, exactly as
 * before this check existed. When a key is configured, the request must present
 * it as `Authorization: Bearer <key>` or `x-api-key: <key>`.
 */
export function checkApiKey(
  configured: string | null,
  authorization: string | null,
  xApiKey: string | null,
): boolean {
  if (configured === null) return true;

  return presentedKeys(authorization, xApiKey).some((presented) => constantTimeEquals(presented, configured));
}
