import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type ClipboardEvent,
  type FocusEvent,
  forwardRef,
  type KeyboardEvent,
  type MouseEvent,
  memo,
  type RefObject,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useLocale } from "../../i18n";
import {
  createFileMentionReference,
  escapeMarkdownReferenceLabel,
  type FileMentionKind,
  type FileMentionReference,
  fileMentionDisplayName,
  fileMentionTitle,
  formatFileMentionToken,
  formatMarkdownReferenceDestination,
} from "../../lib/chat/messages/mentionReferences";
import { cn } from "../../lib/shared/utils";
import { invokeFs } from "../../lib/tools/fsBackend";
import {
  ClipboardPaste,
  Copy,
  ScanText,
  Scissors,
  SKILL_ICON_SVG_MARKUP,
  SkillIcon,
} from "../icons";
import { getFileTypeIcon, getFileTypeIconSvg } from "./fileTypeIcons";
import { mentionChipClassName } from "./mentionChipStyles";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface MentionFileEntry {
  path: string;
  kind: FileMentionKind;
}

interface MentionListResponse {
  entries: MentionFileEntry[];
  truncated: boolean;
}

type MentionSearchEntry = {
  entry: MentionFileEntry;
  searchPath: string;
};

export type MentionComposerSkill = {
  name: string;
  description: string;
  skillFile: string;
  baseDir: string;
};

export type MentionComposerSkillMention = MentionComposerSkill;

export type MentionComposerCommitMention = {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  fileCount: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  stat: string;
  remoteName: string;
  remoteUrl: string;
  githubUrl?: string;
};

export type MentionComposerGitFileMention = {
  path: string;
  oldPath?: string;
  status: string;
  commitSha: string;
  shortSha: string;
  refName: string;
  remoteName: string;
  remoteUrl: string;
  githubUrl?: string;
};

type MentionSuggestion =
  | { type: "file"; entry: MentionFileEntry }
  | { type: "skill"; skill: MentionComposerSkill };

type ComposerContextMenuState = {
  x: number;
  y: number;
  selectedText: string;
  hasContent: boolean;
};

/** Where the @/$ trigger lives inside a text node */
interface MentionContext {
  trigger: "file" | "skill";
  query: string;
  textNode: Text;
  triggerOffset: number; // char offset of the trigger inside textNode
}

export interface MentionComposerHandle {
  getText: () => string;
  getDraft: () => MentionComposerDraft;
  hasContent: () => boolean;
  setText: (text: string) => void;
  setDraft: (draft: MentionComposerDraft) => void;
  insertFileMention: (path: string, kind: "file" | "dir") => void;
  insertCommitMention: (commit: MentionComposerCommitMention) => void;
  insertGitFileMention: (file: MentionComposerGitFileMention) => void;
  clear: () => void;
  focus: () => void;
  /**
   * Clear the composer and type `text` in with a typewriter animation.
   * User input is locked out while it runs; resolves once the full text
   * has landed in the editor (or the run was cancelled).
   */
  typeText: (text: string) => Promise<void>;
}

export type MentionComposerLargePaste = {
  id: string;
  label: string;
  text: string;
  charCount: number;
  lineCount: number;
  preview: string;
};

export type MentionComposerDraftSegment =
  | { type: "text"; text: string }
  | { type: "fileMention"; reference: FileMentionReference }
  | { type: "largePaste"; paste: MentionComposerLargePaste }
  | { type: "skillMention"; skill: MentionComposerSkillMention }
  | { type: "commitMention"; commit: MentionComposerCommitMention }
  | { type: "gitFileMention"; file: MentionComposerGitFileMention };

export type MentionComposerDraft = {
  segments: MentionComposerDraftSegment[];
  text: string;
  textWithoutLargePastes: string;
  largePastes: MentionComposerLargePaste[];
  skillMentions: MentionComposerSkillMention[];
  commitMentions: MentionComposerCommitMention[];
  gitFileMentions: MentionComposerGitFileMention[];
  isEmpty: boolean;
};

export interface MentionComposerProps {
  /** Called when user presses Enter (without Shift). */
  onSend: () => void;
  /** Called only when empty/non-empty state flips. */
  onEmptyChange?: (isEmpty: boolean) => void;
  onBusyChange?: (isBusy: boolean) => void;
  onPasteFiles?: (files: File[]) => void;
  disabled?: boolean;
  placeholder?: string;
  workdir: string;
  enabledSkills?: MentionComposerSkill[];
  className?: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const MAX_SUGGESTIONS = 30;
const MENTION_INDEX_MAX_RESULTS = 5000;
const MENTION_TAG_ATTR = "data-mention-path";
const MENTION_KIND_ATTR = "data-mention-kind";
const SKILL_MENTION_NAME_ATTR = "data-skill-name";
const SKILL_MENTION_FILE_ATTR = "data-skill-file";
const SKILL_MENTION_BASE_DIR_ATTR = "data-skill-base-dir";
const SKILL_MENTION_DESCRIPTION_ATTR = "data-skill-description";
const COMMIT_MENTION_SHA_ATTR = "data-commit-sha";
const COMMIT_MENTION_SHORT_SHA_ATTR = "data-commit-short-sha";
const COMMIT_MENTION_SUBJECT_ATTR = "data-commit-subject";
const COMMIT_MENTION_BODY_ATTR = "data-commit-body";
const COMMIT_MENTION_AUTHOR_NAME_ATTR = "data-commit-author-name";
const COMMIT_MENTION_AUTHOR_EMAIL_ATTR = "data-commit-author-email";
const COMMIT_MENTION_AUTHOR_DATE_ATTR = "data-commit-author-date";
const COMMIT_MENTION_FILE_COUNT_ATTR = "data-commit-file-count";
const COMMIT_MENTION_FILES_CHANGED_ATTR = "data-commit-files-changed";
const COMMIT_MENTION_INSERTIONS_ATTR = "data-commit-insertions";
const COMMIT_MENTION_DELETIONS_ATTR = "data-commit-deletions";
const COMMIT_MENTION_STAT_ATTR = "data-commit-stat";
const COMMIT_MENTION_REMOTE_NAME_ATTR = "data-commit-remote-name";
const COMMIT_MENTION_REMOTE_URL_ATTR = "data-commit-remote-url";
const COMMIT_MENTION_GITHUB_URL_ATTR = "data-commit-github-url";
const GIT_FILE_MENTION_PATH_ATTR = "data-git-file-path";
const GIT_FILE_MENTION_OLD_PATH_ATTR = "data-git-file-old-path";
const GIT_FILE_MENTION_STATUS_ATTR = "data-git-file-status";
const GIT_FILE_MENTION_COMMIT_SHA_ATTR = "data-git-file-commit-sha";
const GIT_FILE_MENTION_SHORT_SHA_ATTR = "data-git-file-short-sha";
const GIT_FILE_MENTION_REF_NAME_ATTR = "data-git-file-ref-name";
const GIT_FILE_MENTION_REMOTE_NAME_ATTR = "data-git-file-remote-name";
const GIT_FILE_MENTION_REMOTE_URL_ATTR = "data-git-file-remote-url";
const GIT_FILE_MENTION_GITHUB_URL_ATTR = "data-git-file-github-url";
const LARGE_PASTE_TAG_ATTR = "data-large-paste-id";
const LARGE_PASTE_CHAR_THRESHOLD = 8_000;
const LARGE_PASTE_LINE_THRESHOLD = 200;
const LARGE_PASTE_PREVIEW_CHARS = 160;
const COMPOSER_CONTEXT_MENU_WIDTH = 184;
const COMPOSER_CONTEXT_MENU_HEIGHT = 154;
const COMPOSER_CONTEXT_MENU_MARGIN = 12;
const CARET_ANCHOR_TEXT = "\u200B";
const CARET_SPACER_TEXT = "\u00A0";
const IME_ENTER_SUPPRESS_WINDOW_MS = 300;
const IME_COMPOSITION_END_ENTER_TAIL_MS = 80;
// Must match the .composer-typewriter-char animation duration in index.css.
const TYPEWRITER_CHAR_FADE_MS = 220;
const GITHUB_ICON_SVG =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.6 7.6 0 0 1 8 3.86c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>';

/* ------------------------------------------------------------------ */
/*  DOM helpers                                                        */
/* ------------------------------------------------------------------ */

function formatSkillMentionToken(skill: Pick<MentionComposerSkillMention, "name">) {
  return `$${skill.name}`;
}

function formatCommitMentionToken(
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

function formatGitFileMentionToken(
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

function removeCaretAnchors(value: string) {
  return value.split(CARET_ANCHOR_TEXT).join("");
}

function countCaretAnchors(value: string) {
  return value.split(CARET_ANCHOR_TEXT).length - 1;
}

function normalizeSerializedText(value: string) {
  return removeCaretAnchors(value).replace(/\u00A0/g, " ");
}

function isMentionBoundaryChar(value: string) {
  return /\s/.test(value) || value === CARET_ANCHOR_TEXT;
}

/** Recursively serialise a contenteditable DOM tree back to plain text.
 *  Mention chips become Markdown file references. */
function pushTextSegment(out: MentionComposerDraftSegment[], text: string) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last?.type === "text") {
    last.text += text;
    return;
  }
  out.push({ type: "text", text });
}

function serializeChildrenToSegments(
  parent: Node,
  largePastes: Map<string, MentionComposerLargePaste>,
): MentionComposerDraftSegment[] {
  const parts: MentionComposerDraftSegment[] = [];
  parent.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      pushTextSegment(parts, removeCaretAnchors(child.textContent || ""));
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as HTMLElement;
      const mentionPath = el.getAttribute(MENTION_TAG_ATTR);
      if (mentionPath) {
        const kind = el.getAttribute(MENTION_KIND_ATTR) === "dir" ? "dir" : "file";
        const reference = createFileMentionReference(mentionPath, kind);
        if (reference) {
          parts.push({ type: "fileMention", reference });
        }
      } else if (el.hasAttribute(GIT_FILE_MENTION_PATH_ATTR)) {
        const file = gitFileMentionFromElement(el);
        if (file) {
          parts.push({ type: "gitFileMention", file });
        }
      } else if (el.hasAttribute(COMMIT_MENTION_SHA_ATTR)) {
        const commit = commitMentionFromElement(el);
        if (commit) {
          parts.push({ type: "commitMention", commit });
        }
      } else if (el.hasAttribute(SKILL_MENTION_NAME_ATTR)) {
        const name = el.getAttribute(SKILL_MENTION_NAME_ATTR)?.trim() ?? "";
        const skillFile = el.getAttribute(SKILL_MENTION_FILE_ATTR)?.trim() ?? "";
        const baseDir = el.getAttribute(SKILL_MENTION_BASE_DIR_ATTR)?.trim() ?? "";
        if (name && skillFile && baseDir) {
          parts.push({
            type: "skillMention",
            skill: {
              name,
              skillFile,
              baseDir,
              description: el.getAttribute(SKILL_MENTION_DESCRIPTION_ATTR)?.trim() ?? "",
            },
          });
        }
      } else {
        const largePasteId = el.getAttribute(LARGE_PASTE_TAG_ATTR);
        const largePaste = largePasteId ? largePastes.get(largePasteId) : undefined;
        if (largePaste) {
          parts.push({ type: "largePaste", paste: largePaste });
          return;
        }
        if (el.tagName === "BR") {
          pushTextSegment(parts, "\n");
        } else {
          // Block-level wrappers (DIV / P) inserted by the browser on Enter
          if (el.tagName === "DIV" || el.tagName === "P") {
            if (parts.length > 0) pushTextSegment(parts, "\n");
          }
          for (const segment of serializeChildrenToSegments(el, largePastes)) {
            if (segment.type === "text") {
              pushTextSegment(parts, segment.text);
            } else {
              parts.push(segment);
            }
          }
        }
      }
    }
  });
  return parts;
}

