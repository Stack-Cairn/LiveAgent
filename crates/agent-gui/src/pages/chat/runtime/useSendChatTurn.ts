import type { Context, UserMessage } from "@earendil-works/pi-ai";
import { invoke } from "@tauri-apps/api/core";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useCallback } from "react";
import type {
  MentionComposerDraft,
  MentionComposerHandle,
} from "../../../components/chat/MentionComposer";
import { getAutomationState } from "../../../lib/automation";
import { createHookRunScope } from "../../../lib/automation/hookRunner";
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
  createConversationHookLifecycle,
  createGatewayBridgeEventController,
} from "../../../lib/chat/conversation/run";
import { createTurnCancellation } from "../../../lib/chat/conversation/turnCancellation";
import type { ChatHistorySummary } from "../../../lib/chat/history/chatHistory";
import type { MemoryExtractionStatusKey } from "../../../lib/chat/memory/extractionEngine";
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
import { createModelFromConfig } from "../../../lib/providers/llm";
import {
  type AppSettings,
  applyMcpOpsToAppSettings,
  type ChatRuntimeControls,
  type ExecutionMode,
  getSshProjectHostIds,
  isAgentDevMode,
  isAgentExecutionMode,
  type SelectedModel,
  type SystemToolId,
  updateMemorySettings,
  updateSkills,
  workspaceProjectPathKey,
} from "../../../lib/settings";
import type { SidebarStore } from "../../../lib/sidebar/store";
import {
  buildSkillsSystemPrompt,
  resolveExplicitSkillMentions,
  type SkillSummary,
} from "../../../lib/skills";
import type { SubagentStoreManager } from "../../../lib/subagents";
import type { SkillAccessPolicy } from "../../../lib/tools/skillAccessPolicy";
import { appendManagedSkillSelections, asErrorMessage } from "../chatPageUtils";
import {
  buildTextFromComposerDraft,
  importPastedTextsAsFiles,
} from "../composer/composerDraftText";
import type { GatewayRuntimeSnapshotState } from "../gateway/chatRuntimeSnapshot";
import type { ActiveGatewayBridgeRequest } from "../gateway/gatewayBridgeTypes";
import { createLocalGatewayChatRunId } from "../gateway/gatewayRuntimeStatusModel";
import type { useGatewayBridgeBatcher } from "../gateway/useGatewayBridgeBatcher";
import type { useGatewayRuntimeSnapshots } from "../gateway/useGatewayRuntimeSnapshots";
import type { PersistConversationParams } from "../history/useConversationHistoryActions";
import type { useChatPageRuntimeStore } from "../hooks/useChatPageRuntimeStore";
import type { useLiveTranscriptController } from "../hooks/useLiveTranscriptController";
import type { createChatRuntimeHost } from "./ChatRuntimeHost";
import { buildErrorAssistantMessage, formatHookWarningMessage } from "./chatPageRuntime";
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
  buildProviderRuntimeConfig,
  resolveConversationTitleModelSelection,
  resolveMemorySummaryModelSelection,
  selectedModelsMatch,
} from "./providerRuntimeConfig";

type LiveTranscriptController = ReturnType<typeof useLiveTranscriptController>;
type ChatPageRuntimeStore = ReturnType<typeof useChatPageRuntimeStore>;
type GatewayBridgeBatcher = ReturnType<typeof useGatewayBridgeBatcher>;
type GatewayRuntimeSnapshots = ReturnType<typeof useGatewayRuntimeSnapshots>;

type TitleJobRefValue = {
  conversationId: string;
  promise: Promise<string | null>;
} | null;

