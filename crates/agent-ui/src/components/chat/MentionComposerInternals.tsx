import { usesCustomComposerContextMenu } from "@liveagent/adapters/composerClipboard";
import {
  extractGitHubCommitSha,
  extractGitHubFileReference,
  tokenizeUserMessage,
} from "@liveagent/adapters/userMessageContent";
import { getFileTypeIconSvg } from "@liveagent/ui/components/chat/fileTypeIcons";
import { SKILL_ICON_SVG_MARKUP } from "@liveagent/ui/components/IconSet";
import { normalizeLogicalLineEndings } from "@liveagent/ui/lib/chat/composerText";
import {
  type CodeMentionReference,
  codeMentionDisplayName,
  codeMentionLineLabel,
  createCodeMentionReference,
  createConversationMentionReference,
  createFileMentionReference,
  escapeMarkdownReferenceLabel,
  type FileMentionKind,
  fileMentionDisplayName,
  fileMentionTitle,
  formatCodeMentionToken,
  formatConversationMentionToken,
  formatFileMentionToken,
  formatMarkdownReferenceDestination,
} from "@liveagent/ui/lib/chat/mentionReferences";
import { mentionChipClassName } from "./mentionChipStyles";

export {
  hasLegacyImeKeyboardSignal,
  isActiveImeKeyboardEvent,
  isEnterKeyboardEvent,
  isImeKeyboardEvent,
} from "./MentionComposerInputUtils";

import {
  CARET_ANCHOR_TEXT,
  CODE_MENTION_END_ATTR,
  CODE_MENTION_PATH_ATTR,
  CODE_MENTION_START_ATTR,
  COMMIT_MENTION_AUTHOR_DATE_ATTR,
  COMMIT_MENTION_AUTHOR_EMAIL_ATTR,
  COMMIT_MENTION_AUTHOR_NAME_ATTR,
  COMMIT_MENTION_BODY_ATTR,
  COMMIT_MENTION_DELETIONS_ATTR,
  COMMIT_MENTION_FILE_COUNT_ATTR,
  COMMIT_MENTION_FILES_CHANGED_ATTR,
  COMMIT_MENTION_GITHUB_URL_ATTR,
  COMMIT_MENTION_INSERTIONS_ATTR,
  COMMIT_MENTION_REMOTE_NAME_ATTR,
  COMMIT_MENTION_REMOTE_URL_ATTR,
  COMMIT_MENTION_SHA_ATTR,
  COMMIT_MENTION_SHORT_SHA_ATTR,
  COMMIT_MENTION_STAT_ATTR,
  COMMIT_MENTION_SUBJECT_ATTR,
  COMPOSER_CLIPBOARD_HTML_ATTR,
  COMPOSER_CLIPBOARD_MIME,
  COMPOSER_CLIPBOARD_VERSION,
  COMPOSER_CONTEXT_MENU_HEIGHT,
  COMPOSER_CONTEXT_MENU_MARGIN,
  COMPOSER_CONTEXT_MENU_WIDTH,
  CONVERSATION_MENTION_CWD_ATTR,
  CONVERSATION_MENTION_ID_ATTR,
  CONVERSATION_MENTION_TITLE_ATTR,
  CONVERSATION_MENTION_UPDATED_AT_ATTR,
  type ComposerClipboardSnapshot,
  formatLargePasteCount,
  GIT_FILE_MENTION_COMMIT_SHA_ATTR,
  GIT_FILE_MENTION_GITHUB_URL_ATTR,
  GIT_FILE_MENTION_OLD_PATH_ATTR,
  GIT_FILE_MENTION_PATH_ATTR,
  GIT_FILE_MENTION_REF_NAME_ATTR,
  GIT_FILE_MENTION_REMOTE_NAME_ATTR,
  GIT_FILE_MENTION_REMOTE_URL_ATTR,
  GIT_FILE_MENTION_SHORT_SHA_ATTR,
  GIT_FILE_MENTION_STATUS_ATTR,
  GITHUB_ICON_SVG,
  LARGE_PASTE_CHAR_THRESHOLD,
  LARGE_PASTE_LINE_THRESHOLD,
  LARGE_PASTE_PREVIEW_CHARS,
  LARGE_PASTE_TAG_ATTR,
  MENTION_KIND_ATTR,
  MENTION_TAG_ATTR,
  type MentionComposerCommitMention,
  type MentionComposerConversationMention,
  type MentionComposerDraftSegment,
  type MentionComposerGitFileMention,
  type MentionComposerLargePaste,
  type MentionComposerSkill,
  type MentionComposerSkillMention,
  type MentionContext,
  SKILL_MENTION_BASE_DIR_ATTR,
  SKILL_MENTION_DESCRIPTION_ATTR,
  SKILL_MENTION_FILE_ATTR,
  SKILL_MENTION_NAME_ATTR,
} from "./MentionComposerModel";

export * from "./MentionComposerModel";
export { CommitMentionTooltip, Popup } from "./MentionComposerOverlays";

export { usesCustomComposerContextMenu };

/* ------------------------------------------------------------------ */
/*  DOM helpers                                                        */
/* ------------------------------------------------------------------ */

export function formatSkillMentionToken(skill: Pick<MentionComposerSkillMention, "name">) {
  return `/${skill.name}`;
}

export function formatCommitMentionToken(
  commit: Pick<MentionComposerCommitMention, "sha" | "shortSha" | "subject" | "githubUrl">,
) {
  const shortSha = commit.shortSha || commit.sha.slice(0, 7);
  const subject = commit.subject.trim() || shortSha;
  const label = `commit ${shortSha}: ${subject}`;
  if (commit.githubUrl?.trim()) {
    return `[${escapeMarkdownReferenceLabel(label)}](${formatMarkdownReferenceDestination(commit.githubUrl.trim())})`;
  }
  return `${label} (${commit.sha})`;
}

export function formatGitFileMentionToken(
  file: Pick<
    MentionComposerGitFileMention,
    "path" | "commitSha" | "shortSha" | "refName" | "githubUrl"
  >,
) {
  const refLabel = file.refName || file.shortSha || file.commitSha.slice(0, 7);
  const label = `git file ${refLabel}: ${file.path}`;
  if (file.githubUrl?.trim()) {
    return `[${escapeMarkdownReferenceLabel(label)}](${formatMarkdownReferenceDestination(file.githubUrl.trim())})`;
  }
  return `${label} (${file.commitSha})`;
}

export { formatConversationMentionToken };

export function removeCaretAnchors(value: string) {
  return value.split(CARET_ANCHOR_TEXT).join("");
}

export function countCaretAnchors(value: string) {
  return value.split(CARET_ANCHOR_TEXT).length - 1;
}

export function normalizeSerializedText(value: string) {
  return normalizeLogicalLineEndings(removeCaretAnchors(value).replace(/\u00A0/g, " "));
}

export function isMentionBoundaryChar(value: string) {
  return /\s/.test(value) || value === CARET_ANCHOR_TEXT;
}

/** Recursively serialise a contenteditable DOM tree back to plain text.
 *  Mention chips become Markdown file references. */
export function pushTextSegment(out: MentionComposerDraftSegment[], text: string) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last?.type === "text") {
    last.text += text;
    return;
  }
  out.push({ type: "text", text });
}

export function serializeChildrenToSegments(
  parent: Node,
  largePastes: Map<string, MentionComposerLargePaste>,
): MentionComposerDraftSegment[] {
  return injectMentionBoundarySpaces(collectDraftSegments(parent, largePastes));
}

/** A chip's visual gap is CSS margin with no character behind it; re-insert
 *  the word boundary at serialization time so a token never glues onto the
 *  content on either side of it. */
export function injectMentionBoundarySpaces(
  segments: MentionComposerDraftSegment[],
): MentionComposerDraftSegment[] {
  const out: MentionComposerDraftSegment[] = [];
  for (const segment of segments) {
    const prev = out[out.length - 1];
    if (prev != null && prev.type !== "text") {
      if (segment.type !== "text" || !/^\s/.test(segment.text)) {
        pushTextSegment(out, " ");
      }
    } else if (prev?.type === "text" && segment.type !== "text" && !/\s$/.test(prev.text)) {
      prev.text += " ";
    }
    if (segment.type === "text") {
      pushTextSegment(out, segment.text);
    } else {
      out.push(segment);
    }
  }
  return out;
}

