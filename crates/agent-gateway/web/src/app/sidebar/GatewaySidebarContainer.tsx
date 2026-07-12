// Sidebar container for the web end: owns every useSidebarSelector
// subscription plus the rename UI state, so store commits (activity ticks,
// list updates, per-row mutations) re-render this subtree only — never
// GatewayApp. Renders the per-end <ChatHistorySidebar/> view.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatHistorySidebar } from "@/components/chat/ChatHistorySidebar";
import { useLocale } from "@/i18n";
import type { ChatHistorySummary } from "@/lib/chat/chatHistory";
import type { WorkspaceProject } from "@/lib/settings";
import {
  selectConversations,
  selectListState,
  selectProjectActivityInputs,
  selectRunningConversationIds,
  sidebarShallowEqual,
} from "@/lib/sidebar/selectors";
import type { SidebarSnapshot, SidebarStore } from "@/lib/sidebar/store";
import type { SidebarErrorCode } from "@/lib/sidebar/types";
import { useSidebarSelector } from "@/lib/sidebar/useSidebarSelector";
import { sortWorkspaceProjectsByActivity } from "@/lib/workspaceProjects";

function selectMutations(snapshot: SidebarSnapshot) {
  return snapshot.mutations;
}

function selectMutationErrors(snapshot: SidebarSnapshot) {
  return snapshot.mutationErrors;
}

function selectConversationIndex(snapshot: SidebarSnapshot) {
  return snapshot.byId;
}

// Transport-shaped list errors merely restate "the read path is down or
// congested right now"; the page-level banner and Online/Offline pill own
// that story, so the sidebar never repeats it — including the stale copy
// that lingers until the next reconcile tick or reconnect refetch lands.
// Three sources produce this class of message:
// - browser⇄gateway socket failures (mirrors isRecoverableGatewayTransportError
//   in lib/gatewaySocket.ts) plus the client-side request timeout, which the
//   status poll ignores under fresh inbound activity for the same reason;
// - the Go hub rejecting a roundtrip while the desktop agent is briefly
//   offline or re-registering ("agent offline", websocket_roundtrip.go) —
//   the socket stays up in that window, so connectionLost never covers it;
// - gateway-side context outcomes on the hub⇄agent roundtrip
//   ("request timed out"/"request canceled", websocket_roundtrip.go).
// Genuine desktop read failures arrive as other strings and still surface.
function isGatewayTransportErrorDetail(detail: string | null | undefined) {
  const message = (detail ?? "").trim();
  return (
    message.startsWith("Gateway WebSocket disconnected") ||
    message === "Gateway WebSocket is not connected" ||
    message.startsWith("Gateway transport stalled") ||
    message.startsWith("Gateway WebSocket request timed out") ||
    message === "agent offline" ||
    message === "request timed out" ||
    message === "request canceled"
  );
}

// Stable identity wrapper so callback props from GatewayApp (recreated per
// render) never churn effects or the memo'd view rows.
function useStableCallback<Args extends unknown[], Return>(
  handler: (...args: Args) => Return,
): (...args: Args) => Return {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  return useCallback((...args: Args) => handlerRef.current(...args), []);
}

