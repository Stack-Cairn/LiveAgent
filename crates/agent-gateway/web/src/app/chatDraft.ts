import type {
  MentionComposerCommitMention,
  MentionComposerDraft,
  MentionComposerGitFileMention,
  MentionComposerLargePaste,
} from "@/components/chat/MentionComposer";
import { formatCodeMentionToken, formatFileMentionToken } from "@/lib/chat/mentionReferences";
import type { PendingUploadedFile } from "@/lib/chat/uploadedFiles";
import { withPastedTextDisplayMetadata } from "@/lib/chat/uploadedFiles";
import { importReadableFiles } from "@/lib/uploadReadableFiles";

function buildPastedTextFileName(paste: MentionComposerLargePaste, index: number) {
  const baseName = paste.label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${baseName || `pasted-text-${index + 1}`}.txt`;
}

function escapeComposerCommitLinkLabel(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/]/g, "\\]");
}

function formatComposerCommitLinkDestination(value: string) {
  const normalized = value.replace(/\\/g, "/");
  if (/[\s()<>]/.test(normalized)) {
    return `<${normalized.replace(/</g, "%3C").replace(/>/g, "%3E")}>`;
  }
  return normalized;
}

function formatComposerCommitMention(commit: MentionComposerCommitMention) {
  const shortSha = commit.shortSha || commit.sha.slice(0, 7);
  const subject = commit.subject.trim() || shortSha;
  const label = `commit ${shortSha}: ${subject}`;
  if (commit.githubUrl?.trim()) {
    return `[${escapeComposerCommitLinkLabel(label)}](${formatComposerCommitLinkDestination(commit.githubUrl.trim())})`;
  }
  return `${label} (${commit.sha})`;
}

function formatComposerGitFileMention(file: MentionComposerGitFileMention) {
  const refLabel = file.refName || file.shortSha || file.commitSha.slice(0, 7);
  const label = `git file ${refLabel}: ${file.path}`;
  if (file.githubUrl?.trim()) {
    return `[${escapeComposerCommitLinkLabel(label)}](${formatComposerCommitLinkDestination(file.githubUrl.trim())})`;
  }
  return `${label} (${file.commitSha})`;
}

export function buildTextFromComposerDraft(
  draft: MentionComposerDraft,
  pastedFileById?: Map<string, PendingUploadedFile>,
) {
  return draft.segments
    .map((segment) => {
      if (segment.type === "text") {
        return segment.text;
      }
      if (segment.type === "fileMention") {
        return formatFileMentionToken(segment.reference);
      }
      if (segment.type === "skillMention") {
        return `$${segment.skill.name}`;
      }
      if (segment.type === "commitMention") {
        return formatComposerCommitMention(segment.commit);
      }
      if (segment.type === "gitFileMention") {
        return formatComposerGitFileMention(segment.file);
      }
      if (segment.type === "codeMention") {
        return formatCodeMentionToken(segment.reference);
      }
      const file = pastedFileById?.get(segment.paste.id);
      return file ? `[${segment.paste.label}: ${file.relativePath}]` : segment.paste.text;
    })
    .join("")
    .replace(/\u00A0/g, " ");
}

export async function importPastedTextsAsFiles(params: {
  token: string;
  workdir: string;
  pastes: MentionComposerLargePaste[];
}) {
  const { token, workdir, pastes } = params;
  const normalizedWorkdir = workdir.trim();
  if (!normalizedWorkdir) {
    throw new Error("项目目录未选择，无法发送大段粘贴内容。");
  }
  if (pastes.length === 0) {
    return {
      files: [],
      fileByPasteId: new Map<string, PendingUploadedFile>(),
    };
  }

  const textFiles = pastes.map(
    (paste, index) =>
      new File([paste.text], buildPastedTextFileName(paste, index), {
        type: "text/plain",
      }),
  );
  const response = await importReadableFiles(token, normalizedWorkdir, textFiles);
  if (response.files.length !== pastes.length) {
    const skipped = response.skipped.length > 0 ? `\n${response.skipped.join("\n")}` : "";
    throw new Error(`部分大段粘贴内容未能导入为附件。${skipped}`);
  }

  const files = response.files.map((file, index) => {
    const paste = pastes[index];
    return paste ? withPastedTextDisplayMetadata(file, paste) : file;
  });

  const fileByPasteId = new Map<string, PendingUploadedFile>();
  files.forEach((file, index) => {
    const paste = pastes[index];
    if (paste) {
      fileByPasteId.set(paste.id, file);
    }
  });
  return {
    files,
    fileByPasteId,
  };
}
