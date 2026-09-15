import {
  selectConversations,
  selectListState,
  selectProjectActivityInputs,
  selectRunningConversationIds,
  sidebarShallowEqual,
} from "@liveagent/ui/lib/sidebar/selectors";
import type { SidebarSnapshot, SidebarStore } from "@liveagent/ui/lib/sidebar/store";
import { useSidebarSelector } from "@liveagent/ui/lib/sidebar/useSidebarSelector";
import { useMemo } from "react";
import { sortSidebarConversations } from "./reconcile";

function selectMutations(snapshot: SidebarSnapshot) {
  return snapshot.mutations;
}

function selectMutationErrors(snapshot: SidebarSnapshot) {
  return snapshot.mutationErrors;
}

export function useSidebarContainerState(store: SidebarStore, showProjects = false) {
  const scopedItems = useSidebarSelector(store, selectConversations);
  const byId = useSidebarSelector(store, (snapshot) => snapshot.byId);
  const workspaceHistory = useSidebarSelector(store, (snapshot) => snapshot.workspaceHistory);
  const items = useMemo(
    () => (showProjects ? sortSidebarConversations(Array.from(byId.values())) : scopedItems),
    [byId, scopedItems, showProjects],
  );
  const listState = useSidebarSelector(store, selectListState, sidebarShallowEqual);
  const scopeKey = useSidebarSelector(store, (snapshot) => snapshot.scopeKey);
  const runningConversationIds = useSidebarSelector(store, selectRunningConversationIds);
  const mutations = useSidebarSelector(store, selectMutations);
  const mutationErrors = useSidebarSelector(store, selectMutationErrors);
  const projectActivityInputs = useSidebarSelector(
    store,
    selectProjectActivityInputs,
    sidebarShallowEqual,
  );

  return {
    items,
    workspaceHistory,
    listState,
    scopeKey,
    runningConversationIds,
    mutations,
    mutationErrors,
    projectActivityInputs,
  };
}