export type GatewaySidebarContainerProps = {
  store: SidebarStore;
  currentConversationId: string;
  isOpen: boolean;
  fontScale?: number;
  activeView: "chat" | "skills-hub" | "mcp-hub";
  showProjects: boolean;
  // Merged (settings + history workdirs), unsorted: sorting happens here on
  // the store's activity snapshot so project reordering never re-renders
  // GatewayApp.
  projects: WorkspaceProject[];
  activeProjectId?: string;
  missingProjectPathKeys: ReadonlySet<string>;
  projectRenamingId: string | null;
  projectRenameDraft: string;
  projectsCollapsed: boolean;
  recentCollapsed: boolean;
  canShareConversations: boolean;
  sharedConversationCount: number;
  // GatewayApp-level sidebar errors (project removal flow); store errors are
  // derived locally and take precedence.
  externalErrorMessage: string | null;
  // Gateway socket dropped after having been connected: transport-shaped
  // error cards are suppressed because the page banner owns that messaging.
  connectionLost: boolean;
  // Workspace and recent-conversation interactions are available only while
  // both the browser transport and the desktop Agent are confirmed online.
  sectionsDisabled: boolean;
  isLocalDraftConversationId: (id: string) => boolean;
  onProjectsCollapsedChange: (collapsed: boolean) => void;
  onRecentCollapsedChange: (collapsed: boolean) => void;
  onCreateProject: () => void;
  onSelectProject: (project: WorkspaceProject) => void;
  onNewConversationForProject: (project: WorkspaceProject) => void;
  onBrowseProjectInFileTree: (project: WorkspaceProject) => void;
  onStartRenamingProject: (project: WorkspaceProject) => void;
  onProjectRenameDraftChange: (value: string) => void;
  onCommitProjectRename: () => void;
  onCancelProjectRename: () => void;
  onSetProjectPinned: (project: WorkspaceProject, isPinned: boolean) => void;
  onRemoveProject: (project: WorkspaceProject) => void;
  onNewConversation: () => void;
  onSelectConversation: (id: string) => void;
  onShareConversation: (item: ChatHistorySummary) => void;
  onOpenSharedConversations: () => void;
  // User-initiated removal of a local draft row (never hits the backend).
  onLocalDraftDeleted: (id: string) => void;
  // Conversations that left the authoritative index (remote delete, local
  // delete confirmation, reconcile drop): GatewayApp cleans caches and
  // migrates the selection when the displayed conversation vanished.
  onConversationsRemoved: (ids: readonly string[]) => void;
  onCloseSidebar: () => void;
  onOpenSkillsHub: () => void;
  onOpenMcpHub: () => void;
};

