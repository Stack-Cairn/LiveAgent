import type { Context, Message, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { isSubagentCardToolCall } from "../../subagents/card";
import type { DisplayImageItemDetails, DisplayImageResultDetails } from "../../tools/builtinTypes";
import { normalizeHostedSearchBlock } from "../messages/hostedSearch";
import { isOnlyDsmlOrphanCloseTags, stripDsmlToolCallMarkup } from "../runner/deepSeekDsml";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function normalizeDisplayImageItem(value: unknown): DisplayImageItemDetails | null {
  if (!isRecord(value)) return null;
  const {
    path,
    scope,
    absolutePath,
    relativePath,
    displayPath,
    sourceType,
    renderMode,
    sourceUrl,
    mimeType,
    sizeBytes,
    mtimeMs,
    contentHash,
  } = value;
  if (typeof path !== "string") {
    return null;
  }
  return {
    path,
    ...(typeof scope === "string" ? { scope: scope as DisplayImageItemDetails["scope"] } : {}),
    ...(typeof absolutePath === "string" ? { absolutePath } : {}),
    ...(typeof relativePath === "string" ? { relativePath } : {}),
    ...(typeof displayPath === "string" ? { displayPath } : {}),
    ...(typeof sourceType === "string"
      ? { sourceType: sourceType as DisplayImageItemDetails["sourceType"] }
      : {}),
    ...(typeof renderMode === "string"
      ? { renderMode: renderMode as DisplayImageItemDetails["renderMode"] }
      : {}),
    ...(typeof sourceUrl === "string" ? { sourceUrl } : {}),
    ...(typeof mimeType === "string" ? { mimeType } : {}),
    ...(typeof sizeBytes === "number" ? { sizeBytes } : {}),
    ...(typeof mtimeMs === "number" ? { mtimeMs } : {}),
    ...(typeof contentHash === "string" ? { contentHash } : {}),
  };
}

function getDisplayImageItems(details: unknown): DisplayImageItemDetails[] {
  if (!isRecord(details) || details.kind !== "display_image" || !Array.isArray(details.images)) {
    return [];
  }
  return details.images.flatMap((item) => {
    const normalized = normalizeDisplayImageItem(item);
    return normalized ? [normalized] : [];
  });
}

function isDisplayImageToolResult(
  message: Message,
): message is ToolResultMessage<DisplayImageResultDetails> {
  return (
    message.role === "toolResult" &&
    !message.isError &&
    (message.toolName === "Image" ||
      (isRecord(message.details) && message.details.kind === "display_image"))
  );
}

function getToolResultText(message: ToolResultMessage) {
  return message.content
    .flatMap((block) => (block.type === "text" && block.text.trim() ? [block.text.trim()] : []))
    .join("\n\n");
}

function buildDisplayImageContextText(message: ToolResultMessage<DisplayImageResultDetails>) {
  const images = getDisplayImageItems(message.details);
  if (images.length === 0) {
    const text = getToolResultText(message);
    return [
      text || "Image tool displayed image content in the chat UI.",
      "Inline image bytes are omitted from model context because Image is a display-only UI tool.",
    ].join("\n\n");
  }

  const noun = images.length === 1 ? "image" : "images";
  const formatPath = (image: DisplayImageItemDetails) => image.displayPath || image.path;
  return [
    `Displayed ${images.length} ${noun} in the chat UI successfully.`,
    ...images.map((image, index) => {
      const facts = [
        image.sourceType ? `sourceType=${image.sourceType}` : null,
        image.renderMode ? `renderMode=${image.renderMode}` : null,
        image.mimeType ? `mime=${image.mimeType}` : null,
        typeof image.sizeBytes === "number" ? `sizeBytes=${image.sizeBytes}` : null,
      ].filter(Boolean);
      return `${index + 1}. ${formatPath(image)}${facts.length > 0 ? ` (${facts.join(", ")})` : ""}`;
    }),
    "Inline image bytes are omitted from model context because Image is a display-only UI tool.",
  ].join("\n");
}

function sanitizeModelText(text: string) {
  const stripped = stripDsmlToolCallMarkup(text);
  return isOnlyDsmlOrphanCloseTags(stripped) ? "" : stripped;
}

function sanitizeTextBlocksForModelContext(message: Message): Message {
  if (message.role !== "assistant" && message.role !== "user" && message.role !== "toolResult") {
    return message;
  }

  if (typeof message.content === "string") {
    const content = sanitizeModelText(message.content);
    return content === message.content ? message : ({ ...message, content } as Message);
  }

  if (!Array.isArray(message.content)) return message;

  let changed = false;
  const content = (message.content as unknown[]).flatMap((block) => {
    if (!isRecord(block)) {
      return [block];
    }

    if (block.type === "text" && typeof block.text === "string") {
      const text = sanitizeModelText(block.text);
      if (text !== block.text) changed = true;
      if (!text.trim()) return [];
      return [{ ...block, text }];
    }

    if (block.type === "thinking" && typeof block.thinking === "string") {
      const thinking = sanitizeModelText(block.thinking);
      if (thinking !== block.thinking) changed = true;
      if (!thinking.trim()) return [];
      return [{ ...block, thinking }];
    }

    return [block];
  });

  return changed ? ({ ...message, content: content as Message["content"] } as Message) : message;
}

export function sanitizeMessageForModelContext(message: Message): Message {
  let nextMessage = sanitizeTextBlocksForModelContext(message);

  if (nextMessage.role === "assistant") {
    const nextContent: unknown[] = [];
    let changed = false;
    for (const block of nextMessage.content as unknown[]) {
      if (isSubagentCardToolCall(block)) {
        changed = true;
        continue;
      }

      const hostedSearch = normalizeHostedSearchBlock(block);
      if (hostedSearch) {
        changed = true;
        continue;
      }
      nextContent.push(block);
    }
    if (changed) {
      nextMessage = {
        ...nextMessage,
        content: nextContent as Message["content"],
      } as Message;
    }
  }

  if (!isDisplayImageToolResult(nextMessage)) return nextMessage;
  const hasInlineImages = nextMessage.content.some((block) => block.type === "image");
  const hasDisplayImageDetails = getDisplayImageItems(nextMessage.details).length > 0;
  if (!hasInlineImages && !hasDisplayImageDetails) return nextMessage;

  const text: TextContent = {
    type: "text",
    text: buildDisplayImageContextText(nextMessage),
  };

  return {
    ...nextMessage,
    content: [text],
  };
}

function collectSubagentCardToolCallIds(messages: Message[]) {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content as unknown[]) {
      if (!isSubagentCardToolCall(block) || !isRecord(block)) continue;
      if (typeof block.id === "string" && block.id) ids.add(block.id);
    }
  }
  return ids;
}

