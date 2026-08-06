import { z } from "zod/v4";
import { ChatCompletionRequest, ToolCall } from "./schemas.js";
import { handleChatCompletion, type SessionPool } from "./handler.js";

const ContentPart = z.object({
  type: z.string(),
  text: z.string().optional(),
  image_url: z.string().optional(),
  detail: z.enum(["auto", "low", "high"]).optional(),
});

const MessageItem = z.object({
  type: z.literal("message").optional(),
  role: z.enum(["system", "developer", "user", "assistant"]),
  content: z.union([z.string(), z.array(ContentPart)]),
});

const FunctionCallItem = z.object({
  type: z.literal("function_call"),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string(),
});

const FunctionCallOutputItem = z.object({
  type: z.literal("function_call_output"),
  call_id: z.string(),
  output: z.union([z.string(), z.array(ContentPart)]),
});

const FunctionTool = z.object({
  type: z.literal("function"),
  name: z.string(),
  description: z.string().optional(),
  parameters: z.unknown().optional(),
});

export const ResponsesRequest = z.object({
  model: z.string().optional().default("gpt-5.5-think-deeper"),
  instructions: z.string().optional(),
  input: z.union([z.string(), z.array(z.unknown())]),
  tools: z.array(z.unknown()).optional().default([]),
  tool_choice: z.unknown().optional(),
  parallel_tool_calls: z.boolean().optional().default(false),
  previous_response_id: z.string().nullable().optional(),
  reasoning: z.unknown().optional(),
  text: z.unknown().optional(),
  stream: z.boolean().optional().default(false),
  store: z.boolean().optional().default(false),
  prompt_cache_key: z.string().optional(),
  client_metadata: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const ChatCompletionResponse = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.string().nullable().optional(),
      tool_calls: z.array(ToolCall).optional(),
    }),
  })).min(1),
  usage: z.object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
  }).passthrough().optional(),
});

export type ResponsesRequestBody = z.infer<typeof ResponsesRequest>;
type ChatMessageInput = z.input<typeof ChatCompletionRequest>["messages"][number];
type OutputItem =
  | {
      id: string;
      type: "message";
      status: "completed";
      role: "assistant";
      content: Array<{ type: "output_text"; text: string; annotations: never[] }>;
    }
  | {
      id: string;
      type: "function_call";
      status: "completed";
      call_id: string;
      name: string;
      arguments: string;
    };

function contentText(content: string | Array<z.infer<typeof ContentPart>>): string {
  if (typeof content === "string") return content;
  return content.map((part) => part.text ?? "").filter(Boolean).join("\n");
}

function toChatContent(content: string | Array<z.infer<typeof ContentPart>>): ChatMessageInput["content"] {
  if (typeof content === "string") return content;
  return content.flatMap((part) => {
    if ((part.type === "input_image" || part.type === "image_url") && part.image_url) {
      return [{
        type: "image_url" as const,
        image_url: { url: part.image_url, detail: part.detail },
      }];
    }
    if (part.text !== undefined) return [{ type: "text" as const, text: part.text }];
    return [];
  });
}

function toChatMessages(body: ResponsesBody): ChatMessageInput[] {
  const messages: ChatMessageInput[] = [];
  if (body.instructions) messages.push({ role: "system", content: body.instructions });

  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
    return messages;
  }

  for (const rawItem of body.input) {
    const message = MessageItem.safeParse(rawItem);
    if (message.success) {
      messages.push({
        role: message.data.role,
        content: toChatContent(message.data.content),
      });
      continue;
    }

    const call = FunctionCallItem.safeParse(rawItem);
    if (call.success) {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: call.data.call_id,
          type: "function",
          function: { name: call.data.name, arguments: call.data.arguments },
        }],
      });
      continue;
    }

    const output = FunctionCallOutputItem.safeParse(rawItem);
    if (output.success) {
      messages.push({
        role: "tool",
        tool_call_id: output.data.call_id,
        content: contentText(output.data.output),
      });
    }
  }

  return messages;
}

function toChatTools(rawTools: unknown[]) {
  return rawTools.flatMap((rawTool) => {
    const tool = FunctionTool.safeParse(rawTool);
    if (!tool.success) return [];
    return [{
      type: "function" as const,
      function: {
        name: tool.data.name,
        description: tool.data.description,
        parameters: tool.data.parameters,
      },
    }];
  });
}

function toChatToolChoice(choice: unknown) {
  if (choice === "auto" || choice === "none" || choice === "required") return choice;
  const selected = z.object({ type: z.literal("function"), name: z.string() }).safeParse(choice);
  return selected.success
    ? { type: "function" as const, function: { name: selected.data.name } }
    : undefined;
}

interface ResponseEnvelope {
  id: string;
  created_at: number;
  completed_at: number;
  status: "completed";
  output: OutputItem[];
  [key: string]: unknown;
}

function responseEnvelope(body: ResponsesBody, id: string, createdAt: number, output: OutputItem[], usage: z.infer<typeof ChatCompletionResponse>["usage"]): ResponseEnvelope {
  return {
    id,
    object: "response" as const,
    created_at: createdAt,
    completed_at: createdAt,
    status: "completed" as const,
    error: null,
    incomplete_details: null,
    instructions: body.instructions ?? null,
    max_output_tokens: null,
    model: body.model,
    output,
    parallel_tool_calls: body.parallel_tool_calls,
    previous_response_id: body.previous_response_id ?? null,
    reasoning: body.reasoning ?? { effort: null, summary: null },
    store: body.store,
    text: body.text ?? { format: { type: "text" } },
    tool_choice: body.tool_choice ?? "auto",
    tools: body.tools,
    truncation: "disabled",
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: usage?.completion_tokens ?? 0,
      total_tokens: usage?.total_tokens ?? 0,
    },
    metadata: {},
  };
}

