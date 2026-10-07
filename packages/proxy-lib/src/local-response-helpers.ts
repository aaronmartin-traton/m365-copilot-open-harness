/**
 * Local response helpers for requests that never reach a backend: metadata-only
 * (title generation) and locally-rendered completions.
 */

import { getMessageContent } from "@m365-copilot/core";
import { ChatCompletionRequest } from "./schemas.js";
import type { z } from "zod/v4";
import { jsonResponse, sseResponse } from "./response-helpers.js";

type ChatBody = z.infer<typeof ChatCompletionRequest>;

/** One SSE `chat.completion.chunk` payload. */
interface SseChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices?: unknown[];
}

/** OpenAI usage block — the producer decides which fields it carries. */
interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  x_m365_local_response: boolean;
}

/** The non-stream completion this helper renders locally. */
interface LocalCompletion {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }[];
  usage: Usage;
}

/** The choices array of one SSE chunk. */
interface SseChoices {
  index: number;
  delta: { role?: string; content?: string };
  finish_reason: string | null;
}

/**
 * Detect if this is a metadata-only request (title generation) and return local response.
 * Returns null if this is a normal conversation request.
 */
export function localMetaResponse(body: ChatBody): string | null {
  const metadataType = body.metadata?.request_type?.toLowerCase() ?? "";

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
    const completion: LocalCompletion = {
      id,
      object: "chat.completion",
      created,
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, x_m365_local_response: true },
    };

    return jsonResponse(200, completion);
  }

  const enc = new TextEncoder();

  return sseResponse(new ReadableStream({
    start(controller) {
      const send = (chunk: SseChunk) => controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      const base: SseChunk = { id, object: "chat.completion.chunk", created, model: body.model };

      send({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  }));
}