export function collectDraftSegments(
  parent: Node,
  largePastes: Map<string, MentionComposerLargePaste>,
): MentionComposerDraftSegment[] {
  const parts: MentionComposerDraftSegment[] = [];
  let hasLogicalChild = false;
  let previousChildWasBlock = false;
  parent.childNodes.forEach((child) => {
    const childParts: MentionComposerDraftSegment[] = [];
    let childIsBlock = false;
    let childIsLogical = false;
    if (child.nodeType === Node.TEXT_NODE) {
      const text = removeCaretAnchors(child.textContent || "");
      pushTextSegment(childParts, text);
      childIsLogical = text.length > 0;
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as HTMLElement;
      const mentionPath = el.getAttribute(MENTION_TAG_ATTR);
      if (mentionPath) {
        const kind = el.getAttribute(MENTION_KIND_ATTR) === "dir" ? "dir" : "file";
        const reference = createFileMentionReference(mentionPath, kind);
        if (reference) {
          childParts.push({ type: "fileMention", reference });
          childIsLogical = true;
        }
      } else if (el.hasAttribute(CONVERSATION_MENTION_ID_ATTR)) {
        const conversation = conversationMentionFromElement(el);
        if (conversation) {
          childParts.push({ type: "conversationMention", conversation });
          childIsLogical = true;
        }
      } else if (el.hasAttribute(GIT_FILE_MENTION_PATH_ATTR)) {
        const file = gitFileMentionFromElement(el);
        if (file) {
          childParts.push({ type: "gitFileMention", file });
          childIsLogical = true;
        }
      } else if (el.hasAttribute(CODE_MENTION_PATH_ATTR)) {
        const reference = codeMentionFromElement(el);
        if (reference) {
          childParts.push({ type: "codeMention", reference });
          childIsLogical = true;
        }
      } else if (el.hasAttribute(COMMIT_MENTION_SHA_ATTR)) {
        const commit = commitMentionFromElement(el);
        if (commit) {
          childParts.push({ type: "commitMention", commit });
          childIsLogical = true;
        }
      } else if (el.hasAttribute(SKILL_MENTION_NAME_ATTR)) {
        const name = el.getAttribute(SKILL_MENTION_NAME_ATTR)?.trim() ?? "";
        const skillFile = el.getAttribute(SKILL_MENTION_FILE_ATTR)?.trim() ?? "";
        const baseDir = el.getAttribute(SKILL_MENTION_BASE_DIR_ATTR)?.trim() ?? "";
        if (name && skillFile && baseDir) {
          childParts.push({
            type: "skillMention",
            skill: {
              name,
              skillFile,
              baseDir,
              description: el.getAttribute(SKILL_MENTION_DESCRIPTION_ATTR)?.trim() ?? "",
            },
          });
          childIsLogical = true;
        }
      } else {
        const largePasteId = el.getAttribute(LARGE_PASTE_TAG_ATTR);
        const largePaste = largePasteId ? largePastes.get(largePasteId) : undefined;
        if (largePaste) {
          childParts.push({ type: "largePaste", paste: largePaste });
          childIsLogical = true;
        } else if (el.tagName === "BR") {
          const parentEl = parent.nodeType === Node.ELEMENT_NODE ? (parent as HTMLElement) : null;
          const isEmptyBlockPlaceholder =
            parentEl != null &&
            (parentEl.tagName === "DIV" || parentEl.tagName === "P") &&
            parent.childNodes.length === 1;
          if (!isEmptyBlockPlaceholder) {
            pushTextSegment(childParts, "\n");
            childIsLogical = true;
          }
        } else {
          childIsBlock = el.tagName === "DIV" || el.tagName === "P";
          for (const segment of collectDraftSegments(el, largePastes)) {
            if (segment.type === "text") {
              pushTextSegment(childParts, segment.text);
            } else {
              childParts.push(segment);
            }
          }
          childIsLogical = childIsBlock || childParts.length > 0;
        }
      }
    }

    if (!childIsLogical) return;
    if (hasLogicalChild && (previousChildWasBlock || childIsBlock)) {
      pushTextSegment(parts, "\n");
    }
    for (const segment of childParts) {
      if (segment.type === "text") pushTextSegment(parts, segment.text);
      else parts.push(segment);
    }
    hasLogicalChild = true;
    previousChildWasBlock = childIsBlock;
  });
  return parts;
}

export function serializeChildren(
  parent: Node,
  largePastes: Map<string, MentionComposerLargePaste>,
): string {
  return serializeDraftSegments(serializeChildrenToSegments(parent, largePastes));
}

export function serializeDraftSegments(segments: MentionComposerDraftSegment[]) {
  return segments
    .map((segment) => {
      if (segment.type === "fileMention") return formatFileMentionToken(segment.reference);
      if (segment.type === "largePaste") return segment.paste.text;
      if (segment.type === "skillMention") return formatSkillMentionToken(segment.skill);
      if (segment.type === "commitMention") return formatCommitMentionToken(segment.commit);
      if (segment.type === "gitFileMention") return formatGitFileMentionToken(segment.file);
      if (segment.type === "conversationMention") {
        return formatConversationMentionToken(segment.conversation);
      }
      if (segment.type === "codeMention") return formatCodeMentionToken(segment.reference);
      return segment.text;
    })
    .join("");
}

export function editorTextIsEmpty(editor: HTMLElement) {
  const raw = normalizeSerializedText(editor.textContent || "");
  return raw.trim().length === 0;
}

/** Unlike editorTextIsEmpty, this doesn't trim — a leading/trailing space
 *  still counts as content so the placeholder hides as soon as the user types.
 *  Zero-width caret anchors are artifacts, not content, and are ignored. */
export function editorHasNoContent(editor: HTMLElement) {
  return removeCaretAnchors(editor.textContent || "").length === 0;
}

export function editorRangeIsInsideRoot(root: HTMLElement, range: Range) {
  const commonAncestor = range.commonAncestorContainer;
  return commonAncestor === root || root.contains(commonAncestor);
}

export function editorSelectionRange(root: HTMLElement) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  return editorRangeIsInsideRoot(root, range) ? range : null;
}

export function serializeComposerClipboardPayload(segments: MentionComposerDraftSegment[]) {
  return JSON.stringify({ version: COMPOSER_CLIPBOARD_VERSION, segments });
}

export function resolveComposerSelection(
  root: HTMLElement | null,
  largePastes: Map<string, MentionComposerLargePaste>,
): ComposerClipboardSnapshot | null {
  if (!root) return null;

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  if (!editorRangeIsInsideRoot(root, range)) {
    return null;
  }

  const fragment = range.cloneContents();
  const segments = serializeChildrenToSegments(fragment, largePastes);
  const payload = serializeComposerClipboardPayload(segments);
  const htmlWrapper = document.createElement("div");
  htmlWrapper.setAttribute(COMPOSER_CLIPBOARD_HTML_ATTR, payload);
  htmlWrapper.appendChild(fragment);
  return {
    text: normalizeSerializedText(serializeDraftSegments(segments)),
    html: htmlWrapper.outerHTML,
    payload,
  };
}

export function resolveComposerSelectionText(
  root: HTMLElement | null,
  largePastes: Map<string, MentionComposerLargePaste>,
) {
  return resolveComposerSelection(root, largePastes)?.text ?? "";
}

export function selectionContainsPoint(
  root: HTMLElement,
  selection: Selection | null,
  x: number,
  y: number,
) {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;

  const range = selection.getRangeAt(0);
  if (!editorRangeIsInsideRoot(root, range)) return false;

  for (const rect of Array.from(range.getClientRects())) {
    if (x >= rect.left - 2 && x <= rect.right + 2 && y >= rect.top - 2 && y <= rect.bottom + 2) {
      return true;
    }
  }

  return false;
}

export function createCaretRangeFromPoint(x: number, y: number) {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };

  const position = doc.caretPositionFromPoint?.(x, y);
  if (position) {
    const range = document.createRange();
    range.setStart(position.offsetNode, position.offset);
    range.collapse(true);
    return range;
  }

  return doc.caretRangeFromPoint?.(x, y) ?? null;
}

export function closestComposerChipFromNode(root: HTMLElement, node: Node | null) {
  let current: Node | null =
    node?.nodeType === Node.ELEMENT_NODE ? node : (node?.parentNode ?? null);

  while (current && current !== root) {
    if (isComposerChipElement(current)) {
      return current;
    }
    current = current.parentNode;
  }

  return null;
}

export function placeComposerCaretFromPoint(root: HTMLElement, x: number, y: number) {
  const range = createCaretRangeFromPoint(x, y);
  if (!range || !editorRangeIsInsideRoot(root, range)) return false;

  const chip = closestComposerChipFromNode(root, range.startContainer);
  if (chip) {
    const anchor = ensureCaretAnchorAfterChip(chip);
    if (!anchor) return false;
    placeCaretInTextNode(anchor.textNode, anchor.offset);
    return true;
  }

  const selection = window.getSelection();
  if (!selection) return false;

  selection.removeAllRanges();
  selection.addRange(range);
  normalizeCaretAfterChip(root);
  return true;
}

