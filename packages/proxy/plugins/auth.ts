import { getToken, validateLocalShellBackend, openAiApiKey, openAiBaseUrl, openAiRequiresKey } from "@m365-copilot/core";

/**
 * Authenticate the configured backend once, at server startup. A failure here
 * throws and aborts boot — the equivalent of the old binary's
 * `process.exit(1)` on auth failure, so the server never comes up half-broken.
 *
 * The backend decides what "authenticate" means. The M365 lane opens a
 * browser; the OpenAI lane checks for a key (or, against a self-hosted
 * endpoint, deliberately checks that none is required). Authenticating M365 on
 * an `openai` host would pop a sign-in window nobody asked for.
 */
export default defineNitroPlugin(async () => {
  const backend = process.env.PROVIDER ?? "m365";

  console.log(`Authenticating (${backend})...`);
  validateLocalShellBackend();

  if (backend === "openai") {
    const key = openAiApiKey();

    if (openAiRequiresKey() && key === null) {
      throw new Error(
        "PROVIDER=openai needs an API key. Set OPENAI_API_KEY, or point OPENAI_BASE_URL at a local server (e.g. LM Studio) which needs none.",
      );
    }

    console.log(
      key === null
        ? `OpenAI lane ready: local endpoint ${openAiBaseUrl()} (no key required).`
        : "OpenAI lane ready.",
    );
    return;
  }

  try {
    await getToken();
  } catch (err: any) {
    console.error(`Auth failed: ${err.message}`);
    throw err;
  }
});
