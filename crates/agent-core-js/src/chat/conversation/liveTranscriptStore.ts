import type { RetryAttemptRecord } from "../../providers/runtime/streamRetry";
import type { LiveRound } from "../messages/uiMessages";

export type { RetryAttemptRecord } from "../../providers/runtime/streamRetry";

export type LiveTranscriptState = {
  draftAssistantText: string;
  toolStatus: string | null;
  liveRounds: LiveRound[];
  retryAttempts: RetryAttemptRecord[];
  isSettled: boolean;
};

export type LiveTranscriptStore = {
  getSnapshot: () => LiveTranscriptState;
  subscribe: (listener: () => void) => () => void;
  reset: () => void;
  settle: () => void;
  appendDraftAssistantText: (delta: string) => void;
  setToolStatus: (toolStatus: string | null) => void;
  setRetryAttempts: (retryAttempts: RetryAttemptRecord[]) => void;
  updateLiveRounds: (updater: (prev: LiveRound[]) => LiveRound[]) => void;
};

const EMPTY_RETRY_ATTEMPTS: RetryAttemptRecord[] = [];

const EMPTY_ACTIVE_STATE: LiveTranscriptState = {
  draftAssistantText: "",
  toolStatus: null,
  liveRounds: [],
  retryAttempts: EMPTY_RETRY_ATTEMPTS,
  isSettled: false,
};

const EMPTY_SETTLED_STATE: LiveTranscriptState = {
  ...EMPTY_ACTIVE_STATE,
  isSettled: true,
};

export function createLiveTranscriptStore(
  initialState: LiveTranscriptState = EMPTY_SETTLED_STATE,
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
        state.retryAttempts.length === 0 &&
        !state.isSettled
      ) {
        return;
      }
      state = EMPTY_ACTIVE_STATE;
      emitChange();
    },
    settle: () => {
      if (
        state.draftAssistantText.length === 0 &&
        state.toolStatus === null &&
        state.liveRounds.length === 0 &&
        state.retryAttempts.length === 0 &&
        state.isSettled
      ) {
        return;
      }
      state = EMPTY_SETTLED_STATE;
      emitChange();
    },
    appendDraftAssistantText: (delta) => {
      if (!delta) return;
      state = {
        ...state,
        draftAssistantText: state.draftAssistantText + delta,
        isSettled: false,
      };
      emitChange();
    },
    setToolStatus: (toolStatus) => {
      if (state.toolStatus === toolStatus) return;
      state = {
        ...state,
        toolStatus,
        isSettled: toolStatus ? false : state.isSettled,
      };
      emitChange();
    },
    setRetryAttempts: (retryAttempts) => {
      if (state.retryAttempts === retryAttempts) return;
      state = {
        ...state,
        retryAttempts,
        isSettled: retryAttempts.length > 0 ? false : state.isSettled,
      };
      emitChange();
    },
    updateLiveRounds: (updater) => {
      const nextLiveRounds = updater(state.liveRounds);
      if (nextLiveRounds === state.liveRounds) return;
      state = {
        ...state,
        liveRounds: nextLiveRounds,
        isSettled: nextLiveRounds.length > 0 ? false : state.isSettled,
      };
      emitChange();
    },
  };
}