export function selectComposerContents(root: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(root);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function clampComposerContextMenuPosition(x: number, y: number) {
  const maxLeft = Math.max(
    COMPOSER_CONTEXT_MENU_MARGIN,
    window.innerWidth - COMPOSER_CONTEXT_MENU_WIDTH - COMPOSER_CONTEXT_MENU_MARGIN,
  );
  const maxTop = Math.max(
    COMPOSER_CONTEXT_MENU_MARGIN,
    window.innerHeight - COMPOSER_CONTEXT_MENU_HEIGHT - COMPOSER_CONTEXT_MENU_MARGIN,
  );

  return {
    left: Math.min(Math.max(COMPOSER_CONTEXT_MENU_MARGIN, x), maxLeft),
    top: Math.min(Math.max(COMPOSER_CONTEXT_MENU_MARGIN, y), maxTop),
  };
}

export function normalizeMentionQuery(query: string) {
  return removeCaretAnchors(query).trim().replace(/\\/g, "/").toLowerCase();
}

export type MentionFetchSnapshot = {
  trigger: MentionContext["trigger"];
  query: string;
  truncated: boolean;
};

// A cached snapshot answers narrower queries client-side only when the backend
// returned every match for the query it was fetched with. A truncated snapshot
// can be missing matches for any other query, so extending the query must go
// back to the backend instead of narrowing locally.
export function mentionSnapshotCoversQuery(
  fetched: MentionFetchSnapshot | null,
  trigger: MentionContext["trigger"],
  normalizedQuery: string,
): boolean {
  if (!fetched) return true;
  if (fetched.trigger !== trigger) return false;
  if (!normalizedQuery.startsWith(fetched.query)) return false;
  if (!fetched.truncated) return true;
  return normalizedQuery === fetched.query;
}

export function normalizeLargePastePreview(text: string) {
  return text.trim().replace(/\s+/g, " ").slice(0, LARGE_PASTE_PREVIEW_CHARS);
}

export function countLargePasteLines(text: string) {
  if (!text) return 0;
  return text.split(/\r\n|\r|\n/).length;
}

export function isLargePasteText(text: string) {
  if (text.length >= LARGE_PASTE_CHAR_THRESHOLD) return true;
  return countLargePasteLines(text) >= LARGE_PASTE_LINE_THRESHOLD;
}

export function clipboardFileExtension(mimeType: string) {
  switch (mimeType.trim().toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/bmp":
      return "bmp";
    case "image/tiff":
      return "tiff";
    case "application/pdf":
      return "pdf";
    case "text/plain":
      return "txt";
    case "text/markdown":
      return "md";
    case "application/json":
      return "json";
    default:
      return "bin";
  }
}

export function normalizeClipboardFile(file: File, index: number) {
  if (file.name.trim()) {
    return file;
  }
  const extension = clipboardFileExtension(file.type);
  const fallbackName = `clipboard-file-${index + 1}.${extension}`;
  return new File([file], fallbackName, {
    type: file.type || "application/octet-stream",
    lastModified: file.lastModified || Date.now(),
  });
}

export function extractClipboardFiles(data: DataTransfer) {
  const files: File[] = [];
  const seen = new Set<string>();

  const addFile = (file: File | null) => {
    if (!file) return;
    const key = [
      file.name.trim() || "__clipboard_file__",
      file.type,
      file.size,
      file.lastModified,
    ].join("\u0000");
    if (seen.has(key)) return;
    seen.add(key);
    const normalized = normalizeClipboardFile(file, files.length);
    files.push(normalized);
  };

  const clipboardFiles = Array.from(data.files ?? []);
  if (clipboardFiles.length > 0) {
    for (const file of clipboardFiles) {
      addFile(file);
    }
    return files;
  }

  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    addFile(item.getAsFile());
  }

  return files;
}

export function writeTextToClipboard(text: string) {
  if (!text) return;

  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => {
      fallbackWriteTextToClipboard(text);
    });
    return;
  }

  fallbackWriteTextToClipboard(text);
}

export function fallbackWriteTextToClipboard(text: string) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

export function parseCommitMentionNumber(value: string | null) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeCommitMention(
  commit: MentionComposerCommitMention,
): MentionComposerCommitMention {
  const sha = commit.sha.trim();
  const shortSha = (commit.shortSha || sha.slice(0, 7)).trim();
  return {
    sha,
    shortSha,
    subject: commit.subject ?? "",
    body: commit.body ?? "",
    authorName: commit.authorName ?? "",
    authorEmail: commit.authorEmail ?? "",
    authorDate: commit.authorDate ?? "",
    fileCount: Number.isFinite(commit.fileCount) ? commit.fileCount : 0,
    filesChanged: Number.isFinite(commit.filesChanged) ? commit.filesChanged : 0,
    insertions: Number.isFinite(commit.insertions) ? commit.insertions : 0,
    deletions: Number.isFinite(commit.deletions) ? commit.deletions : 0,
    stat: commit.stat ?? "",
    remoteName: commit.remoteName ?? "",
    remoteUrl: commit.remoteUrl ?? "",
    githubUrl: commit.githubUrl?.trim() || undefined,
  };
}

export function commitMentionFromElement(el: HTMLElement): MentionComposerCommitMention | null {
  const sha = el.getAttribute(COMMIT_MENTION_SHA_ATTR)?.trim() ?? "";
  if (!sha) return null;
  return normalizeCommitMention({
    sha,
    shortSha: el.getAttribute(COMMIT_MENTION_SHORT_SHA_ATTR)?.trim() ?? sha.slice(0, 7),
    subject: el.getAttribute(COMMIT_MENTION_SUBJECT_ATTR) ?? "",
    body: el.getAttribute(COMMIT_MENTION_BODY_ATTR) ?? "",
    authorName: el.getAttribute(COMMIT_MENTION_AUTHOR_NAME_ATTR) ?? "",
    authorEmail: el.getAttribute(COMMIT_MENTION_AUTHOR_EMAIL_ATTR) ?? "",
    authorDate: el.getAttribute(COMMIT_MENTION_AUTHOR_DATE_ATTR) ?? "",
    fileCount: parseCommitMentionNumber(el.getAttribute(COMMIT_MENTION_FILE_COUNT_ATTR)),
    filesChanged: parseCommitMentionNumber(el.getAttribute(COMMIT_MENTION_FILES_CHANGED_ATTR)),
    insertions: parseCommitMentionNumber(el.getAttribute(COMMIT_MENTION_INSERTIONS_ATTR)),
    deletions: parseCommitMentionNumber(el.getAttribute(COMMIT_MENTION_DELETIONS_ATTR)),
    stat: el.getAttribute(COMMIT_MENTION_STAT_ATTR) ?? "",
    remoteName: el.getAttribute(COMMIT_MENTION_REMOTE_NAME_ATTR) ?? "",
    remoteUrl: el.getAttribute(COMMIT_MENTION_REMOTE_URL_ATTR) ?? "",
    githubUrl: el.getAttribute(COMMIT_MENTION_GITHUB_URL_ATTR)?.trim() || undefined,
  });
}

export function normalizeGitFileMention(
  file: MentionComposerGitFileMention,
): MentionComposerGitFileMention {
  const path = file.path.trim().replace(/\\/g, "/");
  const commitSha = file.commitSha.trim();
  const shortSha = (file.shortSha || commitSha.slice(0, 7)).trim();
  return {
    path,
    oldPath: file.oldPath?.trim() || undefined,
    status: file.status ?? "",
    commitSha,
    shortSha,
    refName: file.refName?.trim() || shortSha,
    remoteName: file.remoteName ?? "",
    remoteUrl: file.remoteUrl ?? "",
    githubUrl: file.githubUrl?.trim() || undefined,
  };
}

export function gitFileMentionFromElement(el: HTMLElement): MentionComposerGitFileMention | null {
  const path = el.getAttribute(GIT_FILE_MENTION_PATH_ATTR)?.trim() ?? "";
  const commitSha = el.getAttribute(GIT_FILE_MENTION_COMMIT_SHA_ATTR)?.trim() ?? "";
  if (!path || !commitSha) return null;
  return normalizeGitFileMention({
    path,
    oldPath: el.getAttribute(GIT_FILE_MENTION_OLD_PATH_ATTR)?.trim() || undefined,
    status: el.getAttribute(GIT_FILE_MENTION_STATUS_ATTR) ?? "",
    commitSha,
    shortSha: el.getAttribute(GIT_FILE_MENTION_SHORT_SHA_ATTR)?.trim() ?? commitSha.slice(0, 7),
    refName: el.getAttribute(GIT_FILE_MENTION_REF_NAME_ATTR)?.trim() ?? "",
    remoteName: el.getAttribute(GIT_FILE_MENTION_REMOTE_NAME_ATTR) ?? "",
    remoteUrl: el.getAttribute(GIT_FILE_MENTION_REMOTE_URL_ATTR) ?? "",
    githubUrl: el.getAttribute(GIT_FILE_MENTION_GITHUB_URL_ATTR)?.trim() || undefined,
  });
}

export function conversationMentionFromElement(
  el: HTMLElement,
): MentionComposerConversationMention | null {
  return createConversationMentionReference({
    id: el.getAttribute(CONVERSATION_MENTION_ID_ATTR) ?? "",
    title: el.getAttribute(CONVERSATION_MENTION_TITLE_ATTR) ?? "",
    cwd: el.getAttribute(CONVERSATION_MENTION_CWD_ATTR)?.trim() || undefined,
    updatedAt: Number(el.getAttribute(CONVERSATION_MENTION_UPDATED_AT_ATTR) ?? "") || undefined,
  });
}

export function codeMentionFromElement(el: HTMLElement): CodeMentionReference | null {
  const path = el.getAttribute(CODE_MENTION_PATH_ATTR)?.trim() ?? "";
  if (!path) return null;
  return createCodeMentionReference({
    path,
    startLine: Number(el.getAttribute(CODE_MENTION_START_ATTR) ?? "1"),
    endLine: Number(el.getAttribute(CODE_MENTION_END_ATTR) ?? "1"),
  });
}

export function clipboardRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function clipboardString(record: Record<string, unknown>, key: string, fallback = "") {
  const value = record[key];
  return typeof value === "string" ? value : fallback;
}

