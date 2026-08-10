import { ImageGenerationError, type GeneratedImage } from "@m365-copilot/core";
import { describe, expect, it, vi } from "vitest";
import { ImageGenerationRequest, handleImageGeneration } from "./images-generation.js";

function image(overrides: Partial<GeneratedImage> = {}): GeneratedImage {
  return {
    url: "https://example.test/image.png",
    contentType: "image/png",
    data: Buffer.alloc(0),
    base64: "cG5n",
    ...overrides,
  };
}

describe("image generation request validation", () => {
  it("rejects a body without a prompt", () => {
    expect(() => ImageGenerationRequest.parse({})).toThrow();
    expect(() => ImageGenerationRequest.parse({ prompt: "" })).toThrow();
  });

  it("rejects an unknown size and a non-positive or fractional n", () => {
    expect(() => ImageGenerationRequest.parse({ prompt: "p", size: "999x999" })).toThrow();
    expect(() => ImageGenerationRequest.parse({ prompt: "p", n: 0 })).toThrow();
    expect(() => ImageGenerationRequest.parse({ prompt: "p", n: 1.5 })).toThrow();
  });

  it("defaults n to 1 and response_format to url", () => {
    const parsed = ImageGenerationRequest.parse({ prompt: "p" });
    expect(parsed.n).toBe(1);
    expect(parsed.response_format).toBe("url");
  });
});

