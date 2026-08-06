export const MAX_IMAGE_BYTES = Number(process.env.M365_IMAGE_MAX_BYTES ?? 20 * 1024 * 1024);
export type ParsedImageInput = {
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  data: Uint8Array;
  detail?: "auto" | "low" | "high";
};

const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/;

function hasExpectedSignature(mediaType: ParsedImageInput["mediaType"], data: Uint8Array): boolean {
  if (mediaType === "image/png") {
    return data.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => data[index] === byte);
  }
  if (mediaType === "image/jpeg") return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  return data.length >= 12 && Buffer.from(data.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(data.subarray(8, 12)).toString("ascii") === "WEBP";
}

export function parseImageDataUrl(
  value: string,
  detail?: "auto" | "low" | "high",
): ParsedImageInput {
  const match = DATA_URL.exec(value);
  if (!match) throw new Error("image must be a base64 PNG, JPEG, or WebP data URL");
  const mediaType = match[1] as ParsedImageInput["mediaType"];
  const encoded = match[2];
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const decodedSize = Math.floor(encoded.length * 3 / 4) - padding;
  if (decodedSize <= 0) throw new Error("image data URL is empty");
  if (decodedSize > MAX_IMAGE_BYTES) throw new Error(`decoded image exceeds ${MAX_IMAGE_BYTES} byte limit`);
  const data = Uint8Array.from(Buffer.from(encoded, "base64"));
  if (data.byteLength !== decodedSize || !hasExpectedSignature(mediaType, data)) {
    throw new Error(`image bytes do not match declared media type ${mediaType}`);
  }
  return { mediaType, data, detail };
}

