import type { Context, UserMessage } from "@earendil-works/pi-ai";
import { invoke } from "@tauri-apps/api/core";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  MentionComposerDraft,
  MentionComposerHandle,
} from "../../../components/chat/MentionComposer";
import { getAutomationState } from "../../../lib/automation";
import { createHookRunScope } from "../../../lib/automation/hookRunner";
import { backendFetch } from "../../../lib/backend/client";
import {
  buildPersistableMessagesFromSnapshot,
  type SuppressedToolTraceSnapshot,
} from "../../../lib/chat/conversation/chatAbort";
import {
  appendMessagesToConversation,
  buildRequestContext,
  type ConversationViewState,
  findHistoryMessageRefByMessageId,
  type HistoryMessageRef,
} from "../../../lib/chat/conversation/conversationState";
import {
  createBackendBridgeEventController,
  createConversationHookLifecycle,
} from "../../../lib/chat/conversation/run";
import { createTurnCancellation } from "../../../lib/chat/conversation/turnCancellation";
import type { ChatHistorySummary } from "../../../lib/chat/history/chatHistory";
import {
  createUserMessageWithUploads,
  mergePendingUploadedFiles,
  type PendingUploadedFile,
} from "../../../lib/chat/messages/uploadedFiles";
import {
  BRANCH_CONVERSATION_DEFAULT_TITLE,
  buildFallbackConversationTitle,
  createPendingHistoryItem,
  getFirstUserMessageText,
  isAbortLikeError,
} from "../../../lib/chat/page/chatPageHelpers";
import type { ScrollFollowHandle } from "../../../lib/chat-scroll/useScrollFollow";
import { createStreamDebugLogger } from "../../../lib/debug/agentDebug";
import { buildMemoryOverviewSection } from "../../../lib/memory/prompts/injection";
import { createModelFromConfig, createProviderRuntimeConfig } from "../../../lib/providers/llm";
import {
  type AppSettings,
  type ChatRuntimeControls,
  type ExecutionMode,
  isAgentDevMode,
  isAgentExecutionMode,
} from "../../../lib/settings";
import type { SidebarStore } from "../../../lib/sidebar/store";
import {
  buildSkillsSystemPrompt,
  resolveExplicitSkillMentions,
  type SkillSummary,
} from "../../../lib/skills";
import {
  collectRetainedSubagentParentToolCallIds,
  pruneSubagentRunsForConversation,
  type SubagentStoreManager,
} from "../../../lib/subagents";
import type { ActiveBackendBridgeRequest } from "../bridge/bridgeTypes";
import {
  type BackendRuntimeSnapshotState,
  buildBackendFinalProjectionEntries,
  buildBackendRuntimeSnapshotEntries,
} from "../bridge/chatRuntimeSnapshot";
import { createLocalChatRunId } from "../bridge/remoteRuntimeStatusModel";
import type { useBackendRunMirrorCoordinator } from "../bridge/useRunMirrorCoordinator";
import { asErrorMessage } from "../chatPageUtils";
import {
  buildTextFromComposerDraft,
  importPastedTextsAsFiles,
} from "../composer/composerDraftText";
import type { PersistConversationParams } from "../history/useConversationHistoryActions";
import type { useChatPageRuntimeStore } from "../hooks/useChatPageRuntimeStore";
import type { useLiveTranscriptController } from "../hooks/useLiveTranscriptController";
import { buildErrorAssistantMessage, formatHookWarningMessage } from "./chatPageRuntime";
import {
  finalizeChatRunInOrder,
  releaseChatRunUi,
  settleChatRunFinalization,
  trackTerminalHistoryPersist,
} from "./chatRunFinalization";
import {
  buildPreparedContext as buildPreparedConversationContext,
  buildResumeContext as buildResumeConversationContext,
} from "./conversationContextBuilders";
import { startConversationTitleJob } from "./conversationTitleJob";
import {
  type EffectiveChatModelSelection,
  resolveEffectiveChatModelSelection,
} from "./modelSelection";
import {
  resolveConversationTitleModelSelection,
  selectedModelsMatch,
} from "./providerRuntimeConfig";

type LiveTranscriptController = ReturnType<typeof useLiveTranscriptController>;
type ChatPageRuntimeStore = ReturnType<typeof useChatPageRuntimeStore>;
type BackendRunMirrorCoordinator = ReturnType<typeof useBackendRunMirrorCoordinator>;

type TitleJobRefValue = {
  conversationId: string;
  promise: Promise<string | null>;
} | null;