export function clipboardNumber(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function normalizeClipboardSkill(
  rawSkill: Record<string, unknown>,
  enabledSkills: readonly MentionComposerSkill[],
): MentionComposerDraftSegment | null {
  const name = clipboardString(rawSkill, "name").trim();
  const skillFile = clipboardString(rawSkill, "skillFile").trim().replace(/\\/g, "/");
  const baseDir = clipboardString(rawSkill, "baseDir").trim().replace(/\\/g, "/");
  if (!name || !skillFile || !baseDir) return null;

  const enabledSkill = enabledSkills.find(
    (candidate) =>
      candidate.name === name &&
      candidate.skillFile.trim().replace(/\\/g, "/") === skillFile &&
      candidate.baseDir.trim().replace(/\\/g, "/") === baseDir,
  );
  if (!enabledSkill) {
    return { type: "text", text: `/${name}` };
  }
  return { type: "skillMention", skill: enabledSkill };
}

export function normalizeClipboardCommit(
  rawCommit: Record<string, unknown>,
): MentionComposerCommitMention | null {
  const sha = clipboardString(rawCommit, "sha").trim();
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) return null;
  // Clipboard payloads are untrusted — the text/html fallback channel reads
  // the payload attribute out of any copied page — and githubUrl feeds the
  // chip's open-on-GitHub action, so it must pass the same GitHub URL
  // validation as the plain-text token channel or drop to a link-less chip.
  const githubUrl = clipboardString(rawCommit, "githubUrl").trim();
  return normalizeCommitMention({
    sha,
    shortSha: clipboardString(rawCommit, "shortSha", sha.slice(0, 7)),
    subject: clipboardString(rawCommit, "subject"),
    body: clipboardString(rawCommit, "body"),
    authorName: clipboardString(rawCommit, "authorName"),
    authorEmail: clipboardString(rawCommit, "authorEmail"),
    authorDate: clipboardString(rawCommit, "authorDate"),
    fileCount: clipboardNumber(rawCommit, "fileCount"),
    filesChanged: clipboardNumber(rawCommit, "filesChanged"),
    insertions: clipboardNumber(rawCommit, "insertions"),
    deletions: clipboardNumber(rawCommit, "deletions"),
    stat: clipboardString(rawCommit, "stat"),
    remoteName: clipboardString(rawCommit, "remoteName"),
    remoteUrl: clipboardString(rawCommit, "remoteUrl"),
    githubUrl: extractGitHubCommitSha(githubUrl) ? githubUrl : undefined,
  });
}

export function normalizeClipboardGitFile(
  rawFile: Record<string, unknown>,
): MentionComposerGitFileMention | null {
  const path = clipboardString(rawFile, "path").trim().replace(/\\/g, "/");
  const commitSha = clipboardString(rawFile, "commitSha").trim();
  if (!createFileMentionReference(path, "file") || !commitSha) return null;
  // Same trust boundary as normalizeClipboardCommit: only a real GitHub blob
  // URL may reach the chip's open action.
  const githubUrl = clipboardString(rawFile, "githubUrl").trim();
  return normalizeGitFileMention({
    path,
    oldPath: clipboardString(rawFile, "oldPath") || undefined,
    status: clipboardString(rawFile, "status"),
    commitSha,
    shortSha: clipboardString(rawFile, "shortSha", commitSha.slice(0, 7)),
    refName: clipboardString(rawFile, "refName"),
    remoteName: clipboardString(rawFile, "remoteName"),
    remoteUrl: clipboardString(rawFile, "remoteUrl"),
    githubUrl: extractGitHubFileReference(githubUrl) ? githubUrl : undefined,
  });
}

export function normalizeComposerClipboardSegment(
  rawSegment: unknown,
  enabledSkills: readonly MentionComposerSkill[],
): MentionComposerDraftSegment | null {
  const segment = clipboardRecord(rawSegment);
  if (!segment) return null;
  const type = clipboardString(segment, "type");

  if (type === "text") {
    return { type, text: normalizeLogicalLineEndings(clipboardString(segment, "text")) };
  }
  if (type === "fileMention") {
    const rawReference = clipboardRecord(segment.reference);
    if (!rawReference) return null;
    const kind = clipboardString(rawReference, "kind") === "dir" ? "dir" : "file";
    const reference = createFileMentionReference(clipboardString(rawReference, "path"), kind);
    return reference ? { type, reference } : null;
  }
  if (type === "largePaste") {
    const rawPaste = clipboardRecord(segment.paste);
    if (!rawPaste) return null;
    const id = clipboardString(rawPaste, "id").trim();
    const label = clipboardString(rawPaste, "label").trim();
    const text = normalizeLogicalLineEndings(clipboardString(rawPaste, "text"));
    if (!id || !label || !text) return null;
    return {
      type,
      paste: {
        id,
        label,
        text,
        charCount: text.length,
        lineCount: countLargePasteLines(text),
        preview: normalizeLargePastePreview(text),
      },
    };
  }
  if (type === "skillMention") {
    const rawSkill = clipboardRecord(segment.skill);
    return rawSkill ? normalizeClipboardSkill(rawSkill, enabledSkills) : null;
  }
  if (type === "commitMention") {
    const rawCommit = clipboardRecord(segment.commit);
    const commit = rawCommit ? normalizeClipboardCommit(rawCommit) : null;
    return commit ? { type, commit } : null;
  }
  if (type === "gitFileMention") {
    const rawFile = clipboardRecord(segment.file);
    const file = rawFile ? normalizeClipboardGitFile(rawFile) : null;
    return file ? { type, file } : null;
  }
  if (type === "conversationMention") {
    const rawConversation = clipboardRecord(segment.conversation);
    if (!rawConversation) return null;
    const conversation = createConversationMentionReference({
      id: clipboardString(rawConversation, "id"),
      title: clipboardString(rawConversation, "title"),
      cwd: clipboardString(rawConversation, "cwd") || undefined,
      updatedAt: clipboardNumber(rawConversation, "updatedAt") || undefined,
    });
    return conversation ? { type, conversation } : null;
  }
  if (type === "codeMention") {
    const rawReference = clipboardRecord(segment.reference);
    if (!rawReference) return null;
    const reference = createCodeMentionReference({
      path: clipboardString(rawReference, "path"),
      startLine: clipboardNumber(rawReference, "startLine"),
      endLine: clipboardNumber(rawReference, "endLine"),
    });
    return reference ? { type, reference } : null;
  }
  return null;
}

export function parseComposerClipboardPayload(
  rawPayload: string,
  enabledSkills: readonly MentionComposerSkill[] = [],
): MentionComposerDraftSegment[] | null {
  if (!rawPayload) return null;
  try {
    const payload = clipboardRecord(JSON.parse(rawPayload));
    if (!payload || payload.version !== COMPOSER_CLIPBOARD_VERSION) return null;
    if (!Array.isArray(payload.segments) || payload.segments.length > 10_000) return null;
    const segments: MentionComposerDraftSegment[] = [];
    for (const rawSegment of payload.segments) {
      const segment = normalizeComposerClipboardSegment(rawSegment, enabledSkills);
      if (!segment) return null;
      if (segment.type !== "text" || segment.text) {
        segments.push(segment);
      }
    }
    return segments.length > 0 ? segments : null;
  } catch {
    return null;
  }
}

// Restored segments must obey the same large-paste threshold as direct input:
// text over the limit collapses into a chip, and carried-over largePaste
// segments are rebuilt with fresh ids so they cannot collide in the map.
export function rebuildClipboardSegmentsForPaste(
  segments: MentionComposerDraftSegment[],
  createLargePaste: (text: string) => MentionComposerLargePaste,
): MentionComposerDraftSegment[] {
  return segments.map((segment) => {
    if (segment.type === "largePaste") {
      return { type: "largePaste" as const, paste: createLargePaste(segment.paste.text) };
    }
    if (segment.type === "text" && isLargePasteText(segment.text)) {
      return { type: "largePaste" as const, paste: createLargePaste(segment.text) };
    }
    return segment;
  });
}

export function parseSerializedComposerText(
  value: string,
  enabledSkills: readonly MentionComposerSkill[] = [],
): MentionComposerDraftSegment[] | null {
  const segments: MentionComposerDraftSegment[] = [];
  let matched = false;
  for (const segment of tokenizeUserMessage(normalizeLogicalLineEndings(value), [])) {
    if (segment.type === "text") {
      pushTextSegment(segments, segment.value);
    } else if (segment.type === "mention") {
      segments.push({ type: "fileMention", reference: segment.reference });
      matched = true;
    } else if (segment.type === "skill") {
      const enabledSkill = enabledSkills.find((skill) => skill.name === segment.name);
      if (enabledSkill) {
        segments.push({ type: "skillMention", skill: enabledSkill });
        matched = true;
      } else {
        pushTextSegment(segments, `/${segment.name}`);
      }
    } else if (segment.type === "commit") {
      segments.push({
        type: "commitMention",
        commit: normalizeCommitMention({
          body: "",
          authorName: "",
          authorEmail: "",
          authorDate: "",
          fileCount: 0,
          filesChanged: 0,
          insertions: 0,
          deletions: 0,
          stat: "",
          remoteName: "",
          remoteUrl: "",
          ...segment.commit,
        }),
      });
      matched = true;
    } else if (segment.type === "gitFile") {
      segments.push({
        type: "gitFileMention",
        file: normalizeGitFileMention({
          status: "",
          remoteName: "",
          remoteUrl: "",
          ...segment.file,
        }),
      });
      matched = true;
    } else if (segment.type === "conversation") {
      segments.push({ type: "conversationMention", conversation: segment.reference });
      matched = true;
    } else if (segment.type === "codeRef") {
      segments.push({ type: "codeMention", reference: segment.reference });
      matched = true;
    }
  }
  return matched ? segments : null;
}

export function readComposerClipboardSegments(
  data: DataTransfer,
  enabledSkills: readonly MentionComposerSkill[],
) {
  const privatePayload = data.getData(COMPOSER_CLIPBOARD_MIME);
  const privateSegments = parseComposerClipboardPayload(privatePayload, enabledSkills);
  if (privateSegments) return privateSegments;

  const html = data.getData("text/html");
  if (!html) return null;
  const wrapper = new DOMParser()
    .parseFromString(html, "text/html")
    .querySelector<HTMLElement>(`[${COMPOSER_CLIPBOARD_HTML_ATTR}]`);
  return parseComposerClipboardPayload(
    wrapper?.getAttribute(COMPOSER_CLIPBOARD_HTML_ATTR) ?? "",
    enabledSkills,
  );
}

