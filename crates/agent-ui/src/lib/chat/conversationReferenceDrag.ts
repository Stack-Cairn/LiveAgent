import {
  type ConversationMentionReference,
  createConversationMentionReference,
} from "./mentionReferences";

export const CONVERSATION_REFERENCE_DRAG_MIME =
  "application/x-liveagent-conversation-reference+json";
export const CONVERSATION_REFERENCE_DROP_ZONE_SELECTOR = "[data-conversation-reference-drop-zone]";

export type ConversationReferenceInsertResult =
  | "inserted"
  | "duplicate"
  | "limit"
  | "invalid"
  | "self"
  | "disabled";

let activeNativeDragReference: ConversationMentionReference | null = null;

export type ConversationReferenceDropZoneRegistration = {
  conversationId: string;
  enabled: boolean;
  onHover?: (reference: ConversationMentionReference, active: boolean) => void;
  onDrop: (reference: ConversationMentionReference) => ConversationReferenceInsertResult;
};

export type ConversationReferenceDropZoneHit = ConversationReferenceDropZoneRegistration & {
  element: HTMLElement;
};

const conversationReferenceDropZones = new Map<
  HTMLElement,
  ConversationReferenceDropZoneRegistration
>();

export function writeConversationReferenceDragPayload(
  dataTransfer: DataTransfer,
  input: ConversationMentionReference,
) {
  const reference = createConversationMentionReference(input);
  if (!reference) return false;
  dataTransfer.setData(CONVERSATION_REFERENCE_DRAG_MIME, JSON.stringify(reference));
  dataTransfer.effectAllowed = "copy";
  activeNativeDragReference = reference;
  return true;
}

export function getActiveConversationReferenceDrag() {
  return activeNativeDragReference;
}

export function clearActiveConversationReferenceDrag() {
  activeNativeDragReference = null;
}

export function hasConversationReferenceDragPayload(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.types).includes(CONVERSATION_REFERENCE_DRAG_MIME);
}

export function readConversationReferenceDragPayload(dataTransfer: DataTransfer) {
  const raw = dataTransfer.getData(CONVERSATION_REFERENCE_DRAG_MIME);
  if (!raw) return null;
  try {
    return createConversationMentionReference(JSON.parse(raw) as ConversationMentionReference);
  } catch {
    return null;
  }
}

export function registerConversationReferenceDropZone(
  element: HTMLElement,
  registration: ConversationReferenceDropZoneRegistration,
) {
  conversationReferenceDropZones.set(element, registration);
  return () => {
    if (conversationReferenceDropZones.get(element) === registration) {
      conversationReferenceDropZones.delete(element);
    }
  };
}

function fallbackDropZoneHit(element: HTMLElement): ConversationReferenceDropZoneHit {
  const registration = conversationReferenceDropZones.get(element);
  if (registration) return { element, ...registration };
  return {
    element,
    conversationId:
      element.getAttribute("data-conversation-reference-drop-conversation-id")?.trim() ?? "",
    enabled: element.getAttribute("data-conversation-reference-drop-zone") === "enabled",
    onDrop: () => "disabled",
  };
}

function rectContainsPoint(rect: DOMRect, clientX: number, clientY: number) {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    clientX >= rect.left &&
    clientX <= rect.right &&
    clientY >= rect.top &&
    clientY <= rect.bottom
  );
}

/**
 * Resolve a Composer as a semantic target before the Workbench layout hit-test.
 * Disabled zones are returned too: a Composer must block a pane split even when
 * it cannot currently accept a reference (self, approval, text mode, etc.).
 *
 * `elementFromPoint` preserves paint-order semantics. The registered-rect
 * fallback covers pointer capture and WebKit overlays that can otherwise make
 * the element query miss a visible Composer.
 */
export function findConversationReferenceDropZone(
  clientX: number,
  clientY: number,
): ConversationReferenceDropZoneHit | null {
  const target =
    typeof document.elementFromPoint === "function"
      ? document.elementFromPoint(clientX, clientY)
      : null;
  const direct =
    target instanceof Element
      ? target.closest<HTMLElement>(CONVERSATION_REFERENCE_DROP_ZONE_SELECTOR)
      : null;
  if (direct) return fallbackDropZoneHit(direct);

  const registered = [...conversationReferenceDropZones.entries()];
  for (let index = registered.length - 1; index >= 0; index -= 1) {
    const [element, registration] = registered[index];
    if (!element.isConnected) continue;
    if (rectContainsPoint(element.getBoundingClientRect(), clientX, clientY)) {
      return { element, ...registration };
    }
  }
  return null;
}
