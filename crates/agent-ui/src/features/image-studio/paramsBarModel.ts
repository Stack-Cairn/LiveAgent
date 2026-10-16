import type { GenerationParams, ImageTarget } from "../../lib/imaging/types";

/** The unified parameter bar. One row of controls for every platform; the
 * backend converts the values and corrects anything the platform cannot take
 * (see 2026-10-16-image-studio-rebuild.md 3.4). A control is disabled — not
 * hidden — when the target's platform does not declare the matching native key,
 * so the layout never shifts while switching models. */

export type ParamField =
  | "size"
  | "quality"
  | "outputFormat"
  | "outputCompression"
  | "moderation"
  | "transparentOutput";

export const QUALITY_VALUES = ["auto", "low", "medium", "high"] as const;
export const FORMAT_VALUES = ["png", "jpeg", "webp"] as const;
export const MODERATION_VALUES = ["auto", "low"] as const;
export const QUALITY_LABELS: Record<string, string> = {
  auto: "自动",
  low: "低",
  medium: "中",
  high: "高",
};
export const FORMAT_LABELS: Record<string, string> = {
  png: "PNG",
  jpeg: "JPEG",
  webp: "WebP",
};

/** Ratio presets per tier, 16-pixel aligned, mirroring the backend's envelope. */
export const SIZE_PRESETS: Record<string, Record<string, string>> = {
  "1K": {
    "1:1": "1024x1024",
    "3:2": "1536x1024",
    "2:3": "1024x1536",
    "16:9": "1280x720",
    "9:16": "720x1280",
    "4:3": "1024x768",
    "3:4": "768x1024",
    "21:9": "1280x544",
  },
  "2K": {
    "1:1": "2048x2048",
    "3:2": "2160x1440",
    "2:3": "1440x2160",
    "16:9": "2560x1440",
    "9:16": "1440x2560",
    "4:3": "2048x1536",
    "3:4": "1536x2048",
    "21:9": "2560x1088",
  },
  "4K": {
    "1:1": "2880x2880",
    "3:2": "3520x2352",
    "2:3": "2352x3520",
    "16:9": "3840x2160",
    "9:16": "2160x3840",
    "4:3": "3200x2400",
    "3:4": "2400x3200",
    "21:9": "3840x1648",
  },
};

export const ALL_FIELDS: ParamField[] = [
  "size",
  "quality",
  "outputFormat",
  "outputCompression",
  "moderation",
  "transparentOutput",
];

/** Which unified fields the target accepts, derived from the native parameter
 * keys its adapter declared. */
export function allowedFields(target: ImageTarget | undefined): Set<ParamField> {
  const keys = new Set((target?.parameters ?? []).map((spec) => spec.key));
  const allowed = new Set<ParamField>();
  if (keys.has("size") || (keys.has("aspect_ratio") && keys.has("image_size"))) allowed.add("size");
  if (keys.has("quality")) allowed.add("quality");
  if (keys.has("output_format")) allowed.add("outputFormat");
  if (keys.has("output_compression")) allowed.add("outputCompression");
  if (keys.has("moderation")) allowed.add("moderation");
  if (keys.has("background")) allowed.add("transparentOutput");
  return allowed;
}

export function defaultParams(target: ImageTarget | undefined): GenerationParams {
  const allowed = allowedFields(target);
  const params: GenerationParams = { size: "auto", n: 1 };
  if (allowed.has("quality")) params.quality = "auto";
  if (allowed.has("outputFormat")) params.outputFormat = "png";
  if (allowed.has("moderation")) params.moderation = "auto";
  return params;
}

/** Drop values the current target cannot use; unsupported fields are omitted
 * rather than sent and rejected. */
export function pruneParams(
  target: ImageTarget | undefined,
  values: Record<string, unknown>,
): GenerationParams {
  const allowed = allowedFields(target);
  const params: GenerationParams = { size: "auto", n: 1 };
  const text = (key: string): string | undefined => {
    const value = values[key];
    return typeof value === "string" && value ? value : undefined;
  };
  const size = text("size");
  if (allowed.has("size") && size) params.size = size;
  const quality = text("quality");
  if (allowed.has("quality") && quality) params.quality = quality;
  const format = text("outputFormat");
  if (allowed.has("outputFormat") && format) params.outputFormat = format;
  const moderation = text("moderation");
  if (allowed.has("moderation") && moderation) params.moderation = moderation;
  if (allowed.has("transparentOutput") && values.transparentOutput === true)
    params.transparentOutput = true;
  const compression = values.outputCompression;
  if (
    allowed.has("outputCompression") &&
    typeof compression === "number" &&
    Number.isInteger(compression) &&
    compression >= 0 &&
    compression <= 100
  )
    params.outputCompression = compression;
  return params;
}

/** Human-readable summary for the task card, in the order the bar shows them. */
export function describeParams(params: GenerationParams | undefined): string[] {
  if (!params) return [];
  const parts: string[] = [];
  if (params.size && params.size !== "auto") parts.push(params.size);
  if (params.quality && params.quality !== "auto")
    parts.push(`质量 ${QUALITY_LABELS[params.quality] ?? params.quality}`);
  if (params.outputFormat && params.outputFormat !== "png")
    parts.push(FORMAT_LABELS[params.outputFormat] ?? params.outputFormat);
  if (params.outputCompression !== undefined) parts.push(`压缩 ${params.outputCompression}`);
  if (params.moderation && params.moderation !== "auto") parts.push("审核低");
  if (params.transparentOutput) parts.push("透明背景");
  return parts;
}
