import { type RefObject, useLayoutEffect } from "react";

/**
 * Keeps the unavoidable scrollHeight measurement for auto-growing textareas
 * behind one browser boundary. Resetting the height before reading lets the
 * field shrink again after text is removed.
 */
export function useAutosizeTextarea(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  value: string,
  enabled = true,
  minHeight = 0,
) {
  useLayoutEffect(() => {
    // The controlled value is the invalidation signal. React has already
    // committed it to the textarea before this layout effect reads scrollHeight.
    void value;
    if (!enabled) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.max(textarea.scrollHeight, minHeight)}px`;
  }, [enabled, minHeight, textareaRef, value]);
}
