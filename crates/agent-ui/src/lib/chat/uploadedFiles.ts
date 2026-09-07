import { normalizeLogicalLineEndings } from "@liveagent/ui/lib/chat/composerText";
import {
  type ConversationMentionReference,
  normalizeConversationMentionReferences,
} from "@liveagent/ui/lib/chat/mentionReferences";
import { createUuid } from "@liveagent/ui/lib/shared/id";

export type UploadedReadableFileKind =
  | "text"
  | "image"
  | "pdf"
  | "notebook"
  | "word"
  | "spreadsheet"
  | "archive";

const UPLOADED_READABLE_FILE_KINDS = new Set<string>([
  "text",
  "image",
  "pdf",
  "notebook",
  "word",
  "spreadsheet",
  "archive",
]);

const DISPLAY_CONTENT_FIELD = "liveAgentDisplayContent";
const ATTACHMENTS_FIELD = "liveAgentAttachments";
const REFERENCED_CONVERSATIONS_FIELD = "liveAgentReferencedConversations";

function createUserMessageId() {
  return `user-${createUuid()}`;
}

export type PendingUploadedFile = {
  relativePath: string;
  absolutePath?: string;
  /** Stable source/content identity used only to collapse pending duplicates. */
  dedupeKey?: string;
  fileName: string;
  kind: UploadedReadableFileKind;
  sizeBytes: number;
  displayMode?: "largePaste";
  displayLabel?: string;
  displayCharCount?: number;
  displayLineCount?: number;
};

export type PastedTextDisplayReference = {
  raw: string;
  label: string;
  relativePath: string;
  start: number;
  end: number;
};

const PASTED_TEXT_DISPLAY_REFERENCE_RE = /\[(Pasted text \d+):\s*([^\]\r\n]+)]/g;

export type UploadedUserMessage = {
  role: "user";
  id: string;
  content: string;
  timestamp: number;
  [DISPLAY_CONTENT_FIELD]?: string;
  [ATTACHMENTS_FIELD]?: PendingUploadedFile[];
  [REFERENCED_CONVERSATIONS_FIELD]?: ConversationMentionReference[];
};

export function mergePendingUploadedFiles(
  current: PendingUploadedFile[],
  incoming: PendingUploadedFile[],
) {
  return mergePendingUploadedFilesWithStats(current, incoming).files;
}

export function pendingUploadedFileDedupeKey(file: PendingUploadedFile) {
  return file.dedupeKey?.trim() || `relative:${file.relativePath}`;
}

export function mergePendingUploadedFilesWithStats(
  current: PendingUploadedFile[],
  incoming: PendingUploadedFile[],
) {
  const merged = new Map<string, PendingUploadedFile>();
  let duplicateCount = 0;
  for (const file of current) {
    const key = pendingUploadedFileDedupeKey(file);
    if (merged.has(key)) duplicateCount += 1;
    merged.set(key, file);
  }
  for (const file of incoming) {
    const key = pendingUploadedFileDedupeKey(file);
    if (merged.has(key)) duplicateCount += 1;
    merged.set(key, file);
  }
  return { files: Array.from(merged.values()), duplicateCount };
}

function clonePendingUploadedFiles(files: PendingUploadedFile[]) {
  return files.map((file) => ({ ...file }));
}

export function withPastedTextDisplayMetadata(
  file: PendingUploadedFile,
  paste: { label: string; charCount: number; lineCount: number },
): PendingUploadedFile {
  return {
    ...file,
    displayMode: "largePaste",
    displayLabel: paste.label,
    displayCharCount: paste.charCount,
    displayLineCount: paste.lineCount,
  };
}

export function isPastedTextDisplayFile(file: PendingUploadedFile) {
  return file.displayMode === "largePaste";
}

