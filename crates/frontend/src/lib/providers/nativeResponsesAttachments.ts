import type { Context, Model } from "@earendil-works/pi-ai";
import { invoke } from "@tauri-apps/api/core";

import {
  getUserMessageAttachments,
  type PendingUploadedFile,
} from "../chat/messages/uploadedFiles";

type PayloadHook = (payload: unknown, model: Model<any>) => unknown | Promise<unknown>;

export type StreamOptionsWithPayloadHook = {
  onPayload?: PayloadHook;
};

type NativeAttachmentCommandResponse = {
  mimeType: string;
  data: string;
  sizeBytes: number;
};

type NativeAttachmentContentPart =
  | {
      type: "input_image";
      detail: "auto";
      image_url: string;
    }
  | {
      type: "input_file";
      filename: string;
      file_data: string;
    };

type OpenAIChatCompletionsNativeAttachmentContentPart = {
  type: "image_url";
  image_url: {
    url: string;
    detail: "auto";
  };
};

type AnthropicNativeAttachmentContentPart =
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: string;
        data: string;
      };
    }
  | {
      type: "document";
      source:
        | {
            type: "base64";
            media_type: string;
            data: string;
          }
        | {
            type: "text";
            media_type: "text/plain";
            data: string;
          };
      title?: string;
    };

type GeminiNativeAttachmentContentPart = {
  inlineData: {
    mimeType: string;
    data: string;
  };
};

type GeminiNativeAttachmentCandidate = {
  part: GeminiNativeAttachmentContentPart;
  requestBytes: number;
};

const WORKSPACE_UPLOAD_INSTRUCTION = [
  "The user attached the files below to this message.",
  "Use Read with these exact paths before analyzing or modifying them:",
].join("\n");

const NATIVE_UPLOAD_INSTRUCTION = [
  "The attached files are inlined into this OpenAI Responses request as native inputs when supported, and are also readable at the exact paths below.",
  "Analyze the native attachments directly first. Use Read only when you need exact file access, edits, or native attachment content is unavailable:",
].join("\n");

const OPENAI_CHAT_COMPLETIONS_NATIVE_UPLOAD_INSTRUCTION = [
  "The attached images are inlined into this OpenAI Chat Completions request as native image inputs when supported, and are also readable at the exact paths below.",
  "Analyze the native image attachments directly first. Use Read only when you need exact file access, edits, or native attachment content is unavailable:",
].join("\n");

const ANTHROPIC_NATIVE_UPLOAD_INSTRUCTION = [
  "The attached files are inlined into this Anthropic Messages request as native image/document inputs when supported, and are also readable at the exact paths below.",
  "Analyze the native attachments directly first. Use Read only when you need exact file access, edits, or native attachment content is unavailable:",
].join("\n");

const GEMINI_NATIVE_UPLOAD_INSTRUCTION = [
  "The attached files are inlined into this Gemini request as native inlineData inputs when supported, and are also readable at the exact paths below.",
  "Analyze the native attachments directly first. Use Read only when you need exact file access, edits, or native attachment content is unavailable:",
].join("\n");

const GEMINI_INLINE_NATIVE_ATTACHMENT_MAX_REQUEST_BYTES = 20 * 1024 * 1024;
const GEMINI_INLINE_NATIVE_ATTACHMENT_REQUEST_RESERVE_BYTES = 256 * 1024;
const GEMINI_INLINE_NATIVE_ATTACHMENT_DATA_BUDGET_BYTES =
  GEMINI_INLINE_NATIVE_ATTACHMENT_MAX_REQUEST_BYTES -
  GEMINI_INLINE_NATIVE_ATTACHMENT_REQUEST_RESERVE_BYTES;

const NATIVE_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const NATIVE_INPUT_FILE_KINDS = new Set<PendingUploadedFile["kind"]>([
  "text",
  "pdf",
  "notebook",
  "word",
  "spreadsheet",
]);

const ANTHROPIC_NATIVE_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const ANTHROPIC_NATIVE_DOCUMENT_MIME_TYPES = new Set(["application/pdf", "text/plain"]);

const GEMINI_NATIVE_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
]);

