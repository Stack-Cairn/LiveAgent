export const FILE_UPLOAD_DROP_ZONE_SELECTOR = "[data-file-upload-drop-zone]";
export const FILE_UPLOAD_CONVERSATION_ATTRIBUTE = "data-file-upload-conversation-id";

type ClosestElementTarget = EventTarget & {
  closest: (selector: string) => Element | null;
};

function supportsClosest(target: EventTarget | null): target is ClosestElementTarget {
  return typeof (target as { closest?: unknown } | null)?.closest === "function";
}

export function resolveFileUploadDropZone(target: EventTarget | null): Element | null {
  if (!supportsClosest(target)) return null;
  return target.closest(FILE_UPLOAD_DROP_ZONE_SELECTOR);
}

/**
 * Web drag/drop and paste events already identify the exact DOM node under the
 * pointer/caret. Resolve the conversation from that landing composer instead
 * of consulting whichever Pane happens to be focused when async import work
 * starts or finishes.
 */
export function resolveFileUploadConversationId(target: EventTarget | null): string | null {
  return (
    resolveFileUploadDropZone(target)?.getAttribute(FILE_UPLOAD_CONVERSATION_ATTRIBUTE)?.trim() ||
    null
  );
}
