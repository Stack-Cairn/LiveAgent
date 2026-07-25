// The unified two-phase conversation-open controller: paint an initial slice
// fast (active segment / message tail, or a synchronous cache hit), then
// hydrate the full transcript at idle. Ends whose phase 1 already paints
// everything they intend to load (e.g. a lazy history window) resolve
// "painted-complete" and skip phase 2 entirely. The switch overlay appears
// only after overlayDelayMs of still-loading — there is no minimum overlay
// duration, so cache hits switch synchronously with no flash. Byte-mirrored
// between agent-gui and agent-gateway/web.

export type ConversationOpenPhase = "idle" | "opening" | "hydrating" | "ready" | "failed";

export type ConversationOpenState = {
  conversationId: string;
  phase: ConversationOpenPhase;
  showOverlay: boolean;
  errorCode: "openFailed" | "openFullFailed" | null;
};

export type ConversationOpenController = {
  open(conversationId: string): void;
  cancel(): void;
  getSequence(): number;
  getState(): ConversationOpenState;
};

export type ConversationOpenControllerDeps = {
  // Phase 1: make the conversation visible. Resolve "cache-hit" when it was
  // activated synchronously from a runtime cache (already complete — phase 2
  // is skipped), "painted" when an initial slice was fetched and rendered
  // (phase 2 hydrates the rest at idle), or "painted-complete" when the
  // fetched slice already covers everything this end intends to load
  // (phase 2 is skipped). Reject on failure. Must itself drop stale work
  // when seq is outdated.
  openInitial(
    conversationId: string,
    seq: number,
  ): Promise<"cache-hit" | "painted" | "painted-complete">;
  // Phase 2: quiet full hydration. Must check seq before committing. Only
  // consulted after a plain "painted" phase 1; ends that never resolve
  // "painted" may omit it.
  hydrateFull?(conversationId: string, seq: number): Promise<void>;
  scheduleIdle(task: () => void): () => void;
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
  let cancelIdle: (() => void) | null = null;

  const setState = (next: ConversationOpenState) => {
    state = next;
    deps.onStateChange(next);
  };

  const clearOverlayTimer = () => {
    if (overlayTimer !== null) {
      clearTimeout(overlayTimer);
      overlayTimer = null;
    }
  };

  const clearIdleTask = () => {
    if (cancelIdle) {
      cancelIdle();
      cancelIdle = null;
    }
  };

  const scheduleHydration = (
    conversationId: string,
    seq: number,
    hydrateFull: (conversationId: string, seq: number) => Promise<void>,
  ) => {
    clearIdleTask();
    cancelIdle = deps.scheduleIdle(() => {
      cancelIdle = null;
      hydrateFull(conversationId, seq)
        .then(() => {
          if (seq !== sequence) return;
          setState({ conversationId, phase: "ready", showOverlay: false, errorCode: null });
        })
        .catch(() => {
          if (seq !== sequence) return;
          // The phase-1 paint stays up; only surface that the tail of the
          // transcript could not be completed.
          setState({
            conversationId,
            phase: "ready",
            showOverlay: false,
            errorCode: "openFullFailed",
          });
        });
    });
  };

  return {
    open: (conversationId) => {
      sequence += 1;
      const seq = sequence;
      clearOverlayTimer();
      clearIdleTask();
      setState({ conversationId, phase: "opening", showOverlay: false, errorCode: null });
      overlayTimer = setTimeout(() => {
        overlayTimer = null;
        if (seq !== sequence || state.phase !== "opening") return;
        setState({ conversationId, phase: "opening", showOverlay: true, errorCode: null });
      }, overlayDelayMs);

      deps
        .openInitial(conversationId, seq)
        .then((result) => {
          if (seq !== sequence) return;
          clearOverlayTimer();
          const hydrateFull = deps.hydrateFull;
          if (result === "painted" && hydrateFull) {
            setState({ conversationId, phase: "hydrating", showOverlay: false, errorCode: null });
            scheduleHydration(conversationId, seq, hydrateFull);
            return;
          }
          // "cache-hit" and "painted-complete" own their full paint already;
          // a "painted" without a hydrateFull dep has nothing left to run.
          setState({ conversationId, phase: "ready", showOverlay: false, errorCode: null });
        })
        .catch(() => {
          if (seq !== sequence) return;
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
      clearIdleTask();
      setState(IDLE_STATE);
    },

    getSequence: () => sequence,
    getState: () => state,
  };
}