const GEMINI_NATIVE_DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/html",
  "text/xml",
  "application/json",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function normalizeMimeType(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isOpenAIResponsesModel(model: Model<any>) {
  return model.api === "openai-responses";
}

function isOpenAICompletionsModel(model: Model<any>) {
  return model.api === "openai-completions";
}

function isAnthropicMessagesModel(model: Model<any>) {
  return model.api === "anthropic-messages";
}

function isGoogleGenerativeAIModel(model: Model<any>) {
  return model.api === "google-generative-ai";
}

function modelSupportsImageInput(model: Model<any>) {
  return Array.isArray(model.input) && model.input.includes("image");
}

function getUserMessageNativeAttachmentBatches(context: Context) {
  return context.messages
    .filter((message) => message.role === "user")
    .map((message) => getUserMessageAttachments(message as any));
}

function buildDataUrl(mimeType: string, data: string) {
  return `data:${mimeType};base64,${data}`;
}

function decodeBase64Utf8(data: string) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

function estimateJsonRequestBytes(value: unknown) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return 0;
  }
}

async function readNativeAttachment(params: {
  workdir: string;
  file: PendingUploadedFile;
}): Promise<NativeAttachmentCommandResponse> {
  // 附件读取只走导入时返回的绝对路径；旧版本仅持久化 workdir 相对路径的
  // 附件不再兼容，直接走各 adapter 的 Read-fallback 分支。
  const absolutePath =
    typeof params.file.absolutePath === "string" ? params.file.absolutePath.trim() : "";
  if (!absolutePath) {
    throw new Error(
      `attachment ${params.file.relativePath} has no absolute path (legacy upload); re-upload it to inline natively`,
    );
  }
  const response = await invoke<NativeAttachmentCommandResponse>(
    "system_read_uploaded_native_attachment",
    {
      workdir: params.workdir,
      absolute_path: absolutePath,
      kind: params.file.kind,
    },
  );

  return {
    mimeType: String(response.mimeType || "").trim(),
    data: String(response.data || "").trim(),
    sizeBytes: Number(response.sizeBytes || 0),
  };
}

async function buildNativeAttachmentContentPart(params: {
  workdir: string;
  model: Model<any>;
  file: PendingUploadedFile;
}): Promise<NativeAttachmentContentPart | null> {
  const { file, model, workdir } = params;
  if (file.kind === "archive") return null;
  if (file.kind === "image" && !modelSupportsImageInput(model)) return null;
  if (file.kind !== "image" && !NATIVE_INPUT_FILE_KINDS.has(file.kind)) return null;

  const attachment = await readNativeAttachment({ workdir, file });
  const mimeType = normalizeMimeType(attachment.mimeType);
  if (!mimeType || !attachment.data) return null;

  if (file.kind === "image") {
    if (!NATIVE_IMAGE_MIME_TYPES.has(mimeType)) return null;
    return {
      type: "input_image",
      detail: "auto",
      image_url: buildDataUrl(mimeType, attachment.data),
    };
  }

  return {
    type: "input_file",
    filename: file.fileName || file.relativePath.split("/").pop() || "attachment",
    file_data: buildDataUrl(mimeType, attachment.data),
  };
}

async function buildOpenAIChatCompletionsNativeAttachmentContentPart(params: {
  workdir: string;
  model: Model<any>;
  file: PendingUploadedFile;
}): Promise<OpenAIChatCompletionsNativeAttachmentContentPart | null> {
  const { file, model, workdir } = params;
  if (file.kind !== "image" || !modelSupportsImageInput(model)) return null;

  const attachment = await readNativeAttachment({ workdir, file });
  const mimeType = normalizeMimeType(attachment.mimeType);
  if (!mimeType || !attachment.data || !NATIVE_IMAGE_MIME_TYPES.has(mimeType)) {
    return null;
  }

  return {
    type: "image_url",
    image_url: {
      url: buildDataUrl(mimeType, attachment.data),
      detail: "auto",
    },
  };
}

function normalizeUserContent(content: unknown): unknown[] {
  if (Array.isArray(content)) return content.slice();
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  return [];
}

function applyNativeUploadInstruction(content: unknown[]) {
  const next = content.slice();
  for (let index = 0; index < next.length; index += 1) {
    const part = next[index];
    if (!isRecord(part) || part.type !== "input_text" || typeof part.text !== "string") {
      continue;
    }
    next[index] = {
      ...part,
      text: part.text.includes(WORKSPACE_UPLOAD_INSTRUCTION)
        ? part.text.replace(WORKSPACE_UPLOAD_INSTRUCTION, NATIVE_UPLOAD_INSTRUCTION)
        : `${part.text}\n\n${NATIVE_UPLOAD_INSTRUCTION}`,
    };
    return next;
  }
  return [{ type: "input_text", text: NATIVE_UPLOAD_INSTRUCTION }, ...next];
}