type UseSendChatTurnParams = {
  settings: AppSettings;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
  getMcpSettings: () => AppSettings["mcp"];
  getToolPolicies: () => AppSettings["system"]["toolPolicies"];
  t: (key: string) => string;
  sidebarStore: SidebarStore;
  titleJobRef: MutableRefObject<TitleJobRefValue>;
  subagentStoresRef: MutableRefObject<SubagentStoreManager>;
  scrollFollowRef: MutableRefObject<ScrollFollowHandle | null>;
  composerRef: MutableRefObject<MentionComposerHandle | null>;
  composerDraftCacheRef: MutableRefObject<Map<string, MentionComposerDraft>>;
  clearCachedComposerDraft: (conversationId?: string) => void;
  resetVisibleTransientState: (conversationId?: string) => void;
  isImportingPastedTextRef: MutableRefObject<boolean>;
  setIsImportingPastedText: Dispatch<SetStateAction<boolean>>;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
  hydratingConversationIdRef: MutableRefObject<string | null>;
  hydrationFailedConversationIdRef: MutableRefObject<string | null>;
  currentConversationIdRef: ChatPageRuntimeStore["currentConversationIdRef"];
  conversationRuntimeCacheRef: ChatPageRuntimeStore["conversationRuntimeCacheRef"];
  buildRuntimeEntryFromVisibleState: ChatPageRuntimeStore["buildRuntimeEntryFromVisibleState"];
  updateConversationRuntimeEntry: ChatPageRuntimeStore["updateConversationRuntimeEntry"];
  setConversationAbortController: ChatPageRuntimeStore["setConversationAbortController"];
  getConversationStopRequestVersion: ChatPageRuntimeStore["getConversationStopRequestVersion"];
  isConversationStopRequested: ChatPageRuntimeStore["isConversationStopRequested"];
  consumeConversationStop: ChatPageRuntimeStore["consumeConversationStop"];
  setConversationStopHandler: ChatPageRuntimeStore["setConversationStopHandler"];
  clearConversationStopHandler: ChatPageRuntimeStore["clearConversationStopHandler"];
  setConversationSendingState: ChatPageRuntimeStore["setConversationSendingState"];
  pendingUploadedFiles: PendingUploadedFile[];
  getPendingUploadsForConversation: (conversationId: string) => PendingUploadedFile[];
  setPendingUploadsForConversation: (
    conversationId: string,
    uploads: PendingUploadedFile[],
  ) => void;
  getConversationLiveTranscriptStore: LiveTranscriptController["getConversationLiveTranscriptStore"];
  getCompactionController: LiveTranscriptController["getCompactionController"];
  clearAbortSnapshot: LiveTranscriptController["clearAbortSnapshot"];
  getAbortSnapshot: LiveTranscriptController["getAbortSnapshot"];
  resetLiveTranscript: LiveTranscriptController["resetLiveTranscript"];
  settleLiveTranscript: LiveTranscriptController["settleLiveTranscript"];
  updateToolStatus: LiveTranscriptController["updateToolStatus"];
  queueBackendBridgeEventForRequest: BackendRunMirrorCoordinator["queueBackendBridgeEventForRequest"];
  flushBackendBridgeEventsForRequest: BackendRunMirrorCoordinator["flushBackendBridgeEventsForRequest"];
  registerBackendRunMirror: BackendRunMirrorCoordinator["registerBackendRunMirror"];
  finishBackendRunMirror: BackendRunMirrorCoordinator["finishBackendRunMirror"];
  backendBridgeHistorySummaryRef: MutableRefObject<Map<string, ChatHistorySummary>>;
  availableSkills: SkillSummary[];
  skillsRootDir: string;
  refreshSkills: () => Promise<{ skills: SkillSummary[]; rootDir: string } | null>;
  selectedSkillNames: string[];
  activeAgentPrompt: string;
  ensureTunnelToolTab: (projectPathKey?: string) => void;
  ensureSshTunnelToolTab: (projectPathKey?: string) => void;
  persistConversation: (params: PersistConversationParams) => Promise<boolean>;
  replaceConversationAtMessage: (
    conversationId: string,
    messageRef: HistoryMessageRef,
    replacementMessage: UserMessage,
  ) => Promise<ConversationViewState>;
  pruneIdleConversationCaches: (extraKeepIds?: Iterable<string>) => void;
  requestQueuedChatTurnProcessing: (conversationId: string) => void;
};

/**
 * The chat send pipeline: resolves effective overrides (queue / gateway /
 * composer), imports large pastes, spins up the gateway bridge event stream
 * and runtime-snapshot run, persists the user turn, builds skills/memory
 * prompts and hook scopes, then drives the agent or text runtime turn and
 * commits abort/error tails. Extracted verbatim from ChatPage — the send
 * closure is recreated per render so it always reads current settings.
 */