export function writeComposerClipboardSnapshot(
  data: DataTransfer,
  snapshot: ComposerClipboardSnapshot,
) {
  data.clearData();
  data.setData("text/plain", snapshot.text);
  data.setData("text/html", snapshot.html);
  try {
    data.setData(COMPOSER_CLIPBOARD_MIME, snapshot.payload);
  } catch {}
}

export function createMentionIcon(svgMarkup: string) {
  const template = document.createElement("template");
  template.innerHTML = svgMarkup.trim();
  const parsed = template.content.firstElementChild;
  const icon =
    parsed instanceof SVGElement && parsed.tagName.toLowerCase() === "svg"
      ? (parsed.cloneNode(true) as SVGSVGElement)
      : document.createElementNS("http://www.w3.org/2000/svg", "svg");

  icon.setAttribute("width", "12");
  icon.setAttribute("height", "12");
  icon.style.flexShrink = "0";
  icon.style.alignSelf = "center";
  return icon;
}

export function createFileTypeMentionIcon(path: string, kind: FileMentionKind) {
  return createMentionIcon(getFileTypeIconSvg(path, kind));
}

export function createGitHubMentionIcon() {
  return createMentionIcon(GITHUB_ICON_SVG);
}

export function createSkillMentionIcon() {
  return createMentionIcon(SKILL_ICON_SVG_MARKUP);
}

const CONVERSATION_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/><path d="M8 8h8M8 12h5"/></svg>';

export function createConversationMentionIcon() {
  return createMentionIcon(CONVERSATION_ICON_SVG);
}

export function isComposerChipElement(node: Node | null): node is HTMLElement {
  return (
    node instanceof HTMLElement &&
    (node.hasAttribute(MENTION_TAG_ATTR) ||
      node.hasAttribute(SKILL_MENTION_NAME_ATTR) ||
      node.hasAttribute(COMMIT_MENTION_SHA_ATTR) ||
      node.hasAttribute(CONVERSATION_MENTION_ID_ATTR) ||
      node.hasAttribute(GIT_FILE_MENTION_PATH_ATTR) ||
      node.hasAttribute(CODE_MENTION_PATH_ATTR) ||
      node.hasAttribute(LARGE_PASTE_TAG_ATTR))
  );
}

/** The caret's rest position in the text right after a chip: at the end of an
 *  existing leading-whitespace run (the run and the chip form one atomic unit
 *  for caret purposes), otherwise after a zero-width anchor. The visual gap
 *  after a chip is pure CSS margin — never a spacer character; serialization
 *  re-adds the word boundary (injectMentionBoundarySpaces). */
export function createCaretAnchorText(afterRaw: string) {
  const cleaned = removeCaretAnchors(afterRaw);
  const matchedWhitespace = cleaned.match(/^\s+/)?.[0] ?? "";
  if (matchedWhitespace.length > 0) {
    return { text: cleaned, caretOffset: matchedWhitespace.length };
  }
  return {
    text: `${CARET_ANCHOR_TEXT}${cleaned}`,
    caretOffset: CARET_ANCHOR_TEXT.length,
  };
}

export function placeCaretInTextNode(textNode: Text, offset: number) {
  const range = document.createRange();
  range.setStart(textNode, Math.min(offset, textNode.data.length));
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

export function removeStaleCaretAnchorsFromTextNode(textNode: Text, offset: number) {
  if (!textNode.data.includes(CARET_ANCHOR_TEXT)) return false;

  const cleaned = removeCaretAnchors(textNode.data);
  if (cleaned.length === 0) return false;

  const nextOffset = Math.max(0, offset - countCaretAnchors(textNode.data.slice(0, offset)));
  textNode.data = cleaned;
  placeCaretInTextNode(textNode, Math.min(nextOffset, cleaned.length));
  return true;
}

export function removeStaleCaretAnchorsAroundSelection(root: HTMLElement) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;

  const { startContainer: node, startOffset: offset } = sel.getRangeAt(0);
  if (!root.contains(node) || node.nodeType !== Node.TEXT_NODE) return false;
  if (isComposerChipElement(node.parentNode)) return false;

  return removeStaleCaretAnchorsFromTextNode(node as Text, offset);
}

export function ensureCaretAnchorAfterChip(
  chip: HTMLElement,
): { textNode: Text; offset: number } | null {
  const parent = chip.parentNode;
  if (!parent) return null;

  const next = chip.nextSibling;
  if (next?.nodeType === Node.TEXT_NODE) {
    const textNode = next as Text;
    const anchor = createCaretAnchorText(textNode.data);
    if (textNode.data !== anchor.text) {
      textNode.data = anchor.text;
    }
    return { textNode, offset: anchor.caretOffset };
  }

  const anchor = createCaretAnchorText("");
  const textNode = document.createTextNode(anchor.text);
  parent.insertBefore(textNode, next);
  return { textNode, offset: anchor.caretOffset };
}

/** A text position right before the chip. Without a preceding text node the
 *  caret would sit on a bare element offset, which browsers render at the
 *  chip's inner edge — so create a zero-width anchor to host it instead. */
export function ensureCaretAnchorBeforeChip(
  chip: HTMLElement,
): { textNode: Text; offset: number } | null {
  const parent = chip.parentNode;
  if (!parent) return null;

  const prev = chip.previousSibling;
  if (prev?.nodeType === Node.TEXT_NODE) {
    const textNode = prev as Text;
    // An empty text node has no text box to carry the caret; seed it.
    if (textNode.data.length === 0) {
      textNode.data = CARET_ANCHOR_TEXT;
    }
    return { textNode, offset: textNode.data.length };
  }

  const textNode = document.createTextNode(CARET_ANCHOR_TEXT);
  parent.insertBefore(textNode, chip);
  return { textNode, offset: textNode.data.length };
}

export function normalizeCaretAfterChip(root: HTMLElement) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;

  const range = sel.getRangeAt(0);
  const { startContainer: node, startOffset: offset } = range;
  if (!root.contains(node)) return false;

  if (node.nodeType === Node.TEXT_NODE) {
    const textNode = node as Text;
    const before = textNode.data.slice(0, offset);
    if (caretSpacerTextIsEmpty(before) && isComposerChipElement(textNode.previousSibling)) {
      const anchor = ensureCaretAnchorAfterChip(textNode.previousSibling);
      if (!anchor) return false;
      if (anchor.textNode !== textNode || anchor.offset !== offset) {
        placeCaretInTextNode(anchor.textNode, anchor.offset);
      }
      return true;
    }
    return false;
  }

  if (node.nodeType === Node.ELEMENT_NODE) {
    const childBefore = node.childNodes[offset - 1] ?? null;
    if (isComposerChipElement(childBefore)) {
      const anchor = ensureCaretAnchorAfterChip(childBefore);
      if (!anchor) return false;
      placeCaretInTextNode(anchor.textNode, anchor.offset);
      return true;
    }
    // An element-position caret right before a chip renders at the chip's
    // inner edge; move it into a real text position before the chip.
    const childAfter = node.childNodes[offset] ?? null;
    if (isComposerChipElement(childAfter)) {
      const anchor = ensureCaretAnchorBeforeChip(childAfter);
      if (!anchor) return false;
      placeCaretInTextNode(anchor.textNode, anchor.offset);
      return true;
    }
  }

  return false;
}

export function ensureTrailingCaretAnchor(root: HTMLElement) {
  const last = root.lastChild;
  if (isComposerChipElement(last)) {
    ensureCaretAnchorAfterChip(last);
  }
}

export function pruneLargePastesInRange(
  range: Range,
  largePastes: Map<string, MentionComposerLargePaste>,
) {
  range
    .cloneContents()
    .querySelectorAll<HTMLElement>(`[${LARGE_PASTE_TAG_ATTR}]`)
    .forEach((chip) => {
      const largePasteId = chip.getAttribute(LARGE_PASTE_TAG_ATTR);
      if (largePasteId) largePastes.delete(largePasteId);
    });
}

export function deleteComposerSelection(
  root: HTMLElement,
  largePastes: Map<string, MentionComposerLargePaste>,
) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;

  const range = selection.getRangeAt(0);
  if (!editorRangeIsInsideRoot(root, range)) return false;

  pruneLargePastesInRange(range, largePastes);
  range.deleteContents();
  selection.removeAllRanges();
  selection.addRange(range);
  normalizeCaretAfterChip(root);
  ensureTrailingCaretAnchor(root);
  return true;
}

/** Find the nearest previous leaf node (for checking what precedes @). */
export function prevLeaf(node: Node, root: Node): Node | null {
  let cur: Node | null = node;
  while (cur && cur !== root) {
    if (cur.previousSibling) {
      cur = cur.previousSibling;
      // Descend to rightmost leaf
      while (cur.lastChild && !isComposerChipElement(cur)) cur = cur.lastChild;
      return cur;
    }
    cur = cur.parentNode;
  }
  return null;
}

export function rightmostTextNode(node: Node | null): Text | null {
  let cur = node;
  while (cur) {
    if (isComposerChipElement(cur)) {
      return null;
    }
    if (cur.nodeType === Node.TEXT_NODE) {
      return cur as Text;
    }
    cur = cur.lastChild;
  }
  return null;
}

export function selectionTextPosition(
  root: HTMLElement,
): { textNode: Text; offset: number } | null {
  normalizeCaretAfterChip(root);

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;

  const { startContainer: node, startOffset: offset } = sel.getRangeAt(0);
  if (!root.contains(node)) return null;
  if (node.nodeType === Node.TEXT_NODE) {
    if (isComposerChipElement(node.parentNode)) return null;
    return { textNode: node as Text, offset };
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }

  const element = node as HTMLElement;
  const childBefore = element.childNodes[offset - 1] ?? null;
  if (isComposerChipElement(childBefore)) {
    const anchor = ensureCaretAnchorAfterChip(childBefore);
    if (!anchor) return null;
    placeCaretInTextNode(anchor.textNode, anchor.offset);
    return { textNode: anchor.textNode, offset: anchor.offset };
  }
  const textNode = rightmostTextNode(childBefore);
  if (textNode) {
    return { textNode, offset: (textNode.textContent || "").length };
  }
  return null;
}

