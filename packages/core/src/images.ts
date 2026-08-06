
export const MAX_IMAGE_BYTES = Number(process.env.M365_IMAGE_MAX_BYTES ?? 20 * 1024 * 1024);
export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp";

export interface ImageInput {
  mediaType: ImageMediaType;
  data: Uint8Array;
  detail?: "auto" | "low" | "high";
  name?: string;
}

export interface PreparedImageAttachment {
  docId: string;
  fileName: string;
  fileType: string;
  annotation: {
    id: string;
    messageAnnotationMetadata: {
      "@type": "File";
      annotationType: "File";
      fileType: string;
      fileName: string;
    };
    messageAnnotationType: "ImageFile";
  };
}

interface UploadResponse {
  docId?: string;
  fileName?: string;
  fileType?: string;
  result?: { value?: string };
}

function tokenClaims(token: string): { oid: string; tid: string } {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("M365 image upload token is not a JWT");
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!parsed.oid || !parsed.tid) throw new Error("missing oid/tid");
    return { oid: parsed.oid, tid: parsed.tid };
  } catch (error) {
    throw new Error(`M365 image upload token claims are invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function prepareImageAttachments(
  token: string,
  conversationId: string,
  images: ImageInput[],
  fetchImpl: typeof fetch = fetch,
): Promise<PreparedImageAttachment[]> {
  if (images.length === 0) return [];
  const claims = tokenClaims(token);
  const attachments: PreparedImageAttachment[] = [];
  for (let index = 0; index < images.length; index++) {
    const image = images[index];
    const fileType = image.mediaType === "image/jpeg" ? "jpg" : image.mediaType.split("/")[1];
    const fallbackName = image.name || `image-${index + 1}.${fileType}`;
    const dataUrl = `data:${image.mediaType};base64,${Buffer.from(image.data).toString("base64")}`;
    const form = new FormData();
    form.append("scenario", "UploadImage");
    form.append("conversationId", conversationId);
    form.append("FileBase64", dataUrl);
    form.append("optionsSets", "cwcgptvsan");
    form.append("optionsSets", "flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch");
    form.append("optionsSets", "gptvnorm2048");

    const response = await fetchImpl("https://substrate.office.com/m365Copilot/UploadFile", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        Origin: "https://m365.cloud.microsoft",
        "X-Variants": "feature.EnableImageSupportInUploadFile",
        "X-Scenario": "OfficeWebIncludedCopilot",
        "X-AnchorMailbox": `Oid:${claims.oid}@${claims.tid}`,
      },
      body: form,
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`M365 image upload failed: HTTP ${response.status} ${raw.slice(0, 500)}`);
    let payload: UploadResponse;
    try { payload = JSON.parse(raw) as UploadResponse; }
    catch { throw new Error("M365 image upload returned invalid JSON"); }
    if (payload.result?.value !== "Success" || !payload.docId) {
      throw new Error(`M365 image upload failed: ${raw.slice(0, 500)}`);
    }
    const uploadedType = (payload.fileType || fileType).replace(/^\./, "").toLowerCase().replace(/^jpeg$/, "jpg");
    const fileName = payload.fileName || fallbackName;
    attachments.push({
      docId: payload.docId,
      fileName,
      fileType: uploadedType,
      annotation: {
        id: payload.docId,
        messageAnnotationMetadata: {
          "@type": "File",
          annotationType: "File",
          fileType: uploadedType,
          fileName,
        },
        messageAnnotationType: "ImageFile",
      },
    });
  }
  return attachments;
}