export function useSendChatTurn(params: UseSendChatTurnParams) {
  const {
    settings,
    t,
    sidebarStore,
    titleJobRef,
    subagentStoresRef,
    scrollFollowRef,
    composerRef,
    composerDraftCacheRef,
    clearCachedComposerDraft,
    resetVisibleTransientState,
    isImportingPastedTextRef,
    setIsImportingPastedText,
    setErrorMessage,
    hydratingConversationIdRef,
    hydrationFailedConversationIdRef,
    currentConversationIdRef,
    conversationRuntimeCacheRef,
    buildRuntimeEntryFromVisibleState,
    updateConversationRuntimeEntry,
    setConversationAbortController,
    getConversationStopRequestVersion,
    isConversationStopRequested,
    consumeConversationStop,
    setConversationStopHandler,
    clearConversationStopHandler,
    setConversationSendingState,
    pendingUploadedFiles,
    getPendingUploadsForConversation,
    setPendingUploadsForConversation,
    getConversationLiveTranscriptStore,
    getCompactionController,
    clearAbortSnapshot,
    getAbortSnapshot,
    resetLiveTranscript,
    settleLiveTranscript,
    updateToolStatus,
    queueBackendBridgeEventForRequest,
    flushBackendBridgeEventsForRequest,
    registerBackendRunMirror,
    finishBackendRunMirror,
    backendBridgeHistorySummaryRef,
    availableSkills,
    skillsRootDir,
    refreshSkills,
    selectedSkillNames,
    activeAgentPrompt,
    persistConversation,
    replaceConversationAtMessage,
    pruneIdleConversationCaches,
    requestQueuedChatTurnProcessing,
  } = params;

  // The sidebar store keeps workdir activity/summaries fresh from the
  // persist-driven upsert (locally and via sync events); no settings write,
  // no extra workdirs IPC.
  async function persistConversationWithHistorySync(
    params: Parameters<typeof persistConversation>[0],
  ) {
    return await persistConversation(params);
  }

  async function waitForTerminalHistoryPersist(persistPromise: Promise<boolean> | null) {
    if (persistPromise) {
      await persistPromise.catch(() => false);
    }
  }

  async function send(overrides?: {
    textOverride?: string;
    composerDraftOverride?: MentionComposerDraft;
    uploadedFilesOverride?: PendingUploadedFile[];
    conversationIdOverride?: string;
    executionModeOverride?: ExecutionMode;
    workdirOverride?: string;
    runtimeControlsOverride?: ChatRuntimeControls;
    backendBridgeRequestOverride?: ActiveBackendBridgeRequest | null;
    preserveComposerOnStart?: boolean;
    beforeRuntimeStart?: () => Promise<void>;
    afterInitialHistoryPersist?: () => Promise<void>;
    editResendBaseMessageRef?: HistoryMessageRef;
  }) {
    const overrideConversationId = overrides?.conversationIdOverride?.trim() ?? "";
    const conversationId = overrideConversationId || currentConversationIdRef.current;
    if (!conversationId) {
      return false;
    }

    const runtimeEntry =
      conversationRuntimeCacheRef.current.get(conversationId) ??
      (conversationId === currentConversationIdRef.current
        ? buildRuntimeEntryFromVisibleState()
        : null);

    const backendBridgeRequest = overrides?.backendBridgeRequestOverride ?? null;
    const effectiveExecutionMode =
      overrides?.executionModeOverride ??
      backendBridgeRequest?.executionModeOverride ??
      settings.system.executionMode;
    const effectiveIsAgentMode = isAgentExecutionMode(effectiveExecutionMode);
    const effectiveWorkdir = (
      overrides?.workdirOverride ??
      backendBridgeRequest?.workdirOverride ??
      (effectiveIsAgentMode ? (runtimeEntry?.workdir ?? settings.system.workdir) : "")
    ).trim();
    const effectiveIsAgentDevExecutionMode = isAgentDevMode(effectiveExecutionMode);
    const effectiveSkillsEnabled = settings.skills.enabled && effectiveIsAgentMode;
    // 没有「连到哪个 Backend」了：开着远程访问就意味着可能有远程前端在看。
    const hasRemoteBackendTarget = settings.remote.enabled;
    const mirrorsLocalRunToBackend = !backendBridgeRequest && hasRemoteBackendTarget;
    const backendBridgeRequestId =
      backendBridgeRequest?.requestId ?? createLocalChatRunId(conversationId);
    const backendBridgeWorkerId =
      backendBridgeRequest?.workerId ?? (mirrorsLocalRunToBackend ? "gui-live" : undefined);
    const backendBridgeEvents = createBackendBridgeEventController({
      conversationId,
      requestId: backendBridgeRequestId,
      workerId: backendBridgeWorkerId,
      enabled: Boolean(backendBridgeRequest) || hasRemoteBackendTarget,
      sendEvent: queueBackendBridgeEventForRequest,
      flushEvents: flushBackendBridgeEventsForRequest,
      resolveErrorConversationId: () =>
        backendBridgeRequest?.conversationId ?? currentConversationIdRef.current,
    });
    const updateBackendBridgeToolStatus = (status: string | null, isCompaction = false) => {
      backendBridgeEvents.queueToolStatus(status, isCompaction);
      updateToolStatus(status, transcriptStore);
    };
    // Mirrors the live retry-attempt list to remote WebUI clients alongside
    // the local live-transcript update.
    const setConversationErrorState = (message: string | null) => {
      updateConversationRuntimeEntry(conversationId, (prev) => ({
        ...prev,
        errorMessage: message,
      }));
    };
    if (!runtimeEntry) {
      const message = `Conversation runtime not found: ${conversationId}`;
      backendBridgeEvents.emitError(message, conversationId);
      throw new Error(message);
    }
    if (runtimeEntry.isSending) {
      if (backendBridgeRequest) {
        const message = "Conversation is already sending.";
        backendBridgeEvents.emitError(message, conversationId);
        await backendBridgeEvents.close();
      }
      return false;
    }
    if (isImportingPastedTextRef.current && typeof overrides?.textOverride !== "string") {
      return false;
    }
    if (hydratingConversationIdRef.current === conversationId) {
      const message = "当前会话仍在加载，请稍候。";
      setConversationErrorState(message);
      backendBridgeEvents.emitError(message, conversationId);
      return false;
    }
    if (hydrationFailedConversationIdRef.current === conversationId) {
      const message = "当前会话加载失败，请重新打开该会话后再继续。";
      setConversationErrorState(message);
      backendBridgeEvents.emitError(message, conversationId);
      return false;
    }
    if (runtimeEntry.compactionStatus.phase !== "idle") {
      updateConversationRuntimeEntry(conversationId, (prev) => ({
        ...prev,
        compactionStatus: { phase: "idle" },
      }));
    }

    let effectiveSelectedModel: EffectiveChatModelSelection;
    try {
      effectiveSelectedModel = resolveEffectiveChatModelSelection({
        settings,
        conversationSelectedModel:
          conversationRuntimeCacheRef.current.get(conversationId)?.selectedModel,
        gatewaySelectedModel: backendBridgeRequest?.selectedModelOverride,
      });
    } catch (error) {
      const message = asErrorMessage(error, "当前模型配置不可用，请重新选择后重试。");
      setConversationErrorState(message);
      backendBridgeEvents.emitError(message);
      return false;
    }

    const { selectedModel, provider, providerId, model } = effectiveSelectedModel;
    updateConversationRuntimeEntry(conversationId, (prev) =>
      selectedModelsMatch(prev.selectedModel, selectedModel) ? prev : { ...prev, selectedModel },
    );
    const runtimeControls =
      backendBridgeRequest?.runtimeControlsOverride ??
      overrides?.runtimeControlsOverride ??
      settings.chatRuntimeControls;
    const providerConfig = createProviderRuntimeConfig(
      provider,
      model,
      runtimeControls,
      settings.customSettings.providerIdentities,
    );
    const runtimeModel = createModelFromConfig(
      providerId,
      model,
      provider.baseUrl.trim(),
      provider.requestFormat,
      providerConfig.modelConfig,
    );

    const textOverride =
      typeof overrides?.textOverride === "string" ? overrides.textOverride : null;
    const hasTextOverride = textOverride !== null;
    const composerDraft = hasTextOverride
      ? null
      : (overrides?.composerDraftOverride ?? composerRef.current?.getDraft() ?? null);
    let text = hasTextOverride
      ? textOverride.trim()
      : composerDraft
        ? (effectiveIsAgentMode && composerDraft.largePastes.length > 0
            ? composerDraft.textWithoutLargePastes
            : buildTextFromComposerDraft(composerDraft)
          ).trim()
        : "";
    let uploadedFiles = overrides?.uploadedFilesOverride ?? pendingUploadedFiles;

    if (
      effectiveIsAgentMode &&
      composerDraft &&
      composerDraft.largePastes.length > 0 &&
      !hasTextOverride
    ) {
      isImportingPastedTextRef.current = true;
      setIsImportingPastedText(true);
      try {
        const imported = await importPastedTextsAsFiles(
          effectiveWorkdir,
          composerDraft.largePastes,
        );
        text = buildTextFromComposerDraft(composerDraft, imported.fileByPasteId).trim();
        uploadedFiles = mergePendingUploadedFiles(uploadedFiles, imported.files);
      } catch (error) {
        const message = asErrorMessage(error, "大段粘贴内容导入附件失败");
        setConversationErrorState(message);
        setErrorMessage(message);
        backendBridgeEvents.emitError(message, conversationId);
        await backendBridgeEvents.close();
        return false;
      } finally {
        isImportingPastedTextRef.current = false;
        setIsImportingPastedText(false);
      }
    }
    if (isConversationStopRequested(conversationId)) {
      const stopRequestVersion = getConversationStopRequestVersion(conversationId);
      if (backendBridgeRequest) {
        void invoke("gateway_chat_cancel_request", {
          request_id: backendBridgeRequestId,
          conversation_id: conversationId,
          worker_id: backendBridgeWorkerId ?? "gui-live",
        } as any).catch((error) => {
          console.warn("gateway_chat_cancel_request failed", error);
        });
      }
      consumeConversationStop(conversationId, stopRequestVersion);
      void settleChatRunFinalization(backendBridgeEvents.close());
      return false;
    }

    const userMessage = createUserMessageWithUploads(text, uploadedFiles, Date.now());
    if (!userMessage) {
      if (backendBridgeRequest) {
        const message = "Message is required.";
        backendBridgeEvents.emitError(message, conversationId);
        await backendBridgeEvents.close();
      }
      return false;
    }
    const pendingUserMessage = userMessage;
    const content =
      typeof pendingUserMessage.content === "string" ? pendingUserMessage.content : "";

    const titleSourceText = text || uploadedFiles.map((file) => file.fileName).join(", ");

    const sessionId = runtimeEntry.sessionId;
    const createdAt = runtimeEntry.createdAt;
    const conversationCwd = effectiveWorkdir || undefined;
    updateConversationRuntimeEntry(conversationId, (prev) => ({
      ...prev,
      workdir: conversationCwd,
    }));
    const transcriptStore = getConversationLiveTranscriptStore(conversationId);
    const compaction = getCompactionController(conversationId);
    const isConversationVisible = () => currentConversationIdRef.current === conversationId;
    // 轮次级取消：会话 abort controller 只注册 userStop 一次；每个 LLM 请求
    // （主请求/压缩摘要/标题任务）各自派生子 scope，杜绝 abort 换代丢停止的窗口。
    const cancellation = createTurnCancellation();
    const compactionDebugLogger = createStreamDebugLogger({
      enabled: effectiveIsAgentDevExecutionMode,
      conversationId,
      executionMode: effectiveExecutionMode,
      streamKind: "conversation_compaction",
      providerId,
      model,
    });
    const baseConversationState = runtimeEntry.state;
    const isFirstTurn = baseConversationState.meta.totalMessageCount === 0;
    const existingHistoryItem =
      sidebarStore.peek(conversationId) ??
      backendBridgeHistorySummaryRef.current.get(conversationId);
    // Branched conversations start with the placeholder title; the first
    // prompt sent inside the branch regenerates it like a first turn would.
    const isBranchDefaultTitle =
      !!existingHistoryItem &&
      !existingHistoryItem.isPending &&
      existingHistoryItem.title.trim() === BRANCH_CONVERSATION_DEFAULT_TITLE;
    const shouldCreatePendingHistoryItem = isFirstTurn && !existingHistoryItem;
    const pendingConversationTitle = t("chat.pendingTitle");
    const fallbackTitle =
      existingHistoryItem &&
      (!existingHistoryItem.isPending || existingHistoryItem.title !== pendingConversationTitle)
        ? existingHistoryItem.title
        : buildFallbackConversationTitle(
            getFirstUserMessageText(buildRequestContext(baseConversationState)) || titleSourceText,
          );

    let titlePromise: Promise<string | null> | null = null;
    if (isFirstTurn || isBranchDefaultTitle) {
      const titleModelSelection = resolveConversationTitleModelSelection(
        settings,
        effectiveSelectedModel,
      );
      const titleProviderConfig = createProviderRuntimeConfig(
        titleModelSelection.provider,
        titleModelSelection.model,
        runtimeControls,
        settings.customSettings.providerIdentities,
      );
      titlePromise = startConversationTitleJob({
        providerId: titleModelSelection.providerId,
        model: titleModelSelection.model,
        runtime: titleProviderConfig,
        signal: cancellation.deriveScope().controller.signal,
        conversationId,
        titleSourceText,
        content,
        locale: settings.locale,
        sidebarStore,
        titleJobRef,
        backendBridgeEvents,
      });
    }

    if (shouldCreatePendingHistoryItem) {
      sidebarStore.upsertLocal(
        createPendingHistoryItem({
          conversationId,
          title: pendingConversationTitle,
          providerId,
          model,
          sessionId,
          cwd: conversationCwd,
          createdAt,
        }),
      );
    }

    clearAbortSnapshot(transcriptStore);

    let nextConversationState = appendMessagesToConversation(baseConversationState, [
      pendingUserMessage,
    ]);
    let conversationRunStarted = false;
    let conversationUiReleased = false;
    let gatewayRunStarted = false;
    let localBackendRunStarted = false;
    let remoteBackendCancelRequested = false;
    let gatewayRuntimeFinalState: BackendRuntimeSnapshotState = "completed";
    let gatewayRuntimeErrorCode = "";
    let gatewayRuntimeErrorMessage = "";
    let frozenBackendFinalProjectionJson: string | null = null;
    let frozenBackendContentComplete = false;
    let terminalHistoryPersistFailed = false;
    let initialUserTurnPersisted = false;
    let initialPersistPromise: Promise<boolean> | null = null;
    let terminalHistoryPersistPromise: Promise<boolean> | null = null;
    let runCleanupPromise: Promise<void> = Promise.resolve();
    let compactionBound = false;
    let runStopRequestVersion: number | null = null;

    function registerBackendRuntimeRun(state: BackendRuntimeSnapshotState) {
      if (!(backendBridgeRequest || hasRemoteBackendTarget)) {
        return null;
      }
      return registerBackendRunMirror({
        runId: backendBridgeRequestId,
        conversationId,
        workerId: backendBridgeWorkerId,
        userMessage: pendingUserMessage,
        transcriptStore,
        state,
      });
    }

    function freezeBackendFinalProjection(state: ConversationViewState, contentComplete = true) {
      const entries = buildBackendFinalProjectionEntries({
        state,
        userMessage: pendingUserMessage,
        runId: backendBridgeRequestId,
      });
      frozenBackendFinalProjectionJson = JSON.stringify(entries);
      // The builder degrades to a user-only projection when it cannot locate
      // this run's user message in the persisted history. If the run visibly
      // produced assistant output, that degradation must not claim
      // completeness — a confirmed-empty projection would erase the reply on
      // remote clients and block history convergence.
      const hasAssistantEntry = entries.some((entry) => entry.kind !== "user");
      const liveSnapshot = transcriptStore.getSnapshot();
      const runProducedOutput =
        liveSnapshot.liveRounds.length > 0 || Boolean(liveSnapshot.draftAssistantText);
      frozenBackendContentComplete = contentComplete && (hasAssistantEntry || !runProducedOutput);
    }

    function freezeBackendLiveProjection() {
      const entries = buildBackendRuntimeSnapshotEntries({
        userMessage: pendingUserMessage,
        liveTranscript: transcriptStore.getSnapshot(),
      });
      frozenBackendFinalProjectionJson = JSON.stringify(entries);
      frozenBackendContentComplete = false;
    }

    async function persistTerminalConversation(
      input: Parameters<typeof persistConversationWithHistorySync>[0],
    ) {
      return trackTerminalHistoryPersist(
        () => persistConversationWithHistorySync(input),
        () => {
          terminalHistoryPersistFailed = true;
        },
      );
    }

    function acknowledgeBackendRunStarted() {
      // Runs without a remote target must never enter the mirror lifecycle:
      // the coordinator would otherwise attempt ingress commits that fail on
      // the missing gateway identity and leak a mirror per local run.
      if (gatewayRunStarted || !(backendBridgeRequest || hasRemoteBackendTarget)) {
        return;
      }
      gatewayRunStarted = true;
      registerBackendRuntimeRun("running");
    }

    function ensureBackendRunForTerminalState(state: BackendRuntimeSnapshotState) {
      if (gatewayRunStarted || !(backendBridgeRequest || hasRemoteBackendTarget)) return;
      gatewayRunStarted = true;
      registerBackendRuntimeRun(state);
    }

    function markConversationRunStarted() {
      if (conversationRunStarted) {
        return;
      }
      conversationRunStarted = true;
      applyConversationState(nextConversationState);
      resetLiveTranscript(transcriptStore);
      setConversationAbortController(conversationId, cancellation.userStop);
      if (isConversationStopRequested(conversationId)) {
        cancellation.userStop.abort();
      }
      setConversationSendingState(conversationId, true);
      // Queue-drained auto-starts are not a user gesture: the reader may be
      // deep in history when the previous run finishes, and force-pinning
      // for the next queued turn would yank them to the bottom. Manual sends
      // still pin (here and via resetVisibleTransientState below).
      if (isConversationVisible() && !overrides?.preserveComposerOnStart) {
        scrollFollowRef.current?.stickToBottom();
      }
    }

    function releaseConversationRunUi() {
      if (!conversationRunStarted || conversationUiReleased) return;
      conversationUiReleased = true;
      releaseChatRunUi({
        clearAbortController: () => setConversationAbortController(conversationId, null),
        clearSendingState: () => setConversationSendingState(conversationId, false),
        clearToolStatus: () => updateToolStatus(null, transcriptStore),
      });
    }

    function requestRemoteBackendCancellation() {
      if (remoteBackendCancelRequested) return;
      remoteBackendCancelRequested = true;
      const command = backendBridgeRequest
        ? "gateway_chat_cancel_request"
        : mirrorsLocalRunToBackend
          ? "gateway_chat_mark_local_cancelled"
          : null;
      if (!command) return;
      const payload = backendBridgeRequest
        ? {
            request_id: backendBridgeRequestId,
            conversation_id: conversationId,
            worker_id: backendBridgeWorkerId ?? "gui-live",
          }
        : {
            request_id: backendBridgeRequestId,
            conversation_id: conversationId,
          };
      void invoke(command, payload as any).catch((error) => {
        console.warn(`${command} failed`, error);
      });
    }

    const handleConversationStop = (options: { force: boolean; requestVersion: number }) => {
      runStopRequestVersion = options.requestVersion;
      gatewayRuntimeFinalState = "cancelled";
      cancellation.userStop.abort();
      requestRemoteBackendCancellation();
      if (!options.force) return;
      releaseConversationRunUi();
      // Force stop is the escape hatch for a stuck run: it intentionally
      // skips the persist barrier (which may itself be hung) so the gateway
      // still learns the run is cancelled. The run's own finally block will
      // additionally do the ordered persist-first finalization if it ever
      // completes.
      void settleChatRunFinalization(finishBackendRuntimeRun("cancelled"));
    };

    async function finishBackendRuntimeRun(state: BackendRuntimeSnapshotState) {
      // A cancel or an early failure that carries an error message must reach
      // remote clients as a terminal record even when the run never streamed;
      // otherwise the WebUI sees a phantom completed/queued command with no
      // explanation.
      if (state === "cancelled" || (state === "failed" && gatewayRuntimeErrorMessage)) {
        ensureBackendRunForTerminalState(state);
      }
      if (gatewayRunStarted) {
        if (frozenBackendFinalProjectionJson === null) {
          if (state === "cancelled") {
            freezeBackendLiveProjection();
          } else {
            freezeBackendFinalProjection(nextConversationState, true);
          }
        }
        const terminalState = terminalHistoryPersistFailed ? "failed" : state;
        const terminalErrorCode = terminalHistoryPersistFailed
          ? "history_persist_failed"
          : gatewayRuntimeErrorCode;
        const terminalErrorMessage = terminalHistoryPersistFailed
          ? "The final conversation history could not be persisted."
          : gatewayRuntimeErrorMessage;
        const projectionJson = frozenBackendFinalProjectionJson ?? "[]";
        const projectionBytes = new TextEncoder().encode(projectionJson).byteLength;
        const historyRequired = projectionBytes > 64 * 1024 * 1024;
        await finishBackendRunMirror({
          runId: backendBridgeRequestId,
          conversationId,
          entriesJson: historyRequired ? "[]" : projectionJson,
          state: terminalState,
          errorCode: terminalErrorCode || undefined,
          errorMessage: terminalErrorMessage || undefined,
          contentComplete: !historyRequired && frozenBackendContentComplete,
          historyRequired,
        });
      }
    }

    async function finalizeConversationRun(state: BackendRuntimeSnapshotState) {
      const result = await settleChatRunFinalization(
        finalizeChatRunInOrder({
          waitForPersistBarrier: async () => {
            await runCleanupPromise.catch(() => undefined);
            await waitForTerminalHistoryPersist(initialPersistPromise);
            await waitForTerminalHistoryPersist(terminalHistoryPersistPromise);
          },
          closeBridge: () => backendBridgeEvents.close(),
          finishRuntimeRun: () => finishBackendRuntimeRun(state),
        }),
      );
      if (result === "timed_out") {
        console.warn(`chat run finalization timed out: ${conversationId}`);
      }
    }

    async function finishRequestedStopBeforeRuntime() {
      if (runStopRequestVersion === null) return false;
      gatewayRuntimeFinalState = "cancelled";
      cancellation.userStop.abort();
      requestRemoteBackendCancellation();
      backendBridgeEvents.emitError("Cancelled", conversationId);
      releaseConversationRunUi();
      if (compactionBound) {
        compaction.unbindTurn();
        compactionBound = false;
      }
      clearAbortSnapshot(transcriptStore);
      await finalizeConversationRun("cancelled");
      clearConversationStopHandler(conversationId, handleConversationStop);
      consumeConversationStop(conversationId, runStopRequestVersion);
      pruneIdleConversationCaches([conversationId]);
      return true;
    }

    async function markLocalBackendRunStarted() {
      if (!mirrorsLocalRunToBackend || localBackendRunStarted) {
        return;
      }
      await invoke("gateway_chat_mark_local_started", {
        request_id: backendBridgeRequestId,
        conversation_id: conversationId,
      } as any);
      localBackendRunStarted = true;
    }

    if (overrides?.editResendBaseMessageRef) {
      try {
        nextConversationState = await replaceConversationAtMessage(
          conversationId,
          overrides.editResendBaseMessageRef,
          pendingUserMessage,
        );
        initialUserTurnPersisted = true;
        const keepParentToolCallIds =
          collectRetainedSubagentParentToolCallIds(nextConversationState);
        subagentStoresRef.current.invalidate(conversationId);
        await pruneSubagentRunsForConversation({
          parentConversationId: conversationId,
          keepParentToolCallIds,
        }).catch((error) => {
          console.warn("edit-resend subagent cleanup failed", error);
        });
      } catch (error) {
        const message = asErrorMessage(error, "替换编辑消息失败，原历史保持不变。");
        cancellation.userStop.abort();
        setConversationErrorState(message);
        backendBridgeEvents.emitError(message, conversationId);
        await backendBridgeEvents.close();
        return false;
      }
    }

    setConversationStopHandler(conversationId, handleConversationStop);
    markConversationRunStarted();
    if (await finishRequestedStopBeforeRuntime()) {
      return true;
    }
    // Clear the composer in the same beat as the optimistic user bubble.
    // Everything below until the runtime turn starts (gateway mark-started
    // IPC, initial history persist, skills refresh, memory overview read) may
    // await for seconds; the input box must not keep the sent text visible in
    // the meantime. Early-failure paths below restore the cleared draft.
    let composerClearedOnStart = false;
    let clearedComposerDraft: MentionComposerDraft | null = null;
    let clearedPendingUploads: PendingUploadedFile[] = [];
    if (!hasTextOverride && !overrides?.composerDraftOverride) {
      clearCachedComposerDraft(conversationId);
    }
    if (!overrides?.preserveComposerOnStart) {
      if (isConversationVisible()) {
        composerClearedOnStart = true;
        const liveDraft = composerDraft ?? composerRef.current?.getDraft() ?? null;
        clearedComposerDraft = liveDraft && !liveDraft.isEmpty ? liveDraft : null;
        clearedPendingUploads = pendingUploadedFiles;
      }
      resetVisibleTransientState(conversationId);
    } else {
      setConversationErrorState(null);
      updateConversationRuntimeEntry(conversationId, (prev) => ({
        ...prev,
        hookWarning: null,
      }));
    }
    const restoreComposerOnStartFailure = () => {
      if (!composerClearedOnStart) {
        return;
      }
      if (isConversationVisible()) {
        if (clearedComposerDraft && composerRef.current && !composerRef.current.hasContent()) {
          composerRef.current.setDraft(clearedComposerDraft);
        }
      } else if (clearedComposerDraft && !composerDraftCacheRef.current.has(conversationId)) {
        composerDraftCacheRef.current.set(conversationId, clearedComposerDraft);
      }
      if (
        clearedPendingUploads.length > 0 &&
        getPendingUploadsForConversation(conversationId).length === 0
      ) {
        setPendingUploadsForConversation(conversationId, clearedPendingUploads);
      }
    };
    if (mirrorsLocalRunToBackend) {
      try {
        await markLocalBackendRunStarted();
      } catch (error) {
        console.warn("gateway_chat_mark_local_started failed", error);
      }
      if (await finishRequestedStopBeforeRuntime()) {
        return true;
      }
    }
    if (overrides?.beforeRuntimeStart) {
      try {
        await overrides.beforeRuntimeStart();
        if (await finishRequestedStopBeforeRuntime()) {
          return true;
        }
      } catch (error) {
        if (await finishRequestedStopBeforeRuntime()) {
          return true;
        }
        const message = asErrorMessage(error, "启动远程对话运行失败");
        setConversationErrorState(message);
        backendBridgeEvents.emitError(message, conversationId);
        releaseConversationRunUi();
        await finalizeConversationRun("failed");
        clearConversationStopHandler(conversationId, handleConversationStop);
        restoreComposerOnStartFailure();
        return false;
      }
    }

    // Persist the user turn immediately so WebUI/GUI sidebars can surface the
    // latest conversation before the assistant round finishes.
    initialPersistPromise = initialUserTurnPersisted
      ? Promise.resolve(true)
      : persistConversationWithHistorySync({
          conversationId,
          sessionId,
          providerId,
          model,
          selectedModel,
          cwd: conversationCwd,
          state: nextConversationState,
          fallbackTitle,
          createdAt,
          titlePromise,
          titleLookahead: true,
        });
    const initialPersist = initialPersistPromise;
    if (overrides?.afterInitialHistoryPersist && !overrides.beforeRuntimeStart) {
      const persisted = await initialPersist;
      if (await finishRequestedStopBeforeRuntime()) {
        return true;
      }
      if (!persisted) {
        const message = "历史记录保存失败，已取消发送。";
        setConversationErrorState(message);
        gatewayRuntimeErrorCode = "history_persist_failed";
        gatewayRuntimeErrorMessage = message;
        backendBridgeEvents.emitError(message, conversationId);
        releaseConversationRunUi();
        await finalizeConversationRun("failed");
        clearConversationStopHandler(conversationId, handleConversationStop);
        restoreComposerOnStartFailure();
        return true;
      }
      try {
        await overrides.afterInitialHistoryPersist();
        if (await finishRequestedStopBeforeRuntime()) {
          return true;
        }
      } catch (error) {
        if (await finishRequestedStopBeforeRuntime()) {
          return true;
        }
        const message = asErrorMessage(error, "历史保存后的启动操作失败");
        setConversationErrorState(message);
        gatewayRuntimeErrorCode = "post_history_start_failed";
        gatewayRuntimeErrorMessage = message;
        backendBridgeEvents.emitError(message, conversationId);
        releaseConversationRunUi();
        await finalizeConversationRun("failed");
        clearConversationStopHandler(conversationId, handleConversationStop);
        restoreComposerOnStartFailure();
        return true;
      }
    } else {
      const initialPersistConfirmation = initialPersist
        .then(async (persisted) => {
          if (!persisted) {
            console.warn(
              "initial conversation history persist did not complete before chat runtime",
            );
            return false;
          }
          if (overrides?.afterInitialHistoryPersist) {
            await overrides.afterInitialHistoryPersist();
          }
          return true;
        })
        .catch((error) => {
          console.warn("initial conversation history persist confirmation failed", error);
          return false;
        });
      void initialPersistConfirmation;
    }
    if (backendBridgeRequest || hasRemoteBackendTarget) {
      const persisted = await initialPersist.catch((error) => {
        console.warn("initial conversation history persist before gateway stream failed", error);
        return false;
      });
      if (!persisted) {
        console.warn("gateway stream started before initial user turn was persisted");
      }
      if (await finishRequestedStopBeforeRuntime()) {
        return true;
      }
    }
    await backendBridgeEvents.queueUserMessage(text, uploadedFiles, {
      messageId: pendingUserMessage.id,
      baseMessageRef: overrides?.editResendBaseMessageRef,
      // The new message's own stable identity: lets remote transcripts bind
      // their user bubble's messageRef immediately, so a follow-up edit of
      // this message can anchor its rebase without a history round-trip.
      messageRef: findHistoryMessageRefByMessageId(nextConversationState, pendingUserMessage.id),
    });
    if (await finishRequestedStopBeforeRuntime()) {
      return true;
    }
    acknowledgeBackendRunStarted();
    let skillsPrompt = "";
    let memoryPrompt = "";

    function buildPreparedContext(
      state: ConversationViewState,
      tools?: Context["tools"],
      options?: { includeAbortedMessages?: boolean; includeUploadedFilesMetadata?: boolean },
    ): Context {
      return buildPreparedConversationContext({
        state,
        tools,
        activeAgentPrompt,
        skillsPrompt,
        memoryPrompt,
        includeAbortedMessages: options?.includeAbortedMessages,
        includeUploadedFilesMetadata: options?.includeUploadedFilesMetadata,
      });
    }

    function buildResumeContext(
      state: ConversationViewState,
      resumeMessage?: UserMessage,
      tools?: Context["tools"],
      options?: { includeAbortedMessages?: boolean; includeUploadedFilesMetadata?: boolean },
    ): Context {
      return buildResumeConversationContext({
        state,
        resumeMessage,
        tools,
        activeAgentPrompt,
        skillsPrompt,
        memoryPrompt,
        includeAbortedMessages: options?.includeAbortedMessages,
        includeUploadedFilesMetadata: options?.includeUploadedFilesMetadata,
      });
    }

    compaction.bindTurn({
      providerId,
      model,
      runtime: providerConfig,
      cancellation,
      debugLogger: compactionDebugLogger,
      buildPreparedContext,
      buildResumeContext,
      presend: {
        baseState: baseConversationState,
        pendingUserText: content,
        composerText: content,
        uploadedFiles,
        composeAppliedState: (state) => appendMessagesToConversation(state, [pendingUserMessage]),
      },
      sinks: {
        applyState: applyConversationState,
        applyStateMidRun: rebaseConversationStateDuringRun,
        publishStatus: (status) =>
          updateConversationRuntimeEntry(conversationId, (prev) => ({
            ...prev,
            compactionStatus: status,
          })),
        setBridgeToolStatus: updateBackendBridgeToolStatus,
        queueCheckpoint: (state) => backendBridgeEvents.queueCheckpoint(state),
        persist: (state) =>
          persistConversation({
            conversationId,
            sessionId,
            providerId,
            model,
            selectedModel,
            cwd: conversationCwd,
            state,
            fallbackTitle,
            createdAt,
            titlePromise,
          }),
        restoreComposer: (composerText, restoredUploads) => {
          if (isConversationVisible() && typeof composerText === "string") {
            composerRef.current?.setText(composerText);
            composerRef.current?.focus();
          }
          setPendingUploadsForConversation(conversationId, restoredUploads);
        },
        persistRollback: async (state) => {
          abortedConversationCommitted = true;
          await persistConversationWithHistorySync({
            conversationId,
            sessionId,
            providerId,
            model,
            selectedModel,
            cwd: conversationCwd,
            state,
            fallbackTitle,
            createdAt,
            titlePromise,
          });
        },
      },
    });
    compactionBound = true;

    // Optionally append skills metadata to system prompt (progressive disclosure).
    if (effectiveSkillsEnabled && selectedSkillNames.length > 0) {
      // In case the user sends quickly after startup (availableSkills not loaded yet),
      // do a best-effort refresh before failing.
      let skillsList = availableSkills;
      let rootDir = skillsRootDir;
      let byName = new Map(skillsList.map((s) => [s.name, s]));
      let missing = selectedSkillNames.filter((n) => !byName.has(n));
      if (missing.length > 0) {
        const fresh = await refreshSkills();
        if (await finishRequestedStopBeforeRuntime()) {
          return true;
        }
        if (fresh) {
          skillsList = fresh.skills;
          rootDir = fresh.rootDir;
          byName = new Map(skillsList.map((s) => [s.name, s]));
          missing = selectedSkillNames.filter((n) => !byName.has(n));
        }
      }

      if (missing.length > 0) {
        const message = `找不到以下 Skills：${missing.join(", ")}（请先重新扫描固定 Skills 目录）`;
        setConversationErrorState(message);
        gatewayRuntimeErrorCode = "skills_missing";
        gatewayRuntimeErrorMessage = message;
        backendBridgeEvents.emitError(message, conversationId);
        releaseConversationRunUi();
        await finalizeConversationRun("failed");
        clearConversationStopHandler(conversationId, handleConversationStop);
        restoreComposerOnStartFailure();
        return true;
      }

      const selectedSkills = selectedSkillNames.map((n) => byName.get(n)!).filter(Boolean);
      // IMPORTANT: Claude Code-style skills are progressive disclosure.
      // We only provide metadata in the system prompt. The model decides whether to read the skill file.
      const explicitSkills = resolveExplicitSkillMentions({
        text,
        structured: composerDraft?.skillMentions ?? [],
        enabledSkills: selectedSkills,
      });
      skillsPrompt = buildSkillsSystemPrompt({
        rootDir,
        selected: selectedSkills,
        explicit: explicitSkills,
      });
    }

    try {
      memoryPrompt = await buildMemoryOverviewSection(effectiveWorkdir);
    } catch (error) {
      console.warn("Failed to build memory overview prompt", error);
      memoryPrompt = "";
    }
    if (await finishRequestedStopBeforeRuntime()) {
      return true;
    }

    const hookScope = createHookRunScope({
      hooks: getAutomationState().hooks.hooks,
      conversationId,
      workdir: effectiveWorkdir,
      onWarning: (warning) => {
        updateConversationRuntimeEntry(conversationId, (prev) => ({
          ...prev,
          hookWarning: formatHookWarningMessage(settings.locale, t, warning),
        }));
      },
    });

    const hookLifecycle = createConversationHookLifecycle((event) => {
      hookScope.dispatch(event);
    });

    let abortedConversationCommitted = false;
    const persistableAgentProgress: {
      completedThroughRound: number;
      suppressedToolTrace: SuppressedToolTraceSnapshot[];
    } = {
      completedThroughRound: 0,
      suppressedToolTrace: [],
    };
    const commitVisibleAbortedConversation = () => {
      if (abortedConversationCommitted) return true;

      const snapshot = getAbortSnapshot(transcriptStore);
      const partialMessages = buildPersistableMessagesFromSnapshot({
        executionMode: effectiveExecutionMode,
        model: runtimeModel,
        draftAssistantText: snapshot.draftAssistantText,
        liveRounds: snapshot.liveRounds,
        completedThroughRound: persistableAgentProgress.completedThroughRound,
        suppressedToolTrace: persistableAgentProgress.suppressedToolTrace,
      });

      if (partialMessages.length === 0) return false;

      const finalState = appendMessagesToConversation(nextConversationState, partialMessages);
      abortedConversationCommitted = true;
      applyConversationState(finalState);
      freezeBackendFinalProjection(finalState, true);
      settleLiveTranscript(transcriptStore);
      terminalHistoryPersistPromise = persistTerminalConversation({
        conversationId,
        sessionId,
        providerId,
        model,
        selectedModel,
        cwd: conversationCwd,
        state: finalState,
        fallbackTitle,
        createdAt,
        titlePromise,
      });
      return true;
    };

    const commitErroredConversation = (rawMessage: string) => {
      const snapshot = getAbortSnapshot(transcriptStore);
      const partialMessages = buildPersistableMessagesFromSnapshot({
        executionMode: effectiveExecutionMode,
        model: runtimeModel,
        draftAssistantText: snapshot.draftAssistantText,
        liveRounds: snapshot.liveRounds,
        completedThroughRound: persistableAgentProgress.completedThroughRound,
        suppressedToolTrace: persistableAgentProgress.suppressedToolTrace,
      });
      const errorAssistant = buildErrorAssistantMessage({
        model: runtimeModel,
        errorMessage: rawMessage,
        timestamp: Date.now() + partialMessages.length,
      });
      const finalState = appendMessagesToConversation(nextConversationState, [
        ...partialMessages,
        errorAssistant,
      ]);
      abortedConversationCommitted = true;
      applyConversationState(finalState);
      freezeBackendFinalProjection(finalState, true);
      settleLiveTranscript(transcriptStore);
      updateConversationRuntimeEntry(conversationId, (prev) => ({
        ...prev,
        errorMessage: null,
      }));
      terminalHistoryPersistPromise = persistTerminalConversation({
        conversationId,
        sessionId,
        providerId,
        model,
        selectedModel,
        cwd: conversationCwd,
        state: finalState,
        fallbackTitle,
        createdAt,
        titlePromise,
      });
    };

    function applyConversationState(nextState: ConversationViewState) {
      nextConversationState = nextState;
      updateConversationRuntimeEntry(conversationId, (prev) => ({
        ...prev,
        state: nextState,
      }));
    }

    function rebaseConversationStateDuringRun(nextState: ConversationViewState) {
      // Once a compaction/prune result is committed into visible history, the
      // corresponding live transcript becomes stale and must be cleared.
      applyConversationState(nextState);
      resetLiveTranscript(transcriptStore);
    }

    try {
      // 引擎在后端 Node 进程里跑(阶段 3):这里只提交请求,增量与终态走 WS 事件。
      // clientRequestId 供引擎幂等去重——网络重试不会跑出第二个 turn。
      if (effectiveIsAgentMode) {
        await backendFetch<void>("chat_send", {
          conversationId,
          clientRequestId: pendingUserMessage.id,
          sessionId,
          mode: "agent",
          text,
          selectedModel,
          workdir: effectiveWorkdir,
          skillsEnabled: effectiveSkillsEnabled,
          selectedSkillNames,
        });
      } else {
        await backendFetch<void>("chat_send", {
          conversationId,
          clientRequestId: pendingUserMessage.id,
          sessionId,
          mode: "text",
          text,
          selectedModel,
          workdir: effectiveWorkdir,
        });
      }
    } catch (err) {
      const aborted = cancellation.userStop.signal.aborted || isAbortLikeError(err);
      gatewayRuntimeFinalState = aborted ? "cancelled" : "failed";
      const remoteErrorMessage = aborted
        ? "Cancelled"
        : (err instanceof Error ? err.message : String(err)) || "Request failed";
      gatewayRuntimeErrorCode = aborted ? "cancelled" : "provider_error";
      gatewayRuntimeErrorMessage = remoteErrorMessage;
      if (aborted) {
        hookScope.cancel();
        requestRemoteBackendCancellation();
        runCleanupPromise = (async () => {
          const rolledBack = await compaction.handleTurnAbort();
          if (!rolledBack) {
            commitVisibleAbortedConversation();
          }
          if (shouldCreatePendingHistoryItem && !abortedConversationCommitted) {
            sidebarStore.removeLocal(conversationId);
          }
        })();
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        commitErroredConversation(msg || "Request failed");
      }
      backendBridgeEvents.emitError(remoteErrorMessage, conversationId);
      if (titleJobRef.current?.conversationId === conversationId) {
        titleJobRef.current = null;
      }
    } finally {
      releaseConversationRunUi();
      if (compactionBound) {
        compaction.unbindTurn();
        compactionBound = false;
      }
      hookLifecycle.endAgent();
      hookScope.close();
      clearAbortSnapshot(transcriptStore);
      const stopped = runStopRequestVersion !== null || cancellation.userStop.signal.aborted;
      if (stopped) {
        gatewayRuntimeFinalState = "cancelled";
        requestRemoteBackendCancellation();
      }
      await finalizeConversationRun(gatewayRuntimeFinalState);
      clearConversationStopHandler(conversationId, handleConversationStop);
      pruneIdleConversationCaches([conversationId]);
      if (stopped) {
        if (runStopRequestVersion !== null) {
          consumeConversationStop(conversationId, runStopRequestVersion);
        }
      } else {
        requestQueuedChatTurnProcessing(conversationId);
      }
    }
    return true;
  }

  return { send };
}
