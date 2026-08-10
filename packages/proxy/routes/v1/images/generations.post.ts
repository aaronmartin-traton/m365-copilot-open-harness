import { ImageGenerationRequest, handleImageGeneration } from "@m365-copilot/proxy-lib";
import { pool } from "../../../server-pool";

export default defineEventHandler(async (event) => {
  let body: ReturnType<typeof ImageGenerationRequest.parse>;
  try {
    body = ImageGenerationRequest.parse(await readBody(event));
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: { message: err.message, type: "invalid_request_error" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Propagate a client disconnect as an AbortSignal so a long M365 image turn
  // gets cancelled instead of running on after the caller gave up.
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

  // Gate each M365 generation through the pool scheduler (new conversation per
  // image) so concurrent requests cannot exhaust the account thread budget.
  return handleImageGeneration(body, {
    signal: ac.signal,
    schedule: (task) => pool.schedule({ newConversation: true }, task),
  });
});