function serializeChildren(
  parent: Node,
  largePastes: Map<string, MentionComposerLargePaste>,
): string {
  return serializeChildrenToSegments(parent, largePastes)
    .map((segment) => {
      if (segment.type === "fileMention") return formatFileMentionToken(segment.reference);
      if (segment.type === "largePaste") return segment.paste.text;
      if (segment.type === "skillMention") return formatSkillMentionToken(segment.skill);
      if (segment.type === "commitMention") return formatCommitMentionToken(segment.commit);
      if (segment.type === "gitFileMention") return formatGitFileMentionToken(segment.file);
      return segment.text;
    })
    .join("");
}

function editorTextIsEmpty(editor: HTMLElement) {
  const raw = normalizeSerializedText(editor.textContent || "");
  return raw.trim().length === 0;
}

/** Unlike editorTextIsEmpty, this doesn't trim — a leading/trailing space
 *  still counts as content so the placeholder hides as soon as the user types. */
function editorHasNoContent(editor: HTMLElement) {
  return (editor.textContent || "").length === 0;
}

function editorRangeIsInsideRoot(root: HTMLElement, range: Range) {
  const commonAncestor = range.commonAncestorContainer;
  return commonAncestor === root || root.contains(commonAncestor);
}

function editorSelectionRange(root: HTMLElement) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  return editorRangeIsInsideRoot(root, range) ? range : null;
}

function resolveComposerSelectionText(
  root: HTMLElement | null,
  largePastes: Map<string, MentionComposerLargePaste>,
) {
  if (!root) return "";

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return "";
  }

  const range = selection.getRangeAt(0);
  if (!editorRangeIsInsideRoot(root, range)) {
    return "";
  }

  return normalizeSerializedText(serializeChildren(range.cloneContents(), largePastes));
}

