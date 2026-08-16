import { ApplicationView } from "@liveagent/ui/application/ApplicationView";
import { AppErrorBoundary } from "@liveagent/ui/components/AppErrorBoundary";
import { ChangedFilesActionsProvider } from "@liveagent/ui/components/chat/ChangedFilesCard";
import { FileDropOverlay } from "@liveagent/ui/components/chat/FileDropOverlay";
import { HistoryShareModal } from "@liveagent/ui/components/chat/HistoryShareModal";
import { NotifyToast } from "@liveagent/ui/components/chat/NotifyToast";
import { SharedHistoryManagerModal } from "@liveagent/ui/components/chat/SharedHistoryManagerModal";
import { TaskProgressBar } from "@liveagent/ui/components/chat/TaskProgressBar";
import { WorkspaceCloneModal } from "@liveagent/ui/components/chat/WorkspaceCloneModal";
import { WorkspaceCloneTaskOverlay } from "@liveagent/ui/components/chat/WorkspaceCloneTaskOverlay";
import { WorkspaceProjectSettingsModal } from "@liveagent/ui/components/chat/WorkspaceProjectSettingsModal";
import { ChevronDown } from "@liveagent/ui/components/IconSet";
import { ProjectToolsPanelToggle } from "@liveagent/ui/components/project-tools/ProjectToolsPanelToggle";
import { RightDockPanel } from "@liveagent/ui/components/project-tools/RightDockPanel";
import { ScrollArea } from "@liveagent/ui/components/ui/scroll-area";
import { WorkspaceOverlayHost } from "@liveagent/ui/components/workspace-editor/WorkspaceOverlayHost";
import { LocaleContext, t as translate } from "@liveagent/ui/i18n/index";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import { mergePendingUploadedFiles } from "@liveagent/ui/lib/chat/uploadedFiles";
import { ChatComposerBar } from "@liveagent/ui/pages/chat/ChatComposerBar";
import { FloorNavRail } from "@liveagent/ui/pages/chat/transcript/FloorNavRail";
import {
  CHAT_TRANSCRIPT_WIDTH_CSS_VAR,
  TranscriptWidthControls,
} from "@liveagent/ui/pages/chat/transcript/TranscriptWidthControls";
import { SettingsPage } from "@liveagent/ui/pages/settings/SettingsPage";
import type { CSSProperties } from "react";
import { GatewayTranscript } from "@/components/GatewayTranscript";
import {
  getNextTheme,
  updateExecutionModeFromChatSelection,
  updateWorkspaceResourceSettings,
} from "@/lib/settings";
import { WorkdirPickerModal } from "@/pages/settings/WorkdirPickerModal";
import { AgentSelector } from "./AgentSelector";
import { asErrorMessage } from "./chatEventUtils";
import { CHAT_RUNTIME_FOREGROUND_PREPARE_TIMEOUT_MS } from "./constants";
import type { GatewayAppViewModel } from "./GatewayApp";
import { isLocalDraftConversationId } from "./gatewayLocalDraft";
import { HistorySwitchLoadingOverlay } from "./HistorySwitchLoadingOverlay";
import { useWindowFileDropGuard } from "./hooks/useWindowFileDropGuard";
import { GatewaySidebarContainer } from "./sidebar/GatewaySidebarContainer";
import { UserMenu } from "./UserMenu";

