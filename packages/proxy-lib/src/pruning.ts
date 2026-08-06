import { z } from "zod/v4";
import type { ConversationPruneSelector, SessionPool } from "./handler.js";

export const ConversationPruneSelectorSchema = z.union([
  z.object({ session_key: z.string().min(1) }).strict(),
  z.object({ conversation_id: z.string().min(1) }).strict(),
]);

export type ConversationPruneRequest = z.infer<typeof ConversationPruneSelectorSchema>;

type PrunablePool = Pick<SessionPool, "prune">;

function toSelector(body: ConversationPruneRequest): ConversationPruneSelector {
  return "session_key" in body
    ? { sessionKey: body.session_key }
    : { conversationId: body.conversation_id };
}

export async function handleConversationPrune(
  pool: PrunablePool,
  body: ConversationPruneRequest,
): Promise<Response> {
  try {
    const result = await pool.prune(toSelector(body));
    if (!result) {
      return new Response(JSON.stringify({ error: { type: "not_found", message: "Unknown managed conversation" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ deleted: true, conversation_id: result.conversationId }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    const message = error instanceof Error && error.message === "remote_prune_unavailable"
      ? "M365 web conversation deletion is unavailable"
      : "M365 web conversation deletion failed";
    return new Response(JSON.stringify({ error: { type: "remote_prune_unavailable", message } }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
}
