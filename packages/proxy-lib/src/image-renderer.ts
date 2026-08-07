/**
 * Image rendering utilities for M365 Copilot responses.
 *
 * Handles fetching and rendering images from M365 artifact tokens or URLs.
 */

import { getImageArtifactToken, fetchImageBytes, type CapturedImage } from "@m365-copilot/core";
import { createLogger } from "@m365-copilot/core";

const log = createLogger("image-renderer");

/**
 * Render images as Markdown, fetching from M365 artifact tokens when available.
 */
export async function renderImagesMarkdown(images: CapturedImage[]): Promise<string> {
  let artifactToken: string | null = null;
  try {
    artifactToken = await getImageArtifactToken();
  } catch (error: unknown) {
    log.info(`image token failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const parts: string[] = [];
  for (const image of images) {
    const url = image.referenceUrls[0];
    if (!url) continue;

    if (artifactToken) {
      try {
        const fetched = await fetchImageBytes(url, artifactToken);
        parts.push(`![generated image](data:${fetched.contentType};base64,${fetched.data.toString("base64")})`);
        continue;
      } catch (error: unknown) {
        log.info(`image fetch failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    parts.push(`![generated image](${url})`);
  }

  return parts.join("\n\n");
}
