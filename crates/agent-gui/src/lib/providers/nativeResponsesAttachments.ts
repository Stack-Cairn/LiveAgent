import type { Api, Context, Model } from "@earendil-works/pi-ai";
import {
  getUserMessageAttachments,
  matchesUploadedFileInstructionLine,
  type PendingUploadedFile,
  UPLOADED_FILES_INSTRUCTION_HEADER_TEXTS,
  UPLOADED_FILES_READ_PAGING_HINT,
} from "@liveagent/ui/lib/chat/uploadedFiles";
import { invoke } from "@tauri-apps/api/core";

type PayloadHook = (payload: unknown, model: Model<Api>) => unknown | Promise<unknown>;

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
      source: {
        type: "base64";
        media_type: string;
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

/**
 * 原生内联策略（按附件 kind 分层，五家 provider 统一）：
 *
 * - image：各家都是标准 block（input_image / image_url / image / inlineData），
 *   兼容中转也认，零往返成本，保留原生内联。codex / gemini 分支沿用原有的
 *   model.input 含 "image" 门控；anthropic 分支按 modelFactory 的约定不读
 *   model.input（见 buildAnthropicNativeAttachmentContentPart）。
 * - pdf：document / input_file / inlineData 都是各家专有结构，第三方
 *   Anthropic/OpenAI/Gemini 兼容中转普遍不认（Kimi Coding、z.ai 等直接 400
 *   "Invalid request"），只在各家官方端点内联；其余端点退回 Read（lopdf 抽文本）。
 * - text / word / spreadsheet / notebook / archive：一律不内联，走 Read。
 *   这正是在兼容中转上出错的类型，而 Read 对它们的结果与内联等价。
 *
 * 用户消息里原本的两行 Read 指令头（uploadedFiles.ts）在至少一个附件被内联时
 * 换成下面的版本，并给被内联的附件行加 "inlined" 标注，让模型明确知道哪些
 * 已经在请求里、哪些必须 Read。
 */
function buildNativeUploadInstruction(requestLabel: string, inputLabel: string) {
  return [
    `Attachments marked "inlined" below are included in this ${requestLabel} request as native ${inputLabel} inputs; analyze those directly. Every other listed file is only available through Read.`,
    `Use Read with the exact paths for files that are not inlined before analyzing or modifying them. ${UPLOADED_FILES_READ_PAGING_HINT}`,
  ].join("\n");
}

const NATIVE_UPLOAD_INSTRUCTION = buildNativeUploadInstruction("OpenAI Responses", "input");

const OPENAI_CHAT_COMPLETIONS_NATIVE_UPLOAD_INSTRUCTION = buildNativeUploadInstruction(
  "OpenAI Chat Completions",
  "image",
);

const ANTHROPIC_NATIVE_UPLOAD_INSTRUCTION = buildNativeUploadInstruction(
  "Anthropic Messages",
  "image/document",
);

const GEMINI_NATIVE_UPLOAD_INSTRUCTION = buildNativeUploadInstruction("Gemini", "inlineData");

const INLINED_ATTACHMENT_LINE_SUFFIX = "; inlined";

const GEMINI_INLINE_NATIVE_ATTACHMENT_MAX_REQUEST_BYTES = 20 * 1024 * 1024;
const GEMINI_INLINE_NATIVE_ATTACHMENT_REQUEST_RESERVE_BYTES = 256 * 1024;
const GEMINI_INLINE_NATIVE_ATTACHMENT_DATA_BUDGET_BYTES =
  GEMINI_INLINE_NATIVE_ATTACHMENT_MAX_REQUEST_BYTES -
  GEMINI_INLINE_NATIVE_ATTACHMENT_REQUEST_RESERVE_BYTES;

const NATIVE_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const ANTHROPIC_NATIVE_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const GEMINI_NATIVE_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
]);

const PDF_MIME_TYPE = "application/pdf";

