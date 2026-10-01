export type CopyTextToClipboardOptions = {
  /** Restore focus after the legacy textarea fallback temporarily steals it. */
  restoreFocus?: HTMLElement | null;
};

function fallbackCopyText(text: string, options?: CopyTextToClipboardOptions) {
  let textarea: HTMLTextAreaElement | null = null;
  try {
    textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.inset = "0";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.appendChild(textarea);
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea?.remove();
    options?.restoreFocus?.focus();
  }
}

export async function copyTextToClipboard(text: string, options?: CopyTextToClipboardOptions) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return fallbackCopyText(text, options);
    }
  }
  return fallbackCopyText(text, options);
}