describe("handleImageGeneration", () => {
  it("returns the reference url for response_format url", async () => {
    const generateImage = vi.fn(async () => [image()]);
    const res = await handleImageGeneration(ImageGenerationRequest.parse({ prompt: "a cat" }), { generateImage });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBeTypeOf("number");
    expect(body.data).toEqual([{ url: "https://example.test/image.png" }]);
    expect(generateImage).toHaveBeenCalledWith("a cat", expect.objectContaining({ urlsOnly: true }));
  });

  it("returns the base64 payload for response_format b64_json", async () => {
    const generateImage = vi.fn(async () => [image({ base64: "aGVsbG8=" })]);
    const res = await handleImageGeneration(
      ImageGenerationRequest.parse({ prompt: "a dog", response_format: "b64_json" }),
      { generateImage },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([{ b64_json: "aGVsbG8=" }]);
    expect(generateImage).toHaveBeenCalledWith("a dog", expect.objectContaining({ urlsOnly: false }));
  });

  it.each([
    ["1024x1024", "square"],
    ["512x512", "square"],
    ["256x256", "square"],
    ["1792x1024", "landscape"],
    ["1536x1024", "landscape"],
    ["1024x1792", "portrait"],
    ["1024x1536", "portrait"],
  ] as const)("maps size %s to orientation %s", async (size, orientation) => {
    const generateImage = vi.fn(async () => [image()]);
    await handleImageGeneration(ImageGenerationRequest.parse({ prompt: "p", size }), { generateImage });
    expect(generateImage).toHaveBeenCalledWith("p", expect.objectContaining({ orientation }));
  });

  it("passes no orientation hint when size is unset", async () => {
    const generateImage = vi.fn(async () => [image()]);
    await handleImageGeneration(ImageGenerationRequest.parse({ prompt: "p" }), { generateImage });
    expect(generateImage).toHaveBeenCalledWith("p", expect.objectContaining({ orientation: undefined }));
  });

  it("loops once per n and rejects n above the cap", async () => {
    const generateImage = vi.fn(async () => [image()]);
    const res = await handleImageGeneration(ImageGenerationRequest.parse({ prompt: "p", n: 3 }), { generateImage });
    expect(generateImage).toHaveBeenCalledTimes(3);
    expect((await res.json()).data).toHaveLength(3);
    // n above MAX_IMAGE_COUNT is a schema error (400), never a silent cap.
    expect(ImageGenerationRequest.safeParse({ prompt: "p", n: 6 }).success).toBe(false);
  });

  it.each([
    ["quota_exceeded", 429, "quota_exceeded"],
    ["capacity", 400, "capacity"],
    ["content_filtered", 400, "content_filter"],
    ["no_image", 400, "invalid_request_error"],
  ] as const)("maps %s failure to %d %s", async (reason, status, type) => {
    const generateImage = vi.fn(async () => { throw new ImageGenerationError(reason, `${reason} boom`); });
    const res = await handleImageGeneration(ImageGenerationRequest.parse({ prompt: "p" }), { generateImage });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: { message: `${reason} boom`, type } });
  });

  it("maps an empty image list to 400 invalid_request_error", async () => {
    const generateImage = vi.fn(async () => []);
    const res = await handleImageGeneration(ImageGenerationRequest.parse({ prompt: "p" }), { generateImage });
    expect(res.status).toBe(400);
    expect((await res.json()).error.type).toBe("invalid_request_error");
  });

  it("maps unexpected errors to 502", async () => {
    const generateImage = vi.fn(async () => { throw new Error("upstream exploded"); });
    const res = await handleImageGeneration(ImageGenerationRequest.parse({ prompt: "p" }), { generateImage });
    expect(res.status).toBe(502);
  });

  it("forwards the abort signal to generateImage", async () => {
    const generateImage = vi.fn(async () => [image()]);
    const ac = new AbortController();
    await handleImageGeneration(ImageGenerationRequest.parse({ prompt: "p" }), { generateImage, signal: ac.signal });
    expect(generateImage).toHaveBeenCalledWith("p", expect.objectContaining({ signal: ac.signal }));
  });

  it("returns 499 request_aborted when the signal is aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const generateImage = vi.fn(async () => { throw new Error("websocket closed"); });
    const res = await handleImageGeneration(ImageGenerationRequest.parse({ prompt: "p" }), {
      generateImage,
      signal: ac.signal,
    });
    expect(res.status).toBe(499);
    expect((await res.json()).error.type).toBe("request_aborted");
  });

  it("maps a scheduler-busy rejection to 503 with Retry-After", async () => {
    const { SchedulerBusyError } = await import("./scheduler.js");
    const generateImage = vi.fn(async () => { throw new SchedulerBusyError("queue full", 7); });
    const res = await handleImageGeneration(ImageGenerationRequest.parse({ prompt: "p" }), { generateImage });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("7");
    expect((await res.json()).error.type).toBe("server_busy");
  });

  it("is all-or-nothing on partial n-loop failure (no data leak)", async () => {
    let calls = 0;
    const generateImage = vi.fn(async () => {
      calls++;
      if (calls === 1) return [image()];
      throw new ImageGenerationError("capacity", "capacity boom");
    });
    const res = await handleImageGeneration(ImageGenerationRequest.parse({ prompt: "p", n: 2 }), { generateImage });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.type).toBe("capacity");
    expect(body.data).toBeUndefined();
  });

  it("maps a missing url to 500 (data integrity, not upstream)", async () => {
    const generateImage = vi.fn(async () => [image({ url: "" })]);
    const res = await handleImageGeneration(ImageGenerationRequest.parse({ prompt: "p" }), { generateImage });
    expect(res.status).toBe(500);
    expect((await res.json()).error.type).toBe("server_error");
  });

  it("maps a missing base64 to 500 on the b64_json path", async () => {
    const generateImage = vi.fn(async () => [image({ base64: "" })]);
    const res = await handleImageGeneration(
      ImageGenerationRequest.parse({ prompt: "p", response_format: "b64_json" }),
      { generateImage },
    );
    expect(res.status).toBe(500);
    expect((await res.json()).error.type).toBe("server_error");
  });

  it("rejects a whitespace-only prompt", () => {
    expect(() => ImageGenerationRequest.parse({ prompt: "   " })).toThrow();
  });

  it("accepts the gpt-image-1 size set including auto", async () => {
    const generateImage = vi.fn(async () => [image()]);
    const res = await handleImageGeneration(ImageGenerationRequest.parse({ prompt: "p", size: "auto" }), {
      generateImage,
    });
    expect(res.status).toBe(200);
    expect(generateImage).toHaveBeenCalledWith("p", expect.objectContaining({ orientation: undefined }));
  });

  it("routes every image through the injected schedule gate", async () => {
    const generateImage = vi.fn(async () => [image()]);
    const scheduled: number[] = [];
    const res = await handleImageGeneration(ImageGenerationRequest.parse({ prompt: "p", n: 3 }), {
      generateImage,
      schedule: async (task) => { scheduled.push(1); return task(); },
    });
    expect(res.status).toBe(200);
    expect(scheduled).toHaveLength(3);
  });
});