function parseHostname(baseUrl: string | undefined) {
  if (!baseUrl?.trim()) return undefined;
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * PDF 只在各家官方端点原生内联。判断依据是请求 baseUrl 的主机名，而不是
 * provider 类型——`claude_code` / `codex` / `gemini` 类型同样用于第三方兼容
 * 中转（Kimi Coding、z.ai、各类 new-api 等），它们不接受专有 document 结构。
 */
function supportsNativePdfInline(model: Model<Api>, baseUrl: string | undefined) {
  const hostname = parseHostname(baseUrl);
  if (!hostname) return false;
  switch (model.api) {
    case "openai-responses":
      return (
        hostname === "api.openai.com" ||
        hostname.endsWith(".api.openai.com") ||
        hostname === "chatgpt.com" ||
        hostname === "api.x.ai"
      );
    case "anthropic-messages":
      return hostname === "api.anthropic.com";
    case "google-generative-ai":
      return hostname === "generativelanguage.googleapis.com";
    default:
      return false;
  }
}

/**
 * 附件 kind 是否进入原生内联候选。image 总是候选（MIME 与模型图片能力沿用各
 * adapter 原有的筛法），pdf 仅官方端点，其余 kind 一律交给 Read。
 */
function isNativeInlineCandidate(
  file: PendingUploadedFile,
  model: Model<Api>,
  baseUrl: string | undefined,
) {
  if (file.kind === "image") return true;
  if (file.kind === "pdf") return supportsNativePdfInline(model, baseUrl);
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function normalizeMimeType(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isOpenAIResponsesModel(model: Model<Api>) {
  return model.api === "openai-responses";
}

function isOpenAICompletionsModel(model: Model<Api>) {
  return model.api === "openai-completions";
}

function isAnthropicMessagesModel(model: Model<Api>) {
  return model.api === "anthropic-messages";
}

function isGoogleGenerativeAIModel(model: Model<Api>) {
  return model.api === "google-generative-ai";
}

function modelSupportsImageInput(model: Model<Api>) {
  return Array.isArray(model.input) && model.input.includes("image");
}

function getUserMessageNativeAttachmentBatches(context: Context) {
  return context.messages
    .filter((message) => message.role === "user")
    .map((message) =>
      getUserMessageAttachments(
        message as unknown as Parameters<typeof getUserMessageAttachments>[0],
      ),
    );
}

function buildDataUrl(mimeType: string, data: string) {
  return `data:${mimeType};base64,${data}`;
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
  model: Model<Api>;
  baseUrl?: string;
  file: PendingUploadedFile;
}): Promise<NativeAttachmentContentPart | null> {
  const { file, model, workdir, baseUrl } = params;
  if (!isNativeInlineCandidate(file, model, baseUrl)) return null;
  if (file.kind === "image" && !modelSupportsImageInput(model)) return null;

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

  if (mimeType !== PDF_MIME_TYPE) return null;
  return {
    type: "input_file",
    filename: file.fileName || file.relativePath.split("/").pop() || "attachment",
    file_data: buildDataUrl(mimeType, attachment.data),
  };
}

async function buildOpenAIChatCompletionsNativeAttachmentContentPart(params: {
  workdir: string;
  model: Model<Api>;
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

function replaceUploadInstructionHeader(text: string, nativeInstruction: string) {
  for (const header of UPLOADED_FILES_INSTRUCTION_HEADER_TEXTS) {
    if (text.includes(header)) {
      return text.replace(header, nativeInstruction);
    }
  }
  return `${text}\n\n${nativeInstruction}`;
}

function annotateInlinedAttachmentLines(text: string, inlinedFiles: PendingUploadedFile[]) {
  if (inlinedFiles.length === 0) return text;
  return text
    .split("\n")
    .map((line) => {
      if (inlinedFiles.some((file) => matchesUploadedFileInstructionLine(line, file))) {
        return `${line}${INLINED_ATTACHMENT_LINE_SUFFIX}`;
      }
      return line;
    })
    .join("\n");
}

function rewriteNativeUploadInstructionText(params: {
  text: string;
  nativeInstruction: string;
  inlinedFiles: PendingUploadedFile[];
}) {
  return annotateInlinedAttachmentLines(
    replaceUploadInstructionHeader(params.text, params.nativeInstruction),
    params.inlinedFiles,
  );
}

function applyTypedNativeUploadInstruction(params: {
  content: unknown[];
  type: string;
  nativeInstruction: string;
  inlinedFiles: PendingUploadedFile[];
}) {
  const next = params.content.slice();
  for (let index = 0; index < next.length; index += 1) {
    const part = next[index];
    if (!isRecord(part) || part.type !== params.type || typeof part.text !== "string") {
      continue;
    }
    next[index] = {
      ...part,
      text: rewriteNativeUploadInstructionText({
        text: part.text,
        nativeInstruction: params.nativeInstruction,
        inlinedFiles: params.inlinedFiles,
      }),
    };
    return next;
  }
  return [{ type: params.type, text: params.nativeInstruction }, ...next];
}

function normalizeUserContent(content: unknown): unknown[] {
  if (Array.isArray(content)) return content.slice();
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  return [];
}

function applyNativeUploadInstruction(content: unknown[], inlinedFiles: PendingUploadedFile[]) {
  return applyTypedNativeUploadInstruction({
    content,
    type: "input_text",
    nativeInstruction: NATIVE_UPLOAD_INSTRUCTION,
    inlinedFiles,
  });
}

function normalizeOpenAIChatCompletionsUserContent(content: unknown): unknown[] {
  if (Array.isArray(content)) return content.slice();
  if (typeof content === "string") return [{ type: "text", text: content }];
  return [];
}

function applyOpenAIChatCompletionsNativeUploadInstruction(
  content: unknown[],
  inlinedFiles: PendingUploadedFile[],
) {
  return applyTypedNativeUploadInstruction({
    content,
    type: "text",
    nativeInstruction: OPENAI_CHAT_COMPLETIONS_NATIVE_UPLOAD_INSTRUCTION,
    inlinedFiles,
  });
}

function normalizeAnthropicUserContent(content: unknown): unknown[] {
  if (Array.isArray(content)) return content.slice();
  if (typeof content === "string") return [{ type: "text", text: content }];
  return [];
}

function applyAnthropicNativeUploadInstruction(
  content: unknown[],
  inlinedFiles: PendingUploadedFile[],
) {
  return applyTypedNativeUploadInstruction({
    content,
    type: "text",
    nativeInstruction: ANTHROPIC_NATIVE_UPLOAD_INSTRUCTION,
    inlinedFiles,
  });
}

function normalizeGeminiUserParts(parts: unknown): unknown[] {
  if (Array.isArray(parts)) return parts.slice();
  if (typeof parts === "string") return [{ text: parts }];
  return [];
}

function applyGeminiNativeUploadInstruction(parts: unknown[], inlinedFiles: PendingUploadedFile[]) {
  const next = parts.slice();
  for (let index = 0; index < next.length; index += 1) {
    const part = next[index];
    if (!isRecord(part) || typeof part.text !== "string") {
      continue;
    }
    next[index] = {
      ...part,
      text: rewriteNativeUploadInstructionText({
        text: part.text,
        nativeInstruction: GEMINI_NATIVE_UPLOAD_INSTRUCTION,
        inlinedFiles,
      }),
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
  model: Model<Api>;
  baseUrl?: string;
  files: PendingUploadedFile[];
}) {
  const parts: NativeAttachmentContentPart[] = [];
  const inlinedFiles: PendingUploadedFile[] = [];
  for (const file of params.files) {
    try {
      const part = await buildNativeAttachmentContentPart({
        workdir: params.workdir,
        model: params.model,
        baseUrl: params.baseUrl,
        file,
      });
      if (part) {
        parts.push(part);
        inlinedFiles.push(file);
      }
    } catch (error) {
      console.warn(
        `[native-responses-attachments] skipped ${file.relativePath}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return { parts, inlinedFiles };
}

async function buildOpenAIChatCompletionsNativeContentParts(params: {
  workdir: string;
  model: Model<Api>;
  files: PendingUploadedFile[];
}) {
  const parts: OpenAIChatCompletionsNativeAttachmentContentPart[] = [];
  const inlinedFiles: PendingUploadedFile[] = [];
  for (const file of params.files) {
    try {
      const part = await buildOpenAIChatCompletionsNativeAttachmentContentPart({
        workdir: params.workdir,
        model: params.model,
        file,
      });
      if (part) {
        parts.push(part);
        inlinedFiles.push(file);
      }
    } catch (error) {
      console.warn(
        `[openai-chat-completions-native-attachments] skipped ${file.relativePath}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return { parts, inlinedFiles };
}

async function buildAnthropicNativeAttachmentContentPart(params: {
  workdir: string;
  model: Model<Api>;
  baseUrl?: string;
  file: PendingUploadedFile;
}): Promise<AnthropicNativeAttachmentContentPart | null> {
  const { file, model, workdir, baseUrl } = params;
  if (!isNativeInlineCandidate(file, model, baseUrl)) return null;
  // Anthropic 分支不读 model.input：modelFactory 给所有自定义 Anthropic 模型
  // 硬编码 input: ["text"]，且用户 inputModalities 覆盖也不作用于此处。
  // 若在这里加图片门控，k3 / glm 等一切非目录模型的图片内联都会失效。

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

  if (mimeType !== PDF_MIME_TYPE) return null;
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
  model: Model<Api>;
  baseUrl?: string;
  files: PendingUploadedFile[];
}) {
  const parts: AnthropicNativeAttachmentContentPart[] = [];
  const inlinedFiles: PendingUploadedFile[] = [];
  for (const file of params.files) {
    try {
      const part = await buildAnthropicNativeAttachmentContentPart({
        workdir: params.workdir,
        model: params.model,
        baseUrl: params.baseUrl,
        file,
      });
      if (part) {
        parts.push(part);
        inlinedFiles.push(file);
      }
    } catch (error) {
      console.warn(
        `[anthropic-native-attachments] skipped ${file.relativePath}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return { parts, inlinedFiles };
}

async function buildGeminiNativeAttachmentContentPart(params: {
  workdir: string;
  model: Model<Api>;
  baseUrl?: string;
  file: PendingUploadedFile;
}): Promise<GeminiNativeAttachmentCandidate | null> {
  const { file, model, workdir, baseUrl } = params;
  if (!isNativeInlineCandidate(file, model, baseUrl)) return null;
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
  } else if (mimeType !== PDF_MIME_TYPE) {
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
  model: Model<Api>;
  baseUrl?: string;
  files: PendingUploadedFile[];
  availableRequestBytes: number;
}) {
  const parts: GeminiNativeAttachmentContentPart[] = [];
  const inlinedFiles: PendingUploadedFile[] = [];
  let usedRequestBytes = 0;
  if (params.availableRequestBytes <= 0) {
    return { parts, inlinedFiles, usedRequestBytes };
  }
  for (const file of params.files) {
    try {
      const candidate = await buildGeminiNativeAttachmentContentPart({
        workdir: params.workdir,
        model: params.model,
        baseUrl: params.baseUrl,
        file,
      });
      if (!candidate) continue;
      if (usedRequestBytes + candidate.requestBytes > params.availableRequestBytes) {
        continue;
      }
      parts.push(candidate.part);
      inlinedFiles.push(file);
      usedRequestBytes += candidate.requestBytes;
    } catch (error) {
      console.warn(
        `[gemini-native-attachments] skipped ${file.relativePath}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return { parts, inlinedFiles, usedRequestBytes };
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
  model: Model<Api>;
  workdir: string;
  baseUrl?: string;
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

    const nativeContent = await buildNativeContentParts({
      workdir: params.workdir,
      model: params.model,
      baseUrl: params.baseUrl,
      files,
    });
    if (nativeContent.parts.length === 0) {
      nextInput.push(item);
      continue;
    }

    nextInput.push({
      ...item,
      content: [
        ...applyNativeUploadInstruction(
          normalizeUserContent(item.content),
          nativeContent.inlinedFiles,
        ),
        ...nativeContent.parts,
      ],
    });
    changed = true;
  }

  return changed ? { ...payload, input: nextInput } : payload;
}

async function applyNativeAttachmentsToOpenAICompletionsPayload(params: {
  payload: unknown;
  context: Context;
  model: Model<Api>;
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

    const nativeContent = await buildOpenAIChatCompletionsNativeContentParts({
      workdir: params.workdir,
      model: params.model,
      files,
    });
    if (nativeContent.parts.length === 0) {
      nextMessages.push(message);
      continue;
    }

    nextMessages.push({
      ...message,
      content: [
        ...applyOpenAIChatCompletionsNativeUploadInstruction(
          normalizeOpenAIChatCompletionsUserContent(message.content),
          nativeContent.inlinedFiles,
        ),
        ...nativeContent.parts,
      ],
    });
    changed = true;
  }

  return changed ? { ...payload, messages: nextMessages } : payload;
}

async function applyNativeAttachmentsToAnthropicPayload(params: {
  payload: unknown;
  context: Context;
  model: Model<Api>;
  workdir: string;
  baseUrl?: string;
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

    const nativeContent = await buildAnthropicNativeContentParts({
      workdir: params.workdir,
      model: params.model,
      baseUrl: params.baseUrl,
      files,
    });
    if (nativeContent.parts.length === 0) {
      nextMessages.push(message);
      continue;
    }

    nextMessages.push({
      ...message,
      content: [
        ...applyAnthropicNativeUploadInstruction(
          normalizeAnthropicUserContent(message.content),
          nativeContent.inlinedFiles,
        ),
        ...nativeContent.parts,
      ],
    });
    changed = true;
  }

  return changed ? { ...payload, messages: nextMessages } : payload;
}

async function applyNativeAttachmentsToGeminiPayload(params: {
  payload: unknown;
  context: Context;
  model: Model<Api>;
  workdir: string;
  baseUrl?: string;
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
      baseUrl: params.baseUrl,
      files,
      availableRequestBytes: remainingNativeRequestBytes,
    });
    if (nativeContent.parts.length === 0) {
      nextContents.push(item);
      continue;
    }
    remainingNativeRequestBytes -= nativeContent.usedRequestBytes;

    nextContents.push({
      ...item,
      parts: [
        ...nativeContent.parts,
        ...applyGeminiNativeUploadInstruction(
          normalizeGeminiUserParts(item.parts),
          nativeContent.inlinedFiles,
        ),
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
    model: Model<Api>;
    providerId: string;
    workdir?: string;
    baseUrl?: string;
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
        baseUrl: params.baseUrl,
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
    model: Model<Api>;
    providerId: string;
    workdir?: string;
    baseUrl?: string;
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
    model: Model<Api>;
    providerId: string;
    workdir?: string;
    baseUrl?: string;
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
        baseUrl: params.baseUrl,
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
    model: Model<Api>;
    providerId: string;
    workdir?: string;
    baseUrl?: string;
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
        baseUrl: params.baseUrl,
      });
    },
  };
}

export const __nativeResponsesAttachmentsTest = {
  NATIVE_UPLOAD_INSTRUCTION,
  OPENAI_CHAT_COMPLETIONS_NATIVE_UPLOAD_INSTRUCTION,
  ANTHROPIC_NATIVE_UPLOAD_INSTRUCTION,
  GEMINI_NATIVE_UPLOAD_INSTRUCTION,
  INLINED_ATTACHMENT_LINE_SUFFIX,
  applyNativeAttachmentsToResponsesPayload,
  applyNativeAttachmentsToOpenAICompletionsPayload,
  applyNativeAttachmentsToAnthropicPayload,
  applyNativeAttachmentsToGeminiPayload,
  supportsNativePdfInline,
};
