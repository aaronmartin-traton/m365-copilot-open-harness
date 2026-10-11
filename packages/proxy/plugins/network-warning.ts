import { configuredApiKey } from "../api-key";

/**
 * Warn loudly when the proxy binds to something other than loopback.
 *
 * `HOST` is configurable, and a network-reachable proxy has no authentication
 * unless `M365_API_KEY` is set — anyone on the network could then spend the
 * signed-in account's quota and drive any tool the client offers. Written with
 * `console.warn` rather than `createLogger` so the warning is always visible;
 * the logger only writes when `M365_DEBUG`/`M365_TRACE` is on.
 */
export default defineNitroPlugin(() => {
  const host = process.env.NITRO_HOST ?? process.env.HOST ?? "127.0.0.1";
  const name = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = name === "localhost" || name === "::1" || name === "::ffff:127.0.0.1" || name.startsWith("127.");

  if (loopback) return;

  const keyed = configuredApiKey() !== null;

  console.warn(
    `[m365-proxy] WARNING: bound to ${host}, which is not loopback — the proxy is reachable from the network. ` +
      (keyed
        ? "It requires M365_API_KEY, so callers must present the key."
        : "It has NO AUTHENTICATION: anyone who can reach this port can spend the signed-in account's quota " +
          "and drive any tool the client offers. Set M365_API_KEY, or bind HOST=127.0.0.1."),
  );
});