/** Detect an in-progress @file or /skill mention at the cursor position. */
export function detectMention(root: HTMLElement, skillsEnabled: boolean): MentionContext | null {
  const position = selectionTextPosition(root);
  if (!position) return null;

  const { textNode: node, offset } = position;
  const text = node.textContent || "";
  const before = text.slice(0, offset);

  let triggerIdx = -1;
  let trigger: MentionContext["trigger"] | null = null;
  for (let i = before.length - 1; i >= 0; i--) {
    if (before[i] === "@") {
      triggerIdx = i;
      trigger = "file";
      break;
    }
    // "/" only triggers a skill mention at a word boundary; slashes inside an
    // @file query (e.g. "@docs/foo") must keep scanning back toward the "@".
    if (before[i] === "/" && skillsEnabled && (i === 0 || isMentionBoundaryChar(before[i - 1]))) {
      triggerIdx = i;
      trigger = "skill";
      break;
    }
    if (isMentionBoundaryChar(before[i])) break;
  }
  if (triggerIdx < 0 || !trigger) return null;

  // Typing a filesystem path ("/usr/bin") reaches a second "/", which can
  // never appear in a skill name — drop the skill context instead of keeping
  // an unmatchable popup query around.
  if (trigger === "skill" && before.slice(triggerIdx + 1).includes("/")) return null;

  // Trigger must be preceded by whitespace or be the very first character.
  if (triggerIdx > 0) {
    if (!isMentionBoundaryChar(before[triggerIdx - 1])) return null;
  } else {
    // triggerIdx === 0 — check previous leaf
    const prev = prevLeaf(node, root);
    if (prev) {
      if (prev.nodeType === Node.TEXT_NODE) {
        const pt = prev.textContent || "";
        if (pt.length > 0 && !isMentionBoundaryChar(pt[pt.length - 1])) return null;
      }
      // Element node (e.g. mention chip) acts as word boundary → OK
    }
  }

  return {
    trigger,
    query: before.slice(triggerIdx + 1),
    textNode: node as Text,
    triggerOffset: triggerIdx,
  };
}

export function mentionContextEquals(a: MentionContext, b: MentionContext) {
  return (
    a.trigger === b.trigger &&
    a.query === b.query &&
    a.textNode === b.textNode &&
    a.triggerOffset === b.triggerOffset
  );
}

export function createFileMentionChip(path: string, kind: FileMentionKind) {
  const reference = createFileMentionReference(path, kind);
  if (!reference) return null;

  const chip = document.createElement("span");
  chip.setAttribute(MENTION_TAG_ATTR, reference.path);
  chip.setAttribute(MENTION_KIND_ATTR, reference.kind);
  chip.contentEditable = "false";
  chip.className = mentionChipClassName(reference.kind === "dir" ? "dir" : "file", {
    selectable: false,
  });
  chip.title = fileMentionTitle(reference);

  chip.appendChild(createFileTypeMentionIcon(reference.path, reference.kind));

  chip.appendChild(document.createTextNode(fileMentionDisplayName(reference)));
  return chip;
}

export function insertMentionChipElement(ctx: MentionContext, chip: HTMLElement) {
  const { textNode, triggerOffset, query } = ctx;
  const text = textNode.textContent || "";
  const parent = textNode.parentNode;
  if (!parent) return;

  const beforeText = text.slice(0, triggerOffset);
  const afterRaw = text.slice(triggerOffset + 1 + query.length);
  const anchor = createCaretAnchorText(afterRaw);
  const afterNode = document.createTextNode(anchor.text);

  if (beforeText) {
    parent.insertBefore(document.createTextNode(beforeText), textNode);
  }
  parent.insertBefore(chip, textNode);
  parent.insertBefore(afterNode, textNode);
  parent.removeChild(textNode);

  placeCaretInTextNode(afterNode, anchor.caretOffset);
}

/** Replace the @query text with a styled mention chip. */
export function insertMentionChip(ctx: MentionContext, path: string, kind: "file" | "dir") {
  const chip = createFileMentionChip(path, kind);
  if (!chip) return;
  insertMentionChipElement(ctx, chip);
}

export function createSkillMentionChip(skill: MentionComposerSkillMention) {
  const chip = document.createElement("span");
  chip.setAttribute(SKILL_MENTION_NAME_ATTR, skill.name);
  chip.setAttribute(SKILL_MENTION_FILE_ATTR, skill.skillFile);
  chip.setAttribute(SKILL_MENTION_BASE_DIR_ATTR, skill.baseDir);
  chip.setAttribute(SKILL_MENTION_DESCRIPTION_ATTR, skill.description);
  chip.contentEditable = "false";
  chip.className = mentionChipClassName("skill", { selectable: false });
  chip.title = skill.description ? `${skill.name}\n${skill.description}` : skill.name;

  chip.appendChild(createSkillMentionIcon());
  chip.appendChild(document.createTextNode(skill.name));
  return chip;
}

export function insertSkillMentionChip(ctx: MentionContext, skill: MentionComposerSkill) {
  const chip = createSkillMentionChip(skill);
  insertMentionChipElement(ctx, chip);
}

export function createConversationMentionChip(
  input: MentionComposerConversationMention,
): HTMLElement | null {
  const conversation = createConversationMentionReference(input);
  if (!conversation) return null;
  const chip = document.createElement("span");
  chip.setAttribute(CONVERSATION_MENTION_ID_ATTR, conversation.id);
  chip.setAttribute(CONVERSATION_MENTION_TITLE_ATTR, conversation.title);
  if (conversation.cwd) chip.setAttribute(CONVERSATION_MENTION_CWD_ATTR, conversation.cwd);
  if (conversation.updatedAt !== undefined) {
    chip.setAttribute(CONVERSATION_MENTION_UPDATED_AT_ATTR, String(conversation.updatedAt));
  }
  chip.contentEditable = "false";
  chip.className = mentionChipClassName("conversation", { selectable: false });
  chip.title = conversation.cwd ? `${conversation.title}\n${conversation.cwd}` : conversation.title;
  chip.appendChild(createConversationMentionIcon());
  chip.appendChild(document.createTextNode(conversation.title));
  return chip;
}

export function insertConversationMentionChip(
  ctx: MentionContext,
  conversation: MentionComposerConversationMention,
) {
  const chip = createConversationMentionChip(conversation);
  if (chip) insertMentionChipElement(ctx, chip);
}

export function createCommitMentionChip(commitInput: MentionComposerCommitMention) {
  const commit = normalizeCommitMention(commitInput);
  const chip = document.createElement("span");
  chip.setAttribute(COMMIT_MENTION_SHA_ATTR, commit.sha);
  chip.setAttribute(COMMIT_MENTION_SHORT_SHA_ATTR, commit.shortSha);
  chip.setAttribute(COMMIT_MENTION_SUBJECT_ATTR, commit.subject);
  chip.setAttribute(COMMIT_MENTION_BODY_ATTR, commit.body);
  chip.setAttribute(COMMIT_MENTION_AUTHOR_NAME_ATTR, commit.authorName);
  chip.setAttribute(COMMIT_MENTION_AUTHOR_EMAIL_ATTR, commit.authorEmail);
  chip.setAttribute(COMMIT_MENTION_AUTHOR_DATE_ATTR, commit.authorDate);
  chip.setAttribute(COMMIT_MENTION_FILE_COUNT_ATTR, String(commit.fileCount));
  chip.setAttribute(COMMIT_MENTION_FILES_CHANGED_ATTR, String(commit.filesChanged));
  chip.setAttribute(COMMIT_MENTION_INSERTIONS_ATTR, String(commit.insertions));
  chip.setAttribute(COMMIT_MENTION_DELETIONS_ATTR, String(commit.deletions));
  chip.setAttribute(COMMIT_MENTION_STAT_ATTR, commit.stat);
  chip.setAttribute(COMMIT_MENTION_REMOTE_NAME_ATTR, commit.remoteName);
  chip.setAttribute(COMMIT_MENTION_REMOTE_URL_ATTR, commit.remoteUrl);
  if (commit.githubUrl) {
    chip.setAttribute(COMMIT_MENTION_GITHUB_URL_ATTR, commit.githubUrl);
  }
  chip.contentEditable = "false";
  chip.tabIndex = 0;
  chip.setAttribute(
    "aria-label",
    commit.subject ? `${commit.shortSha}: ${commit.subject}` : commit.shortSha,
  );
  chip.className = mentionChipClassName("commit", { selectable: false });

  chip.appendChild(createGitHubMentionIcon());
  chip.appendChild(document.createTextNode(commit.shortSha));
  return chip;
}

