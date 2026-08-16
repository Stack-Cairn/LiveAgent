import type { Context, UserMessage } from "@earendil-works/pi-ai";
import {
  getUserMessageAttachments,
  type PendingUploadedFile,
  parsePastedTextDisplayReferences,
} from "@liveagent/ui/lib/chat/uploadedFiles";
import { invoke } from "@tauri-apps/api/core";

type NativeAttachmentCommandResponse = {
  mimeType: string;
  data: string;
  sizeBytes: number;
};

const UPLOAD_INSTRUCTION_LINES = [
  "The user attached the files below to this message.",
  "Use Read with these exact paths before analyzing or modifying them:",
] as const;

function decodeBase64Utf8(data: string) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function readLargePaste(workdir: string, file: PendingUploadedFile) {
  const absolutePath = file.absolutePath?.trim();
  if (!absolutePath) {
    throw new Error(
      `DeepSeek cannot inline pasted text "${file.fileName}" because its absolute path is unavailable. Paste the content again.`,
    );
  }
  const response = await invoke<NativeAttachmentCommandResponse>(
    "system_read_uploaded_native_attachment",
    {
      workdir,
      absolute_path: absolutePath,
      kind: file.kind,
    },
  );
  const data = String(response.data ?? "").trim();
  if (!data) {
    throw new Error(`DeepSeek could not read pasted text "${file.fileName}".`);
  }
  return decodeBase64Utf8(data);
}

function removeUploadInstructionLine(content: string, file: PendingUploadedFile) {
  const absolutePath = file.absolutePath?.trim();
  if (!absolutePath) return content;
  const target = `- ${absolutePath} (${file.kind})`;
  const lines = content.split("\n").filter((line) => line !== target);
  const instructionIndex = lines.findIndex(
    (line, index) =>
      line === UPLOAD_INSTRUCTION_LINES[0] && lines[index + 1] === UPLOAD_INSTRUCTION_LINES[1],
  );
  if (instructionIndex < 0) return lines.join("\n");

  const hasRemainingFile = lines
    .slice(instructionIndex + UPLOAD_INSTRUCTION_LINES.length)
    .some((line) => line.startsWith("- "));
  if (hasRemainingFile) return lines.join("\n");

  const removeFrom =
    instructionIndex > 0 && lines[instructionIndex - 1] === ""
      ? instructionIndex - 1
      : instructionIndex;
  lines.splice(
    removeFrom,
    UPLOAD_INSTRUCTION_LINES.length + (removeFrom < instructionIndex ? 1 : 0),
  );
  return lines.join("\n");
}

function replacePasteReference(
  content: string,
  file: PendingUploadedFile,
  pastedText: string,
): { content: string; replaced: boolean } {
  const references = parsePastedTextDisplayReferences(content).filter(
    (reference) => reference.relativePath === file.relativePath,
  );
  let next = content;
  for (const reference of [...references].sort((left, right) => right.start - left.start)) {
    next = `${next.slice(0, reference.start)}${pastedText}${next.slice(reference.end)}`;
  }
  next = removeUploadInstructionLine(next, file);
  return { content: next, replaced: references.length > 0 };
}

function inlineIntoUserMessage(
  message: UserMessage,
  files: Array<{ file: PendingUploadedFile; text: string }>,
): UserMessage {
  if (typeof message.content === "string") {
    let content = message.content;
    for (const { file, text } of files) {
      const result = replacePasteReference(content, file, text);
      content = result.replaced
        ? result.content
        : `${result.content}\n\n${file.displayLabel || file.fileName}:\n${text}`;
    }
    return { ...message, content };
  }

  const content = message.content.map((block) => ({ ...block }));
  for (const { file, text } of files) {
    let replaced = false;
    for (const block of content) {
      if (block.type !== "text") continue;
      const result = replacePasteReference(block.text, file, text);
      block.text = result.content;
      replaced ||= result.replaced;
    }
    if (!replaced) {
      content.push({ type: "text", text: `${file.displayLabel || file.fileName}:\n${text}` });
    }
  }
  return { ...message, content };
}

export async function inlineDeepSeekLargePastes(
  context: Context,
  workdir: string | undefined,
): Promise<Context> {
  let changed = false;
  const messages: Context["messages"] = [];

  for (const message of context.messages) {
    if (message.role !== "user") {
      messages.push(message);
      continue;
    }
    const files = getUserMessageAttachments(
      message as UserMessage & Record<string, unknown>,
    ).filter((file) => file.displayMode === "largePaste" && file.kind === "text");
    if (files.length === 0) {
      messages.push(message);
      continue;
    }
    const normalizedWorkdir = workdir?.trim();
    if (!normalizedWorkdir) {
      throw new Error(
        "DeepSeek cannot inline pasted text because the conversation workdir is empty.",
      );
    }
    const pastedTexts = await Promise.all(
      files.map(async (file) => ({ file, text: await readLargePaste(normalizedWorkdir, file) })),
    );
    messages.push(inlineIntoUserMessage(message, pastedTexts));
    changed = true;
  }

  return changed ? { ...context, messages } : context;
}
