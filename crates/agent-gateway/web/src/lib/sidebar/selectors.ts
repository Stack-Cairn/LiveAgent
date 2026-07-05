// Small pure selectors over SidebarSnapshot plus the shallow-equal helper
// used with useSidebarSelector for composite selections. Byte-mirrored
// between agent-gui and agent-gateway/web.

import type { SidebarSnapshot } from "./store";
import type { SidebarMutationKind } from "./types";

export function selectConversations(snapshot: SidebarSnapshot) {
  return snapshot.conversations;
}

export function selectListState(snapshot: SidebarSnapshot) {
  return {
    status: snapshot.listStatus,
    error: snapshot.listError,
    errorDetail: snapshot.listErrorDetail,
    totalCount: snapshot.totalCount,
    hasMore: snapshot.hasMore,
    isLoadingMore: snapshot.isLoadingMore,
  };
}

export function selectRowBusy(
  snapshot: SidebarSnapshot,
  conversationId: string,
): SidebarMutationKind | null {
  return snapshot.mutations.get(conversationId) ?? null;
}

export function selectIsRunning(snapshot: SidebarSnapshot, conversationId: string) {
  return snapshot.runningConversationIds.has(conversationId);
}

export function selectRunningConversationIds(snapshot: SidebarSnapshot) {
  return snapshot.runningConversationIds;
}

export function selectProjectActivityInputs(snapshot: SidebarSnapshot) {
  return {
    workdirs: snapshot.workdirs,
    workdirActivity: snapshot.workdirActivity,
    runningWorkdirPathKeys: snapshot.runningWorkdirPathKeys,
  };
}

// Shallow equality for composite selector results (plain objects whose values
// are compared with Object.is). Pass as useSidebarSelector's isEqual.
export function sidebarShallowEqual<T extends Record<string, unknown>>(left: T, right: T) {
  if (Object.is(left, right)) {
    return true;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const key of leftKeys) {
    if (!Object.is(left[key], right[key])) {
      return false;
    }
  }
  return true;
}
