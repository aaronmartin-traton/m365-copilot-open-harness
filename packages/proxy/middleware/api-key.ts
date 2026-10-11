import { API_KEY_ERROR_BODY, checkApiKey, configuredApiKey } from "../api-key";

/**
 * Enforce `M365_API_KEY` on every `/v1/*` route when it is set.
 *
 * Unset (the default) is a no-op, so nothing changes for existing users. Once
 * set, the check runs before any route handler, so no `/v1/*` route can be
 * driven without the key. OPTIONS preflights are left to the CORS middleware:
 * they carry no credentials, and a 401 here would break browser clients.
 */
export default defineEventHandler((event) => {
  const configured = configuredApiKey();

  if (configured === null) return;

  if (getMethod(event) === "OPTIONS") return;

  if (!getRequestURL(event).pathname.startsWith("/v1/")) return;

  const allowed = checkApiKey(
    configured,
    getHeader(event, "authorization") ?? null,
    getHeader(event, "x-api-key") ?? null,
  );

  if (allowed) return;

  return new Response(JSON.stringify(API_KEY_ERROR_BODY), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
});
