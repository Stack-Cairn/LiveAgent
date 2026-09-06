import type { SidebarConversation } from "./types";

export type ConversationOpenOptions = {
  source?: "search";
  beforeCommit?: (conversation: SidebarConversation) => void;
  afterCommit?: () => void;
};

export type ConversationOpenRequest = ConversationOpenOptions & {
  isCurrent: () => boolean;
};

export type ConversationOpenPhase = "idle" | "opening" | "ready" | "failed";

export type ConversationOpenState = {
  conversationId: string;
  phase: ConversationOpenPhase;
  showOverlay: boolean;
  errorCode: "openFailed" | null;
};

export type ConversationOpenController = {
  open(conversationId: string, options?: ConversationOpenOptions): void;
  cancel(): void;
  getSequence(): number;
  getState(): ConversationOpenState;
};

export type ConversationOpenControllerDeps = {
  openInitial(
    conversationId: string,
    request?: ConversationOpenRequest,
  ): Promise<"cache-hit" | "painted">;
  onStateChange(state: ConversationOpenState): void;
  overlayDelayMs?: number;
};

const DEFAULT_OVERLAY_DELAY_MS = 150;

const IDLE_STATE: ConversationOpenState = {
  conversationId: "",
  phase: "idle",
  showOverlay: false,
  errorCode: null,
};

export function createConversationOpenController(
  deps: ConversationOpenControllerDeps,
): ConversationOpenController {
  const overlayDelayMs = deps.overlayDelayMs ?? DEFAULT_OVERLAY_DELAY_MS;
  let sequence = 0;
  let state = IDLE_STATE;
  let overlayTimer: ReturnType<typeof setTimeout> | null = null;

  const setState = (next: ConversationOpenState) => {
    state = next;
    deps.onStateChange(next);
  };

  const clearOverlayTimer = () => {
    if (overlayTimer === null) return;
    clearTimeout(overlayTimer);
    overlayTimer = null;
  };

  return {
    open: (conversationId, options) => {
      sequence += 1;
      const requestSequence = sequence;
      clearOverlayTimer();
      setState({ conversationId, phase: "opening", showOverlay: false, errorCode: null });
      overlayTimer = setTimeout(() => {
        overlayTimer = null;
        if (requestSequence !== sequence || state.phase !== "opening") return;
        setState({ conversationId, phase: "opening", showOverlay: true, errorCode: null });
      }, overlayDelayMs);

      deps
        .openInitial(conversationId, { ...options, isCurrent: () => requestSequence === sequence })
        .then(() => {
          if (requestSequence !== sequence) return;
          clearOverlayTimer();
          setState({ conversationId, phase: "ready", showOverlay: false, errorCode: null });
        })
        .catch(() => {
          if (requestSequence !== sequence) return;
          clearOverlayTimer();
          setState({
            conversationId,
            phase: "failed",
            showOverlay: false,
            errorCode: "openFailed",
          });
        });
    },

    cancel: () => {
      sequence += 1;
      clearOverlayTimer();
      setState(IDLE_STATE);
    },

    getSequence: () => sequence,
    getState: () => state,
  };
}
