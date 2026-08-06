import { describe, expect, it } from "vitest";
import { MAX_IMAGE_BYTES, parseImageDataUrl } from "./images.js";


const pngDataUrl = `data:image/png;base64,${Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10,
]).toString("base64")}`;

describe("parseImageDataUrl", () => {
  it("accepts a signed PNG data URL", () => {
    expect(parseImageDataUrl(pngDataUrl, "low")).toMatchObject({
      mediaType: "image/png",
      detail: "low",
      data: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    });
  });

  it("accepts signed JPEG and WebP data URLs", () => {
    const jpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64")}`;
    const webp = `data:image/webp;base64,${Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    ]).toString("base64")}`;
    expect(parseImageDataUrl(jpeg).mediaType).toBe("image/jpeg");
    expect(parseImageDataUrl(webp).mediaType).toBe("image/webp");
  });

  it("rejects empty and malformed data URLs", () => {
    expect(() => parseImageDataUrl("data:image/png;base64,")).toThrow("empty");
    expect(() => parseImageDataUrl("data:image/png;base64,not-base64!")).toThrow("data URL");
  });

  it("rejects decoded bytes above the configured limit", () => {
    const bytes = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.alloc(MAX_IMAGE_BYTES + 1),
    ]);
    expect(() => parseImageDataUrl(`data:image/png;base64,${bytes.toString("base64")}`)).toThrow("exceeds");
  });

  it("rejects remote and file URLs", () => {
    expect(() => parseImageDataUrl("file:///tmp/image.png")).toThrow("data URL");
  });

  it("rejects remote URLs and media-type spoofing", () => {
    expect(() => parseImageDataUrl("https://example.com/image.png")).toThrow("data URL");
    expect(() => parseImageDataUrl(`data:image/jpeg;base64,${Buffer.from([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]).toString("base64")}`)).toThrow("do not match");
  });
});

