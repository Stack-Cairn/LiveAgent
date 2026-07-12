import type { PendingUploadedFile } from "../../../lib/chat/messages/uploadedFiles";
import { parsePastedTextDisplayReferences } from "../../../lib/chat/messages/uploadedFiles";

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

export function formatMessageTimestamp(timestamp: number, now = new Date()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return time;
  }
  const monthDay = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  if (date.getFullYear() === now.getFullYear()) {
    return `${monthDay} ${time}`;
  }
  return `${date.getFullYear()}-${monthDay} ${time}`;
}

export type TranscriptContextMenuState = {
  x: number;
  y: number;
  selectedText: string;
};

const TRANSCRIPT_CONTEXT_MENU_WIDTH = 184;
const TRANSCRIPT_CONTEXT_MENU_HEIGHT = 52;
const TRANSCRIPT_CONTEXT_MENU_MARGIN = 12;

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

export function resolveTranscriptSelectionText(root: HTMLElement | null) {
  if (!root) return "";

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return "";
  }

  const selectedText = selection.toString();
  if (!selectedText.trim()) return "";

  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) {
    return "";
  }

  return selectedText;
}

export function clampTranscriptContextMenuPosition(x: number, y: number) {
  const maxLeft = Math.max(
    TRANSCRIPT_CONTEXT_MENU_MARGIN,
    window.innerWidth - TRANSCRIPT_CONTEXT_MENU_WIDTH - TRANSCRIPT_CONTEXT_MENU_MARGIN,
  );
  const maxTop = Math.max(
    TRANSCRIPT_CONTEXT_MENU_MARGIN,
    window.innerHeight - TRANSCRIPT_CONTEXT_MENU_HEIGHT - TRANSCRIPT_CONTEXT_MENU_MARGIN,
  );

  return {
    left: Math.min(Math.max(TRANSCRIPT_CONTEXT_MENU_MARGIN, x), maxLeft),
    top: Math.min(Math.max(TRANSCRIPT_CONTEXT_MENU_MARGIN, y), maxTop),
  };
}
