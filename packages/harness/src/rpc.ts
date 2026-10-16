import { z } from "zod";

/**
 * Records of Pi's RPC interface (`pi --mode rpc`), which Pi-Bolt implements
 * unchanged: one JSON object per LF-terminated line, commands on stdin, and
 * responses plus session events on stdout. Stdout carries protocol records
 * only; diagnostics go to stderr.
 *
 * Reference: https://pi.dev/docs/latest/rpc
 */

export const rpcLineSchema = z.object({ type: z.string() }).loose();

export const rpcResponseSchema = z
  .object({
    type: z.literal("response"),
    id: z.string().optional(),
    command: z.string(),
    success: z.boolean(),
    error: z.string().optional(),
  })
  .loose();

export const rpcTextDeltaSchema = z
  .object({
    type: z.literal("message_update"),
    assistantMessageEvent: z
      .object({ type: z.literal("text_delta"), delta: z.string() })
      .loose(),
  })
  .loose();

export const rpcSettledSchema = z.object({ type: z.literal("agent_settled") }).loose();

export type RpcLine = z.infer<typeof rpcLineSchema>;

export type RpcResponse = z.infer<typeof rpcResponseSchema>;

/** Parse one protocol line: the decoded record, or null when it is not one. */
export function parseRpcLine(text: string): RpcLine | null {
  try {
    const parsed = rpcLineSchema.safeParse(JSON.parse(text));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface JsonlReaderHandlers {
  readonly onRecord: (record: RpcLine) => void;
  readonly onMalformed: (line: string) => void;
}

/**
 * Splits a byte stream into LF-delimited records. Node's `readline` also
 * splits on U+2028 and U+2029, which are legal inside JSON string values, so
 * the framing is done here instead.
 */
export class JsonlReader {
  readonly #handlers: JsonlReaderHandlers;
  readonly #decoder = new TextDecoder();
  #buffer = "";

  constructor(handlers: JsonlReaderHandlers) {
    this.#handlers = handlers;
  }

  push(chunk: Uint8Array): void {
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    this.#drain();
  }

  flush(): void {
    this.#buffer += this.#decoder.decode();

    const remainder = this.#buffer;
    this.#buffer = "";

    if (remainder.trim().length > 0) {
      this.#emit(remainder);
    }
  }

  #drain(): void {
    for (
      let boundary = this.#buffer.indexOf("\n");
      boundary !== -1;
      boundary = this.#buffer.indexOf("\n")
    ) {
      const line = this.#buffer.slice(0, boundary);
      this.#buffer = this.#buffer.slice(boundary + 1);
      this.#emit(line);
    }
  }

  #emit(line: string): void {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;

    if (text.trim().length === 0) return;

    const record = parseRpcLine(text);

    if (record === null) {
      this.#handlers.onMalformed(text);

      return;
    }

    this.#handlers.onRecord(record);
  }
}