function normalizeOpenAIChatCompletionsUserContent(content: unknown): unknown[] {
  if (Array.isArray(content)) return content.slice();
  if (typeof content === "string") return [{ type: "text", text: content }];
  return [];
}

function applyOpenAIChatCompletionsNativeUploadInstruction(content: unknown[]) {
  const next = content.slice();
  for (let index = 0; index < next.length; index += 1) {
    const part = next[index];
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") {
      continue;
    }
    next[index] = {
      ...part,
      text: part.text.includes(WORKSPACE_UPLOAD_INSTRUCTION)
        ? part.text.replace(
            WORKSPACE_UPLOAD_INSTRUCTION,
            OPENAI_CHAT_COMPLETIONS_NATIVE_UPLOAD_INSTRUCTION,
          )
        : `${part.text}\n\n${OPENAI_CHAT_COMPLETIONS_NATIVE_UPLOAD_INSTRUCTION}`,
    };
    return next;
  }
  return [{ type: "text", text: OPENAI_CHAT_COMPLETIONS_NATIVE_UPLOAD_INSTRUCTION }, ...next];
}

function normalizeAnthropicUserContent(content: unknown): unknown[] {
  if (Array.isArray(content)) return content.slice();
  if (typeof content === "string") return [{ type: "text", text: content }];
  return [];
}

function applyAnthropicNativeUploadInstruction(content: unknown[]) {
  const next = content.slice();
  for (let index = 0; index < next.length; index += 1) {
    const part = next[index];
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") {
      continue;
    }
    next[index] = {
      ...part,
      text: part.text.includes(WORKSPACE_UPLOAD_INSTRUCTION)
        ? part.text.replace(WORKSPACE_UPLOAD_INSTRUCTION, ANTHROPIC_NATIVE_UPLOAD_INSTRUCTION)
        : `${part.text}\n\n${ANTHROPIC_NATIVE_UPLOAD_INSTRUCTION}`,
    };
    return next;
  }
  return [{ type: "text", text: ANTHROPIC_NATIVE_UPLOAD_INSTRUCTION }, ...next];
}

function normalizeGeminiUserParts(parts: unknown): unknown[] {
  if (Array.isArray(parts)) return parts.slice();
  if (typeof parts === "string") return [{ text: parts }];
  return [];
}

function applyGeminiNativeUploadInstruction(parts: unknown[]) {
  const next = parts.slice();
  for (let index = 0; index < next.length; index += 1) {
    const part = next[index];
    if (!isRecord(part) || typeof part.text !== "string") {
      continue;
    }
    next[index] = {
      ...part,
      text: part.text.includes(WORKSPACE_UPLOAD_INSTRUCTION)
        ? part.text.replace(WORKSPACE_UPLOAD_INSTRUCTION, GEMINI_NATIVE_UPLOAD_INSTRUCTION)
        : `${part.text}\n\n${GEMINI_NATIVE_UPLOAD_INSTRUCTION}`,
    };
    return next;
  }
  return [{ text: GEMINI_NATIVE_UPLOAD_INSTRUCTION }, ...next];
}

function hasContentPartType(content: unknown, type: string) {
  if (!Array.isArray(content)) return false;
  return content.some((part) => isRecord(part) && part.type === type);
}

function isOpenAIToolOutputTurn(item: Record<string, unknown>) {
  return (
    item.type === "function_call_output" ||
    hasContentPartType(item.content, "function_call_output") ||
    hasContentPartType(item.content, "tool_result")
  );
}

function isOpenAIChatSyntheticToolImageTurn(message: Record<string, unknown>) {
  if (!Array.isArray(message.content)) return false;
  let hasToolImageLabel = false;
  let hasImageUrl = false;
  for (const part of message.content) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") {
      hasToolImageLabel = part.text.trim() === "Attached image(s) from tool result:";
    }
    if (part.type === "image_url") {
      hasImageUrl = true;
    }
  }
  return hasToolImageLabel && hasImageUrl;
}

