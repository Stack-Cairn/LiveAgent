import { copyTextToClipboard } from "@liveagent/ui/lib/shared/clipboard";

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
  void copyTextToClipboard(text);
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
