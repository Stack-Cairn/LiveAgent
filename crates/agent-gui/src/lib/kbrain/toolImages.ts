import type { ImageContent } from "@liveagent/app/lib/agentTypes";
import type {
  DisplayImageItemDetails,
  DisplayImageResultDetails,
} from "@liveagent/ui/contracts/builtinTools";
import type { KBrainContentBlock } from "./types";

const DATA_URL_PREFIX = /^data:([^;,]+);base64,/i;
const REMOTE_URL = /^https?:\/\//i;
const DISPLAY_LINE_PREFIX = "Display image: ";

export type KBrainToolImages = {
  content: ImageContent[];
  images: DisplayImageItemDetails[];
};

/**
 * K-brain sends tool images as `image_url` (a data URL, or the remote URL an
 * Image call displays). The transcript stores raw base64 plus the MIME type and
 * renders remote images through the proxy, so split them here.
 */
export function kbrainToolImages(
  blocks: readonly KBrainContentBlock[] | undefined,
  output = "",
): KBrainToolImages {
  const labels = output
    .split("\n")
    .filter((line) => line.startsWith(DISPLAY_LINE_PREFIX))
    .map((line) => line.slice(DISPLAY_LINE_PREFIX.length).trim());
  const content: ImageContent[] = [];
  const images: DisplayImageItemDetails[] = [];
  for (const block of blocks ?? []) {
    if (block.type !== "image" || !block.image_url) continue;
    const label = labels[images.length] || `inline-image-${images.length + 1}`;
    if (REMOTE_URL.test(block.image_url)) {
      images.push({
        path: label,
        sourceType: "url",
        renderMode: "proxy",
        sourceUrl: block.image_url,
      });
      continue;
    }
    const match = DATA_URL_PREFIX.exec(block.image_url);
    const mimeType = block.mime_type || match?.[1] || "image/png";
    const data = match ? block.image_url.slice(match[0].length) : block.image_url;
    content.push({ type: "image", data, mimeType });
    images.push({
      path: label,
      renderMode: "inline",
      mimeType,
      sizeBytes: Math.ceil((data.length * 3) / 4),
    });
  }
  return { content, images };
}

/** The native `display_image` details the transcript renders an Image call from. */
export function displayImageResultDetails(
  toolName: string | undefined,
  images: readonly DisplayImageItemDetails[],
  isError: boolean,
): DisplayImageResultDetails | undefined {
  if (toolName !== "Image" || isError || images.length === 0) return undefined;
  const proxied = images.filter((image) => image.renderMode === "proxy").length;
  return {
    kind: "display_image",
    images: [...images],
    loadMode: proxied === 0 ? "inline" : proxied === images.length ? "proxy" : "mixed",
  };
}