function sse(type: string, payload: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function streamResponse(response: ResponseEnvelope): Response {
  const inProgress = { ...response, status: "in_progress", completed_at: null, output: [], usage: null };
  const events: string[] = [
    sse("response.created", { type: "response.created", response: inProgress }),
    sse("response.in_progress", { type: "response.in_progress", response: inProgress }),
  ];

  response.output.forEach((item, outputIndex) => {
    if (item.type === "function_call") {
      const pending = { ...item, status: "in_progress", arguments: "" };
      events.push(sse("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: pending,
      }));
      events.push(sse("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: item.id,
        output_index: outputIndex,
        delta: item.arguments,
      }));
      events.push(sse("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: item.id,
        output_index: outputIndex,
        arguments: item.arguments,
      }));
    } else {
      const text = item.content[0]?.text ?? "";
      const pending = { ...item, status: "in_progress", content: [] };
      events.push(sse("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: pending,
      }));
      events.push(sse("response.content_part.added", {
        type: "response.content_part.added",
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      }));
      events.push(sse("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        delta: text,
      }));
      events.push(sse("response.output_text.done", {
        type: "response.output_text.done",
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        text,
      }));
      events.push(sse("response.content_part.done", {
        type: "response.content_part.done",
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        part: item.content[0],
      }));
    }
    events.push(sse("response.output_item.done", {
      type: "response.output_item.done",
      output_index: outputIndex,
      item,
    }));
  });

  events.push(sse("response.completed", { type: "response.completed", response }));
  return new Response(events.join(""), {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

type BuiltResponse = { envelope: ResponseEnvelope } | { error: Response };

async function buildResponse(
  body: ResponsesBody,
  pool: SessionPool,
  options: { signal?: AbortSignal; sessionKey?: string },
): Promise<BuiltResponse> {
  const id = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
  const metadataSessionId = body.client_metadata && typeof body.client_metadata.session_id === "string"
    ? body.client_metadata.session_id
    : undefined;
  let sessionKey = options.sessionKey;
  let managedKey: string | undefined;
  if (!sessionKey && body.previous_response_id) {
    managedKey = pool.lookupResponseId(body.previous_response_id);
    if (!managedKey) {
      return { error: new Response(JSON.stringify({ error: {
        type: "invalid_request_error",
        message: "Unknown or pruned previous_response_id",
      } }), { status: 404, headers: { "Content-Type": "application/json" } }) };
    }
  }
  sessionKey ??= body.prompt_cache_key ?? metadataSessionId ?? `response:${id}`;

  const chatBody = ChatCompletionRequest.parse({
    model: body.model,
    messages: toChatMessages(body),
    stream: false,
    tools: toChatTools(body.tools),
    tool_choice: toChatToolChoice(body.tool_choice),
  });
  const chatResponse = await handleChatCompletion(chatBody, pool, {
    ...options,
    sessionKey,
    managedKey,
  });
  if (!chatResponse.ok) return { error: chatResponse };

  const completion = ChatCompletionResponse.parse(await chatResponse.json());
  const message = completion.choices[0].message;
  const output: OutputItem[] = message.tool_calls?.length
    ? message.tool_calls.map((call) => ({
        id: `fc_${crypto.randomUUID().replaceAll("-", "")}`,
        type: "function_call",
        status: "completed",
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      }))
    : [{
        id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: message.content ?? "", annotations: [] }],
      }];
  pool.bindResponseId(id, managedKey ?? pool.managedKeyForSessionKey(sessionKey));
  return { envelope: responseEnvelope(body, id, Math.floor(Date.now() / 1000), output, completion.usage) };
}

function streamDeferredResponse(pending: Promise<BuiltResponse>): Response {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      const heartbeat = setInterval(() => {
        try { controller.enqueue(enc.encode(": keepalive\n\n")); } catch {}
      }, 15_000);
      try {
        const built = await pending;
        if ("error" in built) {
          let error: unknown = { message: "M365 upstream error", type: "upstream_error" };
          try { error = JSON.parse(await built.error.text()).error ?? error; } catch {}
          controller.enqueue(enc.encode(sse("response.failed", { type: "response.failed", error })));
          return;
        }
        const source = streamResponse(built.envelope).body?.getReader();
        if (!source) return;
        while (true) {
          const chunk = await source.read();
          if (chunk.done) break;
          controller.enqueue(chunk.value);
        }
      } finally {
        clearInterval(heartbeat);
        try { controller.close(); } catch {}
      }
    },
  }), {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export async function handleResponse(
  body: ResponsesBody,
  pool: SessionPool,
  options: { signal?: AbortSignal; sessionKey?: string } = {},
): Promise<Response> {
  const pending = buildResponse(body, pool, options);
  if (body.stream) return streamDeferredResponse(pending);
  const built = await pending;
  if ("error" in built) return built.error;
  return new Response(JSON.stringify(built.envelope), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
