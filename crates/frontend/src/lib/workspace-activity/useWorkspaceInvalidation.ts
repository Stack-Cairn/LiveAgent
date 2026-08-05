// Dirty-flag driven workspace invalidation hook.
//
// Semantics:
// - While subscribed, every activity event marks the tracker dirty (fs/git
//   flags accumulate; filtering by flag is the caller's business inside
//   `onInvalidate`).
// - When `active` is false, events only mark dirty. When `active` flips to
//   true with pending dirt, `onInvalidate` fires once and the dirt clears.
// - When `active` is already true, an event fires `onInvalidate` immediately.
// - `{ kind: "reset" }` and revision regressions (agent restart, missed
//   window) force both flags dirty.
// - Duplicate deliveries of the same revision are ignored.

import { useEffect, useRef } from "react";

import type { WorkspaceActivityClient, WorkspaceActivityEventPayload } from "./types";

export type WorkspaceInvalidationHint = {
  fs: boolean;
  git: boolean;
};

export type WorkspaceInvalidationState = {
  revision: number | null;
  fsDirty: boolean;
  gitDirty: boolean;
};

export const initialWorkspaceInvalidationState: WorkspaceInvalidationState = {
  revision: null,
  fsDirty: false,
  gitDirty: false,
};

// Pure reducer: folds one payload into the dirty-tracking state.
export function reduceWorkspaceInvalidation(
  state: WorkspaceInvalidationState,
  payload: WorkspaceActivityEventPayload,
): WorkspaceInvalidationState {
  if ("kind" in payload) {
    return { revision: null, fsDirty: true, gitDirty: true };
  }
  if (state.revision !== null && payload.revision === state.revision) {
    return state;
  }
  const regressed = state.revision !== null && payload.revision < state.revision;
  return {
    revision: payload.revision,
    fsDirty: state.fsDirty || regressed || payload.fs,
    gitDirty: state.gitDirty || regressed || payload.git,
  };
}

// Pure helper: extracts the pending invalidation hint (if any) and returns
// the cleared state alongside it.
export function takeWorkspaceInvalidationHint(state: WorkspaceInvalidationState): {
  state: WorkspaceInvalidationState;
  hint: WorkspaceInvalidationHint | null;
} {
  if (!state.fsDirty && !state.gitDirty) {
    return { state, hint: null };
  }
  return {
    state: { ...state, fsDirty: false, gitDirty: false },
    hint: { fs: state.fsDirty, git: state.gitDirty },
  };
}

export type UseWorkspaceInvalidationOptions = {
  client: WorkspaceActivityClient | null | undefined;
  workdir: string;
  active: boolean;
  onInvalidate: (hint: WorkspaceInvalidationHint) => void;
};

export function useWorkspaceInvalidation(options: UseWorkspaceInvalidationOptions): void {
  const { client, workdir, active } = options;

  // `onInvalidate` is held in a ref so a new callback identity never tears
  // down the subscription.
  const onInvalidateRef = useRef(options.onInvalidate);
  useEffect(() => {
    onInvalidateRef.current = options.onInvalidate;
  }, [options.onInvalidate]);

  const activeRef = useRef(active);
  const stateRef = useRef<WorkspaceInvalidationState>(initialWorkspaceInvalidationState);

  useEffect(() => {
    activeRef.current = active;
    if (!active) {
      return;
    }
    const { state, hint } = takeWorkspaceInvalidationHint(stateRef.current);
    stateRef.current = state;
    if (hint) {
      onInvalidateRef.current(hint);
    }
  }, [active]);

  useEffect(() => {
    if (!client || !workdir) {
      return undefined;
    }
    // A fresh subscription cannot prove continuity with anything observed
    // before it: drop stale dirty flags and the old revision cursor.
    stateRef.current = initialWorkspaceInvalidationState;
    return client.subscribe(workdir, (payload: WorkspaceActivityEventPayload) => {
      stateRef.current = reduceWorkspaceInvalidation(stateRef.current, payload);
      if (!activeRef.current) {
        return;
      }
      const { state, hint } = takeWorkspaceInvalidationHint(stateRef.current);
      stateRef.current = state;
      if (hint) {
        onInvalidateRef.current(hint);
      }
    });
  }, [client, workdir]);
}
