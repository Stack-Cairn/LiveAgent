import {
  selectConversations,
  selectListState,
  selectProjectActivityInputs,
  selectRunningConversationIds,
  sidebarShallowEqual,
} from "@liveagent/ui/lib/sidebar/selectors";
import type { SidebarSnapshot, SidebarStore } from "@liveagent/ui/lib/sidebar/store";
import { useSidebarSelector } from "@liveagent/ui/lib/sidebar/useSidebarSelector";

function selectMutations(snapshot: SidebarSnapshot) {
  return snapshot.mutations;
}

function selectMutationErrors(snapshot: SidebarSnapshot) {
  return snapshot.mutationErrors;
}

export function useSidebarContainerState(store: SidebarStore) {
  const items = useSidebarSelector(store, selectConversations);
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
    listState,
    scopeKey,
    runningConversationIds,
    mutations,
    mutationErrors,
    projectActivityInputs,
  };
}
