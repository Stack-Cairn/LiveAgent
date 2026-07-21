import type { RetryAttemptRecord } from "../../providers/runtime/streamRetry";
import type { LiveRound } from "../messages/uiMessages";

export type { RetryAttemptRecord } from "../../providers/runtime/streamRetry";

export type LiveTranscriptState = {
  draftAssistantText: string;
  toolStatus: string | null;
  liveRounds: LiveRound[];
  retryAttempts: RetryAttemptRecord[];
};

export type LiveTranscriptStore = {
  getSnapshot: () => LiveTranscriptState;
  subscribe: (listener: () => void) => () => void;
  reset: () => void;
  appendDraftAssistantText: (delta: string) => void;
  setToolStatus: (toolStatus: string | null) => void;
  setRetryAttempts: (retryAttempts: RetryAttemptRecord[]) => void;
  updateLiveRounds: (updater: (prev: LiveRound[]) => LiveRound[]) => void;
};

const EMPTY_RETRY_ATTEMPTS: RetryAttemptRecord[] = [];

const EMPTY_STATE: LiveTranscriptState = {
  draftAssistantText: "",
  toolStatus: null,
  liveRounds: [],
  retryAttempts: EMPTY_RETRY_ATTEMPTS,
};

export function createLiveTranscriptStore(
  initialState: LiveTranscriptState = EMPTY_STATE,
): LiveTranscriptStore {
  let state = initialState;
  const listeners = new Set<() => void>();

  const emitChange = () => {
    listeners.forEach((listener) => {
      listener();
    });
  };

  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset: () => {
      if (
        state.draftAssistantText.length === 0 &&
        state.toolStatus === null &&
        state.liveRounds.length === 0 &&
        state.retryAttempts.length === 0
      ) {
        return;
      }
      state = EMPTY_STATE;
      emitChange();
    },
    appendDraftAssistantText: (delta) => {
      if (!delta) return;
      state = {
        ...state,
        draftAssistantText: state.draftAssistantText + delta,
      };
      emitChange();
    },
    setToolStatus: (toolStatus) => {
      if (state.toolStatus === toolStatus) return;
      state = {
        ...state,
        toolStatus,
      };
      emitChange();
    },
    setRetryAttempts: (retryAttempts) => {
      if (state.retryAttempts === retryAttempts) return;
      state = {
        ...state,
        retryAttempts,
      };
      emitChange();
    },
    updateLiveRounds: (updater) => {
      const nextLiveRounds = updater(state.liveRounds);
      if (nextLiveRounds === state.liveRounds) return;
      state = {
        ...state,
        liveRounds: nextLiveRounds,
      };
      emitChange();
    },
  };
}