export function createGitFileMentionChip(fileInput: MentionComposerGitFileMention) {
  const file = normalizeGitFileMention(fileInput);
  const chip = document.createElement("span");
  chip.setAttribute(GIT_FILE_MENTION_PATH_ATTR, file.path);
  chip.setAttribute(GIT_FILE_MENTION_STATUS_ATTR, file.status);
  chip.setAttribute(GIT_FILE_MENTION_COMMIT_SHA_ATTR, file.commitSha);
  chip.setAttribute(GIT_FILE_MENTION_SHORT_SHA_ATTR, file.shortSha);
  chip.setAttribute(GIT_FILE_MENTION_REF_NAME_ATTR, file.refName);
  chip.setAttribute(GIT_FILE_MENTION_REMOTE_NAME_ATTR, file.remoteName);
  chip.setAttribute(GIT_FILE_MENTION_REMOTE_URL_ATTR, file.remoteUrl);
  if (file.oldPath) {
    chip.setAttribute(GIT_FILE_MENTION_OLD_PATH_ATTR, file.oldPath);
  }
  if (file.githubUrl) {
    chip.setAttribute(GIT_FILE_MENTION_GITHUB_URL_ATTR, file.githubUrl);
  }
  chip.contentEditable = "false";
  chip.setAttribute(
    "aria-label",
    `${file.path} @ ${file.refName || file.shortSha || file.commitSha.slice(0, 7)}`,
  );
  chip.className = mentionChipClassName("gitFile", { selectable: false });
  chip.title = `${file.path}\n${file.refName || file.shortSha} (${file.shortSha})`;

  chip.appendChild(createFileTypeMentionIcon(file.path, "file"));

  const fileName = file.path.split("/").pop() || file.path;
  chip.appendChild(document.createTextNode(fileName));
  const ref = document.createElement("span");
  ref.className = "max-w-[8rem] truncate text-[calc(10px*var(--zone-font-scale,1))] opacity-70";
  ref.textContent = `@${file.refName || file.shortSha}`;
  chip.appendChild(ref);
  return chip;
}

export function createCodeMentionChip(referenceInput: CodeMentionReference) {
  const reference = createCodeMentionReference(referenceInput);
  if (!reference) return null;
  const chip = document.createElement("span");
  chip.setAttribute(CODE_MENTION_PATH_ATTR, reference.path);
  chip.setAttribute(CODE_MENTION_START_ATTR, String(reference.startLine));
  chip.setAttribute(CODE_MENTION_END_ATTR, String(reference.endLine));
  chip.contentEditable = "false";
  chip.className = mentionChipClassName("codeRef", { selectable: false });
  const lineLabel = codeMentionLineLabel(reference);
  chip.title = `${reference.path}:${lineLabel}`;
  chip.setAttribute("aria-label", `${reference.path}:${lineLabel}`);

  chip.appendChild(createFileTypeMentionIcon(reference.path, "file"));

  chip.appendChild(document.createTextNode(`${codeMentionDisplayName(reference)}：${lineLabel}`));
  return chip;
}

export function createLargePasteChip(paste: MentionComposerLargePaste) {
  const chip = document.createElement("span");
  chip.setAttribute(LARGE_PASTE_TAG_ATTR, paste.id);
  chip.contentEditable = "false";
  chip.className = mentionChipClassName("pastedText", { selectable: false });
  chip.title = paste.preview
    ? `${paste.label}\n${paste.preview}`
    : `${paste.label} (${paste.charCount} chars)`;

  chip.appendChild(createFileTypeMentionIcon("pasted.txt", "file"));

  chip.appendChild(
    document.createTextNode(
      `${paste.label} · ${formatLargePasteCount(paste.charCount)} chars · ${formatLargePasteCount(paste.lineCount)} lines`,
    ),
  );
  return chip;
}

export function createComposerSegmentNode(
  segment: MentionComposerDraftSegment,
  largePastes: Map<string, MentionComposerLargePaste>,
): Node | null {
  if (segment.type === "text") {
    return segment.text ? document.createTextNode(normalizeLogicalLineEndings(segment.text)) : null;
  }
  if (segment.type === "fileMention") {
    return createFileMentionChip(segment.reference.path, segment.reference.kind);
  }
  if (segment.type === "largePaste") {
    largePastes.set(segment.paste.id, segment.paste);
    return createLargePasteChip(segment.paste);
  }
  if (segment.type === "skillMention") {
    return createSkillMentionChip(segment.skill);
  }
  if (segment.type === "commitMention") {
    return createCommitMentionChip(segment.commit);
  }
  if (segment.type === "gitFileMention") {
    return createGitFileMentionChip(segment.file);
  }
  if (segment.type === "conversationMention") {
    return createConversationMentionChip(segment.conversation);
  }
  return createCodeMentionChip(segment.reference);
}

export function insertComposerSegmentsAtSelection(
  root: HTMLElement,
  segments: MentionComposerDraftSegment[],
  largePastes: Map<string, MentionComposerLargePaste>,
) {
  const nodes = segments
    .map((segment) => createComposerSegmentNode(segment, largePastes))
    .filter((node): node is Node => node !== null);
  if (nodes.length === 0) return false;

  const selection = window.getSelection();
  let range = editorSelectionRange(root);
  if (!range) {
    range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(false);
  }

  // A caret parked inside a non-editable chip (WebKit drops clicks there)
  // must hop after the chip instead of letting the boundary extension below
  // swallow the chip into the replaced range.
  if (range.collapsed) {
    const chip = closestComposerChipFromNode(root, range.startContainer);
    if (chip) {
      range.setStartAfter(chip);
      range.collapse(true);
    }
  } else {
    const startChip = closestComposerChipFromNode(root, range.startContainer);
    if (startChip) range.setStartBefore(startChip);
    const endChip = closestComposerChipFromNode(root, range.endContainer);
    if (endChip) range.setEndAfter(endChip);
    pruneLargePastesInRange(range, largePastes);
    range.deleteContents();
  }

  const fragment = document.createDocumentFragment();
  for (const node of nodes) fragment.appendChild(node);
  const lastNode = nodes[nodes.length - 1];
  range.insertNode(fragment);

  if (lastNode.nodeType === Node.TEXT_NODE) {
    placeCaretInTextNode(lastNode as Text, (lastNode.textContent ?? "").length);
  } else if (isComposerChipElement(lastNode)) {
    const anchor = ensureCaretAnchorAfterChip(lastNode);
    if (anchor) placeCaretInTextNode(anchor.textNode, anchor.offset);
  } else if (selection) {
    const caret = document.createRange();
    caret.setStartAfter(lastNode);
    caret.collapse(true);
    selection.removeAllRanges();
    selection.addRange(caret);
  }
  ensureTrailingCaretAnchor(root);
  return true;
}

export function insertNodeAtCursor(root: HTMLElement, node: HTMLElement) {
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    if (editorRangeIsInsideRoot(root, range)) {
      // A restored selection can carry boundaries inside a non-editable chip
      // (clicks and double-clicks land there); hop them outside so the new
      // chip never nests into an existing chip and never guts its label.
      const startChip = closestComposerChipFromNode(root, range.startContainer);
      if (startChip) {
        range.setStartAfter(startChip);
      }
      const endChip = closestComposerChipFromNode(root, range.endContainer);
      if (endChip) {
        range.setEndBefore(endChip);
      }
      if (!range.collapsed) {
        range.deleteContents();
      }
      range.insertNode(node);
      // Reuse the split-off text node as the caret anchor instead of minting
      // a fresh one, so mid-text inserts leave no empty text-node leftovers.
      const anchor = ensureCaretAnchorAfterChip(node);
      if (anchor) {
        placeCaretInTextNode(anchor.textNode, anchor.offset);
      }
      return;
    }
  }

  root.appendChild(node);
  const anchor = ensureCaretAnchorAfterChip(node);
  if (anchor) {
    placeCaretInTextNode(anchor.textNode, anchor.offset);
  }
}

/** Measure the caret rect without corrupting the selection.
 *
 *  Range.getClientRects() covers most caret positions but is empty at line
 *  boundaries (e.g. right after a Shift+Enter line break). The old fallback
 *  used Range.insertNode() at the caret, which splits the underlying text
 *  node; the caret then ended up inside the degenerate empty text node left
 *  by the split, and WebKit stops painting a caret there entirely — the
 *  cursor visibly vanished after every Shift+Enter. Instead, insert the
 *  probe at the nearest node boundary (never splitting text nodes) and put
 *  the selection back exactly where it was afterwards. */
export function measureComposerCaretRect(range: Range): DOMRect | null {
  const rects = range.getClientRects();
  if (rects.length > 0) {
    return rects[0];
  }

  const { startContainer, startOffset } = range;
  let parent: Node | null;
  let before: Node | null;
  if (startContainer.nodeType === Node.TEXT_NODE) {
    const textNode = startContainer as Text;
    parent = textNode.parentNode;
    if (startOffset <= 0) {
      before = textNode;
    } else if (startOffset >= textNode.length) {
      before = textNode.nextSibling;
    } else {
      // Mid-text carets always produce client rects; never risk a split.
      return null;
    }
  } else {
    parent = startContainer;
    before = startContainer.childNodes[startOffset] ?? null;
  }
  if (!parent) {
    return null;
  }

  const marker = document.createElement("span");
  marker.textContent = "\u200B";
  marker.style.display = "inline-block";
  marker.style.width = "0";
  marker.style.height = "1em";
  marker.style.overflow = "hidden";
  parent.insertBefore(marker, before);
  const markerRect = marker.getBoundingClientRect();
  marker.remove();

  // Even a non-splitting insert/remove can drop or shift a WebKit selection;
  // restore the caret to the exact position that was measured.
  const sel = window.getSelection();
  if (sel) {
    try {
      sel.collapse(startContainer, startOffset);
    } catch {
      // The container vanished mid-frame; leave the selection untouched.
    }
  }
  return markerRect;
}