type UseSendChatTurnParams = {
  settings: AppSettings;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
  getMcpSettings: () => AppSettings["mcp"];
  t: (key: string) => string;
  sidebarStore: SidebarStore;
  titleJobRef: MutableRefObject<TitleJobRefValue>;
  chatRuntimeHost: ReturnType<typeof createChatRuntimeHost>;
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
  appendDraftAssistantText: LiveTranscriptController["appendDraftAssistantText"];
  batchLiveRoundsUpdate: LiveTranscriptController["batchLiveRoundsUpdate"];
  updateToolStatus: LiveTranscriptController["updateToolStatus"];
  updateRetryAttempts: LiveTranscriptController["updateRetryAttempts"];
  queueGatewayBridgeEventForRequest: GatewayBridgeBatcher["queueGatewayBridgeEventForRequest"];
  flushGatewayBridgeEventsForRequest: GatewayBridgeBatcher["flushGatewayBridgeEventsForRequest"];
  activeGatewayRuntimeRunsRef: GatewayRuntimeSnapshots["activeGatewayRuntimeRunsRef"];
  queueGatewayRuntimeSnapshot: GatewayRuntimeSnapshots["queueGatewayRuntimeSnapshot"];
  queueGatewayRuntimeSnapshotForRun: GatewayRuntimeSnapshots["queueGatewayRuntimeSnapshotForRun"];
  registerActiveGatewayRuntimeRun: GatewayRuntimeSnapshots["registerActiveGatewayRuntimeRun"];
  finishActiveGatewayRuntimeRun: GatewayRuntimeSnapshots["finishActiveGatewayRuntimeRun"];
  gatewayBridgeHistorySummaryRef: MutableRefObject<Map<string, ChatHistorySummary>>;
  availableSkills: SkillSummary[];
  skillsRootDir: string;
  refreshSkills: () => Promise<{ skills: SkillSummary[]; rootDir: string } | null>;
  selectedSkillNames: string[];
  activeAgentPrompt: string;
  ensureTunnelToolTab: (projectPathKey?: string) => void;
  ensureSshTunnelToolTab: (projectPathKey?: string) => void;
  persistConversation: (params: PersistConversationParams) => Promise<boolean>;
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
    setSettings,
    getMcpSettings,
    t,
    sidebarStore,
    titleJobRef,
    chatRuntimeHost,
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
    setConversationSendingState,
    pendingUploadedFiles,
    getPendingUploadsForConversation,
    setPendingUploadsForConversation,
    getConversationLiveTranscriptStore,
    getCompactionController,
    clearAbortSnapshot,
    getAbortSnapshot,
    resetLiveTranscript,
    appendDraftAssistantText,
    batchLiveRoundsUpdate,
    updateToolStatus,
    updateRetryAttempts,
    queueGatewayBridgeEventForRequest,
    flushGatewayBridgeEventsForRequest,
    activeGatewayRuntimeRunsRef,
    queueGatewayRuntimeSnapshot,
    queueGatewayRuntimeSnapshotForRun,
    registerActiveGatewayRuntimeRun,
    finishActiveGatewayRuntimeRun,
    gatewayBridgeHistorySummaryRef,
    availableSkills,
    skillsRootDir,
    refreshSkills,
    selectedSkillNames,
    activeAgentPrompt,
    ensureTunnelToolTab,
    ensureSshTunnelToolTab,
    persistConversation,
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

  const enableManagedSkills = useCallback(
    (names: readonly string[]) => {
      const normalizedNames = names.map((name) => String(name).trim()).filter(Boolean);
      if (normalizedNames.length === 0) return;
      setSettings((prev) => {
        const selected = appendManagedSkillSelections(prev.skills.selected, normalizedNames);
        if (selected.join("\n") === prev.skills.selected.join("\n")) return prev;
        return updateSkills(prev, { selected });
      });
    },
    [setSettings],
  );

  async function send(overrides?: {
    textOverride?: string;
    composerDraftOverride?: MentionComposerDraft;
    uploadedFilesOverride?: PendingUploadedFile[];
    conversationIdOverride?: string;
    executionModeOverride?: ExecutionMode;
    workdirOverride?: string;
    selectedSystemToolIdsOverride?: SystemToolId[];
    runtimeControlsOverride?: ChatRuntimeControls;
    gatewayBridgeRequestOverride?: ActiveGatewayBridgeRequest | null;
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

    const gatewayBridgeRequest = overrides?.gatewayBridgeRequestOverride ?? null;
    const effectiveExecutionMode =
      overrides?.executionModeOverride ??
      gatewayBridgeRequest?.executionModeOverride ??
      settings.system.executionMode;
    const effectiveIsAgentMode = isAgentExecutionMode(effectiveExecutionMode);
    const effectiveWorkdir = (
      overrides?.workdirOverride ??
      gatewayBridgeRequest?.workdirOverride ??
      (effectiveIsAgentMode ? (runtimeEntry?.workdir ?? settings.system.workdir) : "")
    ).trim();
    const effectiveSelectedSystemToolIds =
      overrides?.selectedSystemToolIdsOverride ??
      gatewayBridgeRequest?.selectedSystemToolIdsOverride ??
      settings.system.selectedSystemTools;
    const effectiveProjectPathKey = workspaceProjectPathKey(effectiveWorkdir);
    const effectiveAssociatedSshHostIds = getSshProjectHostIds(
      settings.ssh,
      effectiveProjectPathKey,
    );
    const effectiveIsAgentDevExecutionMode = isAgentDevMode(effectiveExecutionMode);
    const effectiveSkillsEnabled = settings.skills.enabled && effectiveIsAgentMode;
    const hasRemoteGatewayTarget =
      settings.remote.enabled &&
      settings.remote.gatewayUrl.trim() !== "" &&
      settings.remote.token.trim() !== "";
    const mirrorsLocalRunToGateway = !gatewayBridgeRequest && hasRemoteGatewayTarget;
    const gatewayBridgeRequestId =
      gatewayBridgeRequest?.requestId ?? createLocalGatewayChatRunId(conversationId);
    const gatewayBridgeWorkerId =
      gatewayBridgeRequest?.workerId ?? (mirrorsLocalRunToGateway ? "gui-live" : undefined);
    const gatewayBridgeEvents = createGatewayBridgeEventController({
      conversationId,
      requestId: gatewayBridgeRequestId,
      workerId: gatewayBridgeWorkerId,
      enabled: Boolean(gatewayBridgeRequest) || hasRemoteGatewayTarget,
      sendEvent: (requestId, event, options) => {
        const result = queueGatewayBridgeEventForRequest(requestId, event, options);
        void queueGatewayRuntimeSnapshot(conversationId);
        return result;
      },
      flushEvents: flushGatewayBridgeEventsForRequest,
      resolveErrorConversationId: () =>
        gatewayBridgeRequest?.conversationId ?? currentConversationIdRef.current,
    });
    const updateGatewayBridgeToolStatus = (status: string | null, isCompaction = false) => {
      gatewayBridgeEvents.queueToolStatus(status, isCompaction);
      updateToolStatus(status, transcriptStore);
      const run = activeGatewayRuntimeRunsRef.current.get(conversationId);
      if (run) {
        run.toolStatusIsCompaction = Boolean(status?.trim()) && isCompaction;
      }
      void queueGatewayRuntimeSnapshot(conversationId);
    };
    // Mirrors the live retry-attempt list to remote WebUI clients alongside
    // the local live-transcript update.
    const updateGatewayBridgeRetryAttempts: typeof updateRetryAttempts = (attempts, store) => {
      gatewayBridgeEvents.queueRetryAttempts(attempts);
      updateRetryAttempts(attempts, store);
    };
    const setConversationErrorState = (message: string | null) => {
      updateConversationRuntimeEntry(conversationId, (prev) => ({
        ...prev,
        errorMessage: message,
      }));
    };
    if (!runtimeEntry) {
      const message = `Conversation runtime not found: ${conversationId}`;
      gatewayBridgeEvents.emitError(message, conversationId);
      throw new Error(message);
    }
    if (runtimeEntry.isSending) {
      if (gatewayBridgeRequest) {
        const message = "Conversation is already sending.";
        gatewayBridgeEvents.emitError(message, conversationId);
        await gatewayBridgeEvents.close();
      }
      return false;
    }
    if (isImportingPastedTextRef.current && typeof overrides?.textOverride !== "string") {
      return false;
    }
    if (hydratingConversationIdRef.current === conversationId) {
      const message = "当前会话仍在补全完整历史，请稍候。";
      setConversationErrorState(message);
      gatewayBridgeEvents.emitError(message, conversationId);
      return false;
    }
    if (hydrationFailedConversationIdRef.current === conversationId) {
      const message = "当前会话完整历史加载失败，请重新打开该会话后再继续。";
      setConversationErrorState(message);
      gatewayBridgeEvents.emitError(message, conversationId);
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
        gatewaySelectedModel: gatewayBridgeRequest?.selectedModelOverride,
      });
    } catch (error) {
      const message = asErrorMessage(error, "当前模型配置不可用，请重新选择后重试。");
      setConversationErrorState(message);
      gatewayBridgeEvents.emitError(message);
      return false;
    }

    const { selectedModel, provider, providerId, model } = effectiveSelectedModel;
    updateConversationRuntimeEntry(conversationId, (prev) =>
      selectedModelsMatch(prev.selectedModel, selectedModel) ? prev : { ...prev, selectedModel },
    );
    const runtimeControls =
      gatewayBridgeRequest?.runtimeControlsOverride ??
      overrides?.runtimeControlsOverride ??
      settings.chatRuntimeControls;
    const providerConfig = buildProviderRuntimeConfig(provider, model, runtimeControls);
    const memorySummaryModelSelection = resolveMemorySummaryModelSelection(settings);
    const memoryExtractionModel = memorySummaryModelSelection
      ? {
          providerId: memorySummaryModelSelection.providerId,
          model: memorySummaryModelSelection.model,
          runtime: buildProviderRuntimeConfig(
            memorySummaryModelSelection.provider,
            memorySummaryModelSelection.model,
            runtimeControls,
          ),
          selectedModel: memorySummaryModelSelection.selectedModel,
        }
      : undefined;
    const handleMemoryExtractionModelFailure = memoryExtractionModel
      ? (failedModel: { selectedModel?: SelectedModel }) => {
          const failedSelectedModel = failedModel.selectedModel;
          setSettings((prev) => {
            if (!selectedModelsMatch(prev.memory.summaryModel, failedSelectedModel)) {
              return prev;
            }
            return updateMemorySettings(prev, { summaryModel: undefined });
          });
        }
      : undefined;
    const memoryExtractionStatusText = (
      key: MemoryExtractionStatusKey,
      counts: { accepted: number; rejected: number },
    ) =>
      t(`chat.memoryExtraction.${key}`)
        .replace("{accepted}", String(counts.accepted))
        .replace("{rejected}", String(counts.rejected));
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
        gatewayBridgeEvents.emitError(message, conversationId);
        await gatewayBridgeEvents.close();
        return false;
      } finally {
        isImportingPastedTextRef.current = false;
        setIsImportingPastedText(false);
      }
    }

    const userMessage = createUserMessageWithUploads(text, uploadedFiles, Date.now());
    if (!userMessage) {
      if (gatewayBridgeRequest) {
        const message = "Message is required.";
        gatewayBridgeEvents.emitError(message, conversationId);
        await gatewayBridgeEvents.close();
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
    const conversationDebugLogger = createStreamDebugLogger({
      enabled: effectiveIsAgentDevExecutionMode,
      conversationId,
      executionMode: effectiveExecutionMode,
      streamKind: "conversation",
      providerId,
      model,
    });
    const recoveryDebugLogger = createStreamDebugLogger({
      enabled: effectiveIsAgentDevExecutionMode,
      conversationId,
      executionMode: effectiveExecutionMode,
      streamKind: "conversation_recovery",
      providerId,
      model,
    });
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
      gatewayBridgeHistorySummaryRef.current.get(conversationId);
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
      const titleProviderConfig = buildProviderRuntimeConfig(
        titleModelSelection.provider,
        titleModelSelection.model,
        runtimeControls,
      );
      titlePromise = startConversationTitleJob({
        providerId: titleModelSelection.providerId,
        model: titleModelSelection.model,
        runtime: {
          baseUrl: titleProviderConfig.baseUrl,
          apiKey: titleProviderConfig.apiKey,
          requestFormat: titleProviderConfig.requestFormat,
          reasoning: titleProviderConfig.reasoning,
          promptCachingEnabled: titleProviderConfig.promptCachingEnabled,
          nativeWebSearchEnabled: titleProviderConfig.nativeWebSearchEnabled,
          useSystemProxy: titleProviderConfig.useSystemProxy,
          modelConfig: titleProviderConfig.modelConfig,
        },
        signal: cancellation.deriveScope().controller.signal,
        conversationId,
        titleSourceText,
        content,
        sidebarStore,
        titleJobRef,
        gatewayBridgeEvents,
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
    let gatewayRunStarted = false;
    function acknowledgeGatewayRunStarted() {
      if (gatewayRunStarted) {
        return;
      }
      gatewayRunStarted = true;
      if (gatewayBridgeRequest || hasRemoteGatewayTarget) {
        const run = registerActiveGatewayRuntimeRun({
          conversationId,
          runId: gatewayBridgeRequestId,
          clientRequestId: gatewayBridgeRequest?.clientRequestId,
          workerId: gatewayBridgeWorkerId,
          cwd: conversationCwd,
          revision: 0,
          state: "running",
          userMessage: pendingUserMessage,
          transcriptStore,
          toolStatusIsCompaction: false,
        });
        void queueGatewayRuntimeSnapshotForRun(run, { state: "running", force: true });
      }
    }
    function markConversationRunStarted() {
      if (conversationRunStarted) {
        return;
      }
      conversationRunStarted = true;
      applyConversationState(nextConversationState);
      resetLiveTranscript(transcriptStore);
      setConversationAbortController(conversationId, cancellation.userStop);
      setConversationSendingState(conversationId, true);
      // Queue-drained auto-starts are not a user gesture: the reader may be
      // deep in history when the previous run finishes, and force-pinning
      // for the next queued turn would yank them to the bottom. Manual sends
      // still pin (here and via resetVisibleTransientState below).
      if (isConversationVisible() && !overrides?.preserveComposerOnStart) {
        scrollFollowRef.current?.stickToBottom();
      }
    }
    async function markConversationRunStopped(state: GatewayRuntimeSnapshotState = "completed") {
      if (!conversationRunStarted) {
        return;
      }
      setConversationAbortController(conversationId, null);
      setConversationSendingState(conversationId, false);
      await gatewayBridgeEvents.close();
      if (gatewayRunStarted) {
        await finishActiveGatewayRuntimeRun(conversationId, state);
      }
    }
    let localGatewayRunStarted = false;
    async function markLocalGatewayRunStarted() {
      if (!mirrorsLocalRunToGateway || localGatewayRunStarted) {
        return;
      }
      await invoke("gateway_chat_mark_local_started", {
        request_id: gatewayBridgeRequestId,
        conversation_id: conversationId,
      } as any);
      localGatewayRunStarted = true;
    }

    markConversationRunStarted();
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
    if (mirrorsLocalRunToGateway) {
      try {
        await markLocalGatewayRunStarted();
      } catch (error) {
        console.warn("gateway_chat_mark_local_started failed", error);
      }
    }
    if (overrides?.beforeRuntimeStart) {
      try {
        await overrides.beforeRuntimeStart();
      } catch (error) {
        const message = asErrorMessage(error, "启动远程对话运行失败");
        setConversationErrorState(message);
        gatewayBridgeEvents.emitError(message, conversationId);
        await gatewayBridgeEvents.close();
        await markConversationRunStopped("failed");
        restoreComposerOnStartFailure();
        return false;
      }
    }

    // Persist the user turn immediately so WebUI/GUI sidebars can surface the
    // latest conversation before the assistant round finishes. The live runtime
    // itself is mirrored through ChatRuntimeSnapshot, not history_sync.
    const initialPersist = persistConversationWithHistorySync({
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
    if (overrides?.afterInitialHistoryPersist && !overrides.beforeRuntimeStart) {
      const persisted = await initialPersist;
      if (!persisted) {
        const message = "历史记录保存失败，已取消回滚与重发。";
        setConversationErrorState(message);
        gatewayBridgeEvents.emitError(message, conversationId);
        await gatewayBridgeEvents.close();
        await markConversationRunStopped("failed");
        restoreComposerOnStartFailure();
        return true;
      }
      try {
        await overrides.afterInitialHistoryPersist();
      } catch (error) {
        const message = asErrorMessage(error, "回滚历史失败");
        setConversationErrorState(message);
        gatewayBridgeEvents.emitError(message, conversationId);
        await gatewayBridgeEvents.close();
        await markConversationRunStopped("failed");
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
    if (gatewayBridgeRequest || hasRemoteGatewayTarget) {
      const persisted = await initialPersist.catch((error) => {
        console.warn("initial conversation history persist before gateway stream failed", error);
        return false;
      });
      if (!persisted) {
        console.warn("gateway stream started before initial user turn was persisted");
      }
    }
    await gatewayBridgeEvents.queueUserMessage(text, uploadedFiles, {
      messageId: pendingUserMessage.id,
      baseMessageRef: overrides?.editResendBaseMessageRef,
      // The new message's own stable identity: lets remote transcripts bind
      // their user bubble's messageRef immediately, so a follow-up edit of
      // this message can anchor its rebase without a history round-trip.
      messageRef: findHistoryMessageRefByMessageId(nextConversationState, pendingUserMessage.id),
    });
    acknowledgeGatewayRunStarted();
    let skillsPrompt = "";
    let memoryPrompt = "";
    let skillsRootDirForTools = skillsRootDir;
    let skillAccessPolicyForTools: SkillAccessPolicy | undefined = effectiveSkillsEnabled
      ? {
          allowedSkillNames: [],
          allowedSkillBaseDirs: [],
          allowSkillInventory: false,
          allowSkillManagement: false,
          allowSkillMutation: true,
        }
      : undefined;

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
      runtime: {
        baseUrl: providerConfig.baseUrl,
        apiKey: providerConfig.apiKey,
        requestFormat: providerConfig.requestFormat,
        reasoning: providerConfig.reasoning,
        promptCachingEnabled: providerConfig.promptCachingEnabled,
        nativeWebSearchEnabled: providerConfig.nativeWebSearchEnabled,
        useSystemProxy: providerConfig.useSystemProxy,
        modelConfig: providerConfig.modelConfig,
      },
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
        setBridgeToolStatus: updateGatewayBridgeToolStatus,
        queueCheckpoint: (state) => gatewayBridgeEvents.queueCheckpoint(state),
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
        gatewayBridgeEvents.emitError(message, conversationId);
        await gatewayBridgeEvents.close();
        await markConversationRunStopped("failed");
        restoreComposerOnStartFailure();
        return true;
      }

      const selectedSkills = selectedSkillNames.map((n) => byName.get(n)!).filter(Boolean);
      const allowBuiltinSkillManagement = selectedSkills.some(
        (skill) => skill.name === "skills-creator" || skill.name === "skills-installer",
      );

      // IMPORTANT: Claude Code-style skills are progressive disclosure.
      // We only provide metadata in the system prompt. The model decides whether to read the skill file.
      skillsRootDirForTools = rootDir;
      skillAccessPolicyForTools = {
        allowedSkillNames: selectedSkills.map((skill) => skill.name),
        allowedSkillBaseDirs: selectedSkills.map((skill) => skill.baseDir),
        protectedSkillNames: selectedSkills
          .filter((skill) => skill.builtIn === true)
          .map((skill) => skill.name),
        protectedSkillBaseDirs: selectedSkills
          .filter((skill) => skill.builtIn === true)
          .map((skill) => skill.baseDir),
        allowSkillInventory: true,
        allowSkillManagement: allowBuiltinSkillManagement,
        allowSkillMutation: true,
      };
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
    let terminalHistoryPersistPromise: Promise<boolean> | null = null;
    let persistableAgentProgress: {
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
      resetLiveTranscript(transcriptStore);
      updateConversationRuntimeEntry(conversationId, (prev) => ({
        ...prev,
        state: finalState,
      }));
      terminalHistoryPersistPromise = persistConversationWithHistorySync({
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
      resetLiveTranscript(transcriptStore);
      updateConversationRuntimeEntry(conversationId, (prev) => ({
        ...prev,
        state: finalState,
        errorMessage: null,
      }));
      terminalHistoryPersistPromise = persistConversationWithHistorySync({
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

    let gatewayRuntimeFinalState: GatewayRuntimeSnapshotState = "completed";
    try {
      if (effectiveIsAgentMode) {
        await chatRuntimeHost.runTurn({
          mode: "agent",
          params: {
            providerId,
            model,
            runtime: {
              baseUrl: providerConfig.baseUrl,
              apiKey: providerConfig.apiKey,
              requestFormat: providerConfig.requestFormat,
              reasoning: providerConfig.reasoning,
              promptCachingEnabled: providerConfig.promptCachingEnabled,
              nativeWebSearchEnabled: providerConfig.nativeWebSearchEnabled,
              useSystemProxy: providerConfig.useSystemProxy,
              modelConfig: providerConfig.modelConfig,
            },
            runtimeModel,
            selectedModel,
            memoryExtractionModel,
            onMemoryExtractionModelFailure: handleMemoryExtractionModelFailure,
            memoryExtractionStatusText,
            effectiveWorkdir,
            effectiveSkillsEnabled,
            showSilentMemoryExtraction: effectiveIsAgentDevExecutionMode,
            skillsRootDir: skillsRootDirForTools,
            skillAccessPolicy: skillAccessPolicyForTools,
            onManagedSkillsChanged: (change) => {
              enableManagedSkills(change.names);
            },
            agentTemplates: settings.agents,
            selectedSystemToolIds: effectiveSelectedSystemToolIds,
            getMcpSettings,
            applyMcpOps: (ops) => {
              setSettings((prev) => applyMcpOpsToAppSettings(prev, ops));
            },
            remoteWebTunnelsEnabled: settings.remote.enableWebTunnels,
            tunnelPublicBaseUrl: settings.remote.gatewayUrl.trim(),
            sshHosts: settings.ssh.hosts,
            associatedSshHostIds: effectiveAssociatedSshHostIds,
            sshManagerRemoteAllowed:
              !gatewayBridgeRequest || settings.remote.enableWebSshTerminal === true,
            onSshSessionsChanged: (change) => {
              if (change.action === "create") {
                ensureSshTunnelToolTab(change.projectPathKey);
              }
            },
            onTunnelsChanged: (change) => {
              if (change.action === "create") {
                ensureTunnelToolTab(change.projectPathKey);
              }
            },
            sessionId,
            conversationId,
            conversationCwd,
            fallbackTitle,
            createdAt,
            titlePromise,
            transcriptStore,
            gatewayBridgeEvents,
            hookLifecycle,
            conversationDebugLogger,
            subagentStore: subagentStoresRef.current.get(conversationId),
            getNextConversationState: () => nextConversationState,
            applyConversationState,
            buildPreparedContext,
            compaction,
            cancellation,
            resetLiveTranscript,
            batchLiveRoundsUpdate,
            updateToolStatus,
            updateRetryAttempts: updateGatewayBridgeRetryAttempts,
            updatePersistableAgentProgress: (progress) => {
              persistableAgentProgress = progress;
            },
            commitVisibleAbortedConversation,
            updateConversationRuntimeEntry,
            persistConversationWithHistorySync,
          },
        });
      } else {
        await chatRuntimeHost.runTurn({
          mode: "text",
          params: {
            providerId,
            model,
            runtime: {
              baseUrl: providerConfig.baseUrl,
              apiKey: providerConfig.apiKey,
              requestFormat: providerConfig.requestFormat,
              reasoning: providerConfig.reasoning,
              promptCachingEnabled: providerConfig.promptCachingEnabled,
              nativeWebSearchEnabled: providerConfig.nativeWebSearchEnabled,
              useSystemProxy: providerConfig.useSystemProxy,
              modelConfig: providerConfig.modelConfig,
            },
            runtimeModel,
            selectedModel,
            memoryExtractionModel,
            onMemoryExtractionModelFailure: handleMemoryExtractionModelFailure,
            memoryExtractionStatusText,
            sessionId,
            conversationId,
            conversationCwd,
            fallbackTitle,
            createdAt,
            titlePromise,
            transcriptStore,
            gatewayBridgeEvents,
            hookLifecycle,
            conversationDebugLogger,
            recoveryDebugLogger,
            getNextConversationState: () => nextConversationState,
            applyConversationState,
            buildPreparedContext,
            compaction,
            cancellation,
            resetLiveTranscript,
            appendDraftAssistantText,
            batchLiveRoundsUpdate,
            updateGatewayBridgeToolStatus,
            updateRetryAttempts: updateGatewayBridgeRetryAttempts,
            commitVisibleAbortedConversation,
            updateConversationRuntimeEntry,
            persistConversationWithHistorySync,
          },
        });
      }
    } catch (err) {
      const aborted = cancellation.userStop.signal.aborted || isAbortLikeError(err);
      gatewayRuntimeFinalState = aborted ? "cancelled" : "failed";
      const remoteErrorMessage = aborted
        ? "Cancelled"
        : (err instanceof Error ? err.message : String(err)) || "Request failed";
      if (aborted) {
        hookScope.cancel();
        const rolledBack = await compaction.handleTurnAbort();
        if (!rolledBack) {
          commitVisibleAbortedConversation();
        }
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        commitErroredConversation(msg || "Request failed");
      }
      await waitForTerminalHistoryPersist(terminalHistoryPersistPromise);
      gatewayBridgeEvents.emitError(remoteErrorMessage, conversationId);
      await gatewayBridgeEvents.close();
      if (shouldCreatePendingHistoryItem && !abortedConversationCommitted) {
        sidebarStore.removeLocal(conversationId);
      }
      if (titleJobRef.current?.conversationId === conversationId) {
        titleJobRef.current = null;
      }
    } finally {
      compaction.unbindTurn();
      hookLifecycle.endAgent();
      hookScope.close();
      clearAbortSnapshot(transcriptStore);
      await waitForTerminalHistoryPersist(terminalHistoryPersistPromise);
      await markConversationRunStopped(gatewayRuntimeFinalState);
      pruneIdleConversationCaches([conversationId]);
      requestQueuedChatTurnProcessing(conversationId);
    }
    return true;
  }

  return { send };
}
