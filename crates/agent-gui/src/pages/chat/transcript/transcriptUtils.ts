import { copyTextToClipboard } from "@liveagent/ui/lib/shared/clipboard";

export type TranscriptContextMenuState = {
  x: number;
  y: number;
  selectedText: string;
};

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
