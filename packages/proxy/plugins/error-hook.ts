import { createLogger } from "@m365-copilot/core";

const log = createLogger("nitro:error");

/**
 * Register Nitro lifecycle hooks that this minimal Nitro app otherwise lacks.
 *
 * Load-bearing: Nitro's internals call `hooks.callHook(...)` /
 * `callHookParallel(...)` and then `.catch(...)` on the result. Those callers
 * return `undefined` when ZERO hooks are registered for the name, so the
 * `.catch` throws a TypeError inside the pipeline — turning ANY request (a
 * plain 404 included) into a 500, and previously (before the error hook
 * below) into a process-killing uncaughtException.
 *
 * One no-op hook per name makes the callers return a real Promise. The
 * no-ops MUST be async: the callers resolve through `createTask`, which
 * under Bun (no `console.createTask`) runs hooks synchronously, so a sync
 * no-op hook still yields `undefined` and the `.catch` crashes again.
 * Observed 2026-08-12: every 404 crashed the proxy; after the error hook
 * alone, every request 500'd on the `request` hook. Sites in the built
 * nitro.mjs:
 *   - callHookParallel("error", ...)          (captureError)
 *   - callHook("request", ...)                (per-request pipeline)
 *   - callHook("beforeResponse", ...)         (response pipeline)
 *   - callHook("afterResponse", ...)          (response pipeline)
 *   - callHook("close")                       (shutdown)
 *
 * The error hook doubles as the log point for the original error, which
 * previously died with the process.
 */
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook("request", async () => {});
  nitroApp.hooks.hook("beforeResponse", async () => {});
  nitroApp.hooks.hook("afterResponse", async () => {});
  nitroApp.hooks.hook("close", async () => {});
  nitroApp.hooks.hook("error", async (error, context) => {
    const tags = Array.isArray(context?.tags) ? context.tags.join(",") : "unknown";
    const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
    log.error(`tags=${tags} ${detail}`);
  });
});