export function scrollSelectionIntoComposerView(root: HTMLElement) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) {
    root.scrollTop = root.scrollHeight;
    return;
  }

  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) {
    return;
  }

  const caretRect = measureComposerCaretRect(range);
  if (!caretRect) {
    return;
  }

  const rootRect = root.getBoundingClientRect();
  const margin = 4;
  const bottomOverflow = caretRect.bottom - (rootRect.bottom - margin);
  const topOverflow = rootRect.top + margin - caretRect.top;

  if (bottomOverflow > 0) {
    root.scrollTop += bottomOverflow;
  } else if (topOverflow > 0) {
    root.scrollTop -= topOverflow;
  }
}

export function scheduleComposerSelectionScroll(root: HTMLElement | null) {
  if (!root) return;
  window.requestAnimationFrame(() => {
    if (!root.isConnected) return;
    scrollSelectionIntoComposerView(root);
  });
}

export type ComposerChipBeforeCursor = {
  chip: HTMLElement;
  textNode?: Text;
  offset?: number;
};

export function caretSpacerTextIsEmpty(value: string) {
  return removeCaretAnchors(value).replace(/[ \t\u00A0]/g, "").length === 0;
}

export function isCaretAnchorTextNode(textNode: Text, beforeCursor: string) {
  return (
    beforeCursor.length === 0 ||
    textNode.data.includes(CARET_ANCHOR_TEXT) ||
    caretSpacerTextIsEmpty(beforeCursor)
  );
}

export function stripLeadingCaretAnchorText(value: string) {
  const anchorIndex = value.indexOf(CARET_ANCHOR_TEXT);
  if (anchorIndex < 0) return value.replace(/^[ \t\u00A0]/, "");
  const beforeAnchor = value.slice(0, anchorIndex);
  if (beforeAnchor.replace(/[ \t\u00A0]/g, "").length > 0) return value;
  return removeCaretAnchors(value.slice(anchorIndex + CARET_ANCHOR_TEXT.length));
}

export function childNodeIndex(parent: Node, child: Node) {
  return Array.prototype.indexOf.call(parent.childNodes, child);
}

export function placeCaretInNode(parent: Node, offset: number) {
  const range = document.createRange();
  range.setStart(parent, Math.min(Math.max(0, offset), parent.childNodes.length));
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/** Check if cursor is right after a mention chip, return that chip if so. */
export function chipBeforeCursor(root: HTMLElement): ComposerChipBeforeCursor | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;

  const { startContainer: node, startOffset: offset } = sel.getRangeAt(0);
  if (!root.contains(node)) return null;

  // Case 1: cursor is inside the text anchor after a mention chip.
  if (node.nodeType === Node.TEXT_NODE) {
    const textNode = node as Text;
    const before = textNode.data.slice(0, offset);
    if (
      caretSpacerTextIsEmpty(before) &&
      isCaretAnchorTextNode(textNode, before) &&
      isComposerChipElement(textNode.previousSibling)
    ) {
      return { chip: textNode.previousSibling, textNode, offset };
    }
  }

  // Case 2: cursor inside the contenteditable element itself (not a text node),
  // offset points to a child index — check the child before that index
  if (node === root || (node.nodeType === Node.ELEMENT_NODE && root.contains(node))) {
    const el = node as HTMLElement;
    const childBefore = el.childNodes[offset - 1];
    if (isComposerChipElement(childBefore)) {
      return { chip: childBefore };
    }
  }

  return null;
}

export function deleteChipBeforeCursor(
  root: HTMLElement,
  largePastes: Map<string, MentionComposerLargePaste>,
) {
  const target = chipBeforeCursor(root);
  if (!target) return false;

  const { chip, textNode, offset = 0 } = target;
  const parent = chip.parentNode;
  if (!parent) return false;

  const largePasteId = chip.getAttribute(LARGE_PASTE_TAG_ATTR);
  if (largePasteId) {
    largePastes.delete(largePasteId);
  }

  const chipIndex = childNodeIndex(parent, chip);
  let nextCaretTextNode: Text | null = null;

  if (textNode?.parentNode === parent) {
    const remainder = textNode.data.slice(offset);
    textNode.data =
      offset > 0 ? removeCaretAnchors(remainder) : stripLeadingCaretAnchorText(remainder);
    if (textNode.data.length > 0) {
      nextCaretTextNode = textNode;
    } else {
      textNode.remove();
    }
  } else if (chip.nextSibling?.nodeType === Node.TEXT_NODE) {
    const nextTextNode = chip.nextSibling as Text;
    nextTextNode.data = stripLeadingCaretAnchorText(nextTextNode.data);
    if (nextTextNode.data.length > 0) {
      nextCaretTextNode = nextTextNode;
    } else {
      nextTextNode.remove();
    }
  }

  chip.remove();

  if (nextCaretTextNode) {
    placeCaretInTextNode(nextCaretTextNode, 0);
  } else {
    const previousNode = chipIndex > 0 ? (parent.childNodes[chipIndex - 1] ?? null) : null;
    const followingNode = parent.childNodes[chipIndex] ?? null;
    if (previousNode?.nodeType === Node.TEXT_NODE) {
      const previousTextNode = previousNode as Text;
      placeCaretInTextNode(previousTextNode, previousTextNode.data.length);
    } else if (isComposerChipElement(previousNode)) {
      const anchor = ensureCaretAnchorAfterChip(previousNode);
      if (anchor) {
        placeCaretInTextNode(anchor.textNode, anchor.offset);
      }
    } else if (isComposerChipElement(followingNode)) {
      const anchor = ensureCaretAnchorBeforeChip(followingNode);
      if (anchor) {
        placeCaretInTextNode(anchor.textNode, anchor.offset);
      }
    } else {
      placeCaretInNode(parent, Math.min(chipIndex, parent.childNodes.length));
    }
  }

  return true;
}

export function placeCaretBeforeChip(chip: HTMLElement) {
  const prev = chip.previousSibling;
  if (isComposerChipElement(prev)) {
    // Adjacent chips: rest at the canonical anchor after the previous one.
    const anchor = ensureCaretAnchorAfterChip(prev);
    if (!anchor) return false;
    placeCaretInTextNode(anchor.textNode, anchor.offset);
    return true;
  }
  const anchor = ensureCaretAnchorBeforeChip(chip);
  if (!anchor) return false;
  placeCaretInTextNode(anchor.textNode, anchor.offset);
  return true;
}

export function placeCaretAfterChip(chip: HTMLElement) {
  const anchor = ensureCaretAnchorAfterChip(chip);
  if (!anchor) return false;
  placeCaretInTextNode(anchor.textNode, anchor.offset);
  return true;
}

/** Check if the content right after the cursor is a mention chip, return it if so. */
export function chipAfterCursor(root: HTMLElement): HTMLElement | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;

  const { startContainer: node, startOffset: offset } = sel.getRangeAt(0);
  if (!root.contains(node)) return null;

  if (node.nodeType === Node.TEXT_NODE) {
    const textNode = node as Text;
    const rest = textNode.data.slice(offset);
    if (removeCaretAnchors(rest).length === 0 && isComposerChipElement(textNode.nextSibling)) {
      return textNode.nextSibling;
    }
    return null;
  }

  if (node === root || (node.nodeType === Node.ELEMENT_NODE && root.contains(node))) {
    const childAfter = (node as HTMLElement).childNodes[offset] ?? null;
    if (isComposerChipElement(childAfter)) {
      return childAfter;
    }
  }

  return null;
}

/** Move a caret that ended up inside a non-editable chip back outside it. */
export function ejectCaretFromChip(root: HTMLElement, side: "before" | "after") {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;

  const node = sel.getRangeAt(0).startContainer;
  if (!root.contains(node)) return false;

  const chip = closestComposerChipFromNode(root, node);
  if (!chip) return false;
  return side === "before" ? placeCaretBeforeChip(chip) : placeCaretAfterChip(chip);
}

/**
 * ←/→ treat a chip plus its caret anchor as one atomic unit: the caret only
 * ever rests right before the chip or at the anchor after it. The browser's
 * default one-character move would land between chip and anchor, where the
 * keyup normalisation snaps it straight back (the caret would never cross).
 */
export function stepCaretOverChip(root: HTMLElement, direction: "left" | "right") {
  if (ejectCaretFromChip(root, direction === "left" ? "before" : "after")) {
    return true;
  }
  if (direction === "left") {
    const target = chipBeforeCursor(root);
    return target ? placeCaretBeforeChip(target.chip) : false;
  }
  const chip = chipAfterCursor(root);
  return chip ? placeCaretAfterChip(chip) : false;
}

/** Forward-delete twin of deleteChipBeforeCursor: remove the chip right
 *  after the cursor together with its caret anchor, mirroring how Backspace
 *  treats chip + anchor as one atomic unit (native forward delete would
 *  drop only the chip element and leave its anchor space behind). */
export function deleteChipAfterCursor(
  root: HTMLElement,
  largePastes: Map<string, MentionComposerLargePaste>,
) {
  const chip = chipAfterCursor(root);
  if (!chip) return false;

  const largePasteId = chip.getAttribute(LARGE_PASTE_TAG_ATTR);
  if (largePasteId) {
    largePastes.delete(largePasteId);
  }

  const next = chip.nextSibling;
  if (next?.nodeType === Node.TEXT_NODE) {
    const nextTextNode = next as Text;
    nextTextNode.data = stripLeadingCaretAnchorText(nextTextNode.data);
    if (nextTextNode.data.length === 0) {
      nextTextNode.remove();
    }
  }

  chip.remove();
  // The collapsed caret stayed where it was; it may now sit on a bare
  // element offset right next to another chip — re-anchor it.
  normalizeCaretAfterChip(root);
  return true;
}

/* ------------------------------------------------------------------ */
/*  Popup sub-component                                                */
/* ------------------------------------------------------------------ */