function isAnthropicToolResultTurn(message: Record<string, unknown>) {
  return hasContentPartType(message.content, "tool_result");
}

async function buildNativeContentParts(params: {
  workdir: string;
  model: Model<any>;
  files: PendingUploadedFile[];
}) {
  const parts: NativeAttachmentContentPart[] = [];
  for (const file of params.files) {
    try {
      const part = await buildNativeAttachmentContentPart({
        workdir: params.workdir,
        model: params.model,
        file,
      });
      if (part) parts.push(part);
    } catch (error) {
      console.warn(
        `[native-responses-attachments] skipped ${file.relativePath}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return parts;
}

async function buildOpenAIChatCompletionsNativeContentParts(params: {
  workdir: string;
  model: Model<any>;
  files: PendingUploadedFile[];
}) {
  const parts: OpenAIChatCompletionsNativeAttachmentContentPart[] = [];
  for (const file of params.files) {
    try {
      const part = await buildOpenAIChatCompletionsNativeAttachmentContentPart({
        workdir: params.workdir,
        model: params.model,
        file,
      });
      if (part) parts.push(part);
    } catch (error) {
      console.warn(
        `[openai-chat-completions-native-attachments] skipped ${file.relativePath}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return parts;
}

async function buildAnthropicNativeAttachmentContentPart(params: {
  workdir: string;
  file: PendingUploadedFile;
}): Promise<AnthropicNativeAttachmentContentPart | null> {
  const { file, workdir } = params;
  if (file.kind !== "image" && file.kind !== "pdf" && file.kind !== "text") {
    return null;
  }

  const attachment = await readNativeAttachment({ workdir, file });
  const mimeType = normalizeMimeType(attachment.mimeType);
  if (!mimeType || !attachment.data) return null;

  if (file.kind === "image") {
    if (!ANTHROPIC_NATIVE_IMAGE_MIME_TYPES.has(mimeType)) return null;
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: mimeType,
        data: attachment.data,
      },
    };
  }

  if (!ANTHROPIC_NATIVE_DOCUMENT_MIME_TYPES.has(mimeType)) return null;
  if (file.kind === "text") {
    return {
      type: "document",
      source: {
        type: "text",
        media_type: "text/plain",
        data: decodeBase64Utf8(attachment.data),
      },
      title: file.fileName || file.relativePath.split("/").pop() || undefined,
    };
  }
  return {
    type: "document",
    source: {
      type: "base64",
      media_type: mimeType,
      data: attachment.data,
    },
    title: file.fileName || file.relativePath.split("/").pop() || undefined,
  };
}

async function buildAnthropicNativeContentParts(params: {
  workdir: string;
  files: PendingUploadedFile[];
}) {
  const parts: AnthropicNativeAttachmentContentPart[] = [];
  for (const file of params.files) {
    try {
      const part = await buildAnthropicNativeAttachmentContentPart({
        workdir: params.workdir,
        file,
      });
      if (part) parts.push(part);
    } catch (error) {
      console.warn(
        `[anthropic-native-attachments] skipped ${file.relativePath}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return parts;
}

async function buildGeminiNativeAttachmentContentPart(params: {
  workdir: string;
  model: Model<any>;
  file: PendingUploadedFile;
}): Promise<GeminiNativeAttachmentCandidate | null> {
  const { file, model, workdir } = params;
  if (file.kind === "archive" || file.kind === "word" || file.kind === "spreadsheet") {
    return null;
  }
  if ((file.kind === "image" || file.kind === "pdf") && !modelSupportsImageInput(model)) {
    return null;
  }

  const attachment = await readNativeAttachment({ workdir, file });
  const mimeType = normalizeMimeType(attachment.mimeType);
  if (!mimeType || !attachment.data) return null;
  if (attachment.sizeBytes > GEMINI_INLINE_NATIVE_ATTACHMENT_MAX_REQUEST_BYTES) return null;
  const requestBytes = attachment.data.length + mimeType.length + 64;
  if (requestBytes > GEMINI_INLINE_NATIVE_ATTACHMENT_DATA_BUDGET_BYTES) return null;

  if (file.kind === "image") {
    if (!GEMINI_NATIVE_IMAGE_MIME_TYPES.has(mimeType)) return null;
  } else if (!GEMINI_NATIVE_DOCUMENT_MIME_TYPES.has(mimeType)) {
    return null;
  }

  return {
    part: {
      inlineData: {
        mimeType,
        data: attachment.data,
      },
    },
    requestBytes,
  };
}

async function buildGeminiNativeContentParts(params: {
  workdir: string;
  model: Model<any>;
  files: PendingUploadedFile[];
  availableRequestBytes: number;
}) {
  const parts: GeminiNativeAttachmentContentPart[] = [];
  let usedRequestBytes = 0;
  if (params.availableRequestBytes <= 0) {
    return { parts, usedRequestBytes };
  }
  for (const file of params.files) {
    try {
      const candidate = await buildGeminiNativeAttachmentContentPart({
        workdir: params.workdir,
        model: params.model,
        file,
      });
      if (!candidate) continue;
      if (usedRequestBytes + candidate.requestBytes > params.availableRequestBytes) {
        continue;
      }
      parts.push(candidate.part);
      usedRequestBytes += candidate.requestBytes;
    } catch (error) {
      console.warn(
        `[gemini-native-attachments] skipped ${file.relativePath}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return { parts, usedRequestBytes };
}

function isGeminiFunctionResponseTurn(item: Record<string, unknown>) {
  if (!Array.isArray(item.parts)) return false;
  return item.parts.some((part) => isRecord(part) && isRecord(part.functionResponse));
}

function isGeminiSyntheticToolImageTurn(item: Record<string, unknown>) {
  if (!Array.isArray(item.parts)) return false;
  let hasToolImageLabel = false;
  let hasInlineData = false;
  for (const part of item.parts) {
    if (!isRecord(part)) continue;
    if (typeof part.text === "string" && part.text.trim() === "Tool result image:") {
      hasToolImageLabel = true;
    }
    if (isRecord(part.inlineData)) {
      hasInlineData = true;
    }
  }
  return hasToolImageLabel && hasInlineData;
}

async function applyNativeAttachmentsToResponsesPayload(params: {
  payload: unknown;
  context: Context;
  model: Model<any>;
  workdir: string;
}) {
  const payload = params.payload;
  if (!isRecord(payload) || !Array.isArray(payload.input)) return payload;
  if (!params.workdir.trim() || !isOpenAIResponsesModel(params.model)) return payload;

  const attachmentBatches = getUserMessageNativeAttachmentBatches(params.context);
  if (!attachmentBatches.some((files) => files.length > 0)) return payload;

  let userIndex = 0;
  let changed = false;
  const nextInput = [];
  for (const item of payload.input) {
    if (!isRecord(item) || item.role !== "user" || isOpenAIToolOutputTurn(item)) {
      nextInput.push(item);
      continue;
    }

    const files = attachmentBatches[userIndex] ?? [];
    userIndex += 1;
    if (files.length === 0) {
      nextInput.push(item);
      continue;
    }

    const nativeParts = await buildNativeContentParts({
      workdir: params.workdir,
      model: params.model,
      files,
    });
    if (nativeParts.length === 0) {
      nextInput.push(item);
      continue;
    }

    nextInput.push({
      ...item,
      content: [
        ...applyNativeUploadInstruction(normalizeUserContent(item.content)),
        ...nativeParts,
      ],
    });
    changed = true;
  }

  return changed ? { ...payload, input: nextInput } : payload;
}

async function applyNativeAttachmentsToOpenAICompletionsPayload(params: {
  payload: unknown;
  context: Context;
  model: Model<any>;
  workdir: string;
}) {
  const payload = params.payload;
  if (!isRecord(payload) || !Array.isArray(payload.messages)) return payload;
  if (!params.workdir.trim() || !isOpenAICompletionsModel(params.model)) return payload;

  const attachmentBatches = getUserMessageNativeAttachmentBatches(params.context);
  if (!attachmentBatches.some((files) => files.length > 0)) return payload;

  let userIndex = 0;
  let changed = false;
  const nextMessages = [];
  for (const message of payload.messages) {
    if (
      !isRecord(message) ||
      message.role !== "user" ||
      isOpenAIChatSyntheticToolImageTurn(message)
    ) {
      nextMessages.push(message);
      continue;
    }

    const files = attachmentBatches[userIndex] ?? [];
    userIndex += 1;
    if (files.length === 0) {
      nextMessages.push(message);
      continue;
    }

    const nativeParts = await buildOpenAIChatCompletionsNativeContentParts({
      workdir: params.workdir,
      model: params.model,
      files,
    });
    if (nativeParts.length === 0) {
      nextMessages.push(message);
      continue;
    }

    nextMessages.push({
      ...message,
      content: [
        ...applyOpenAIChatCompletionsNativeUploadInstruction(
          normalizeOpenAIChatCompletionsUserContent(message.content),
        ),
        ...nativeParts,
      ],
    });
    changed = true;
  }

  return changed ? { ...payload, messages: nextMessages } : payload;
}

async function applyNativeAttachmentsToAnthropicPayload(params: {
  payload: unknown;
  context: Context;
  model: Model<any>;
  workdir: string;
}) {
  const payload = params.payload;
  if (!isRecord(payload) || !Array.isArray(payload.messages)) return payload;
  if (!params.workdir.trim() || !isAnthropicMessagesModel(params.model)) return payload;

  const attachmentBatches = getUserMessageNativeAttachmentBatches(params.context);
  if (!attachmentBatches.some((files) => files.length > 0)) return payload;

  let userIndex = 0;
  let changed = false;
  const nextMessages = [];
  for (const message of payload.messages) {
    if (!isRecord(message) || message.role !== "user" || isAnthropicToolResultTurn(message)) {
      nextMessages.push(message);
      continue;
    }

    const files = attachmentBatches[userIndex] ?? [];
    userIndex += 1;
    if (files.length === 0) {
      nextMessages.push(message);
      continue;
    }

    const nativeParts = await buildAnthropicNativeContentParts({
      workdir: params.workdir,
      files,
    });
    if (nativeParts.length === 0) {
      nextMessages.push(message);
      continue;
    }

    nextMessages.push({
      ...message,
      content: [
        ...applyAnthropicNativeUploadInstruction(normalizeAnthropicUserContent(message.content)),
        ...nativeParts,
      ],
    });
    changed = true;
  }

  return changed ? { ...payload, messages: nextMessages } : payload;
}

async function applyNativeAttachmentsToGeminiPayload(params: {
  payload: unknown;
  context: Context;
  model: Model<any>;
  workdir: string;
}) {
  const payload = params.payload;
  if (!isRecord(payload) || !Array.isArray(payload.contents)) return payload;
  if (!params.workdir.trim() || !isGoogleGenerativeAIModel(params.model)) return payload;

  const attachmentBatches = getUserMessageNativeAttachmentBatches(params.context);
  if (!attachmentBatches.some((files) => files.length > 0)) return payload;

  let userIndex = 0;
  let changed = false;
  let remainingNativeRequestBytes =
    GEMINI_INLINE_NATIVE_ATTACHMENT_DATA_BUDGET_BYTES - estimateJsonRequestBytes(payload);
  const nextContents = [];
  for (const item of payload.contents) {
    if (
      !isRecord(item) ||
      item.role !== "user" ||
      isGeminiFunctionResponseTurn(item) ||
      isGeminiSyntheticToolImageTurn(item)
    ) {
      nextContents.push(item);
      continue;
    }

    const files = attachmentBatches[userIndex] ?? [];
    userIndex += 1;
    if (files.length === 0) {
      nextContents.push(item);
      continue;
    }

    const nativeContent = await buildGeminiNativeContentParts({
      workdir: params.workdir,
      model: params.model,
      files,
      availableRequestBytes: remainingNativeRequestBytes,
    });
    const nativeParts = nativeContent.parts;
    if (nativeParts.length === 0) {
      nextContents.push(item);
      continue;
    }
    remainingNativeRequestBytes -= nativeContent.usedRequestBytes;

    nextContents.push({
      ...item,
      parts: [
        ...nativeParts,
        ...applyGeminiNativeUploadInstruction(normalizeGeminiUserParts(item.parts)),
      ],
    });
    changed = true;
  }

  return changed ? { ...payload, contents: nextContents } : payload;
}

export function attachOpenAIResponsesNativeAttachments<
  TOptions extends StreamOptionsWithPayloadHook,
>(
  options: TOptions,
  params: {
    context?: Context;
    model: Model<any>;
    providerId: string;
    workdir?: string;
  },
): TOptions {
  if (
    (params.providerId !== "codex" && params.providerId !== "xai") ||
    !params.context ||
    !isOpenAIResponsesModel(params.model) ||
    !params.workdir?.trim()
  ) {
    return options;
  }

  const previousOnPayload = options.onPayload;
  return {
    ...options,
    onPayload: async (payload, model) => {
      let nextPayload = payload;
      if (previousOnPayload) {
        const overridden = await previousOnPayload(nextPayload, model);
        if (overridden !== undefined) {
          nextPayload = overridden;
        }
      }
      return applyNativeAttachmentsToResponsesPayload({
        payload: nextPayload,
        context: params.context as Context,
        model,
        workdir: params.workdir ?? "",
      });
    },
  };
}

export function attachOpenAICompletionsNativeAttachments<
  TOptions extends StreamOptionsWithPayloadHook,
>(
  options: TOptions,
  params: {
    context?: Context;
    model: Model<any>;
    providerId: string;
    workdir?: string;
  },
): TOptions {
  if (
    params.providerId !== "codex" ||
    !params.context ||
    !isOpenAICompletionsModel(params.model) ||
    !params.workdir?.trim()
  ) {
    return options;
  }

  const previousOnPayload = options.onPayload;
  return {
    ...options,
    onPayload: async (payload, model) => {
      let nextPayload = payload;
      if (previousOnPayload) {
        const overridden = await previousOnPayload(nextPayload, model);
        if (overridden !== undefined) {
          nextPayload = overridden;
        }
      }
      return applyNativeAttachmentsToOpenAICompletionsPayload({
        payload: nextPayload,
        context: params.context as Context,
        model,
        workdir: params.workdir ?? "",
      });
    },
  };
}

export function attachAnthropicMessagesNativeAttachments<
  TOptions extends StreamOptionsWithPayloadHook,
>(
  options: TOptions,
  params: {
    context?: Context;
    model: Model<any>;
    providerId: string;
    workdir?: string;
  },
): TOptions {
  if (
    params.providerId !== "claude_code" ||
    !params.context ||
    !isAnthropicMessagesModel(params.model) ||
    !params.workdir?.trim()
  ) {
    return options;
  }

  const previousOnPayload = options.onPayload;
  return {
    ...options,
    onPayload: async (payload, model) => {
      let nextPayload = payload;
      if (previousOnPayload) {
        const overridden = await previousOnPayload(nextPayload, model);
        if (overridden !== undefined) {
          nextPayload = overridden;
        }
      }
      return applyNativeAttachmentsToAnthropicPayload({
        payload: nextPayload,
        context: params.context as Context,
        model,
        workdir: params.workdir ?? "",
      });
    },
  };
}

export function attachGeminiGenerativeAINativeAttachments<
  TOptions extends StreamOptionsWithPayloadHook,
>(
  options: TOptions,
  params: {
    context?: Context;
    model: Model<any>;
    providerId: string;
    workdir?: string;
  },
): TOptions {
  if (
    params.providerId !== "gemini" ||
    !params.context ||
    !isGoogleGenerativeAIModel(params.model) ||
    !params.workdir?.trim()
  ) {
    return options;
  }

  const previousOnPayload = options.onPayload;
  return {
    ...options,
    onPayload: async (payload, model) => {
      let nextPayload = payload;
      if (previousOnPayload) {
        const overridden = await previousOnPayload(nextPayload, model);
        if (overridden !== undefined) {
          nextPayload = overridden;
        }
      }
      return applyNativeAttachmentsToGeminiPayload({
        payload: nextPayload,
        context: params.context as Context,
        model,
        workdir: params.workdir ?? "",
      });
    },
  };
}

export const __nativeResponsesAttachmentsTest = {
  WORKSPACE_UPLOAD_INSTRUCTION,
  NATIVE_UPLOAD_INSTRUCTION,
  OPENAI_CHAT_COMPLETIONS_NATIVE_UPLOAD_INSTRUCTION,
  ANTHROPIC_NATIVE_UPLOAD_INSTRUCTION,
  GEMINI_NATIVE_UPLOAD_INSTRUCTION,
  applyNativeAttachmentsToResponsesPayload,
  applyNativeAttachmentsToOpenAICompletionsPayload,
  applyNativeAttachmentsToAnthropicPayload,
  applyNativeAttachmentsToGeminiPayload,
};