function selectionContainsPoint(
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

function createCaretRangeFromPoint(x: number, y: number) {
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

function closestComposerChipFromNode(root: HTMLElement, node: Node | null) {
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

function placeComposerCaretFromPoint(root: HTMLElement, x: number, y: number) {
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

function selectComposerContents(root: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(root);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function deleteComposerSelection(
  root: HTMLElement,
  largePastes: Map<string, MentionComposerLargePaste>,
) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;

  const range = selection.getRangeAt(0);
  if (!editorRangeIsInsideRoot(root, range)) return false;

  range
    .cloneContents()
    .querySelectorAll<HTMLElement>(`[${LARGE_PASTE_TAG_ATTR}]`)
    .forEach((chip) => {
      const largePasteId = chip.getAttribute(LARGE_PASTE_TAG_ATTR);
      if (largePasteId) {
        largePastes.delete(largePasteId);
      }
    });

  range.deleteContents();
  selection.removeAllRanges();
  selection.addRange(range);
  normalizeCaretAfterChip(root);
  ensureTrailingCaretAnchor(root);
  return true;
}

function clampComposerContextMenuPosition(x: number, y: number) {
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

function normalizeMentionQuery(query: string) {
  return removeCaretAnchors(query).trim().replace(/\\/g, "/").toLowerCase();
}

function normalizeLargePastePreview(text: string) {
  return text.trim().replace(/\s+/g, " ").slice(0, LARGE_PASTE_PREVIEW_CHARS);
}

function countLargePasteLines(text: string) {
  if (!text) return 0;
  return text.split(/\r\n|\r|\n/).length;
}

function isLargePasteText(text: string) {
  if (text.length >= LARGE_PASTE_CHAR_THRESHOLD) return true;
  return countLargePasteLines(text) >= LARGE_PASTE_LINE_THRESHOLD;
}

function clipboardFileExtension(mimeType: string) {
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

function normalizeClipboardFile(file: File, index: number) {
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

function extractClipboardFiles(data: DataTransfer) {
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

function writeTextToClipboard(text: string) {
  if (!text) return;

  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => {
      fallbackWriteTextToClipboard(text);
    });
    return;
  }

  fallbackWriteTextToClipboard(text);
}

function fallbackWriteTextToClipboard(text: string) {
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

function isImeKeyboardEvent(event: KeyboardEvent<HTMLDivElement>) {
  const nativeEvent = event.nativeEvent as globalThis.KeyboardEvent & {
    isComposing?: boolean;
    keyCode?: number;
    which?: number;
  };
  return (
    nativeEvent.isComposing === true ||
    nativeEvent.keyCode === 229 ||
    nativeEvent.which === 229 ||
    event.key === "Process"
  );
}

function isActiveImeKeyboardEvent(event: KeyboardEvent<HTMLDivElement>) {
  const nativeEvent = event.nativeEvent as globalThis.KeyboardEvent & {
    isComposing?: boolean;
  };
  return nativeEvent.isComposing === true || event.key === "Process";
}

function isEnterKeyboardEvent(event: KeyboardEvent<HTMLDivElement>) {
  const nativeEvent = event.nativeEvent as globalThis.KeyboardEvent;
  return (
    event.key === "Enter" || nativeEvent.code === "Enter" || nativeEvent.code === "NumpadEnter"
  );
}

function hasLegacyImeKeyboardSignal(event: KeyboardEvent<HTMLDivElement>) {
  const nativeEvent = event.nativeEvent as globalThis.KeyboardEvent & {
    keyCode?: number;
    which?: number;
  };
  return nativeEvent.keyCode === 229 || nativeEvent.which === 229;
}

const LARGE_PASTE_COUNT_FORMAT = new Intl.NumberFormat();

function formatLargePasteCount(value: number) {
  return LARGE_PASTE_COUNT_FORMAT.format(value);
}

function parseCommitMentionNumber(value: string | null) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeCommitMention(
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

function commitMentionFromElement(el: HTMLElement): MentionComposerCommitMention | null {
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

function normalizeGitFileMention(
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

function gitFileMentionFromElement(el: HTMLElement): MentionComposerGitFileMention | null {
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

function createMentionIcon(svgMarkup: string) {
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

function createFileTypeMentionIcon(path: string, kind: FileMentionKind) {
  return createMentionIcon(getFileTypeIconSvg(path, kind));
}

function createGitHubMentionIcon() {
  return createMentionIcon(GITHUB_ICON_SVG);
}

function createSkillMentionIcon() {
  return createMentionIcon(SKILL_ICON_SVG_MARKUP);
}

function isComposerChipElement(node: Node | null): node is HTMLElement {
  return (
    node instanceof HTMLElement &&
    (node.hasAttribute(MENTION_TAG_ATTR) ||
      node.hasAttribute(SKILL_MENTION_NAME_ATTR) ||
      node.hasAttribute(COMMIT_MENTION_SHA_ATTR) ||
      node.hasAttribute(GIT_FILE_MENTION_PATH_ATTR) ||
      node.hasAttribute(LARGE_PASTE_TAG_ATTR))
  );
}

function createCaretAnchorText(afterRaw: string, options?: { ensureLeadingSpace?: boolean }) {
  const cleaned = removeCaretAnchors(afterRaw);
  const matchedWhitespace = cleaned.match(/^\s+/)?.[0] ?? "";
  const leadingWhitespace =
    matchedWhitespace || (options?.ensureLeadingSpace === true ? CARET_SPACER_TEXT : "");
  const rest = cleaned.slice(matchedWhitespace.length);
  if (leadingWhitespace.length > 0) {
    return {
      text: `${leadingWhitespace}${rest}`,
      caretOffset: leadingWhitespace.length,
    };
  }
  return {
    text: `${CARET_ANCHOR_TEXT}${rest}`,
    caretOffset: CARET_ANCHOR_TEXT.length,
  };
}

function placeCaretInTextNode(textNode: Text, offset: number) {
  const range = document.createRange();
  range.setStart(textNode, Math.min(offset, textNode.data.length));
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function removeStaleCaretAnchorsFromTextNode(textNode: Text, offset: number) {
  if (!textNode.data.includes(CARET_ANCHOR_TEXT)) return false;

  const cleaned = removeCaretAnchors(textNode.data);
  if (cleaned.length === 0) return false;

  const nextOffset = Math.max(0, offset - countCaretAnchors(textNode.data.slice(0, offset)));
  textNode.data = cleaned;
  placeCaretInTextNode(textNode, Math.min(nextOffset, cleaned.length));
  return true;
}

function removeStaleCaretAnchorsAroundSelection(root: HTMLElement) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;

  const { startContainer: node, startOffset: offset } = sel.getRangeAt(0);
  if (!root.contains(node) || node.nodeType !== Node.TEXT_NODE) return false;
  if (isComposerChipElement(node.parentNode)) return false;

  return removeStaleCaretAnchorsFromTextNode(node as Text, offset);
}

function ensureCaretAnchorAfterChip(chip: HTMLElement): { textNode: Text; offset: number } | null {
  const parent = chip.parentNode;
  if (!parent) return null;

  const next = chip.nextSibling;
  if (next?.nodeType === Node.TEXT_NODE) {
    const textNode = next as Text;
    const anchor = createCaretAnchorText(textNode.data, { ensureLeadingSpace: true });
    if (textNode.data !== anchor.text) {
      textNode.data = anchor.text;
    }
    return { textNode, offset: anchor.caretOffset };
  }

  const anchor = createCaretAnchorText("", { ensureLeadingSpace: true });
  const textNode = document.createTextNode(anchor.text);
  parent.insertBefore(textNode, next);
  return { textNode, offset: anchor.caretOffset };
}

function normalizeCaretAfterChip(root: HTMLElement) {
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
  }

  return false;
}

function ensureTrailingCaretAnchor(root: HTMLElement) {
  const last = root.lastChild;
  if (isComposerChipElement(last)) {
    ensureCaretAnchorAfterChip(last);
  }
}

/** Find the nearest previous leaf node (for checking what precedes @). */
function prevLeaf(node: Node, root: Node): Node | null {
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

function rightmostTextNode(node: Node | null): Text | null {
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

function selectionTextPosition(root: HTMLElement): { textNode: Text; offset: number } | null {
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

/** Detect an in-progress @file or $skill mention at the cursor position. */
function detectMention(root: HTMLElement, skillsEnabled: boolean): MentionContext | null {
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
    if (before[i] === "$" && skillsEnabled) {
      triggerIdx = i;
      trigger = "skill";
      break;
    }
    if (isMentionBoundaryChar(before[i])) break;
  }
  if (triggerIdx < 0 || !trigger) return null;

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

function mentionContextEquals(a: MentionContext, b: MentionContext) {
  return (
    a.trigger === b.trigger &&
    a.query === b.query &&
    a.textNode === b.textNode &&
    a.triggerOffset === b.triggerOffset
  );
}

function createFileMentionChip(path: string, kind: FileMentionKind) {
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

function insertMentionChipElement(
  ctx: MentionContext,
  chip: HTMLElement,
  options?: { ensureSpaceAfterChip?: boolean },
) {
  const { textNode, triggerOffset, query } = ctx;
  const text = textNode.textContent || "";
  const parent = textNode.parentNode!;

  const beforeText = text.slice(0, triggerOffset);
  const afterRaw = text.slice(triggerOffset + 1 + query.length);
  const anchor = createCaretAnchorText(afterRaw, {
    ensureLeadingSpace: options?.ensureSpaceAfterChip === true,
  });
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
function insertMentionChip(ctx: MentionContext, path: string, kind: "file" | "dir") {
  const chip = createFileMentionChip(path, kind);
  if (!chip) return;
  insertMentionChipElement(ctx, chip, { ensureSpaceAfterChip: true });
}

function createSkillMentionChip(skill: MentionComposerSkillMention) {
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

function insertSkillMentionChip(ctx: MentionContext, skill: MentionComposerSkill) {
  const chip = createSkillMentionChip(skill);
  insertMentionChipElement(ctx, chip);
}

function createCommitMentionChip(commitInput: MentionComposerCommitMention) {
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

function createGitFileMentionChip(fileInput: MentionComposerGitFileMention) {
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

function createLargePasteChip(paste: MentionComposerLargePaste) {
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

function insertNodeAtCursor(
  root: HTMLElement,
  node: Node,
  options?: { ensureSpaceAfterNode?: boolean },
) {
  const anchor = createCaretAnchorText("", {
    ensureLeadingSpace: options?.ensureSpaceAfterNode === true,
  });
  const afterNode = document.createTextNode(anchor.text);
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    if (root.contains(range.commonAncestorContainer)) {
      range.deleteContents();
      range.insertNode(afterNode);
      range.insertNode(node);
      placeCaretInTextNode(afterNode, anchor.caretOffset);
      return;
    }
  }

  root.appendChild(node);
  root.appendChild(afterNode);
  placeCaretInTextNode(afterNode, anchor.caretOffset);
}

function scrollSelectionIntoComposerView(root: HTMLElement) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) {
    root.scrollTop = root.scrollHeight;
    return;
  }

  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) {
    return;
  }

  const marker = document.createElement("span");
  marker.textContent = "\u200B";
  marker.style.display = "inline-block";
  marker.style.width = "0";
  marker.style.height = "1em";
  marker.style.overflow = "hidden";

  const markerRange = range.cloneRange();
  markerRange.insertNode(marker);

  const markerRect = marker.getBoundingClientRect();
  const rootRect = root.getBoundingClientRect();
  const margin = 4;
  const bottomOverflow = markerRect.bottom - (rootRect.bottom - margin);
  const topOverflow = rootRect.top + margin - markerRect.top;

  if (bottomOverflow > 0) {
    root.scrollTop += bottomOverflow;
  } else if (topOverflow > 0) {
    root.scrollTop -= topOverflow;
  }

  marker.remove();
}

function scheduleComposerSelectionScroll(root: HTMLElement | null) {
  if (!root) return;
  window.requestAnimationFrame(() => {
    if (!root.isConnected) return;
    scrollSelectionIntoComposerView(root);
  });
}

type ComposerChipBeforeCursor = {
  chip: HTMLElement;
  textNode?: Text;
  offset?: number;
};

function caretSpacerTextIsEmpty(value: string) {
  return removeCaretAnchors(value).replace(/[ \t\u00A0]/g, "").length === 0;
}

function isCaretAnchorTextNode(textNode: Text, beforeCursor: string) {
  return (
    beforeCursor.length === 0 ||
    textNode.data.includes(CARET_ANCHOR_TEXT) ||
    caretSpacerTextIsEmpty(beforeCursor)
  );
}

function stripLeadingCaretAnchorText(value: string) {
  const anchorIndex = value.indexOf(CARET_ANCHOR_TEXT);
  if (anchorIndex < 0) return value.replace(/^[ \t\u00A0]/, "");
  const beforeAnchor = value.slice(0, anchorIndex);
  if (beforeAnchor.replace(/[ \t\u00A0]/g, "").length > 0) return value;
  return removeCaretAnchors(value.slice(anchorIndex + CARET_ANCHOR_TEXT.length));
}

function childNodeIndex(parent: Node, child: Node) {
  return Array.prototype.indexOf.call(parent.childNodes, child);
}

function placeCaretInNode(parent: Node, offset: number) {
  const range = document.createRange();
  range.setStart(parent, Math.min(Math.max(0, offset), parent.childNodes.length));
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/** Check if cursor is right after a mention chip, return that chip if so. */
function chipBeforeCursor(root: HTMLElement): ComposerChipBeforeCursor | null {
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

function deleteChipBeforeCursor(
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
    if (previousNode?.nodeType === Node.TEXT_NODE) {
      const previousTextNode = previousNode as Text;
      placeCaretInTextNode(previousTextNode, previousTextNode.data.length);
    } else {
      placeCaretInNode(parent, Math.min(chipIndex, parent.childNodes.length));
    }
  }

  return true;
}

/* ------------------------------------------------------------------ */
/*  Popup sub-component                                                */
/* ------------------------------------------------------------------ */

function Popup({
  anchorRef,
  suggestions,
  highlightIndex,
  isLoading,
  error,
  showEmpty,
  emptyLabel,
  onSelect,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  suggestions: MentionSuggestion[];
  highlightIndex: number;
  isLoading: boolean;
  error: string | null;
  showEmpty: boolean;
  emptyLabel: string;
  onSelect: (suggestion: MentionSuggestion) => void;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  const hlRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    hlRef.current?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const popup = popupRef.current;
    if (!anchor || !popup) return;

    const update = () => {
      const rect = anchor.getBoundingClientRect();
      popup.style.left = `${rect.left}px`;
      popup.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 8)}px`;
      popup.style.width = `${rect.width}px`;
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(anchor);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef]);

  return createPortal(
    <div
      ref={popupRef}
      className={cn(
        "mention-popup-enter fixed z-[100] overflow-hidden rounded-2xl",
        "border border-white/55 bg-white/75 shadow-[0_18px_48px_-12px_rgba(15,23,42,0.22),0_2px_8px_-2px_rgba(15,23,42,0.06)]",
        "backdrop-blur-2xl backdrop-saturate-[180%]",
        "dark:border-white/[0.08] dark:bg-slate-900/65 dark:shadow-[0_18px_48px_-10px_rgba(0,0,0,0.55)]",
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-4 top-0 h-px rounded-full bg-gradient-to-r from-transparent via-white/85 to-transparent dark:via-white/15"
      />
      <div className="mention-popup-scroll relative max-h-[260px] overflow-y-auto py-0.5">
        {isLoading && (
          <div className="px-3 py-2 text-xs text-muted-foreground">Indexing files...</div>
        )}
        {error && !isLoading && <div className="px-3 py-2 text-xs text-destructive">{error}</div>}
        {suggestions.map((suggestion, i) => {
          const isSkill = suggestion.type === "skill";
          const entry = suggestion.type === "file" ? suggestion.entry : null;
          const skill = suggestion.type === "skill" ? suggestion.skill : null;
          const isDir = entry?.kind === "dir";
          const parts = entry ? entry.path.split("/") : [];
          const fileName = parts.pop() || "";
          const dirPath = parts.join("/");
          const Icon = entry ? getFileTypeIcon(entry.path, entry.kind) : null;
          const title = skill?.name ?? fileName;
          const subtitle = skill?.description ?? (dirPath ? `${dirPath}/` : "");
          return (
            <div
              key={
                entry ? `${entry.kind}:${entry.path}` : `skill:${skill?.skillFile ?? skill?.name}`
              }
              ref={i === highlightIndex ? hlRef : undefined}
              className={cn(
                "mention-popup-item group mx-1.5 flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-[calc(13px*var(--zone-font-scale,1))] leading-5 transition-all",
                i === highlightIndex
                  ? "bg-foreground/[0.08] text-foreground shadow-[inset_0_0_0_1px_rgba(15,23,42,0.06)] dark:bg-white/[0.08] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]"
                  : "text-foreground/85 hover:bg-foreground/[0.04] dark:text-foreground/90 dark:hover:bg-white/[0.04]",
              )}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(suggestion);
              }}
            >
              <span
                className={cn(
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded-md",
                  isSkill
                    ? "bg-violet-500/10 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300"
                    : isDir
                      ? "bg-amber-500/10 dark:bg-amber-400/15"
                      : "bg-foreground/[0.04] dark:bg-white/[0.05]",
                )}
              >
                {Icon ? <Icon width={12} height={12} /> : <SkillIcon width={12} height={12} />}
              </span>
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium tracking-tight text-foreground/95">{title}</span>
                {subtitle && (
                  <span className="ml-1.5 text-[calc(10px*var(--zone-font-scale,1))] text-muted-foreground/85">
                    {subtitle}
                  </span>
                )}
              </span>
              {isSkill ? (
                <span className="shrink-0 text-[calc(10px*var(--zone-font-scale,1))] uppercase tracking-wider text-muted-foreground/60">
                  skill
                </span>
              ) : (
                isDir && (
                  <span className="shrink-0 text-[calc(10px*var(--zone-font-scale,1))] uppercase tracking-wider text-muted-foreground/60">
                    dir
                  </span>
                )
              )}
            </div>
          );
        })}
        {showEmpty && !isLoading && !error && suggestions.length === 0 && (
          <div className="px-3 py-2 text-xs text-muted-foreground">{emptyLabel}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function formatCommitTooltipDate(value: string, locale: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const absolute = date.toLocaleString(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const deltaSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const units: Array<{
    unit: "year" | "month" | "day" | "hour" | "minute" | "second";
    seconds: number;
  }> = [
    { unit: "year", seconds: 365 * 24 * 60 * 60 },
    { unit: "month", seconds: 30 * 24 * 60 * 60 },
    { unit: "day", seconds: 24 * 60 * 60 },
    { unit: "hour", seconds: 60 * 60 },
    { unit: "minute", seconds: 60 },
    { unit: "second", seconds: 1 },
  ];
  const selected = units.find(({ seconds }) => Math.abs(deltaSeconds) >= seconds) ?? units.at(-1)!;
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
    Math.round(deltaSeconds / selected.seconds),
    selected.unit,
  );
  return { relative, absolute };
}

function GitHubMarkIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 16 16"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.6 7.6 0 0 1 8 3.86c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function commitStatLabel(template: string, count: string) {
  return template.replace("{count}", count);
}

function CommitMentionTooltip({
  commit,
  rect,
  onMouseEnter,
  onMouseLeave,
}: {
  commit: MentionComposerCommitMention;
  rect: DOMRect;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const { locale, t } = useLocale();
  const maxWidth = Math.min(440, window.innerWidth - 16);
  const minWidth = Math.min(200, maxWidth);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [tooltipWidth, setTooltipWidth] = useState(minWidth);
  const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - tooltipWidth - 8));
  const availableAbove = rect.top - 16;
  const availableBelow = window.innerHeight - rect.bottom - 16;
  const placeAbove = availableAbove > 260 || availableAbove > availableBelow;
  const maxHeight = Math.max(120, Math.min(520, placeAbove ? availableAbove : availableBelow));
  const top = placeAbove
    ? Math.max(8, rect.top - 8)
    : Math.min(window.innerHeight - 8, rect.bottom + 8);
  const shortSha = commit.shortSha || commit.sha.slice(0, 7);
  const author = commit.authorName || t("chat.composer.commitTooltipUnknownAuthor");
  const date = formatCommitTooltipDate(commit.authorDate, locale);
  const fileCount = commit.filesChanged || commit.fileCount;
  const filesChangedLabel = commitStatLabel(
    t("chat.composer.commitTooltipFilesChanged"),
    formatLargePasteCount(fileCount),
  );
  const insertionsLabel = commitStatLabel(
    t("chat.composer.commitTooltipInsertions"),
    formatLargePasteCount(commit.insertions),
  );
  const deletionsLabel = commitStatLabel(
    t("chat.composer.commitTooltipDeletions"),
    formatLargePasteCount(commit.deletions),
  );
  const messageBody = commit.body.trim();
  const subject = commit.subject.trim() || shortSha;
  const authorLabel = commit.authorEmail ? `${author} <${commit.authorEmail}>` : author;

  useLayoutEffect(() => {
    const node = tooltipRef.current;
    if (!node) return;
    const measuredWidth = Math.ceil(node.getBoundingClientRect().width);
    setTooltipWidth(Math.min(maxWidth, Math.max(minWidth, measuredWidth)));
  }, [commit, maxWidth, minWidth]);

  return createPortal(
    <div
      ref={tooltipRef}
      className="fixed z-[10000] overflow-y-auto rounded-xl border border-border bg-popover px-3 py-2.5 text-xs text-popover-foreground shadow-xl"
      style={{
        left,
        top,
        width: "fit-content",
        minWidth,
        maxWidth,
        maxHeight,
        transform: placeAbove ? "translateY(-100%)" : "none",
      }}
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="flex items-start gap-2">
        <GitHubMarkIcon className="mt-0.5 h-4 w-4 shrink-0 text-foreground" />
        <div className="min-w-0">
          <div className="break-words font-medium leading-tight">{authorLabel}</div>
          {date ? (
            <div className="mt-0.5 text-[calc(11px*var(--zone-font-scale,1))] leading-tight text-muted-foreground">
              {date.relative} ({date.absolute})
            </div>
          ) : null}
        </div>
      </div>
      <div className="mt-2 whitespace-pre-wrap break-words font-medium leading-snug">{subject}</div>
      {messageBody ? (
        <div className="mt-1.5 whitespace-pre-wrap break-words leading-snug text-muted-foreground">
          {messageBody}
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[calc(11px*var(--zone-font-scale,1))] leading-tight">
        <span className="text-muted-foreground">{filesChangedLabel}</span>
        <span className="font-medium text-emerald-600 dark:text-emerald-400">
          {insertionsLabel}
        </span>
        <span className="font-medium text-rose-600 dark:text-rose-400">{deletionsLabel}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/70 pt-1.5 text-[calc(11px*var(--zone-font-scale,1))] leading-tight text-muted-foreground">
        <span className="font-mono text-foreground">{shortSha}</span>
        {commit.remoteName ? <span>{commit.remoteName}</span> : null}
        {commit.githubUrl ? (
          <>
            <span className="text-border">|</span>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-primary hover:bg-primary/10"
              onClick={() => void openUrl(commit.githubUrl!)}
            >
              <GitHubMarkIcon className="h-3 w-3" />
              {t("chat.composer.commitTooltipOpenGithub")}
            </button>
          </>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ */
/*  MentionComposer                                                    */
/* ------------------------------------------------------------------ */

export const MentionComposer = memo(
  forwardRef<MentionComposerHandle, MentionComposerProps>(function MentionComposer(
    {
      onSend,
      onEmptyChange,
      onBusyChange,
      onPasteFiles,
      disabled = false,
      placeholder = "",
      workdir,
      enabledSkills = [],
      className,
    }: MentionComposerProps,
    ref,
  ) {
    const { locale } = useLocale();
    const editorRef = useRef<HTMLDivElement>(null);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const composerContextMenuRef = useRef<HTMLDivElement>(null);
    const composerContextMenuRangeRef = useRef<Range | null>(null);
    const commitTooltipCloseTimerRef = useRef<number | null>(null);
    const commitTooltipChipRef = useRef<HTMLElement | null>(null);
    const [isDomEmpty, setIsDomEmpty] = useState(true);
    const lastIsEmptyRef = useRef(true);
    const lastIsDomEmptyRef = useRef(true);
    const isComposingRef = useRef(false);
    const compositionEnterKeyRef = useRef(false);
    const lastCompositionEndAtRef = useRef(0);
    const imeEnterSuppressUntilRef = useRef(0);
    const busyReleaseTimerRef = useRef<number | null>(null);
    const isBusyRef = useRef(false);
    const largePastesRef = useRef(new Map<string, MentionComposerLargePaste>());
    const largePasteCounterRef = useRef(0);
    const [composerContextMenu, setComposerContextMenu] = useState<ComposerContextMenuState | null>(
      null,
    );
    const [commitTooltip, setCommitTooltip] = useState<{
      commit: MentionComposerCommitMention;
      rect: DOMRect;
    } | null>(null);

    const closeCommitTooltip = useCallback(() => {
      commitTooltipChipRef.current = null;
      setCommitTooltip(null);
    }, []);

    const closeComposerContextMenu = useCallback(() => {
      composerContextMenuRangeRef.current = null;
      setComposerContextMenu(null);
    }, []);

    const setBusy = useCallback(
      (nextBusy: boolean) => {
        if (isBusyRef.current === nextBusy) return;
        isBusyRef.current = nextBusy;
        onBusyChange?.(nextBusy);
      },
      [onBusyChange],
    );

    const scheduleBusyRelease = useCallback(() => {
      if (busyReleaseTimerRef.current !== null) {
        window.clearTimeout(busyReleaseTimerRef.current);
      }
      busyReleaseTimerRef.current = window.setTimeout(() => {
        busyReleaseTimerRef.current = null;
        setBusy(false);
      }, 140);
    }, [setBusy]);

    // ---- File list ----
    const normalizedWorkdir = workdir.trim();
    const [mentionSessionEntries, setMentionSessionEntries] = useState<MentionFileEntry[]>([]);
    const [mentionSessionLoading, setMentionSessionLoading] = useState(false);
    const [mentionSessionError, setMentionSessionError] = useState<string | null>(null);
    const mentionSessionRequestSeqRef = useRef(0);
    const mentionActiveRef = useRef(false);
    const mentionSessionQueryRef = useRef("");
    const mentionFetchRef = useRef<{ trigger: MentionContext["trigger"]; query: string } | null>(
      null,
    );

    // ---- Mention state ----
    const [mentionCtx, setMentionCtx] = useState<MentionContext | null>(null);
    const [highlightIdx, setHighlightIdx] = useState(0);

    const resetMentionSession = useCallback(() => {
      mentionSessionRequestSeqRef.current += 1;
      mentionSessionQueryRef.current = "";
      mentionFetchRef.current = null;
      setMentionSessionEntries([]);
      setMentionSessionLoading(false);
      setMentionSessionError(null);
    }, []);

    const closeMentionSession = useCallback(() => {
      mentionActiveRef.current = false;
      setMentionCtx(null);
      setHighlightIdx(0);
      resetMentionSession();
    }, [resetMentionSession]);

    const startMentionSession = useCallback(
      (ctx: MentionContext) => {
        const requestSeq = ++mentionSessionRequestSeqRef.current;
        mentionSessionQueryRef.current = ctx.query;
        mentionFetchRef.current = { trigger: ctx.trigger, query: normalizeMentionQuery(ctx.query) };
        setMentionSessionEntries([]);
        setMentionSessionLoading(ctx.trigger === "file" && Boolean(normalizedWorkdir));
        setMentionSessionError(null);

        if (ctx.trigger === "skill") {
          return;
        }
        if (!normalizedWorkdir) {
          return;
        }

        invokeFs<MentionListResponse>("fs_mention_list", {
          workdir: normalizedWorkdir,
          max_results: MENTION_INDEX_MAX_RESULTS,
          query: ctx.query,
        })
          .then((resp) => {
            if (requestSeq !== mentionSessionRequestSeqRef.current) return;
            setMentionSessionEntries(resp.entries);
          })
          .catch(() => {
            if (requestSeq !== mentionSessionRequestSeqRef.current) return;
            setMentionSessionEntries([]);
            setMentionSessionError("Could not index files");
          })
          .finally(() => {
            if (requestSeq !== mentionSessionRequestSeqRef.current) return;
            setMentionSessionLoading(false);
          });
      },
      [normalizedWorkdir],
    );

    const mentionSessionSearchIndex = useMemo<MentionSearchEntry[]>(
      () =>
        mentionSessionEntries.map((entry) => ({
          entry,
          searchPath: entry.path.toLowerCase(),
        })),
      [mentionSessionEntries],
    );

    useEffect(() => {
      closeMentionSession();
    }, [normalizedWorkdir, closeMentionSession]);

    useEffect(() => {
      return () => {
        mentionSessionRequestSeqRef.current += 1;
        if (busyReleaseTimerRef.current !== null) {
          window.clearTimeout(busyReleaseTimerRef.current);
        }
        setBusy(false);
      };
    }, [setBusy]);

    useEffect(() => {
      if (!disabled) return;
      closeMentionSession();
      setBusy(false);
    }, [disabled, closeMentionSession, setBusy]);

    useEffect(() => {
      if (!composerContextMenu) return;

      const handlePointerDown = (event: PointerEvent) => {
        const target = event.target;
        if (!(target instanceof Node)) {
          closeComposerContextMenu();
          return;
        }
        if (composerContextMenuRef.current?.contains(target)) {
          return;
        }
        closeComposerContextMenu();
      };

      const handleKeyDown = (event: globalThis.KeyboardEvent) => {
        if (event.key === "Escape") {
          closeComposerContextMenu();
        }
      };

      const handleClose = () => {
        closeComposerContextMenu();
      };

      window.addEventListener("pointerdown", handlePointerDown, true);
      window.addEventListener("keydown", handleKeyDown, true);
      window.addEventListener("scroll", handleClose, true);
      window.addEventListener("resize", handleClose);
      window.addEventListener("blur", handleClose);

      return () => {
        window.removeEventListener("pointerdown", handlePointerDown, true);
        window.removeEventListener("keydown", handleKeyDown, true);
        window.removeEventListener("scroll", handleClose, true);
        window.removeEventListener("resize", handleClose);
        window.removeEventListener("blur", handleClose);
      };
    }, [closeComposerContextMenu, composerContextMenu]);

    const normalizedMentionQuery = mentionCtx ? normalizeMentionQuery(mentionCtx.query) : "";
    const suggestions = useMemo<MentionSuggestion[]>(() => {
      if (mentionCtx === null) {
        return [];
      }

      if (mentionCtx.trigger === "skill") {
        const next: MentionSuggestion[] = [];
        for (const skill of enabledSkills) {
          const haystack = `${skill.name}\n${skill.description}\n${skill.baseDir}`.toLowerCase();
          if (normalizedMentionQuery && !haystack.includes(normalizedMentionQuery)) {
            continue;
          }
          next.push({ type: "skill", skill });
          if (next.length >= MAX_SUGGESTIONS) {
            break;
          }
        }
        return next;
      }

      const next: MentionSuggestion[] = [];
      for (const item of mentionSessionSearchIndex) {
        if (normalizedMentionQuery && !item.searchPath.includes(normalizedMentionQuery)) {
          continue;
        }
        next.push({ type: "file", entry: item.entry });
        if (next.length >= MAX_SUGGESTIONS) {
          break;
        }
      }
      return next;
    }, [enabledSkills, mentionCtx, mentionSessionSearchIndex, normalizedMentionQuery]);

    useEffect(() => {
      setHighlightIdx((current) => {
        if (suggestions.length === 0) return 0;
        return Math.min(current, suggestions.length - 1);
      });
    }, [suggestions.length]);

    const popupLoading = mentionSessionLoading;
    const popupError = suggestions.length === 0 ? mentionSessionError : null;
    const popupEmptyLabel =
      mentionCtx?.trigger === "skill" ? "No matching enabled Skills" : "No matching files";
    const showEmpty =
      mentionCtx !== null && !popupLoading && !popupError && suggestions.length === 0;
    const popupVisible =
      mentionCtx !== null &&
      (popupLoading || Boolean(popupError) || suggestions.length > 0 || showEmpty);

    const applyEmptyState = useCallback(
      (nextEmpty: boolean, nextDomEmpty: boolean) => {
        if (lastIsEmptyRef.current !== nextEmpty) {
          lastIsEmptyRef.current = nextEmpty;
          onEmptyChange?.(nextEmpty);
        }
        if (lastIsDomEmptyRef.current !== nextDomEmpty) {
          lastIsDomEmptyRef.current = nextDomEmpty;
          setIsDomEmpty(nextDomEmpty);
        }
      },
      [onEmptyChange],
    );

    const refreshEmptyState = useCallback(() => {
      const el = editorRef.current;
      if (!el) return;
      applyEmptyState(editorTextIsEmpty(el), editorHasNoContent(el));
    }, [applyEmptyState]);

    // ---- Typewriter (typeText) ----
    // While a run is active the editor drops contentEditable so keyboard and
    // IME input cannot interleave user text with the scripted text.
    const typewriterRef = useRef<{
      timer: number;
      finish: () => void;
      settle: (restoreFocus: boolean) => void;
    } | null>(null);
    const [isTypewriting, setIsTypewriting] = useState(false);
    const typewriterFocusPendingRef = useRef(false);

    const placeCaretAtEditorEnd = useCallback(() => {
      const el = editorRef.current;
      if (!el) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }, []);

    const cancelTypewriter = useCallback(() => {
      const active = typewriterRef.current;
      if (!active) return;
      typewriterRef.current = null;
      window.clearTimeout(active.timer);
      active.settle(false);
    }, []);

    // Programmatic draft reads and mention inserts complete the animation
    // instantly so they always observe the full suggestion text.
    const finishTypewriter = useCallback(() => {
      const active = typewriterRef.current;
      if (!active) return;
      typewriterRef.current = null;
      window.clearTimeout(active.timer);
      active.finish();
      active.settle(true);
    }, []);

    useEffect(() => cancelTypewriter, [cancelTypewriter]);

    // Restore focus only after React has re-enabled contentEditable; focusing
    // inside settle() would race the attribute flip and get dropped.
    useEffect(() => {
      if (isTypewriting || !typewriterFocusPendingRef.current) return;
      typewriterFocusPendingRef.current = false;
      const el = editorRef.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      placeCaretAtEditorEnd();
    }, [isTypewriting, placeCaretAtEditorEnd]);

    const buildDraft = useCallback((): MentionComposerDraft => {
      const el = editorRef.current;
      if (!el) {
        return {
          segments: [],
          text: "",
          textWithoutLargePastes: "",
          largePastes: [],
          skillMentions: [],
          commitMentions: [],
          gitFileMentions: [],
          isEmpty: true,
        };
      }

      const segments = serializeChildrenToSegments(el, largePastesRef.current);
      const largePastes: MentionComposerLargePaste[] = [];
      const skillMentions: MentionComposerSkillMention[] = [];
      const commitMentions: MentionComposerCommitMention[] = [];
      const gitFileMentions: MentionComposerGitFileMention[] = [];
      const textParts: string[] = [];
      const textWithoutLargePastesParts: string[] = [];
      for (const segment of segments) {
        if (segment.type === "text") {
          textParts.push(segment.text);
          textWithoutLargePastesParts.push(segment.text);
        } else if (segment.type === "fileMention") {
          const token = formatFileMentionToken(segment.reference);
          textParts.push(token);
          textWithoutLargePastesParts.push(token);
        } else if (segment.type === "largePaste") {
          largePastes.push(segment.paste);
          textParts.push(segment.paste.text);
        } else if (segment.type === "skillMention") {
          skillMentions.push(segment.skill);
          const token = formatSkillMentionToken(segment.skill);
          textParts.push(token);
          textWithoutLargePastesParts.push(token);
        } else if (segment.type === "commitMention") {
          commitMentions.push(segment.commit);
          const token = formatCommitMentionToken(segment.commit);
          textParts.push(token);
          textWithoutLargePastesParts.push(token);
        } else if (segment.type === "gitFileMention") {
          gitFileMentions.push(segment.file);
          const token = formatGitFileMentionToken(segment.file);
          textParts.push(token);
          textWithoutLargePastesParts.push(token);
        }
      }

      const text = normalizeSerializedText(textParts.join(""));
      const textWithoutLargePastes = normalizeSerializedText(textWithoutLargePastesParts.join(""));
      return {
        segments,
        text,
        textWithoutLargePastes,
        largePastes,
        skillMentions,
        commitMentions,
        gitFileMentions,
        isEmpty: editorTextIsEmpty(el),
      };
    }, []);

    const createLargePaste = useCallback((text: string): MentionComposerLargePaste => {
      const index = largePasteCounterRef.current + 1;
      largePasteCounterRef.current = index;
      return {
        id: `large-paste-${Date.now()}-${crypto.randomUUID()}`,
        label: `Pasted text ${index}`,
        text,
        charCount: text.length,
        lineCount: countLargePasteLines(text),
        preview: normalizeLargePastePreview(text),
      };
    }, []);

    const insertLargePaste = useCallback(
      (text: string) => {
        const el = editorRef.current;
        if (!el) return;
        const paste = createLargePaste(text);
        largePastesRef.current.set(paste.id, paste);
        insertNodeAtCursor(el, createLargePasteChip(paste));
        closeMentionSession();
        refreshEmptyState();
      },
      [closeMentionSession, createLargePaste, refreshEmptyState],
    );

    // ---- Mention detection (called after DOM updates) ----
    const refreshMention = useCallback(() => {
      const el = editorRef.current;
      if (!el) return;
      const applyContext = (ctx: MentionContext | null) => {
        if (!ctx) {
          if (mentionActiveRef.current) {
            closeMentionSession();
          }
          return;
        }
        setMentionCtx((prev) => (prev && mentionContextEquals(prev, ctx) ? prev : ctx));
        if (!mentionActiveRef.current) {
          mentionActiveRef.current = true;
          setHighlightIdx(0);
          startMentionSession(ctx);
          return;
        }
        if (ctx.query === mentionSessionQueryRef.current) return;
        mentionSessionQueryRef.current = ctx.query;
        setHighlightIdx(0);
        // The backend filters entries by the query used at fetch time, so the
        // cached snapshot only narrows further; refetch once that breaks.
        const fetched = mentionFetchRef.current;
        if (
          fetched &&
          (fetched.trigger !== ctx.trigger ||
            !normalizeMentionQuery(ctx.query).startsWith(fetched.query))
        ) {
          startMentionSession(ctx);
        }
      };

      applyContext(detectMention(el, enabledSkills.length > 0));
      window.requestAnimationFrame(() => {
        const nextEl = editorRef.current;
        if (!nextEl || document.activeElement !== nextEl) return;
        applyContext(detectMention(nextEl, enabledSkills.length > 0));
      });
    }, [closeMentionSession, enabledSkills.length, startMentionSession]);

    useImperativeHandle(
      ref,
      () => ({
        getText: () => {
          const el = editorRef.current;
          if (!el) return "";
          finishTypewriter();
          return normalizeSerializedText(serializeChildren(el, largePastesRef.current));
        },
        getDraft: () => {
          finishTypewriter();
          return buildDraft();
        },
        hasContent: () => {
          const el = editorRef.current;
          return el != null && !editorTextIsEmpty(el);
        },
        setText: (text: string) => {
          const el = editorRef.current;
          if (!el) return;
          cancelTypewriter();
          el.innerHTML = "";
          largePastesRef.current.clear();
          closeCommitTooltip();
          closeComposerContextMenu();
          if (isLargePasteText(text)) {
            insertLargePaste(text);
          } else {
            el.innerText = text;
            closeMentionSession();
            refreshEmptyState();
          }
        },
        setDraft: (draft: MentionComposerDraft) => {
          const el = editorRef.current;
          if (!el) return;
          cancelTypewriter();
          el.innerHTML = "";
          largePastesRef.current.clear();
          closeCommitTooltip();
          closeComposerContextMenu();

          for (const segment of draft.segments) {
            if (segment.type === "largePaste") {
              largePastesRef.current.set(segment.paste.id, segment.paste);
              el.appendChild(createLargePasteChip(segment.paste));
            } else if (segment.type === "fileMention") {
              const chip = createFileMentionChip(segment.reference.path, segment.reference.kind);
              if (chip) el.appendChild(chip);
            } else if (segment.type === "skillMention") {
              el.appendChild(createSkillMentionChip(segment.skill));
            } else if (segment.type === "commitMention") {
              el.appendChild(createCommitMentionChip(segment.commit));
            } else if (segment.type === "gitFileMention") {
              el.appendChild(createGitFileMentionChip(segment.file));
            } else if (segment.text) {
              el.appendChild(document.createTextNode(segment.text));
            }
          }
          largePasteCounterRef.current = Math.max(
            largePasteCounterRef.current,
            largePastesRef.current.size,
          );

          ensureTrailingCaretAnchor(el);
          closeMentionSession();
          refreshEmptyState();
        },
        insertFileMention: (path: string, kind: "file" | "dir") => {
          const el = editorRef.current;
          if (!el) return;
          finishTypewriter();
          el.focus();
          const chip = createFileMentionChip(path, kind);
          if (!chip) return;
          insertNodeAtCursor(el, chip, { ensureSpaceAfterNode: true });
          closeMentionSession();
          refreshEmptyState();
        },
        insertCommitMention: (commit: MentionComposerCommitMention) => {
          const el = editorRef.current;
          if (!el) return;
          finishTypewriter();
          el.focus();
          insertNodeAtCursor(el, createCommitMentionChip(commit), { ensureSpaceAfterNode: true });
          closeMentionSession();
          refreshEmptyState();
        },
        insertGitFileMention: (file: MentionComposerGitFileMention) => {
          const el = editorRef.current;
          if (!el) return;
          finishTypewriter();
          el.focus();
          insertNodeAtCursor(el, createGitFileMentionChip(file), { ensureSpaceAfterNode: true });
          closeMentionSession();
          refreshEmptyState();
        },
        clear: () => {
          const el = editorRef.current;
          if (!el) return;
          cancelTypewriter();
          el.innerHTML = "";
          largePastesRef.current.clear();
          closeCommitTooltip();
          closeComposerContextMenu();
          closeMentionSession();
          refreshEmptyState();
        },
        focus: () => editorRef.current?.focus(),
        typeText: (text: string) => {
          const el = editorRef.current;
          if (!el) return Promise.resolve();
          cancelTypewriter();
          el.innerHTML = "";
          largePastesRef.current.clear();
          closeCommitTooltip();
          closeComposerContextMenu();
          closeMentionSession();
          el.focus({ preventScroll: true });

          const chars = Array.from(text);
          const textNode = document.createTextNode("");
          el.appendChild(textNode);
          if (chars.length === 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            textNode.data = chars.join("");
            placeCaretAtEditorEnd();
            refreshEmptyState();
            return Promise.resolve();
          }

          return new Promise<void>((resolve) => {
            let settled = false;
            const settle = (restoreFocus: boolean) => {
              if (settled) return;
              settled = true;
              typewriterFocusPendingRef.current = restoreFocus;
              setIsTypewriting(false);
              resolve();
            };
            setIsTypewriting(true);

            // Freshly typed characters live in short-lived fade-in spans, then
            // fold into the committed text node once their fade completes, so
            // the editor always ends up holding one plain text node.
            const ghosts: HTMLSpanElement[] = [];
            const foldOldestGhost = () => {
              const ghost = ghosts.shift();
              if (!ghost) return;
              textNode.data += ghost.textContent ?? "";
              ghost.remove();
            };
            const finish = () => {
              for (const ghost of ghosts) ghost.remove();
              ghosts.length = 0;
              textNode.data = chars.join("");
              placeCaretAtEditorEnd();
              refreshEmptyState();
            };

            // Adaptive pace: long prompts speed up so the whole line lands in ~1s.
            const tickMs = Math.max(12, Math.min(28, Math.round(900 / chars.length)));
            const maxGhosts = Math.max(1, Math.ceil(TYPEWRITER_CHAR_FADE_MS / tickMs));
            let index = 0;
            const tick = () => {
              if (index < chars.length) {
                const ghost = document.createElement("span");
                ghost.className = "composer-typewriter-char";
                ghost.textContent = chars[index] ?? "";
                el.appendChild(ghost);
                ghosts.push(ghost);
                index += 1;
                while (ghosts.length > maxGhosts) foldOldestGhost();
                placeCaretAtEditorEnd();
                refreshEmptyState();
                typewriterRef.current = { timer: window.setTimeout(tick, tickMs), finish, settle };
                return;
              }
              if (ghosts.length > 0) {
                foldOldestGhost();
                placeCaretAtEditorEnd();
                typewriterRef.current = { timer: window.setTimeout(tick, tickMs), finish, settle };
                return;
              }
              typewriterRef.current = null;
              settle(true);
            };
            refreshEmptyState();
            typewriterRef.current = { timer: window.setTimeout(tick, tickMs), finish, settle };
          });
        },
      }),
      [
        buildDraft,
        cancelTypewriter,
        closeCommitTooltip,
        closeComposerContextMenu,
        closeMentionSession,
        finishTypewriter,
        insertLargePaste,
        placeCaretAtEditorEnd,
        refreshEmptyState,
      ],
    );

    // ---- Select suggestion ----
    const selectSuggestion = useCallback(
      (suggestion: MentionSuggestion) => {
        if (!mentionCtx) return;
        if (!mentionCtx.textNode.isConnected) {
          closeMentionSession();
          return;
        }
        if (suggestion.type === "skill") {
          insertSkillMentionChip(mentionCtx, suggestion.skill);
        } else {
          insertMentionChip(mentionCtx, suggestion.entry.path, suggestion.entry.kind);
        }
        closeMentionSession();
        refreshEmptyState();
        editorRef.current?.focus();
      },
      [closeMentionSession, mentionCtx, refreshEmptyState],
    );

    const restoreComposerContextSelection = useCallback(() => {
      const el = editorRef.current;
      const range = composerContextMenuRangeRef.current;
      if (!el || !range || !editorRangeIsInsideRoot(el, range)) return false;

      const selection = window.getSelection();
      if (!selection) return false;

      try {
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
      } catch {
        return false;
      }
    }, []);

    const contextMenuPosition = composerContextMenu
      ? clampComposerContextMenuPosition(composerContextMenu.x, composerContextMenu.y)
      : null;
    const contextMenuLabels =
      locale === "en-US"
        ? {
            cut: "Cut",
            copy: "Copy",
            paste: "Paste",
            selectAll: "Select all",
          }
        : {
            cut: "剪切",
            copy: "复制",
            paste: "粘贴",
            selectAll: "全选",
          };
    const contextMenuHasSelection = Boolean(composerContextMenu?.selectedText.length);
    const contextMenuCanMutate = !disabled;

    const handleComposerContextCopy = useCallback(() => {
      if (!composerContextMenu?.selectedText) return;
      restoreComposerContextSelection();
      writeTextToClipboard(composerContextMenu.selectedText);
      closeComposerContextMenu();
    }, [closeComposerContextMenu, composerContextMenu, restoreComposerContextSelection]);

    const handleComposerContextCut = useCallback(() => {
      const el = editorRef.current;
      const selectedText = composerContextMenu?.selectedText;
      if (!el || disabled || !selectedText) return;

      restoreComposerContextSelection();
      if (!deleteComposerSelection(el, largePastesRef.current)) return;

      writeTextToClipboard(selectedText);
      closeMentionSession();
      refreshEmptyState();
      refreshMention();
      el.focus({ preventScroll: true });
      closeComposerContextMenu();
    }, [
      closeComposerContextMenu,
      closeMentionSession,
      composerContextMenu?.selectedText,
      disabled,
      refreshEmptyState,
      refreshMention,
      restoreComposerContextSelection,
    ]);

    const handleComposerContextPaste = useCallback(async () => {
      const el = editorRef.current;
      if (!el || disabled) return;

      el.focus({ preventScroll: true });

      let text: string | null = null;
      try {
        text = (await navigator.clipboard?.readText?.()) ?? "";
      } catch {
        text = null;
      }

      restoreComposerContextSelection();

      if (text === null) {
        document.execCommand("paste");
        closeMentionSession();
        refreshEmptyState();
        refreshMention();
        closeComposerContextMenu();
        return;
      }

      if (!text) {
        closeComposerContextMenu();
        return;
      }

      if (isLargePasteText(text)) {
        insertLargePaste(text);
        refreshMention();
        closeComposerContextMenu();
        return;
      }

      document.execCommand("insertText", false, text);
      closeMentionSession();
      refreshEmptyState();
      refreshMention();
      closeComposerContextMenu();
    }, [
      closeComposerContextMenu,
      closeMentionSession,
      disabled,
      insertLargePaste,
      refreshEmptyState,
      refreshMention,
      restoreComposerContextSelection,
    ]);

    const handleComposerContextSelectAll = useCallback(() => {
      const el = editorRef.current;
      if (!el || !composerContextMenu?.hasContent) return;

      el.focus({ preventScroll: true });
      selectComposerContents(el);
      closeMentionSession();
      closeComposerContextMenu();
    }, [closeComposerContextMenu, closeMentionSession, composerContextMenu?.hasContent]);

    // ---- Event handlers ----
    const handleContextMenu = useCallback(
      (event: MouseEvent<HTMLDivElement>) => {
        event.preventDefault();

        const el = editorRef.current;
        if (!el) return;

        closeMentionSession();
        closeCommitTooltip();

        const selection = window.getSelection();
        let selectedText = "";
        let rangeForMenu: Range | null = null;

        if (selectionContainsPoint(el, selection, event.clientX, event.clientY)) {
          selectedText = resolveComposerSelectionText(el, largePastesRef.current);
          rangeForMenu = editorSelectionRange(el)?.cloneRange() ?? null;
        } else {
          el.focus({ preventScroll: true });
          if (placeComposerCaretFromPoint(el, event.clientX, event.clientY)) {
            rangeForMenu = editorSelectionRange(el)?.cloneRange() ?? null;
          } else {
            selection?.removeAllRanges();
          }
        }

        composerContextMenuRangeRef.current = rangeForMenu;
        setComposerContextMenu({
          x: event.clientX,
          y: event.clientY,
          selectedText,
          hasContent: !editorTextIsEmpty(el),
        });
      },
      [closeCommitTooltip, closeMentionSession],
    );

    // Large-paste chips can be removed by native editing paths (select +
    // delete, cut); drop their map entries so the pasted text is released.
    const pruneDetachedLargePastes = useCallback(() => {
      const el = editorRef.current;
      const pastes = largePastesRef.current;
      if (!el || pastes.size === 0) return;
      const attached = new Set<string>();
      el.querySelectorAll(`[${LARGE_PASTE_TAG_ATTR}]`).forEach((chip) => {
        const id = chip.getAttribute(LARGE_PASTE_TAG_ATTR);
        if (id) attached.add(id);
      });
      for (const id of pastes.keys()) {
        if (!attached.has(id)) pastes.delete(id);
      }
    }, []);

    const handleInput = useCallback(() => {
      closeComposerContextMenu();
      const el = editorRef.current;
      if (el) {
        removeStaleCaretAnchorsAroundSelection(el);
        normalizeCaretAfterChip(el);
      }
      pruneDetachedLargePastes();
      refreshEmptyState();
      if (!isComposingRef.current) {
        refreshMention();
      }
    }, [closeComposerContextMenu, pruneDetachedLargePastes, refreshEmptyState, refreshMention]);

    const handleKeyUp = useCallback(
      (e: KeyboardEvent<HTMLDivElement>) => {
        if (disabled || isComposingRef.current || isImeKeyboardEvent(e)) return;
        if (
          e.key === "ArrowDown" ||
          e.key === "ArrowUp" ||
          e.key === "Tab" ||
          e.key === "Enter" ||
          e.key === "Escape"
        ) {
          return;
        }
        const el = editorRef.current;
        if (el) {
          removeStaleCaretAnchorsAroundSelection(el);
          normalizeCaretAfterChip(el);
        }
        refreshMention();
      },
      [disabled, refreshMention],
    );

    const handleMouseUp = useCallback(() => {
      const el = editorRef.current;
      if (!el) return;
      if (normalizeCaretAfterChip(el)) {
        refreshMention();
      }
    }, [refreshMention]);

    const updateCommitTooltipFromTarget = useCallback(
      (target: EventTarget | null) => {
        const editor = editorRef.current;
        const chip =
          target instanceof Element && editor
            ? target.closest<HTMLElement>(`[${COMMIT_MENTION_SHA_ATTR}]`)
            : null;
        if (!chip || !editor?.contains(chip)) {
          closeCommitTooltip();
          return;
        }
        if (commitTooltipChipRef.current === chip) return;
        const commit = commitMentionFromElement(chip);
        if (!commit) {
          closeCommitTooltip();
          return;
        }
        commitTooltipChipRef.current = chip;
        setCommitTooltip({ commit, rect: chip.getBoundingClientRect() });
      },
      [closeCommitTooltip],
    );

    const cancelCommitTooltipClose = useCallback(() => {
      if (commitTooltipCloseTimerRef.current === null) return;
      window.clearTimeout(commitTooltipCloseTimerRef.current);
      commitTooltipCloseTimerRef.current = null;
    }, []);

    const scheduleCommitTooltipClose = useCallback(() => {
      cancelCommitTooltipClose();
      commitTooltipCloseTimerRef.current = window.setTimeout(() => {
        commitTooltipCloseTimerRef.current = null;
        closeCommitTooltip();
      }, 120);
    }, [cancelCommitTooltipClose, closeCommitTooltip]);

    useEffect(() => cancelCommitTooltipClose, [cancelCommitTooltipClose]);

    const handleMouseMove = useCallback(
      (event: MouseEvent<HTMLDivElement>) => {
        cancelCommitTooltipClose();
        updateCommitTooltipFromTarget(event.target);
      },
      [cancelCommitTooltipClose, updateCommitTooltipFromTarget],
    );

    const handleFocus = useCallback(
      (event: FocusEvent<HTMLDivElement>) => {
        updateCommitTooltipFromTarget(event.target);
      },
      [updateCommitTooltipFromTarget],
    );

    const handleKeyDown = useCallback(
      (e: KeyboardEvent<HTMLDivElement>) => {
        if (disabled) {
          e.preventDefault();
          return;
        }
        // The typewriter owns the editor while it runs; swallow keys so Enter
        // cannot send a half-typed suggestion.
        if (typewriterRef.current) {
          e.preventDefault();
          return;
        }
        const isEnter = isEnterKeyboardEvent(e);
        const isActiveCompositionKey = isComposingRef.current || isActiveImeKeyboardEvent(e);
        const hasLegacyImeSignal = hasLegacyImeKeyboardSignal(e);

        if (isActiveCompositionKey) {
          if (isEnter && !e.shiftKey) {
            compositionEnterKeyRef.current = true;
            refreshEmptyState();
            refreshMention();
          } else {
            compositionEnterKeyRef.current = false;
          }
          return;
        }

        if (isEnter && !e.shiftKey && imeEnterSuppressUntilRef.current >= performance.now()) {
          e.preventDefault();
          imeEnterSuppressUntilRef.current = 0;
          compositionEnterKeyRef.current = false;
          lastCompositionEndAtRef.current = 0;
          refreshEmptyState();
          refreshMention();
          return;
        }

        const compositionEndedAgoMs = performance.now() - lastCompositionEndAtRef.current;
        if (
          isEnter &&
          !e.shiftKey &&
          lastCompositionEndAtRef.current > 0 &&
          compositionEndedAgoMs >= 0 &&
          compositionEndedAgoMs <= IME_COMPOSITION_END_ENTER_TAIL_MS
        ) {
          e.preventDefault();
          imeEnterSuppressUntilRef.current = 0;
          compositionEnterKeyRef.current = false;
          lastCompositionEndAtRef.current = 0;
          refreshEmptyState();
          refreshMention();
          return;
        }

        // Legacy keyCode 229 is too broad in WebViews. It is still useful for
        // ignoring non-Enter IME key noise, but should not block normal sending.
        if (!isEnter && hasLegacyImeSignal) {
          return;
        }

        // Popup navigation
        if (popupVisible && suggestions.length > 0) {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlightIdx((p) => (p + 1) % suggestions.length);
            return;
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlightIdx((p) => (p - 1 + suggestions.length) % suggestions.length);
            return;
          }
          if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
            e.preventDefault();
            if (suggestions[highlightIdx]) {
              selectSuggestion(suggestions[highlightIdx]);
            }
            return;
          }
        }
        if (popupVisible && e.key === "Escape") {
          e.preventDefault();
          closeMentionSession();
          return;
        }

        // Backspace: delete mention chip if cursor is right after one
        if (e.key === "Backspace") {
          const el = editorRef.current;
          if (el && deleteChipBeforeCursor(el, largePastesRef.current)) {
            e.preventDefault();
            refreshEmptyState();
            refreshMention();
            return;
          }
        }

        // Normal Enter → send
        if (isEnter && !e.shiftKey) {
          imeEnterSuppressUntilRef.current = 0;
          compositionEnterKeyRef.current = false;
          lastCompositionEndAtRef.current = 0;
          e.preventDefault();
          onSend();
          return;
        }

        // Shift+Enter → line break (normalise to <br>)
        if (isEnter && e.shiftKey) {
          imeEnterSuppressUntilRef.current = 0;
          compositionEnterKeyRef.current = false;
          lastCompositionEndAtRef.current = 0;
          e.preventDefault();
          document.execCommand("insertLineBreak");
          scheduleComposerSelectionScroll(editorRef.current);
          refreshEmptyState();
          refreshMention();
          return;
        }
      },
      [
        popupVisible,
        suggestions,
        highlightIdx,
        selectSuggestion,
        disabled,
        closeMentionSession,
        onSend,
        refreshEmptyState,
        refreshMention,
      ],
    );

    const handlePaste = useCallback(
      (e: ClipboardEvent<HTMLDivElement>) => {
        if (disabled) {
          e.preventDefault();
          return;
        }
        if (typewriterRef.current) {
          e.preventDefault();
          return;
        }
        const clipboardFiles = extractClipboardFiles(e.clipboardData);
        if (clipboardFiles.length > 0) {
          e.preventDefault();
          onPasteFiles?.(clipboardFiles);
          return;
        }
        e.preventDefault();
        const text = e.clipboardData.getData("text/plain");
        if (isLargePasteText(text)) {
          insertLargePaste(text);
          return;
        }
        document.execCommand("insertText", false, text);
        refreshEmptyState();
        refreshMention();
      },
      [disabled, insertLargePaste, onPasteFiles, refreshEmptyState, refreshMention],
    );

    const handleCompositionStart = useCallback(() => {
      isComposingRef.current = true;
      compositionEnterKeyRef.current = false;
      lastCompositionEndAtRef.current = 0;
      imeEnterSuppressUntilRef.current = 0;
      if (busyReleaseTimerRef.current !== null) {
        window.clearTimeout(busyReleaseTimerRef.current);
        busyReleaseTimerRef.current = null;
      }
      setBusy(true);
    }, [setBusy]);

    const handleCompositionEnd = useCallback(() => {
      isComposingRef.current = false;
      lastCompositionEndAtRef.current = performance.now();
      if (compositionEnterKeyRef.current) {
        imeEnterSuppressUntilRef.current = performance.now() + IME_ENTER_SUPPRESS_WINDOW_MS;
        compositionEnterKeyRef.current = false;
      }
      const el = editorRef.current;
      if (el) {
        removeStaleCaretAnchorsAroundSelection(el);
      }
      refreshEmptyState();
      refreshMention();
      scheduleBusyRelease();
    }, [refreshEmptyState, refreshMention, scheduleBusyRelease]);

    const handleBlur = useCallback(() => {
      isComposingRef.current = false;
      compositionEnterKeyRef.current = false;
      lastCompositionEndAtRef.current = 0;
      imeEnterSuppressUntilRef.current = 0;
      if (busyReleaseTimerRef.current !== null) {
        window.clearTimeout(busyReleaseTimerRef.current);
        busyReleaseTimerRef.current = null;
      }
      setBusy(false);
      closeComposerContextMenu();
      closeMentionSession();
      cancelCommitTooltipClose();
      closeCommitTooltip();
    }, [
      cancelCommitTooltipClose,
      closeCommitTooltip,
      closeComposerContextMenu,
      closeMentionSession,
      setBusy,
    ]);

    return (
      <div ref={wrapperRef} className="relative w-full min-w-0 max-w-full flex-1">
        {popupVisible && (
          <Popup
            anchorRef={wrapperRef}
            suggestions={suggestions}
            highlightIndex={highlightIdx}
            isLoading={popupLoading}
            error={popupError}
            showEmpty={showEmpty}
            emptyLabel={popupEmptyLabel}
            onSelect={selectSuggestion}
          />
        )}
        {commitTooltip ? (
          <CommitMentionTooltip
            commit={commitTooltip.commit}
            rect={commitTooltip.rect}
            onMouseEnter={cancelCommitTooltipClose}
            onMouseLeave={scheduleCommitTooltipClose}
          />
        ) : null}
        {composerContextMenu && contextMenuPosition
          ? createPortal(
              <div
                ref={composerContextMenuRef}
                role="menu"
                className="fixed z-[120] w-max min-w-[9.5rem] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-lg border border-border/70 bg-popover p-1.5 text-popover-foreground shadow-[0_20px_60px_-20px_rgba(15,23,42,0.35)]"
                style={{
                  left: contextMenuPosition.left,
                  top: contextMenuPosition.top,
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  disabled={!contextMenuCanMutate || !contextMenuHasSelection}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[calc(13px*var(--zone-font-scale,1))] text-foreground/90 transition-colors hover:bg-accent hover:text-accent-foreground",
                    "disabled:pointer-events-none disabled:opacity-45",
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={handleComposerContextCut}
                >
                  <Scissors className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{contextMenuLabels.cut}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!contextMenuHasSelection}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[calc(13px*var(--zone-font-scale,1))] text-foreground/90 transition-colors hover:bg-accent hover:text-accent-foreground",
                    "disabled:pointer-events-none disabled:opacity-45",
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={handleComposerContextCopy}
                >
                  <Copy className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{contextMenuLabels.copy}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!contextMenuCanMutate}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[calc(13px*var(--zone-font-scale,1))] text-foreground/90 transition-colors hover:bg-accent hover:text-accent-foreground",
                    "disabled:pointer-events-none disabled:opacity-45",
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    void handleComposerContextPaste();
                  }}
                >
                  <ClipboardPaste className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{contextMenuLabels.paste}</span>
                </button>
                <div className="my-1 h-px bg-border/70" />
                <button
                  type="button"
                  role="menuitem"
                  disabled={!composerContextMenu.hasContent}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[calc(13px*var(--zone-font-scale,1))] text-foreground/90 transition-colors hover:bg-accent hover:text-accent-foreground",
                    "disabled:pointer-events-none disabled:opacity-45",
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={handleComposerContextSelectAll}
                >
                  <ScanText className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{contextMenuLabels.selectAll}</span>
                </button>
              </div>,
              document.body,
            )
          : null}
        {/* biome-ignore lint/a11y/useSemanticElements: The composer is contenteditable so it can host inline mention chips. */}
        <div
          ref={editorRef}
          contentEditable={!disabled && !isTypewriting}
          suppressContentEditableWarning
          role="textbox"
          tabIndex={disabled ? undefined : 0}
          aria-multiline
          aria-placeholder={placeholder}
          aria-disabled={disabled}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onFocus={handleFocus}
          onMouseLeave={scheduleCommitTooltipClose}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onPaste={handlePaste}
          onContextMenu={handleContextMenu}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onBlur={handleBlur}
          className={cn(
            "mention-composer min-h-[70px] max-h-[160px] w-full min-w-0 max-w-full overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] outline-hidden",
            "text-sm",
            isDomEmpty && "is-empty",
            disabled && "cursor-not-allowed opacity-60",
            className,
          )}
          data-placeholder={placeholder}
        />
      </div>
    );
  }),
);

MentionComposer.displayName = "MentionComposer";
