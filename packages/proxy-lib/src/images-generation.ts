import { z } from "zod/v4";
import {
  ImageGenerationError,
  createLogger,
  generateImage as coreGenerateImage,
  type GenerateImageOptions,
  type GeneratedImage,
  type ImageGenFailureReason,
  type ImageOrientation,
} from "@m365-copilot/core";
import { SchedulerBusyError } from "./scheduler.js";

const log = createLogger("images-generation");

// --- OpenAI images API request schema (subset backed by M365) ---

const SIZES = [
  "auto",
  "1024x1024",
  "512x512",
  "256x256",
  "1792x1024",
  "1536x1024",
  "1024x512",
  "1024x1792",
  "1024x1536",
  "512x1024",
] as const;

/** Upper bound on `n` — every call opens a fresh M365 conversation. */
export const MAX_IMAGE_COUNT = 4;

export const ImageGenerationRequest = z.object({
  prompt: z.string().trim().min(1),
  // Only the default M365 model is supported. A client may send any model id
  // (OpenAI clients default to gpt-image-1); anything else is ignored rather
  // than forwarded into the M365 chat envelope where it would 502 confusingly.
  model: z.string().optional(),
  // M365 generates ONE image per call and each call is a fresh conversation.
  // n>1 loops over generateImage; n above MAX_IMAGE_COUNT is rejected (the
  // thread budget the scheduler protects is the reason for the cap).
  n: z.number().int().positive().max(MAX_IMAGE_COUNT).optional().default(1),
  size: z.enum(SIZES).optional(),
  response_format: z.enum(["url", "b64_json"]).optional().default("url"),
});

export type ImageGenerationBody = z.infer<typeof ImageGenerationRequest>;

/** OpenAI `size` values map onto the orientation hint passed to M365. */
const SIZE_TO_ORIENTATION: Readonly<Record<string, ImageOrientation | undefined>> = {
  auto: undefined,
  "1024x1024": "square",
  "512x512": "square",
  "256x256": "square",
  "1792x1024": "landscape",
  "1536x1024": "landscape",
  "1024x512": "landscape",
  "1024x1792": "portrait",
  "1024x1536": "portrait",
  "512x1024": "portrait",
};

const FAILURE_STATUS: Record<ImageGenFailureReason, { status: number; type: string }> = {
  quota_exceeded: { status: 429, type: "quota_exceeded" },
  capacity: { status: 400, type: "capacity" },
  content_filtered: { status: 400, type: "content_filter" },
  no_image: { status: 400, type: "invalid_request_error" },
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface ImageGenerationHandlerOptions {
  signal?: AbortSignal;
  /** Injectable for tests; defaults to the core generateImage. */
  generateImage?: (prompt: string, opts?: GenerateImageOptions) => Promise<GeneratedImage[]>;
  /**
   * Gate each M365 generation call through the same scheduler the chat path
   * uses (`newConversation: true`), so concurrent image requests cannot
   * exhaust the account's thread budget. Rejects with SchedulerBusyError when
   * saturated; the handler maps that to 503.
   */
  schedule?: <T>(task: () => Promise<T>) => Promise<T>;
}

/**
 * Handle an OpenAI-compatible image generation request, returning a Response
 * with `{ created, data: [{ url } | { b64_json }] }`.
 */
export async function handleImageGeneration(
  body: ImageGenerationBody,
  opts: ImageGenerationHandlerOptions = {},
): Promise<Response> {
  const generate = opts.generateImage ?? coreGenerateImage;
  const orientation = body.size ? SIZE_TO_ORIENTATION[body.size] : undefined;
  const responseFormat = body.response_format ?? "url";
  const count = body.n ?? 1;
  const schedule = opts.schedule ?? ((task) => task());

  try {
    const data: Array<{ url: string } | { b64_json: string }> = [];
    for (let i = 0; i < count; i++) {
      const images = await schedule(() =>
        generate(body.prompt, {
          // Model is ignored: the only supported model is the M365 default.
          signal: opts.signal,
          orientation,
          // "url" needs only the reference URL (cheap); "b64_json" must fetch bytes.
          urlsOnly: responseFormat === "url",
        }),
      );
      if (images.length === 0) {
        return json(FAILURE_STATUS.no_image.status, {
          error: { message: "No image was generated for the given prompt.", type: FAILURE_STATUS.no_image.type },
        });
      }
      for (const image of images) {
        if (responseFormat === "b64_json") {
          if (!image.base64) {
            log.error("Generated image is missing base64 payload");
            return json(500, { error: { message: "Image data is incomplete", type: "server_error" } });
          }
          data.push({ b64_json: image.base64 });
        } else {
          if (!image.url) {
            log.error("Generated image is missing url");
            return json(500, { error: { message: "Image data is incomplete", type: "server_error" } });
          }
          data.push({ url: image.url });
        }
      }
    }
    return json(200, { created: Math.floor(Date.now() / 1000), data });
  } catch (err) {
    if (opts.signal?.aborted) {
      return json(499, { error: { message: "Request aborted", type: "request_aborted" } });
    }
    if (err instanceof ImageGenerationError) {
      const mapped = FAILURE_STATUS[err.reason];
      log.info(`Image generation failed (${err.reason}): ${err.message}`);
      return json(mapped.status, { error: { message: err.message, type: mapped.type } });
    }
    // SchedulerBusyError from the pool gate: signal the client to back off.
    if (err instanceof SchedulerBusyError) {
      return new Response(
        JSON.stringify({ error: { message: "M365 upstream queue is full", type: "server_busy" } }),
        { status: 503, headers: { "Content-Type": "application/json", "Retry-After": String(err.retryAfterSeconds) } },
      );
    }
    log.error(`Image generation error: ${err instanceof Error ? err.message : String(err)}`);
    return json(502, { error: { message: "Image generation failed", type: "server_error" } });
  }
}
