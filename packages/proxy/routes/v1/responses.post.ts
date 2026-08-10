import { handleResponse, ResponsesRequest } from "@m365-copilot/proxy-lib";
import { pool } from "../../server-pool";

export default defineEventHandler(async (event) => {
  let body;
  try {
    body = ResponsesRequest.parse(await readBody(event));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(
      JSON.stringify({ error: { message, type: "invalid_request_error" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const abortController = new AbortController();
  const request = event.node?.req;
  const response = event.node?.res;
  if (request && response) {
    let finished = false;
    response.once("finish", () => { finished = true; });
    const maybeAbort = () => {
      if (!finished && !response.writableEnded) abortController.abort();
    };
    request.once("close", maybeAbort);
    response.once("close", maybeAbort);
  }

  return handleResponse(body, pool, {
    signal: abortController.signal,
    sessionKey: getHeader(event, "x-m365-session-key") ?? undefined,
    executionGate: getHeader(event, "x-m365-execution-gate") ?? undefined,
    attestationClient: getHeader(event, "x-m365-attestation-client") ?? undefined,
    attestationProof: getHeader(event, "x-m365-attestation-proof") ?? undefined,
  });
});
