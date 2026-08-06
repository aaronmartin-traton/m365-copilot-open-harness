import { describe, expect, it } from "vitest";
import { prepareImageAttachments } from "./images.js";

const jwt = (payload: object) => {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.`;
};

describe("prepareImageAttachments", () => {
  it("uploads a data URL and returns an ImageFile annotation", async () => {
    let request: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      request = init;
      return new Response(JSON.stringify({
        docId: "doc-1",
        fileName: "capture.png",
        fileType: ".png",
        result: { value: "Success" },
      }), { status: 200 });
    };

    const attachments = await prepareImageAttachments(
      jwt({ oid: "user-1", tid: "tenant-1" }),
      "conversation-1",
      [{ mediaType: "image/png", data: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]) }],
      fetchImpl,
    );

    expect(request?.headers).toMatchObject({
      "X-Variants": "feature.EnableImageSupportInUploadFile",
      "X-Scenario": "OfficeWebIncludedCopilot",
      "X-AnchorMailbox": "Oid:user-1@tenant-1",
    });
    const form = request?.body as FormData;
    expect(form.get("scenario")).toBe("UploadImage");
    expect(form.get("conversationId")).toBe("conversation-1");
    expect(String(form.get("FileBase64"))).toMatch(/^data:image\/png;base64,/);
    expect(form.getAll("optionsSets")).toEqual([
      "cwcgptvsan",
      "flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch",
      "gptvnorm2048",
    ]);
    expect(attachments[0].annotation).toEqual({
      id: "doc-1",
      messageAnnotationMetadata: {
        "@type": "File",
        annotationType: "File",
        fileType: "png",
        fileName: "capture.png",
      },
      messageAnnotationType: "ImageFile",
    });
  });

  it("rejects malformed JWT claims and upload failures", async () => {
    await expect(prepareImageAttachments("not-a-jwt", "conversation-1", [
      { mediaType: "image/png", data: Uint8Array.from([1]) },
    ])).rejects.toThrow("not a JWT");
    const token = jwt({ oid: "user-1", tid: "tenant-1" });
    const failedFetch: typeof fetch = async () => new Response("nope", { status: 503 });
    await expect(prepareImageAttachments(token, "conversation-1", [
      { mediaType: "image/png", data: Uint8Array.from([1]) },
    ], failedFetch)).rejects.toThrow("HTTP 503");
    const malformedFetch: typeof fetch = async () => new Response("not-json", { status: 200 });
    await expect(prepareImageAttachments(token, "conversation-1", [
      { mediaType: "image/png", data: Uint8Array.from([1]) },
    ], malformedFetch)).rejects.toThrow("invalid JSON");
  });

  it("does not upload an empty image list", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return new Response();
    };
    await expect(prepareImageAttachments("not-a-jwt", "conversation-1", [], fetchImpl)).resolves.toEqual([]);
    expect(called).toBe(false);
  });

  it("uploads multiple images in order with fallback file names", async () => {
    const requests: RequestInit[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      requests.push(init);
      return new Response(JSON.stringify({ result: { value: "Success" }, docId: `doc-${requests.length}` }), { status: 200 });
    };
    const attachments = await prepareImageAttachments(jwt({ oid: "u", tid: "t" }), "c", [
      { mediaType: "image/png", data: Uint8Array.from([1]) },
      { mediaType: "image/jpeg", data: Uint8Array.from([2]), name: "photo.jpg" },
    ], fetchImpl);
    expect(requests).toHaveLength(2);
    expect(attachments.map((item) => item.fileName)).toEqual(["image-1.png", "photo.jpg"]);
    expect(attachments.map((item) => item.docId)).toEqual(["doc-1", "doc-2"]);
  });
});