export function parsePastedTextDisplayReferences(text: string): PastedTextDisplayReference[] {
  if (!text.trim()) return [];

  const references: PastedTextDisplayReference[] = [];
  for (const match of text.matchAll(PASTED_TEXT_DISPLAY_REFERENCE_RE)) {
    const raw = match[0] ?? "";
    const label = (match[1] ?? "").trim();
    const relativePath = (match[2] ?? "").trim();
    const start = match.index ?? -1;
    if (!raw || !label || !relativePath || start < 0) continue;
    references.push({
      raw,
      label,
      relativePath,
      start,
      end: start + raw.length,
    });
  }
  return references;
}

export function splitUserAttachmentsForDisplay(files: PendingUploadedFile[], text: string) {
  const pastedTextReferences = parsePastedTextDisplayReferences(text);
  if (pastedTextReferences.length === 0 || files.length === 0) {
    return {
      visibleFiles: files,
      pastedTextFiles: [],
    };
  }

  const pastedTextPaths = new Set(pastedTextReferences.map((reference) => reference.relativePath));
  const pastedTextFiles: PendingUploadedFile[] = [];
  const visibleFiles: PendingUploadedFile[] = [];

  for (const file of files) {
    if (pastedTextPaths.has(file.relativePath)) {
      pastedTextFiles.push(file);
    } else {
      visibleFiles.push(file);
    }
  }

  return {
    visibleFiles,
    pastedTextFiles,
  };
}

/**
 * 附件指令的两行固定头。provider 原生内联适配器（nativeResponsesAttachments）
 * 按整段精确匹配把它替换成"部分附件已内联"的版本；DeepSeek 大段粘贴内联
 * （deepSeekAttachments）按整段精确匹配在所有附件行都被移除后删掉它。
 * 改文案必须保持这两处仍能命中，所以只在这里定义一次。
 *
 * 第二行顺带告诉模型 Read 是分窗口返回的：Read 每次只给一段（文本默认 200
 * 行、PDF 默认 5 页、notebook 默认 20 cell），并在结果里报告总量；这里提前
 * 提醒它翻到底，避免模型只读了第一窗就开始总结。这段提示单独导出，供
 * nativeResponsesAttachments 拼"部分附件已内联"版本的指令头时复用。
 */
export const UPLOADED_FILES_READ_PAGING_HINT =
  "Read returns a bounded window per call and reports the total size, so keep paging (start_line/limit, page_start/page_limit, or cell_start/cell_limit) until you have read each file completely:";

export const UPLOADED_FILES_INSTRUCTION_HEADER_LINES = [
  "The user attached the files below to this message.",
  `Use Read with these exact paths before analyzing or modifying them. ${UPLOADED_FILES_READ_PAGING_HINT}`,
] as const;

/** 改文案前落库的历史消息仍带这版头；匹配时两版都认。 */
const LEGACY_UPLOADED_FILES_INSTRUCTION_HEADER_LINES = [
  "The user attached the files below to this message.",
  "Use Read with these exact paths before analyzing or modifying them:",
] as const;

const UPLOADED_FILES_INSTRUCTION_HEADER_VARIANTS: readonly (readonly string[])[] = [
  UPLOADED_FILES_INSTRUCTION_HEADER_LINES,
  LEGACY_UPLOADED_FILES_INSTRUCTION_HEADER_LINES,
];

/** 当前与历史两版附件指令头的整段文本，供按字符串替换的调用方使用。 */
export const UPLOADED_FILES_INSTRUCTION_HEADER_TEXTS: readonly string[] =
  UPLOADED_FILES_INSTRUCTION_HEADER_VARIANTS.map((lines) => lines.join("\n"));

/**
 * 在按行拆开的消息里定位附件指令头（当前或历史格式）。返回头的起始下标
 * 与行数；找不到返回 null。
 */
export function locateUploadedFilesInstructionHeader(lines: readonly string[]) {
  for (let index = 0; index < lines.length; index += 1) {
    for (const header of UPLOADED_FILES_INSTRUCTION_HEADER_VARIANTS) {
      if (header.every((line, offset) => lines[index + offset] === line)) {
        return { index, length: header.length };
      }
    }
  }
  return null;
}

