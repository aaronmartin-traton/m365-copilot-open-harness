/**
 * Local response helpers for requests that never reach a backend: metadata-only
 * (title generation) and locally-rendered completions.
 */

import { getMessageContent } from "@m365-copilot/core";
import { ChatCompletionRequest } from "./schemas.js";
import type { z } from "zod/v4";
import { jsonResponse, sseResponse } from "./response-helpers.js";

type ChatBody = z.infer<typeof ChatCompletionRequest>;

/**
 * Detect if this is a metadata-only request (title generation) and return local response.
 * Returns null if this is a normal conversation request.
 */
export function localMetaResponse(body: ChatBody): string | null {
  const metadataType = body.metadata && typeof body.metadata.request_type === "string"
    ? body.metadata.request_type.toLowerCase()
    : "";

  const lastUser = [...body.messages].reverse().find((message) => message.role === "user");
  const prompt = lastUser ? getMessageContent(lastUser).trim().toLowerCase() : "";
  const explicit = metadataType === "title" || metadataType === "title_generation";

  const knownPrompt = prompt.includes("generate a concise, sentence-case title") ||
    (prompt.startsWith("generate a concise title") && prompt.includes("conversation"));

  if (!explicit && !knownPrompt) return null;

  return '{"title":"New conversation"}';
}

/**
 * Render a local completion (not sent to M365) as JSON or SSE response.
 */
export function renderLocalCompletion(body: ChatBody, text: string): Response {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  if (!body.stream) {
    return jsonResponse(200, {
      id,
      object: "chat.completion",
      created,
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, x_m365_local_response: true },
    });
  }

  const enc = new TextEncoder();

  return sseResponse(new ReadableStream({
    start(controller) {
      const send = (payload: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`));
      const base = { id, object: "chat.completion.chunk", created, model: body.model };
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  }));
}
