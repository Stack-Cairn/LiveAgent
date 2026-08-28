import type {
  MentionComposerAppMention,
  MentionComposerCommitMention,
  MentionComposerDraft,
  MentionComposerGitFileMention,
  MentionComposerLargePaste,
} from "@liveagent/ui/components/chat/MentionComposer";
import { normalizeLogicalLineEndings } from "@liveagent/ui/lib/chat/composerText";
import {
  escapeMarkdownReferenceLabel,
  formatCodeMentionToken,
  formatFileMentionToken,
  formatMarkdownReferenceDestination,
} from "@liveagent/ui/lib/chat/mentionReferences";
import {
  type PendingUploadedFile,
  withPastedTextDisplayMetadata,
} from "@liveagent/ui/lib/chat/uploadedFiles";

export function buildPastedTextFileName(paste: MentionComposerLargePaste, index: number) {
  const baseName = paste.label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${baseName || `pasted-text-${index + 1}`}.txt`;
}

function formatComposerCommitMention(commit: MentionComposerCommitMention) {
  const shortSha = commit.shortSha || commit.sha.slice(0, 7);
  const subject = commit.subject.trim() || shortSha;
  const label = `commit ${shortSha}: ${subject}`;
  if (commit.githubUrl?.trim()) {
    return `[${escapeMarkdownReferenceLabel(label)}](${formatMarkdownReferenceDestination(commit.githubUrl.trim())})`;
  }
  return `${label} (${commit.sha})`;
}

function formatComposerGitFileMention(file: MentionComposerGitFileMention) {
  const refLabel = file.refName || file.shortSha || file.commitSha.slice(0, 7);
  const label = `git file ${refLabel}: ${file.path}`;
  if (file.githubUrl?.trim()) {
    return `[${escapeMarkdownReferenceLabel(label)}](${formatMarkdownReferenceDestination(file.githubUrl.trim())})`;
  }
  return `${label} (${file.commitSha})`;
}

/** 与 MentionComposerInternals.formatAppMentionToken 同构：可见名 + 稳定
 *  身份（bundle id 或安装路径），模型据此用 CUA 工具寻址应用。 */
function formatComposerAppMention(app: MentionComposerAppMention) {
  const identity = app.bundleId?.trim() || app.path.trim();
  if (!identity || identity === app.name) return `app "${app.name}"`;
  return `app "${app.name}" (${identity})`;
}

export function buildTextFromComposerDraft(
  draft: MentionComposerDraft,
  pastedFileById?: Map<string, PendingUploadedFile>,
) {
  return normalizeLogicalLineEndings(
    draft.segments
      .map((segment) => {
        if (segment.type === "text") return segment.text;
        if (segment.type === "fileMention") return formatFileMentionToken(segment.reference);
        if (segment.type === "skillMention") return `/${segment.skill.name}`;
        if (segment.type === "appMention") return formatComposerAppMention(segment.app);
        if (segment.type === "commitMention") return formatComposerCommitMention(segment.commit);
        if (segment.type === "gitFileMention") return formatComposerGitFileMention(segment.file);
        if (segment.type === "codeMention") return formatCodeMentionToken(segment.reference);
        const file = pastedFileById?.get(segment.paste.id);
        return file ? `[${segment.paste.label}: ${file.relativePath}]` : segment.paste.text;
      })
      .join("")
      .replace(/\u00A0/g, " "),
  );
}

export function mapImportedPastedTextFiles(
  pastes: MentionComposerLargePaste[],
  importedFiles: PendingUploadedFile[],
) {
  const files = importedFiles.map((file, index) => {
    const paste = pastes[index];
    return paste ? withPastedTextDisplayMetadata(file, paste) : file;
  });
  const fileByPasteId = new Map<string, PendingUploadedFile>();
  files.forEach((file, index) => {
    const paste = pastes[index];
    if (paste) fileByPasteId.set(paste.id, file);
  });
  return { files, fileByPasteId };
}

export function validateImportedPastedTextFiles(
  pastes: MentionComposerLargePaste[],
  importedFiles: PendingUploadedFile[],
  skipped: string[],
) {
  if (importedFiles.length !== pastes.length) {
    const skippedDetails = skipped.length > 0 ? `\n${skipped.join("\n")}` : "";
    throw new Error(`部分大段粘贴内容未能导入为附件。${skippedDetails}`);
  }
  return mapImportedPastedTextFiles(pastes, importedFiles);
}

export function createTextComposerDraft(text: string): MentionComposerDraft {
  const normalizedText = normalizeLogicalLineEndings(text);
  return {
    segments: normalizedText ? [{ type: "text", text: normalizedText }] : [],
    text: normalizedText,
    textWithoutLargePastes: normalizedText,
    largePastes: [],
    skillMentions: [],
    appMentions: [],
    commitMentions: [],
    gitFileMentions: [],
    codeMentions: [],
    isEmpty: normalizedText.trim().length === 0,
  };
}