/**
 * 单个附件在指令里的一行。格式是跨模块契约：deepSeekAttachments 按整行精确
 * 匹配删除已内联的粘贴行，nativeResponsesAttachments 给原生内联的附件加标注。
 * 带上体积让模型对"一窗读不完"有预期。
 */
export function formatUploadedFileInstructionLine(file: PendingUploadedFile) {
  const absolutePath = typeof file.absolutePath === "string" ? file.absolutePath.trim() : "";
  if (!absolutePath) return "";
  const size =
    Number.isFinite(file.sizeBytes) && file.sizeBytes >= 0
      ? `, ${formatUploadedFileSize(Math.floor(file.sizeBytes))}`
      : "";
  return `- ${absolutePath} (${file.kind}${size})`;
}

/**
 * 判断指令里的某一行是否就是该附件。除当前格式外也接受不带体积的旧格式
 * `- <absolutePath> (<kind>)`，让已落库的历史会话继续能被精确匹配。
 */
export function matchesUploadedFileInstructionLine(line: string, file: PendingUploadedFile) {
  const current = formatUploadedFileInstructionLine(file);
  if (!current) return false;
  if (line === current) return true;
  const absolutePath = typeof file.absolutePath === "string" ? file.absolutePath.trim() : "";
  return line === `- ${absolutePath} (${file.kind})`;
}

export function buildUploadedFilesInstruction(files: PendingUploadedFile[]) {
  // 模型读取路径只认导入时返回的绝对路径（工作区内原地引用、工作区外落
  // 暂存区）。旧版本仅持久化相对路径的附件不再列出——新方案下无法定位。
  const lines = files.map(formatUploadedFileInstructionLine).filter((line) => line.length > 0);
  if (lines.length === 0) return "";
  return [...UPLOADED_FILES_INSTRUCTION_HEADER_LINES, ...lines].join("\n");
}

export function buildUserMessageContentWithUploads(userText: string, files: PendingUploadedFile[]) {
  const normalizedText = normalizeLogicalLineEndings(userText);
  if (files.length === 0) return normalizedText;

  const instruction = buildUploadedFilesInstruction(files);
  if (!instruction) return normalizedText;
  if (!normalizedText.trim()) {
    return `Please inspect the selected files first.\n\n${instruction}`;
  }
  return `${normalizedText}\n\n${instruction}`;
}

export function createUserMessageWithUploads(
  userText: string,
  files: PendingUploadedFile[],
  timestamp = Date.now(),
  referencedConversations: readonly ConversationMentionReference[] = [],
): UploadedUserMessage | null {
  const content = buildUserMessageContentWithUploads(userText, files);
  if (!content.trim()) return null;

  const message: UploadedUserMessage = {
    role: "user",
    id: createUserMessageId(),
    content,
    timestamp,
  };
  if (files.length > 0) {
    message[DISPLAY_CONTENT_FIELD] = normalizeLogicalLineEndings(userText);
    message[ATTACHMENTS_FIELD] = clonePendingUploadedFiles(files);
  }
  const normalizedReferences = normalizeConversationMentionReferences(referencedConversations);
  if (normalizedReferences.length > 0) {
    message[REFERENCED_CONVERSATIONS_FIELD] = normalizedReferences;
  }
  return message;
}

function flattenUserContent(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  let text = "";
  for (const block of content) {
    if (block.type === "text") text += block.text;
  }
  return text;
}

export function getUserMessageDisplayText(
  message: { role: string; content?: unknown } & Record<string, unknown>,
) {
  const displayContent = message[DISPLAY_CONTENT_FIELD];
  if (typeof displayContent === "string") {
    return displayContent;
  }
  return flattenUserContent(message.content);
}