export function GatewaySidebarContainer(props: GatewaySidebarContainerProps) {
  const {
    store,
    projects,
    externalErrorMessage,
    connectionLost,
    sectionsDisabled,
    isLocalDraftConversationId,
  } = props;
  const { t } = useLocale();

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
  const conversationIndex = useSidebarSelector(store, selectConversationIndex);

  // --- Rename UI state (moved out of GatewayApp) ---------------------------
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  useEffect(() => {
    if (!sectionsDisabled) {
      return;
    }
    setRenamingId(null);
    setRenameDraft("");
  }, [sectionsDisabled]);

  const clearMutationErrors = useCallback(() => {
    for (const id of store.getSnapshot().mutationErrors.keys()) {
      store.clearMutationError(id);
    }
  }, [store]);

  const handleStartRenaming = useStableCallback((item: ChatHistorySummary) => {
    if (sectionsDisabled) {
      return;
    }
    setRenamingId(item.id);
    setRenameDraft(item.title);
  });

  const handleCommitRename = useStableCallback(() => {
    if (sectionsDisabled) {
      setRenamingId(null);
      setRenameDraft("");
      return;
    }
    if (!renamingId) {
      return;
    }
    const conversationId = renamingId;
    const title = renameDraft.trim();
    setRenamingId(null);
    setRenameDraft("");
    if (!title || title === store.peek(conversationId)?.title) {
      return;
    }
    clearMutationErrors();
    void store.rename(conversationId, title);
  });

  const handleCancelRename = useStableCallback(() => {
    setRenamingId(null);
    setRenameDraft("");
  });

  const handleSetPinned = useStableCallback((id: string, isPinned: boolean) => {
    if (sectionsDisabled) {
      return;
    }
    clearMutationErrors();
    void store.setPinned(id, isPinned);
  });

  const handleDeleteConversation = useStableCallback((id: string) => {
    if (sectionsDisabled) {
      return;
    }
    clearMutationErrors();
    const existing = store.peek(id);
    if (existing?.isPending === true || isLocalDraftConversationId(id)) {
      store.removeLocal(id);
      props.onLocalDraftDeleted(id);
      return;
    }
    void store.remove(id);
  });

  const handleLoadMore = useStableCallback(() => {
    if (sectionsDisabled) {
      return;
    }
    void store.loadMore();
  });

  // --- Authoritative-removal watcher ---------------------------------------
  // byId is the cross-scope index: entries only leave it on delete events,
  // confirmed local deletes, or authoritative reconcile drops — a scope
  // switch does not evict, so this never fires for out-of-scope selections.
  const onConversationsRemoved = useStableCallback(props.onConversationsRemoved);
  const knownConversationIdsRef = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => {
    const previous = knownConversationIdsRef.current;
    const next = new Set(conversationIndex.keys());
    knownConversationIdsRef.current = next;
    if (!previous || previous.size === 0) {
      return;
    }
    const removed: string[] = [];
    for (const id of previous) {
      if (!next.has(id)) {
        removed.push(id);
      }
    }
    if (removed.length > 0) {
      onConversationsRemoved(removed);
    }
  }, [conversationIndex, onConversationsRemoved]);

  // --- Errors ---------------------------------------------------------------
  const translateErrorCode = useCallback(
    (code: SidebarErrorCode) => t(`chat.history.${code}`),
    [t],
  );
  const listErrorMessage = useMemo(() => {
    if (connectionLost) {
      return null;
    }
    if (listState.error && !isGatewayTransportErrorDetail(listState.errorDetail)) {
      return listState.errorDetail?.trim() || translateErrorCode(listState.error);
    }
    return null;
  }, [connectionLost, listState.error, listState.errorDetail, translateErrorCode]);
  const actionErrorMessage = useMemo(() => {
    if (connectionLost) {
      return null;
    }
    let lastMutationError: SidebarErrorCode | null = null;
    for (const code of mutationErrors.values()) {
      lastMutationError = code;
    }
    if (lastMutationError) {
      return translateErrorCode(lastMutationError);
    }
    return externalErrorMessage;
  }, [connectionLost, externalErrorMessage, mutationErrors, translateErrorCode]);

  // --- Projects -------------------------------------------------------------
  const sortedProjects = useMemo(
    () =>
      sortWorkspaceProjectsByActivity(projects, {
        projectActivityUpdatedAts: projectActivityInputs.workdirActivity,
        runningProjectPathKeys: projectActivityInputs.runningWorkdirPathKeys,
      }),
    [projectActivityInputs.runningWorkdirPathKeys, projectActivityInputs.workdirActivity, projects],
  );

  return (
    <ChatHistorySidebar
      items={items}
      currentConversationId={props.currentConversationId}
      busyConversationIds={mutations}
      runningConversationIds={runningConversationIds}
      listStatus={listState.status}
      scopeKey={scopeKey}
      totalItems={listState.totalCount}
      hasMore={listState.hasMore}
      isLoadingMore={listState.isLoadingMore}
      errorMessage={listErrorMessage}
      actionErrorMessage={actionErrorMessage}
      sectionsDisabled={sectionsDisabled}
      renamingId={renamingId}
      renameDraft={renameDraft}
      isOpen={props.isOpen}
      fontScale={props.fontScale}
      activeView={props.activeView}
      showProjects={props.showProjects}
      projects={sortedProjects}
      activeProjectId={props.activeProjectId}
      missingProjectPathKeys={props.missingProjectPathKeys}
      runningProjectPathKeys={projectActivityInputs.runningWorkdirPathKeys}
      projectRenamingId={props.projectRenamingId}
      projectRenameDraft={props.projectRenameDraft}
      projectsCollapsed={props.projectsCollapsed}
      recentCollapsed={props.recentCollapsed}
      onProjectsCollapsedChange={props.onProjectsCollapsedChange}
      onRecentCollapsedChange={props.onRecentCollapsedChange}
      onCreateProject={props.onCreateProject}
      onSelectProject={props.onSelectProject}
      onNewConversationForProject={props.onNewConversationForProject}
      onBrowseProjectInFileTree={props.onBrowseProjectInFileTree}
      onStartRenamingProject={props.onStartRenamingProject}
      onProjectRenameDraftChange={props.onProjectRenameDraftChange}
      onCommitProjectRename={props.onCommitProjectRename}
      onCancelProjectRename={props.onCancelProjectRename}
      onSetProjectPinned={props.onSetProjectPinned}
      onRemoveProject={props.onRemoveProject}
      onNewConversation={props.onNewConversation}
      onSelectConversation={props.onSelectConversation}
      onStartRenaming={handleStartRenaming}
      onRenameDraftChange={setRenameDraft}
      onCommitRename={handleCommitRename}
      onCancelRename={handleCancelRename}
      onSetPinned={handleSetPinned}
      canShareConversations={props.canShareConversations}
      sharedConversationCount={props.sharedConversationCount}
      onShareConversation={props.onShareConversation}
      onOpenSharedConversations={props.onOpenSharedConversations}
      onDeleteConversation={handleDeleteConversation}
      onLoadMore={handleLoadMore}
      onCloseSidebar={props.onCloseSidebar}
      onOpenSkillsHub={props.onOpenSkillsHub}
      onOpenMcpHub={props.onOpenMcpHub}
    />
  );
}
