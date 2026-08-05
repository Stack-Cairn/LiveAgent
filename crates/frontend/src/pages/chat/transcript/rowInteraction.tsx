import { createContext, useContext, useLayoutEffect, useRef, useSyncExternalStore } from "react";

// Run-scoped interaction state (sending flag, in-flight branch anchor)
// reaches row action bars through this store instead of row props, so settled
// rows keep referentially stable props across run start/settle and their memo
// never breaks — only the mounted action bars re-render on a flip.

export type RowInteractionState = {
  isSending: boolean;
  branchPendingMessageId: string | null;
};

export type RowInteractionStore = {
  getSnapshot: () => RowInteractionState;
  subscribe: (listener: () => void) => () => void;
};

const IDLE_STATE: RowInteractionState = { isSending: false, branchPendingMessageId: null };

const IDLE_STORE: RowInteractionStore = {
  getSnapshot: () => IDLE_STATE,
  subscribe: () => () => {},
};

const RowInteractionContext = createContext<RowInteractionStore>(IDLE_STORE);

export const RowInteractionProvider = RowInteractionContext.Provider;

export function useRowInteractionStore(state: RowInteractionState): RowInteractionStore {
  const stateRef = useRef(state);
  const listenersRef = useRef(new Set<() => void>());
  const storeRef = useRef<RowInteractionStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = {
      getSnapshot: () => stateRef.current,
      subscribe: (listener) => {
        listenersRef.current.add(listener);
        return () => {
          listenersRef.current.delete(listener);
        };
      },
    };
  }

  useLayoutEffect(() => {
    const previous = stateRef.current;
    if (
      previous.isSending === state.isSending &&
      previous.branchPendingMessageId === state.branchPendingMessageId
    ) {
      return;
    }
    stateRef.current = state;
    for (const listener of listenersRef.current) {
      listener();
    }
  });

  return storeRef.current;
}

export function useRowInteraction(): RowInteractionState {
  const store = useContext(RowInteractionContext);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