function isSubagentCardToolResult(message: Message, toolCallIds: Set<string>) {
  return (
    message.role === "toolResult" &&
    (toolCallIds.has(message.toolCallId) ||
      (isRecord(message.details) && message.details.kind === "subagent_card"))
  );
}

export function sanitizeMessagesForModelContext(messages: Message[]): Message[] {
  const subagentCardToolCallIds = collectSubagentCardToolCallIds(messages);
  return messages
    .filter((message) => !isSubagentCardToolResult(message, subagentCardToolCallIds))
    .map(sanitizeMessageForModelContext)
    .filter(
      (message) =>
        message.role !== "assistant" ||
        (Array.isArray(message.content) && message.content.length > 0),
    );
}

export function stripAbortedMessagesForModelContext(messages: Message[]): Message[] {
  const sanitized: Message[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "assistant" && message.stopReason === "aborted") {
      while (index + 1 < messages.length && messages[index + 1]?.role === "toolResult") {
        index += 1;
      }
      continue;
    }
    sanitized.push(message);
  }

  return sanitized;
}

export function sanitizeMessagesForContinuation(messages: Message[]): Message[] {
  return sanitizeMessagesForModelContext(stripAbortedMessagesForModelContext(messages));
}

export function sanitizeContextForModelRequest(context: Context): Context {
  return {
    ...context,
    messages: sanitizeMessagesForContinuation(context.messages),
  };
}
