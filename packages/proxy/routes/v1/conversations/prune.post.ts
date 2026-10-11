import { timingSafeEqual } from "node:crypto";
import {
  ConversationPruneSelectorSchema,
  handleConversationPrune,
  jsonResponse,
} from "@m365-copilot/proxy-lib";
import { pool } from "../../../server-pool";

function validBearer(header: string | undefined, expected: string): boolean {
  const prefix = "Bearer ";

  if (!header?.startsWith(prefix)) return false;
  const supplied = Buffer.from(header.slice(prefix.length), "utf8");
  const secret = Buffer.from(expected, "utf8");

  return supplied.length === secret.length && timingSafeEqual(supplied, secret);
}

export default defineEventHandler(async (event) => {
  const expected = process.env.M365_PRUNE_TOKEN;

  if (!expected) return jsonResponse(404, { error: { type: "not_found", message: "Not found" } });

  if (!validBearer(getHeader(event, "authorization"), expected)) {
    return jsonResponse(401, { error: { type: "authentication_error", message: "Invalid prune token" } });
  }

  let body: unknown;

  try {
    body = await readBody(event);
  } catch {
    return jsonResponse(400, { error: { type: "invalid_request_error", message: "Invalid JSON body" } });
  }

  const parsed = ConversationPruneSelectorSchema.safeParse(body);

  if (!parsed.success) {
    return jsonResponse(400, { error: { type: "invalid_request_error", message: parsed.error.message } });
  }

  return handleConversationPrune(pool, parsed.data);
});
