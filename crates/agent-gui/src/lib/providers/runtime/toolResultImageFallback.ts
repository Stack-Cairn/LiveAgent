import type {
  Api,
  Context,
  ImageContent,
  Message,
  Model,
  TextContent,
  ToolResultMessage,
} from "@earendil-works/pi-ai";

/**
 * Tool results (Browser screenshot, Read on an image file, ...) may carry
 * inline image blocks. When the active model cannot consume images, those
 * blocks must not reach the wire: pi-ai silently drops them for some
 * protocols, and a hard rejection permanently bricks the conversation
 * because the offending tool result stays in history for every later turn.
 *
 * This helper replaces such blocks with an explicit notice so the request
 * still goes out and the model knows why the image is missing and what to
 * do instead. Only the outbound request context is rewritten; persisted
 * messages keep their images for the UI and for vision-capable models.
 */

export function modelAcceptsImageInput(model: Pick<Model<Api>, "input">): boolean {
  return Array.isArray(model.input) && model.input.includes("image");
}

function estimateBase64Bytes(data: string): number {
  const trimmed = data.trim();
  if (!trimmed) return 0;
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function buildOmittedToolResultImagesNotice(
  images: readonly ImageContent[],
  modelId: string,
): string {
  const noun = images.length === 1 ? "image" : "images";
  const lines = images.map((image, index) => {
    const mimeType = image.mimeType?.trim() || "image";
    const bytes = estimateBase64Bytes(image.data);
    return `${index + 1}. ${mimeType}${bytes > 0 ? ` (~${formatBytes(bytes)})` : ""}`;
  });
  return [
    `[${images.length} ${noun} omitted from this tool result]`,
    ...lines,
    `The active model (${modelId}) does not accept image input, so the image bytes were not sent.`,
    "Do not repeat the same image-producing action expecting to see it. Rely on text output instead (for example a page snapshot or file text), or ask the user to switch to a vision-capable model.",
  ].join("\n");
}

function replaceToolResultImages(message: ToolResultMessage, modelId: string): ToolResultMessage {
  const images = message.content.filter((block): block is ImageContent => block.type === "image");
  if (images.length === 0) return message;
  const textBlocks = message.content.filter((block): block is TextContent => block.type === "text");
  const notice: TextContent = {
    type: "text",
    text: buildOmittedToolResultImagesNotice(images, modelId),
  };
  return { ...message, content: [...textBlocks, notice] };
}

/**
 * Replace every tool-result image block with a text notice, regardless of the
 * declared model capabilities. Use this for protocols whose wire format never
 * accepts image tool results. Returns the same object when nothing changes.
 */
export function omitToolResultImages(context: Context, modelId: string): Context {
  let changed = false;
  const messages: Message[] = context.messages.map((message) => {
    if (message.role !== "toolResult") return message;
    const next = replaceToolResultImages(message, modelId);
    if (next !== message) changed = true;
    return next;
  });
  return changed ? { ...context, messages } : context;
}

/**
 * Capability-gated variant: leaves the context untouched for models that
 * declare image input, otherwise behaves like {@link omitToolResultImages}.
 */
export function omitToolResultImagesForTextOnlyModel(context: Context, model: Model<Api>): Context {
  if (modelAcceptsImageInput(model)) return context;
  return omitToolResultImages(context, model.id);
}