export function GatewayAppView({ viewModel }: { viewModel: GatewayAppViewModel }) {
  useWindowFileDropGuard();
  const {
    activeFloorKey,
    activeView,
    activeWorkspaceProject,
    activeWorkspaceProjectPath,
    addNotify,
    api,
    approvalBar,
    archivedWorkspaceProjectPathKeys,
    associatedSshHostIds,
    availableSkills,
    branchPendingMessageId,
    canDropUpload,
    canShareHistory,
    cancelChat,
    changedFilesActions,
    chatError,
    chatProtocolIncompatibleMessage,
    chatRuntimeControlsForCurrentProvider,
    chatRuntimeReasoningOptions,
    chatRuntimeThinkingAlwaysOn,
    closeSettings,
    codeReviewSkill,
    commitQueuedChatEdit,
    composerCompactionBlocked,
    composerInputDisabled,
    composerIsSending,
    composerPlaceholder,
    composerRef,
    confirmDialog,
    contextUsageTokensSource,
    conversationOpenState,
    currentModelContextWindow,
    currentModelLabel,
    dismissNotify,
    displayedConversationBusyRef,
    displayedConversationId,
    displayedConversationWorkdir,
    displayedTranscript,
    displayedTranscriptRowCount,
    editQueuedTurn,
    effectiveTheme,
    enabledComposerSkills,
    fileDropDescription,
    fileDropLimitHint,
    fileDropTitle,
    fileInputRef,
    gatewayConnectionLost,
    getDisplayedConversationId,
    gitClient,
    gitDisabledMessage,
    gitReviewFocusRequest,
    handleActiveAgentChange,
    handleArchiveWorkspaceProject,
    handleBranchConversation,
    handleBrowseWorkspaceProjectInFileTree,
    handleCancelWorkspaceCloneTask,
    handleChatRuntimeControlsChange,
    handleChatTranscriptWidthChange,
    handleCloneWorkspaceProject,
    handleCloseShareModal,
    handleCommitWorkspaceProjectRename,
    handleComposerBusyChange,
    handleCreateWorkspaceGroup,
    handleDeleteWorkspaceGroup,
    handleDisableSharedHistory,
    handleDismissWorkspaceCloneTask,
    handleEmptyStateSuggestion,
    handleFileDragEnter,
    handleFileDragLeave,
    handleFileDragOver,
    handleFileDrop,
    handleFloorJump,
    handleGitReviewFocusRequestHandled,
    handleImportReadableFiles,
    handleInsertCodeMention,
    handleLoadEarlierHistory,
    handleLoadSharedHistoryStatus,
    handleLoadUploadedImagePreview,
    handleLoadWorkspaceRemoteBranches,
    handleLogout,
    handleManualCompact,
    handleMoveWorkspaceProjectToGroup,
    handleNewConversationForProject,
    handleOpenChatFileLink,
    handleOpenClonedWorkspace,
    handleOpenCreateWorkspaceProject,
    handleOpenShareModal,
    handleOpenSharedHistoryManager,
    handleOpenSftpFile,
    handleOpenSshTerminal,
    handleOpenWorkspaceFile,
    handleOpenWorkspaceFolder,
    handleOpenWorktree,
    handleProjectTerminalSessionsChange,
    handleRefreshSharedHistoryStatuses,
    handleRemoveWorkspaceProject,
    handleRenameWorkspaceGroup,
    handleResendFromEdit,
    handleRightDockClose,
    handleRightDockFileTreeStateChange,
    handleRightDockInsertCodeReviewSkill,
    handleRightDockInsertCommitMention,
    handleRightDockInsertFileMention,
    handleRightDockInsertGitFileMention,
    handleRightDockProjectStateChange,
    handleRightDockWidthChange,
    handleSelectModel,
    handleSelectWorkspaceProject,
    handleSetShareRedactToolContent,
    handleSetSharedHistoryRedactToolContent,
    handleSetWorkspaceProjectPinned,
    handleSettingsTransitionEnd,
    handleSidebarConversationsRemoved,
    handleSidebarLocalDraftDeleted,
    handleSidebarNewConversation,
    handleSidebarOpenMcpHub,
    handleSidebarOpenSkillsHub,
    handleSidebarProjectsCollapsedChange,
    handleSidebarRecentCollapsedChange,
    handleSidebarSelectConversation,
    handleSshProjectHostIdsChange,
    handleToggleHistoryShare,
    handleToggleWorkspaceGroupCollapsed,
    handleUnarchiveWorkspaceProject,
    handleWorkdirPickerSelect,
    handleWorkspaceEditorClosed,
    handleWorkspaceEditorHide,
    handleWorkspaceFilePreviewClosed,
    handleWorktreeRemoved,
    hideWorkspaceSshTerminalOverlay,
    historyDetailLoadingTitle,
    historyShareToken,
    isAgentDevExecutionMode,
    isAgentMode,
    isFileDropActive,
    isImportingPastedTextRef,
    isSuggestionTyping,
    isUploadingFiles,
    loadComposerHistoryPrompts,
    loadingOlderHistory,
    localeContextValue,
    manualCompactPending,
    manualCompactTransientConversations,
    materializeComposerDraftForSend,
    missingWorkspaceProjectPathKeys,
    modelOptions,
    moveQueuedTurnUp,
    notifyItems,
    openSettings,
    openWorkspaceEditorFile,
    openWorkspaceFilePreview,
    overlay,
    pendingUploadedFiles,
    prepareChatRuntime,
    projectPickerOpen,
    projectTerminalSessions,
    projectToolsDisabledMessage,
    queuedChatEditSessionRef,
    queuedChatTurnsForDisplayedConversation,
    removeQueuedTurn,
    requestWorkspaceFilePreviewClose,
    projectSettingsProject,
    rightDockFileTreeState,
    rightDockOpen,
    rightDockProjectState,
    runQueuedTurnNow,
    selectedHistoryHasMore,
    selectedValue,
    sendChat,
    setActiveFloorKey,
    setPendingUploadsForConversation,
    setProjectPickerOpen,
    setProjectSettingsProject,
    setRightDockOpen,
    setSettings,
    setSharedManagerOpen,
    setSidebarOpen,
    setTranscriptScrollAreaRoot,
    setTranscriptViewport,
    setUserMenuOpen,
    setWorkspaceCreateModalOpen,
    settings,
    settingsOpen,
    settingsProviderId,
    settingsSaveState,
    settingsSection,
    settingsSyncError,
    sftpClient,
    shareConversation,
    shareError,
    shareLoading,
    shareStatus,
    shareUpdating,
    sharedHistoryItems,
    sharedHistoryListError,
    sharedManagerErrors,
    sharedManagerLoadingIds,
    sharedManagerOpen,
    sharedManagerStatuses,
    sharedManagerUpdatingIds,
    sidebarActionError,
    sidebarOpen,
    sidebarSectionsDisabled,
    sidebarStore,
    skillsRootDir,
    status,
    statusError,
    submitCurrentComposerToGuiQueue,
    submitInFlightRef,
    taskProgressSnapshot,
    terminalClient,
    terminalDisabledMessage,
    terminalProjectPath,
    terminalProjectPathKey,
    terminalSessions,
    terminalSessionsLoaded,
    transcriptBusy,
    transcriptError,
    transcriptFloors,
    transcriptFollow,
    transcriptFollowing,
    transcriptHistoryLoading,
    transcriptLiveStartIndex,
    transcriptNavRef,
    transcriptRows,
    transcriptStageRef,
    transcriptToolStatus,
    transcriptToolStatusIsCompaction,
    transcriptViewport,
    tunnelDisabledMessage,
    tunnelEnabled,
    updatePendingUploadsForConversation,
    userAvatarLabel,
    userMenuLabel,
    userMenuOpen,
    workspaceActivityClient,
    workspaceCloneTasks,
    workspaceCreateModalOpen,
    workspaceEditorCleanupPending,
    workspaceEditorCloseRequestId,
    workspaceEditorMounted,
    workspaceEditorOpen,
    workspaceEditorOpenRequest,
    workspaceFilePreviewMounted,
    workspaceFilePreviewOpen,
    workspaceFilePreviewOpenRequest,
    workspaceFolderDropActive,
    workspaceFolderDropHandlers,
    workspaceProjects,
    workspaceProjectRootClient,
    workspaceSshTerminalMounted,
    workspaceSshTerminalOpen,
    workspaceSshTerminalOpenRequest,
  } = viewModel;
  return (
    <LocaleContext.Provider value={localeContextValue}>
      <AppErrorBoundary>
        <div className="gateway-shell">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            aria-label={translate("chat.upload.selectFiles", settings.locale)}
            className="gateway-hidden-file-input"
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              void handleImportReadableFiles(files);
              event.currentTarget.value = "";
            }}
          />

          <div className="gateway-editor-host">
            <GatewaySidebarContainer
              store={sidebarStore}
              transientRunningConversations={manualCompactTransientConversations}
              currentConversationId={displayedConversationId}
              isOpen={sidebarOpen}
              fontScale={settings.customSettings.fontScale.sidebar}
              activeView={activeView}
              showProjects={isAgentMode && status?.online === true}
              projects={workspaceProjects}
              workspaceProjectGroups={settings.system.workspaceProjectGroups}
              activeProjectId={activeWorkspaceProject?.id}
              missingProjectPathKeys={missingWorkspaceProjectPathKeys}
              projectsCollapsed={settings.customSettings.chatSidebar.projectsCollapsed}
              workspaceFolderDropActive={workspaceFolderDropActive}
              workspaceFolderDropHandlers={workspaceFolderDropHandlers}
              recentCollapsed={settings.customSettings.chatSidebar.recentCollapsed}
              canShareConversations={canShareHistory}
              sharedConversationCount={sharedHistoryItems.length}
              externalErrorMessage={sidebarActionError}
              connectionLost={gatewayConnectionLost}
              sectionsDisabled={sidebarSectionsDisabled}
              isLocalDraftConversationId={isLocalDraftConversationId}
              onProjectsCollapsedChange={handleSidebarProjectsCollapsedChange}
              onRecentCollapsedChange={handleSidebarRecentCollapsedChange}
              onCreateProject={handleOpenCreateWorkspaceProject}
              onCreateWorkspaceGroup={handleCreateWorkspaceGroup}
              onRenameWorkspaceGroup={handleRenameWorkspaceGroup}
              onDeleteWorkspaceGroup={handleDeleteWorkspaceGroup}
              onMoveProjectToGroup={handleMoveWorkspaceProjectToGroup}
              onToggleWorkspaceGroupCollapsed={handleToggleWorkspaceGroupCollapsed}
              onSelectProject={handleSelectWorkspaceProject}
              onNewConversationForProject={handleNewConversationForProject}
              onBrowseProjectInFileTree={handleBrowseWorkspaceProjectInFileTree}
              onConfigureProject={setProjectSettingsProject}
              onSetProjectPinned={handleSetWorkspaceProjectPinned}
              onRemoveProject={handleRemoveWorkspaceProject}
              onArchiveProject={handleArchiveWorkspaceProject}
              onUnarchiveProject={handleUnarchiveWorkspaceProject}
              archivedProjectPathKeys={archivedWorkspaceProjectPathKeys}
              onNewConversation={handleSidebarNewConversation}
              onSelectConversation={handleSidebarSelectConversation}
              onShareConversation={handleOpenShareModal}
              onOpenSharedConversations={handleOpenSharedHistoryManager}
              onLocalDraftDeleted={handleSidebarLocalDraftDeleted}
              onConversationsRemoved={handleSidebarConversationsRemoved}
              onCloseSidebar={() => setSidebarOpen(false)}
              onOpenSettings={() => openSettings()}
              onOpenSkillsHub={handleSidebarOpenSkillsHub}
              onOpenMcpHub={handleSidebarOpenMcpHub}
            />

            {shareConversation ? (
              <HistoryShareModal
                conversation={shareConversation}
                share={shareStatus}
                isLoading={shareLoading}
                isUpdating={shareUpdating}
                errorMessage={shareError}
                onToggle={handleToggleHistoryShare}
                onRedactToolContentChange={handleSetShareRedactToolContent}
                onClose={handleCloseShareModal}
              />
            ) : null}

            {sharedManagerOpen ? (
              <SharedHistoryManagerModal
                conversations={sharedHistoryItems}
                statuses={sharedManagerStatuses}
                loadingIds={sharedManagerLoadingIds}
                updatingIds={sharedManagerUpdatingIds}
                errors={sharedManagerErrors}
                listError={sharedHistoryListError}
                onRefresh={handleRefreshSharedHistoryStatuses}
                onLoadStatus={handleLoadSharedHistoryStatus}
                onDisableShare={handleDisableSharedHistory}
                onSetRedactToolContent={handleSetSharedHistoryRedactToolContent}
                onClose={() => setSharedManagerOpen(false)}
              />
            ) : null}

            {projectPickerOpen ? (
              <WorkdirPickerModal
                initialWorkdir={activeWorkspaceProjectPath || settings.system.workdir.trim()}
                onClose={() => setProjectPickerOpen(false)}
                onSelect={handleWorkdirPickerSelect}
              />
            ) : null}

            {workspaceCreateModalOpen ? (
              <WorkspaceCloneModal
                initialParent={activeWorkspaceProjectPath || settings.system.workdir.trim()}
                canClone={settings.remote.enableWebGit}
                cloneDisabledMessage={translate("chat.workspaceCloneWebDisabled", settings.locale)}
                onOpenFolder={handleOpenWorkspaceFolder}
                onClone={handleCloneWorkspaceProject}
                onLoadBranches={handleLoadWorkspaceRemoteBranches}
                onClose={() => setWorkspaceCreateModalOpen(false)}
              />
            ) : null}
            <WorkspaceCloneTaskOverlay
              tasks={workspaceCloneTasks}
              onCancel={handleCancelWorkspaceCloneTask}
              onDismiss={handleDismissWorkspaceCloneTask}
              onOpenWorkspace={handleOpenClonedWorkspace}
            />

            {confirmDialog}

            <main className="gateway-main-shell">
              <div className="gateway-main-backdrop" />
              <ApplicationView
                activeView={activeView}
                settings={settings}
                setSettings={setSettings}
                isAgentMode={isAgentMode}
                sidebarOpen={sidebarOpen}
                onOpenSidebar={() => setSidebarOpen(true)}
                initialSkills={availableSkills}
                initialSkillsRootDir={skillsRootDir}
                className="contents"
                chat={{
                  containerProps: {
                    className: "gateway-chat-frame zone-font-scale",
                    style: {
                      "--zone-font-scale": settings.customSettings.fontScale.chat,
                    } as CSSProperties,
                    onDragEnter: handleFileDragEnter,
                    onDragOver: handleFileDragOver,
                    onDragLeave: handleFileDragLeave,
                    onDrop: handleFileDrop,
                  },
                  sidebarOpen,
                  onOpenSettings: openSettings,
                  onToggleTheme: () =>
                    setSettings((prev) => ({
                      ...prev,
                      theme: getNextTheme(prev.theme),
                    })),
                  onOpenSidebar: () => setSidebarOpen(true),
                  trailingActions: (
                    <>
                      <ProjectToolsPanelToggle
                        isOpen={rightDockOpen}
                        sessionCount={projectTerminalSessions.length}
                        disabledMessage={projectToolsDisabledMessage}
                        className="gateway-project-tools-panel-toggle"
                        onToggle={() => setRightDockOpen((open) => !open)}
                      />
                      <UserMenu
                        open={userMenuOpen}
                        onOpenChange={setUserMenuOpen}
                        userMenuLabel={userMenuLabel}
                        userAvatarLabel={userAvatarLabel}
                        agentStatus={
                          status === null ? "unknown" : status.online ? "online" : "offline"
                        }
                        agentSelector={
                          <AgentSelector api={api} onAgentChange={handleActiveAgentChange} />
                        }
                        onLogout={handleLogout}
                      />
                    </>
                  ),
                  headerOverlay: (
                    // Zero-height anchor: NotifyToast positions itself below
                    // the header's bottom edge, mirroring the GUI placement.
                    <div className="relative z-50">
                      <NotifyToast items={notifyItems} onDismiss={dismissNotify} />
                    </div>
                  ),
                  content: (
                    <>
                      {statusError ? (
                        <div className="gateway-banner-error">{statusError}</div>
                      ) : null}
                      {chatProtocolIncompatibleMessage && !statusError ? (
                        <div className="gateway-banner-error">
                          {chatProtocolIncompatibleMessage}
                        </div>
                      ) : null}
                      {settingsSyncError ? (
                        <div className="gateway-banner-error">{settingsSyncError}</div>
                      ) : null}
                      {chatError && displayedTranscriptRowCount === 0 ? (
                        <div className="gateway-banner-error">{chatError}</div>
                      ) : null}

                      <section
                        ref={transcriptStageRef}
                        data-file-upload-drop-zone=""
                        className="gateway-transcript-stage"
                        // Preferred (persisted) width, so a fresh mount paints at
                        // the user's width instead of the default.
                        // TranscriptWidthControls narrows this same variable to
                        // the stage in a layout effect — see its header.
                        style={
                          {
                            [CHAT_TRANSCRIPT_WIDTH_CSS_VAR]: `${settings.customSettings.chatTranscript.width}px`,
                          } as CSSProperties
                        }
                      >
                        <div className="gateway-transcript-scroll-shell">
                          <ScrollArea
                            ref={setTranscriptScrollAreaRoot}
                            viewportRef={setTranscriptViewport}
                            className="gateway-transcript-scroll"
                          >
                            <ChangedFilesActionsProvider value={changedFilesActions}>
                              <GatewayTranscript
                                conversationId={displayedConversationId}
                                rows={transcriptRows}
                                liveStartIndex={transcriptLiveStartIndex}
                                activeTurnKey={displayedTranscript.activeTurnKey}
                                contentWidth={settings.customSettings.chatTranscript.width}
                                isViewportFollowing={transcriptFollow.isFollowing}
                                viewportFollowing={transcriptFollowing}
                                navRef={transcriptNavRef}
                                onAnchorUserRowChange={setActiveFloorKey}
                                error={transcriptError}
                                toolStatus={transcriptToolStatus}
                                toolStatusIsCompaction={transcriptToolStatusIsCompaction}
                                retryAttempts={displayedTranscript.retryAttempts}
                                isStreaming={transcriptBusy}
                                isLoading={transcriptHistoryLoading}
                                loadingTitle={historyDetailLoadingTitle}
                                hasModels={modelOptions.length > 0}
                                onOpenSettings={openSettings}
                                hasMoreHistory={selectedHistoryHasMore}
                                isLoadingMoreHistory={loadingOlderHistory}
                                onLoadEarlierHistory={
                                  selectedHistoryHasMore ? handleLoadEarlierHistory : undefined
                                }
                                showUsage={isAgentDevExecutionMode}
                                usageContextWindow={currentModelContextWindow}
                                workspaceRoot={displayedConversationWorkdir}
                                onOpenFileLink={handleOpenChatFileLink}
                                gitClient={gitClient}
                                onLoadUploadedImagePreview={handleLoadUploadedImagePreview}
                                onResendFromEdit={handleResendFromEdit}
                                onBranchConversation={handleBranchConversation}
                                branchPendingMessageId={branchPendingMessageId}
                                onSuggestionSelect={handleEmptyStateSuggestion}
                                suggestionsDisabled={isSuggestionTyping}
                              />
                            </ChangedFilesActionsProvider>
                          </ScrollArea>
                          <TranscriptWidthControls
                            hostRef={transcriptStageRef}
                            width={settings.customSettings.chatTranscript.width}
                            onWidthChange={handleChatTranscriptWidthChange}
                            resizeLabel={
                              settings.locale === "en-US"
                                ? "Resize conversation content"
                                : "调整对话正文宽度"
                            }
                            resetLabel={
                              settings.locale === "en-US"
                                ? "Double-click to reset"
                                : "双击恢复默认宽度"
                            }
                          />
                          {displayedTranscriptRowCount > 0 && !conversationOpenState.showOverlay ? (
                            <FloorNavRail
                              conversationId={displayedConversationId}
                              floors={transcriptFloors}
                              activeRowKey={activeFloorKey}
                              bottomOffset="calc(var(--gateway-chat-composer-overlay-height, 176px) + 12px)"
                              scrollViewport={transcriptViewport}
                              onJump={handleFloorJump}
                            />
                          ) : null}
                          {conversationOpenState.showOverlay ? (
                            <HistorySwitchLoadingOverlay locale={settings.locale} />
                          ) : null}
                        </div>
                        {!transcriptFollowing ? (
                          <button
                            type="button"
                            className="gateway-scroll-to-bottom"
                            onClick={transcriptFollow.jumpToBottom}
                            aria-label="滚动到底部"
                            title="滚动到底部"
                          >
                            <ChevronDown className="h-4 w-4" />
                          </button>
                        ) : null}
                        <ChatComposerBar
                          surface="web"
                          composerRef={composerRef}
                          isSending={composerIsSending}
                          isUploadingFiles={isUploadingFiles}
                          isInputDisabled={composerInputDisabled}
                          inputPlaceholder={composerPlaceholder}
                          workdir={displayedConversationWorkdir}
                          enabledSkills={enabledComposerSkills}
                          isAgentMode={isAgentMode}
                          executionMode={settings.system.executionMode}
                          hasModels={modelOptions.length > 0}
                          currentModelLabel={currentModelLabel}
                          modelOptions={modelOptions}
                          selectedValue={selectedValue}
                          chatRuntimeControls={chatRuntimeControlsForCurrentProvider}
                          reasoningOptions={chatRuntimeReasoningOptions}
                          thinkingAlwaysOn={chatRuntimeThinkingAlwaysOn}
                          contextUsageTokensSource={contextUsageTokensSource}
                          contextWindow={currentModelContextWindow}
                          onManualCompactConfirm={handleManualCompact}
                          manualCompactBlocked={manualCompactPending || composerCompactionBlocked}
                          gitClient={gitClient}
                          onOpenWorktree={handleOpenWorktree}
                          onWorktreeRemoved={handleWorktreeRemoved}
                          gitWriteEnabled={settings.remote.enableWebGit}
                          gitDisabledMessage={gitDisabledMessage}
                          workspaceActivityClient={workspaceActivityClient}
                          onSelectModel={handleSelectModel}
                          onSelectExecutionMode={(mode) =>
                            setSettings((prev) => updateExecutionModeFromChatSelection(prev, mode))
                          }
                          onOpenSettings={openSettings}
                          onSend={() => {
                            if (
                              submitInFlightRef.current ||
                              isUploadingFiles ||
                              isImportingPastedTextRef.current ||
                              composerInputDisabled
                            ) {
                              return;
                            }
                            if (queuedChatEditSessionRef.current) {
                              submitInFlightRef.current = true;
                              void (async () => {
                                try {
                                  await commitQueuedChatEdit();
                                } finally {
                                  submitInFlightRef.current = false;
                                }
                              })();
                              return;
                            }
                            if (
                              displayedConversationBusyRef.current ||
                              queuedChatTurnsForDisplayedConversation.length > 0
                            ) {
                              submitInFlightRef.current = true;
                              void (async () => {
                                try {
                                  await submitCurrentComposerToGuiQueue("append");
                                } finally {
                                  submitInFlightRef.current = false;
                                }
                              })();
                              return;
                            }
                            submitInFlightRef.current = true;
                            void (async () => {
                              try {
                                const draft = composerRef.current?.getDraft() ?? null;
                                // Capture the send target before the paste import
                                // awaits: switching conversations mid-import must
                                // not reroute the message or clear the composer of
                                // the newly displayed conversation.
                                const sendConversationId = getDisplayedConversationId();
                                let text: string;
                                let files: PendingUploadedFile[];
                                try {
                                  const materialized = draft
                                    ? await materializeComposerDraftForSend(
                                        draft,
                                        pendingUploadedFiles,
                                        displayedConversationWorkdir,
                                      )
                                    : { text: "", uploadedFiles: pendingUploadedFiles };
                                  text = materialized.text;
                                  files = materialized.uploadedFiles;
                                } catch (error) {
                                  addNotify("error", asErrorMessage(error, "大段粘贴内容导入失败"));
                                  return;
                                }

                                if (!text && files.length === 0) {
                                  return;
                                }
                                if (getDisplayedConversationId() === sendConversationId) {
                                  composerRef.current?.clear();
                                }
                                setPendingUploadsForConversation(sendConversationId, []);
                                void sendChat(text, {
                                  conversationId: sendConversationId,
                                  uploadedFiles: files,
                                  runtimeControls: chatRuntimeControlsForCurrentProvider,
                                }).catch(() => {
                                  updatePendingUploadsForConversation(
                                    sendConversationId,
                                    (current) => mergePendingUploadedFiles(current, files),
                                  );
                                });
                              } finally {
                                submitInFlightRef.current = false;
                              }
                            })();
                          }}
                          onStop={() => {
                            const nextQueuedTurn = queuedChatTurnsForDisplayedConversation[0];
                            if (nextQueuedTurn) {
                              // Keep WebUI's stop button aligned with the desktop
                              // composer: stop the active run, then drain the queue.
                              runQueuedTurnNow(nextQueuedTurn.id);
                              return;
                            }
                            void cancelChat(displayedConversationId);
                          }}
                          onPrepareChatRuntime={() => {
                            if (!api || historyShareToken) {
                              return;
                            }
                            void prepareChatRuntime(
                              "composer-focus",
                              api,
                              CHAT_RUNTIME_FOREGROUND_PREPARE_TIMEOUT_MS,
                            ).catch(() => undefined);
                          }}
                          onComposerBusyChange={handleComposerBusyChange}
                          onChatRuntimeControlsChange={handleChatRuntimeControlsChange}
                          onPickReadableFiles={() => fileInputRef.current?.click()}
                          onPasteFiles={handleImportReadableFiles}
                          onLoadUploadedImagePreview={handleLoadUploadedImagePreview}
                          loadHistoryPrompts={loadComposerHistoryPrompts}
                          pendingUploadedFiles={pendingUploadedFiles}
                          onRemovePendingUpload={(relativePath) => {
                            updatePendingUploadsForConversation(
                              getDisplayedConversationId(),
                              (current) =>
                                current.filter((file) => file.relativePath !== relativePath),
                            );
                          }}
                          queuedTurns={queuedChatTurnsForDisplayedConversation}
                          onRunQueuedTurnNow={runQueuedTurnNow}
                          onMoveQueuedTurnUp={moveQueuedTurnUp}
                          onEditQueuedTurn={editQueuedTurn}
                          onRemoveQueuedTurn={removeQueuedTurn}
                          taskProgressBar={
                            <TaskProgressBar
                              key={displayedConversationId}
                              snapshot={taskProgressSnapshot}
                              isConversationRunning={transcriptBusy}
                            />
                          }
                          approvalBar={approvalBar}
                        />
                        {isFileDropActive ? (
                          <FileDropOverlay
                            canDropUpload={canDropUpload}
                            title={fileDropTitle}
                            description={fileDropDescription}
                            limitHint={fileDropLimitHint}
                          />
                        ) : null}
                      </section>
                    </>
                  ),
                }}
                workspaceOverlays={
                  <WorkspaceOverlayHost
                    locale={settings.locale}
                    theme={effectiveTheme}
                    workspaceEditorMounted={workspaceEditorMounted}
                    workspaceEditorOpenRequest={workspaceEditorOpenRequest}
                    workspaceEditorCloseRequestId={workspaceEditorCloseRequestId}
                    workspaceEditorOpen={workspaceEditorOpen}
                    workspaceEditorCleanupPending={workspaceEditorCleanupPending}
                    onWorkspaceEditorPreviewFile={openWorkspaceFilePreview}
                    onWorkspaceEditorInsertCodeMention={handleInsertCodeMention}
                    onWorkspaceEditorHide={handleWorkspaceEditorHide}
                    onWorkspaceEditorClose={handleWorkspaceEditorClosed}
                    workspaceFilePreviewMounted={workspaceFilePreviewMounted}
                    workspaceFilePreviewOpenRequest={workspaceFilePreviewOpenRequest}
                    workspaceFilePreviewOpen={workspaceFilePreviewOpen}
                    onWorkspaceFilePreviewOpenEditor={openWorkspaceEditorFile}
                    onWorkspaceFilePreviewRequestClose={requestWorkspaceFilePreviewClose}
                    onWorkspaceFilePreviewClose={handleWorkspaceFilePreviewClosed}
                    workspaceSshTerminalMounted={workspaceSshTerminalMounted}
                    workspaceSshTerminalOpenRequest={workspaceSshTerminalOpenRequest}
                    workspaceSshTerminalOpen={workspaceSshTerminalOpen}
                    terminalProjectPathKey={terminalProjectPathKey}
                    terminalClient={terminalClient}
                    sftpClient={sftpClient}
                    terminalSessions={terminalSessions}
                    onWorkspaceSshTerminalHide={hideWorkspaceSshTerminalOverlay}
                    onSshTerminalOpenFile={handleOpenSftpFile}
                  />
                }
              />
            </main>
          </div>

          {terminalClient ? (
            <RightDockPanel
              isOpen={activeView === "chat" && rightDockOpen}
              collapseImmediately={activeView !== "chat"}
              fontScale={settings.customSettings.fontScale.rightDock}
              projectPathKey={terminalProjectPathKey}
              cwd={terminalProjectPath}
              sessions={terminalSessions}
              sessionsLoaded={terminalSessionsLoaded}
              width={settings.customSettings.rightDock.width}
              theme={effectiveTheme}
              disabledMessage={projectToolsDisabledMessage}
              terminalDisabledMessage={terminalDisabledMessage}
              projectState={rightDockProjectState}
              fileTreeState={rightDockFileTreeState}
              sshHosts={settings.ssh.hosts}
              associatedSshHostIds={associatedSshHostIds}
              client={terminalClient}
              gitClient={gitClient}
              gitWriteEnabled={settings.remote.enableWebGit}
              gitDisabledMessage={gitDisabledMessage}
              tunnelClient={isAgentMode ? api : null}
              tunnelEnabled={tunnelEnabled}
              tunnelDisabledMessage={tunnelDisabledMessage}
              tunnelPublicBaseUrl={window.location.origin}
              workspaceActivityClient={workspaceActivityClient}
              onWidthChange={handleRightDockWidthChange}
              onProjectStateChange={handleRightDockProjectStateChange}
              onFileTreeStateChange={handleRightDockFileTreeStateChange}
              onSshProjectHostIdsChange={handleSshProjectHostIdsChange}
              onOpenSshSession={handleOpenSshTerminal}
              onSessionsChange={handleProjectTerminalSessionsChange}
              onInsertFileMention={handleRightDockInsertFileMention}
              onOpenFile={handleOpenWorkspaceFile}
              gitReviewFocusRequest={gitReviewFocusRequest}
              onGitReviewFocusRequestHandled={handleGitReviewFocusRequestHandled}
              onInsertCodeReviewSkill={
                codeReviewSkill ? handleRightDockInsertCodeReviewSkill : undefined
              }
              onInsertCommitMention={handleRightDockInsertCommitMention}
              onInsertGitFileMention={handleRightDockInsertGitFileMention}
              onClose={handleRightDockClose}
            />
          ) : null}

          {projectSettingsProject ? (
            <WorkspaceProjectSettingsModal
              project={projectSettingsProject}
              settings={settings}
              skills={availableSkills}
              rootClient={workspaceProjectRootClient}
              rootClientUnavailableDescription={
                workspaceProjectRootClient
                  ? undefined
                  : translate(
                      "chat.workspaceSettingsDirectoriesGatewayDescription",
                      settings.locale,
                    )
              }
              onClose={() => setProjectSettingsProject(null)}
              onRenameProject={(name) => {
                handleCommitWorkspaceProjectRename(projectSettingsProject, name);
              }}
              onSave={(draft) => {
                setSettings((prev) =>
                  updateWorkspaceResourceSettings(prev, projectSettingsProject.path, draft),
                );
              }}
            />
          ) : null}

          {settingsOpen ? (
            <div
              className={`gateway-settings-overlay ${
                overlay === "open" ? "gateway-settings-overlay-open" : ""
              }`}
              onTransitionEnd={handleSettingsTransitionEnd}
            >
              <SettingsPage
                settings={settings}
                setSettings={setSettings}
                saveState={settingsSaveState}
                onBack={closeSettings}
                initialSection={settingsSection}
                initialProviderId={settingsProviderId}
                hiddenSections={["remote"]}
                onAgentDirectoryChanged={async () => {
                  if (!api) return;
                  await api.listAgents();
                  handleActiveAgentChange(api.getActiveAgent());
                }}
              />
            </div>
          ) : null}
        </div>
      </AppErrorBoundary>
    </LocaleContext.Provider>
  );
}