export function getUserMessageAttachments(message: { role: string } & Record<string, unknown>) {
  const raw = message[ATTACHMENTS_FIELD];
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const file = item as Record<string, unknown>;
    if (
      typeof file.relativePath !== "string" ||
      typeof file.fileName !== "string" ||
      typeof file.kind !== "string" ||
      typeof file.sizeBytes !== "number"
    ) {
      return [];
    }
    const pendingFile: PendingUploadedFile = {
      relativePath: file.relativePath,
      fileName: file.fileName,
      kind: UPLOADED_READABLE_FILE_KINDS.has(file.kind)
        ? (file.kind as UploadedReadableFileKind)
        : "text",
      sizeBytes: file.sizeBytes,
    };
    if (typeof file.absolutePath === "string" && file.absolutePath.trim()) {
      pendingFile.absolutePath = file.absolutePath;
    }
    if (file.displayMode === "largePaste") {
      pendingFile.displayMode = "largePaste";
    }
    if (typeof file.displayLabel === "string" && file.displayLabel.trim()) {
      pendingFile.displayLabel = file.displayLabel;
    }
    if (typeof file.displayCharCount === "number" && Number.isFinite(file.displayCharCount)) {
      pendingFile.displayCharCount = file.displayCharCount;
    }
    if (typeof file.displayLineCount === "number" && Number.isFinite(file.displayLineCount)) {
      pendingFile.displayLineCount = file.displayLineCount;
    }
    return [pendingFile];
  });
}

export function getUserMessageReferencedConversations(
  message: { role: string } & Record<string, unknown>,
  currentConversationId?: string,
) {
  const raw = message[REFERENCED_CONVERSATIONS_FIELD];
  if (!Array.isArray(raw)) return [];
  return normalizeConversationMentionReferences(
    raw as ConversationMentionReference[],
    currentConversationId,
  );
}

export function normalizeUploadedFileForDisplayComparison(file: PendingUploadedFile) {
  return {
    relativePath: file.relativePath,
    absolutePath: file.absolutePath || "",
    fileName: file.fileName,
    kind: file.kind,
    sizeBytes: Number.isFinite(file.sizeBytes) ? Math.max(0, Math.floor(file.sizeBytes)) : 0,
    displayMode: file.displayMode || "",
    displayLabel: file.displayLabel || "",
    displayCharCount:
      typeof file.displayCharCount === "number" && Number.isFinite(file.displayCharCount)
        ? Math.max(0, Math.floor(file.displayCharCount))
        : 0,
    displayLineCount:
      typeof file.displayLineCount === "number" && Number.isFinite(file.displayLineCount)
        ? Math.max(0, Math.floor(file.displayLineCount))
        : 0,
  };
}

function uploadedFilesDisplayKey(files: readonly PendingUploadedFile[]) {
  return JSON.stringify(files.map(normalizeUploadedFileForDisplayComparison));
}

export function uploadedFilesVisuallyEqual(
  left: readonly PendingUploadedFile[],
  right: readonly PendingUploadedFile[],
) {
  return uploadedFilesDisplayKey(left) === uploadedFilesDisplayKey(right);
}

export function stripUploadedFilesMessageMetadata<TMessage extends { role: string }>(
  message: TMessage,
): TMessage {
  if (message.role !== "user") return message;
  const userMessage = message as TMessage & Record<string, unknown>;
  if (
    !(DISPLAY_CONTENT_FIELD in userMessage) &&
    !(ATTACHMENTS_FIELD in userMessage) &&
    !(REFERENCED_CONVERSATIONS_FIELD in userMessage)
  ) {
    return message;
  }

  const next = { ...userMessage };
  delete next[DISPLAY_CONTENT_FIELD];
  delete next[ATTACHMENTS_FIELD];
  delete next[REFERENCED_CONVERSATIONS_FIELD];
  return next as TMessage;
}

export function formatUploadedFileSize(sizeBytes: number) {
  if (sizeBytes >= 1024 * 1024) return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  if (sizeBytes >= 1024) return `${Math.round(sizeBytes / 1024)} KB`;
  return `${sizeBytes} B`;
}
