import type { Message, UserMessage } from "@earendil-works/pi-ai";

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

function createUserMessageId() {
  const id =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `user-${id}`;
}

export type PendingUploadedFile = {
  relativePath: string;
  absolutePath?: string;
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

export type UploadedUserMessage = UserMessage & {
  id: string;
  [DISPLAY_CONTENT_FIELD]?: string;
  [ATTACHMENTS_FIELD]?: PendingUploadedFile[];
};

export function mergePendingUploadedFiles(
  current: PendingUploadedFile[],
  incoming: PendingUploadedFile[],
) {
  const merged = new Map<string, PendingUploadedFile>();
  for (const file of current) {
    merged.set(file.relativePath, file);
  }
  for (const file of incoming) {
    merged.set(file.relativePath, file);
  }
  return Array.from(merged.values());
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

export function buildUploadedFilesInstruction(files: PendingUploadedFile[]) {
  if (files.length === 0) return "";
  const lines = files.map((file) => `- ${file.relativePath} (${file.kind})`);
  return [
    "Selected files are available in the workspace at these relative paths.",
    "Use Read with the paths below before analyzing or modifying them:",
    ...lines,
  ].join("\n");
}

export function buildUserMessageContentWithUploads(userText: string, files: PendingUploadedFile[]) {
  const normalizedText = userText.trim();
  if (files.length === 0) return normalizedText;

  const instruction = buildUploadedFilesInstruction(files);
  if (!normalizedText) {
    return `Please inspect the selected files first.\n\n${instruction}`;
  }
  return `${normalizedText}\n\n${instruction}`;
}

export function createUserMessageWithUploads(
  userText: string,
  files: PendingUploadedFile[],
  timestamp = Date.now(),
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
    message[DISPLAY_CONTENT_FIELD] = userText.trim();
    message[ATTACHMENTS_FIELD] = clonePendingUploadedFiles(files);
  }
  return message;
}

function flattenUserContent(content: Message["content"] | undefined) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  let text = "";
  for (const block of content) {
    if (block.type === "text") text += block.text;
  }
  return text;
}

export function getUserMessageDisplayText(
  message: Pick<Message, "role" | "content"> & Record<string, unknown>,
) {
  const displayContent = message[DISPLAY_CONTENT_FIELD];
  if (typeof displayContent === "string") {
    return displayContent;
  }
  return flattenUserContent(message.content);
}

export function getUserMessageAttachments(
  message: Pick<Message, "role"> & Record<string, unknown>,
) {
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

export function stripUploadedFilesMessageMetadata(message: Message): Message {
  if (message.role !== "user") return message;
  const userMessage = message as Message & Record<string, unknown>;
  if (!(DISPLAY_CONTENT_FIELD in userMessage) && !(ATTACHMENTS_FIELD in userMessage)) {
    return message;
  }

  const next = { ...userMessage };
  delete next[DISPLAY_CONTENT_FIELD];
  delete next[ATTACHMENTS_FIELD];
  return next as Message;
}

export function formatUploadedFileSize(sizeBytes: number) {
  if (sizeBytes >= 1024 * 1024) return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  if (sizeBytes >= 1024) return `${Math.round(sizeBytes / 1024)} KB`;
  return `${sizeBytes} B`;
}
