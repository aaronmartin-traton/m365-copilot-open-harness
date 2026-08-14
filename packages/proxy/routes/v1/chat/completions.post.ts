import { ChatCompletionRequest, handleChatCompletion } from "@m365-copilot/proxy-lib";
import { pool } from "../../../server-pool";

export default defineEventHandler(async (event) => {
  let body: ReturnType<typeof ChatCompletionRequest.parse>;
  try {
    body = ChatCompletionRequest.parse(await readBody(event));
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: { message: err.message, type: "invalid_request_error" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Propagate client disconnects as an AbortSignal so a long M365 turn gets
  // cancelled (Stop frame) instead of running on after the caller gave up.
  // Only ServerResponse 'close' fires on premature connection termination:
  // IncomingMessage 'close' fires once the request body is fully read (Node
  // >=16), i.e. inside readBody above — listening on it would abort
  // immediately. Guard with "finish" so a normal close after a completed
  // response is ignored.
  const ac = new AbortController();
  const res = event.node?.res;
  if (res) {
    let finished = false;
    res.once("finish", () => { finished = true; });
    res.once("close", () => { if (!finished && !res.writableEnded) ac.abort(); });
  }

  // handleChatCompletion returns a Web Response (JSON or an SSE ReadableStream
  // when stream:true). Returning it directly lets h3 forward it untouched.
  return handleChatCompletion(body, pool, {
    signal: ac.signal,
    sessionKey: getHeader(event, "x-m365-session-key") ?? undefined,
  });
});
