import type { Context, UserMessage } from "@earendil-works/pi-ai";
import type {
  MentionComposerDraft,
  MentionComposerHandle,
} from "@liveagent/ui/components/chat/MentionComposer";
import { getAutomationState } from "@liveagent/ui/lib/automation/index";
import { normalizeLogicalLineEndings } from "@liveagent/ui/lib/chat/composerText";
import {
  createUserMessageWithUploads,
  mergePendingUploadedFiles,
  type PendingUploadedFile,
} from "@liveagent/ui/lib/chat/uploadedFiles";
import { appendManagedSkillSelections } from "@liveagent/ui/lib/chat/useComposerActions";
import type { ScrollFollowHandle } from "@liveagent/ui/lib/chat-scroll/useScrollFollow";
import type { SidebarStore } from "@liveagent/ui/lib/sidebar/store";
import {
  buildSkillsSystemPrompt,
  formatExplicitSkillMentions,
  resolveExplicitSkillMentions,
  type SkillSummary,
} from "@liveagent/ui/lib/skills/index";
import { invoke } from "@tauri-apps/api/core";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useCallback } from "react";
import { createHookRunScope } from "../../../lib/automation/hookRunner";
import {
  buildPersistableMessagesFromSnapshot,
  type SuppressedToolTraceSnapshot,
} from "../../../lib/chat/conversation/chatAbort";
import {
  appendMessagesToConversation,
  buildRequestContext,
  type ConversationViewState,
  clearTaskListState,
  findHistoryMessageRefByMessageId,
  type HistoryMessageRef,
  setTaskListState,
} from "../../../lib/chat/conversation/conversationState";
import {
  createConversationHookLifecycle,
  createGatewayBridgeEventController,
} from "../../../lib/chat/conversation/run";
import { createTurnCancellation } from "../../../lib/chat/conversation/turnCancellation";
import type { ChatHistorySummary } from "../../../lib/chat/history/chatHistory";
import type { MemoryExtractionStatusKey } from "../../../lib/chat/memory/extractionEngine";
import { memoryTurnInjection } from "../../../lib/chat/memory/injectionController";
import {
  BRANCH_CONVERSATION_DEFAULT_TITLE,
  buildFallbackConversationTitle,
  createPendingHistoryItem,
  getFirstUserMessageText,
  isAbortLikeError,
} from "../../../lib/chat/page/chatPageHelpers";
import { skillMentionInjection } from "../../../lib/chat/skills/mentionInjection";
import { createStreamDebugLogger } from "../../../lib/debug/agentDebug";
import { buildMemoryOverviewSection } from "../../../lib/memory/prompts/injection";
import { createModelFromConfig, createProviderRuntimeConfig } from "../../../lib/providers/llm";
import {
  type AppSettings,
  applyMcpOpsToAppSettings,
  type ChatRuntimeControls,
  type ExecutionMode,
  filterMcpSettingsForWorkspace,
  getSshProjectHostIds,
  isAgentDevMode,
  isAgentExecutionMode,
  removeWorkspaceResourceReferences,
  resolveWorkspaceResources,
  type SelectedModel,
  updateMemorySettings,
  updateSkills,
  type WorkspaceProject,
  workspaceProjectPathKey,
} from "../../../lib/settings";
import {
  collectRetainedSubagentParentToolCallIds,
  pruneSubagentRunsForConversation,
  type SubagentStoreManager,
} from "../../../lib/subagents";
import type { AdditionalProjectRoot } from "../../../lib/tools/additionalProjectRoots";
import type { SkillAccessPolicy } from "../../../lib/tools/skillAccessPolicy";
import type { TaskStateStore } from "../../../lib/tools/taskTools";
import { listWorkspaceRootGrants } from "../../../lib/workspaceRootGrants";
import { asErrorMessage } from "../chatPageUtils";
import {
  buildTextFromComposerDraft,
  importPastedTextsAsFiles,
} from "../composer/composerDraftText";
import type { ConversationHydrationStore } from "../conversations/conversationHydrationStore";
import {
  buildGatewayFinalProjectionEntries,
  buildGatewayRuntimeSnapshotEntries,
  type GatewayRuntimeSnapshotState,
} from "../gateway/chatRuntimeSnapshot";
import type { ActiveGatewayBridgeRequest } from "../gateway/gatewayBridgeTypes";
import { createLocalGatewayChatRunId } from "../gateway/gatewayRuntimeStatusModel";
import type { useGatewayRunMirrorCoordinator } from "../gateway/useGatewayRunMirrorCoordinator";
import type { PersistConversationParams } from "../history/useConversationHistoryActions";
import type { useChatPageRuntimeStore } from "../hooks/useChatPageRuntimeStore";
import type { useLiveTranscriptController } from "../hooks/useLiveTranscriptController";
import type { createChatRuntimeHost } from "./ChatRuntimeHost";
import {
  buildErrorAssistantMessage,
  formatHookWarningMessage,
  resolveEffectiveConversationWorkdir,
} from "./chatPageRuntime";
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
  buildModelFailoverPlan,
  resolveConversationTitleModelSelection,
  resolveMemorySummaryModelSelection,
  selectedModelsMatch,
} from "./providerRuntimeConfig";

type LiveTranscriptController = ReturnType<typeof useLiveTranscriptController>;
type ChatPageRuntimeStore = ReturnType<typeof useChatPageRuntimeStore>;
type GatewayRunMirrorCoordinator = ReturnType<typeof useGatewayRunMirrorCoordinator>;

type TitleJobRefValue = {
  conversationId: string;
  promise: Promise<string | null>;
} | null;

type UseSendChatTurnParams = {
  settings: AppSettings;
  workspaceProjects: readonly WorkspaceProject[];
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
  getMcpSettings: () => AppSettings["mcp"];
  getToolPolicies: () => AppSettings["system"]["toolPolicies"];
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
  hydration: ConversationHydrationStore;
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
  appendDraftAssistantText: LiveTranscriptController["appendDraftAssistantText"];
  batchLiveRoundsUpdate: LiveTranscriptController["batchLiveRoundsUpdate"];
  updateToolStatus: LiveTranscriptController["updateToolStatus"];
  updateRetryAttempts: LiveTranscriptController["updateRetryAttempts"];
  queueGatewayBridgeEventForRequest: GatewayRunMirrorCoordinator["queueGatewayBridgeEventForRequest"];
  flushGatewayBridgeEventsForRequest: GatewayRunMirrorCoordinator["flushGatewayBridgeEventsForRequest"];
  registerGatewayRunMirror: GatewayRunMirrorCoordinator["registerGatewayRunMirror"];
  finishGatewayRunMirror: GatewayRunMirrorCoordinator["finishGatewayRunMirror"];
  gatewayBridgeHistorySummaryRef: MutableRefObject<Map<string, ChatHistorySummary>>;
  availableSkills: SkillSummary[];
  skillsRootDir: string;
  refreshSkills: () => Promise<{ skills: SkillSummary[]; rootDir: string } | null>;
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
    workspaceProjects,
    setSettings,
    getMcpSettings,
    getToolPolicies,
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
    hydration,
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
    appendDraftAssistantText,
    batchLiveRoundsUpdate,
    updateToolStatus,
    updateRetryAttempts,
    queueGatewayBridgeEventForRequest,
    flushGatewayBridgeEventsForRequest,
    registerGatewayRunMirror,
    finishGatewayRunMirror,
    gatewayBridgeHistorySummaryRef,
    availableSkills,
    skillsRootDir,
    refreshSkills,
    activeAgentPrompt,
    ensureTunnelToolTab,
    ensureSshTunnelToolTab,
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
    const effectiveWorkdir = resolveEffectiveConversationWorkdir({
      isAgentMode: effectiveIsAgentMode,
      workdirOverride: overrides?.workdirOverride,
      gatewayWorkdirOverride: gatewayBridgeRequest?.workdirOverride,
      persistedWorkdir: sidebarStore.peek(conversationId)?.cwd,
      runtimeWorkdir: runtimeEntry?.workdir,
      globalWorkdir: settings.system.workdir,
    });
    const effectiveProjectPathKey = workspaceProjectPathKey(effectiveWorkdir);
    const effectiveProject = workspaceProjects.find(
      (project) => workspaceProjectPathKey(project.path) === effectiveProjectPathKey,
    );
    let additionalRoots: AdditionalProjectRoot[] = [];
    if (effectiveIsAgentMode && effectiveProject) {
      try {
        additionalRoots = (await listWorkspaceRootGrants(effectiveProject))
          .filter((grant) => grant.state === "active")
          .map((grant) => ({
            id: grant.id,
            alias: grant.alias,
            path: grant.canonicalPath,
            access: grant.access,
          }));
      } catch (error) {
        // Fail closed: unavailable or stale grants must not widen this turn's
        // structured file-tool capability.
        console.warn("Failed to load workspace root grants", error);
      }
    }
    const effectiveAssociatedSshHostIds = getSshProjectHostIds(
      settings.ssh,
      effectiveProjectPathKey,
    );
    const effectiveIsAgentDevExecutionMode = isAgentDevMode(effectiveExecutionMode);
    const workspaceResources = resolveWorkspaceResources(settings, effectiveWorkdir);
    const effectiveSkillsEnabled = workspaceResources.skillsEnabled && effectiveIsAgentMode;
    const selectedSkillNames = effectiveSkillsEnabled ? workspaceResources.skillNames : [];
    const getEffectiveMcpSettings = () =>
      filterMcpSettingsForWorkspace(getMcpSettings(), workspaceResources);
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
      sendEvent: queueGatewayBridgeEventForRequest,
      flushEvents: flushGatewayBridgeEventsForRequest,
      resolveErrorConversationId: () =>
        gatewayBridgeRequest?.conversationId ?? currentConversationIdRef.current,
    });
    const updateGatewayBridgeToolStatus = (status: string | null, isCompaction = false) => {
      gatewayBridgeEvents.queueToolStatus(status, isCompaction);
      updateToolStatus(status, transcriptStore);
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
    if (hydration.isHydrating(conversationId)) {
      const message = "当前会话仍在加载，请稍候。";
      setConversationErrorState(message);
      gatewayBridgeEvents.emitError(message, conversationId);
      return false;
    }
    if (hydration.isFailed(conversationId)) {
      const message = "当前会话加载失败，请重新打开该会话后再继续。";
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
    const providerConfig = createProviderRuntimeConfig(provider, model, runtimeControls);
    // cc-switch style auto-failover plan for this turn (shared by the agent
    // and text runtimes). The switch callback makes the winning fallback the
    // conversation's selection so follow-up turns start on the healthy
    // provider directly.
    const failoverPlan = buildModelFailoverPlan(settings, effectiveSelectedModel, runtimeControls);
    const failoverParams = failoverPlan
      ? {
          config: failoverPlan.config,
          primary: failoverPlan.primary,
          fallbacks: failoverPlan.fallbacks,
          onSwitched: (event: {
            target: { selectedModel: SelectedModel } | null;
            round: number;
            errorMessage: string;
          }) => {
            const nextSelectedModel =
              event.target?.selectedModel ?? failoverPlan.primary.selectedModel;
            updateConversationRuntimeEntry(conversationId, (prev) =>
              selectedModelsMatch(prev.selectedModel, nextSelectedModel)
                ? prev
                : { ...prev, selectedModel: nextSelectedModel },
            );
          },
        }
      : undefined;
    const memorySummaryModelSelection = resolveMemorySummaryModelSelection(settings);
    const memoryExtractionModel = memorySummaryModelSelection
      ? {
          providerId: memorySummaryModelSelection.providerId,
          model: memorySummaryModelSelection.model,
          runtime: createProviderRuntimeConfig(
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
    let text = normalizeLogicalLineEndings(
      hasTextOverride
        ? textOverride
        : composerDraft
          ? effectiveIsAgentMode && composerDraft.largePastes.length > 0
            ? composerDraft.textWithoutLargePastes
            : buildTextFromComposerDraft(composerDraft)
          : "",
    );
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
        text = buildTextFromComposerDraft(composerDraft, imported.fileByPasteId);
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
    if (isConversationStopRequested(conversationId)) {
      const stopRequestVersion = getConversationStopRequestVersion(conversationId);
      if (gatewayBridgeRequest) {
        void invoke("gateway_chat_cancel_request", {
          request_id: gatewayBridgeRequestId,
          conversation_id: conversationId,
          worker_id: gatewayBridgeWorkerId ?? "gui-live",
        } as any).catch((error) => {
          console.warn("gateway_chat_cancel_request failed", error);
        });
      }
      consumeConversationStop(conversationId, stopRequestVersion);
      void settleChatRunFinalization(gatewayBridgeEvents.close());
      return false;
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
    const baseConversationState = clearTaskListState(runtimeEntry.state);
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
      const titleProviderConfig = createProviderRuntimeConfig(
        titleModelSelection.provider,
        titleModelSelection.model,
        runtimeControls,
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
    let conversationUiReleased = false;
    let gatewayRunStarted = false;
    let localGatewayRunStarted = false;
    let remoteGatewayCancelRequested = false;
    let gatewayRuntimeFinalState: GatewayRuntimeSnapshotState = "completed";
    let gatewayRuntimeErrorCode = "";
    let gatewayRuntimeErrorMessage = "";
    let frozenGatewayFinalProjectionJson: string | null = null;
    let frozenGatewayContentComplete = false;
    let terminalHistoryPersistFailed = false;
    let initialUserTurnPersisted = false;
    let initialPersistPromise: Promise<boolean> | null = null;
    let terminalHistoryPersistPromise: Promise<boolean> | null = null;
    let runCleanupPromise: Promise<void> = Promise.resolve();
    let compactionBound = false;
    let runStopRequestVersion: number | null = null;

    function registerGatewayRuntimeRun(state: GatewayRuntimeSnapshotState) {
      if (!(gatewayBridgeRequest || hasRemoteGatewayTarget)) {
        return null;
      }
      return registerGatewayRunMirror({
        runId: gatewayBridgeRequestId,
        conversationId,
        workerId: gatewayBridgeWorkerId,
        userMessage: pendingUserMessage,
        transcriptStore,
        state,
      });
    }

    function freezeGatewayFinalProjection(state: ConversationViewState, contentComplete = true) {
      const entries = buildGatewayFinalProjectionEntries({
        state,
        userMessage: pendingUserMessage,
        runId: gatewayBridgeRequestId,
      });
      frozenGatewayFinalProjectionJson = JSON.stringify(entries);
      // The builder degrades to a user-only projection when it cannot locate
      // this run's user message in the persisted history. If the run visibly
      // produced assistant output, that degradation must not claim
      // completeness — a confirmed-empty projection would erase the reply on
      // remote clients and block history convergence.
      const hasAssistantEntry = entries.some((entry) => entry.kind !== "user");
      const liveSnapshot = transcriptStore.getSnapshot();
      const runProducedOutput =
        liveSnapshot.liveRounds.length > 0 || Boolean(liveSnapshot.draftAssistantText);
      frozenGatewayContentComplete = contentComplete && (hasAssistantEntry || !runProducedOutput);
    }

    function freezeGatewayLiveProjection() {
      const entries = buildGatewayRuntimeSnapshotEntries({
        userMessage: pendingUserMessage,
        liveTranscript: transcriptStore.getSnapshot(),
      });
      frozenGatewayFinalProjectionJson = JSON.stringify(entries);
      frozenGatewayContentComplete = false;
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

    function acknowledgeGatewayRunStarted() {
      // Runs without a remote target must never enter the mirror lifecycle:
      // the coordinator would otherwise attempt ingress commits that fail on
      // the missing gateway identity and leak a mirror per local run.
      if (gatewayRunStarted || !(gatewayBridgeRequest || hasRemoteGatewayTarget)) {
        return;
      }
      gatewayRunStarted = true;
      registerGatewayRuntimeRun("running");
    }

    function ensureGatewayRunForTerminalState(state: GatewayRuntimeSnapshotState) {
      if (gatewayRunStarted || !(gatewayBridgeRequest || hasRemoteGatewayTarget)) return;
      gatewayRunStarted = true;
      registerGatewayRuntimeRun(state);
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

    function requestRemoteGatewayCancellation() {
      if (remoteGatewayCancelRequested) return;
      remoteGatewayCancelRequested = true;
      const command = gatewayBridgeRequest
        ? "gateway_chat_cancel_request"
        : mirrorsLocalRunToGateway
          ? "gateway_chat_mark_local_cancelled"
          : null;
      if (!command) return;
      const payload = gatewayBridgeRequest
        ? {
            request_id: gatewayBridgeRequestId,
            conversation_id: conversationId,
            worker_id: gatewayBridgeWorkerId ?? "gui-live",
          }
        : {
            request_id: gatewayBridgeRequestId,
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
      requestRemoteGatewayCancellation();
      if (!options.force) return;
      releaseConversationRunUi();
      // Force stop is the escape hatch for a stuck run: it intentionally
      // skips the persist barrier (which may itself be hung) so the gateway
      // still learns the run is cancelled. The run's own finally block will
      // additionally do the ordered persist-first finalization if it ever
      // completes.
      void settleChatRunFinalization(finishGatewayRuntimeRun("cancelled"));
    };

    async function finishGatewayRuntimeRun(state: GatewayRuntimeSnapshotState) {
      // A cancel or an early failure that carries an error message must reach
      // remote clients as a terminal record even when the run never streamed;
      // otherwise the WebUI sees a phantom completed/queued command with no
      // explanation.
      if (state === "cancelled" || (state === "failed" && gatewayRuntimeErrorMessage)) {
        ensureGatewayRunForTerminalState(state);
      }
      if (gatewayRunStarted) {
        if (frozenGatewayFinalProjectionJson === null) {
          if (state === "cancelled") {
            freezeGatewayLiveProjection();
          } else {
            freezeGatewayFinalProjection(nextConversationState, true);
          }
        }
        const terminalState = terminalHistoryPersistFailed ? "failed" : state;
        const terminalErrorCode = terminalHistoryPersistFailed
          ? "history_persist_failed"
          : gatewayRuntimeErrorCode;
        const terminalErrorMessage = terminalHistoryPersistFailed
          ? "The final conversation history could not be persisted."
          : gatewayRuntimeErrorMessage;
        const projectionJson = frozenGatewayFinalProjectionJson ?? "[]";
        const projectionBytes = new TextEncoder().encode(projectionJson).byteLength;
        const historyRequired = projectionBytes > 64 * 1024 * 1024;
        await finishGatewayRunMirror({
          runId: gatewayBridgeRequestId,
          conversationId,
          entriesJson: historyRequired ? "[]" : projectionJson,
          state: terminalState,
          errorCode: terminalErrorCode || undefined,
          errorMessage: terminalErrorMessage || undefined,
          contentComplete: !historyRequired && frozenGatewayContentComplete,
          historyRequired,
        });
      }
    }

    async function finalizeConversationRun(state: GatewayRuntimeSnapshotState) {
      const result = await settleChatRunFinalization(
        finalizeChatRunInOrder({
          waitForPersistBarrier: async () => {
            await runCleanupPromise.catch(() => undefined);
            await waitForTerminalHistoryPersist(initialPersistPromise);
            await waitForTerminalHistoryPersist(terminalHistoryPersistPromise);
          },
          closeBridge: () => gatewayBridgeEvents.close(),
          finishRuntimeRun: () => finishGatewayRuntimeRun(state),
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
      requestRemoteGatewayCancellation();
      gatewayBridgeEvents.emitError("Cancelled", conversationId);
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

    if (overrides?.editResendBaseMessageRef) {
      try {
        // 重发同样是新用户消息开启新 Run:替换回来的历史 meta 可能带着上一
        // Run 持久化的 taskList,必须与常规发送一样在 Run 边界清除。
        nextConversationState = clearTaskListState(
          await replaceConversationAtMessage(
            conversationId,
            overrides.editResendBaseMessageRef,
            pendingUserMessage,
          ),
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
        gatewayBridgeEvents.emitError(message, conversationId);
        await gatewayBridgeEvents.close();
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
    if (mirrorsLocalRunToGateway) {
      try {
        await markLocalGatewayRunStarted();
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
        gatewayBridgeEvents.emitError(message, conversationId);
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
        gatewayBridgeEvents.emitError(message, conversationId);
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
        gatewayBridgeEvents.emitError(message, conversationId);
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
    if (gatewayBridgeRequest || hasRemoteGatewayTarget) {
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
    await gatewayBridgeEvents.queueUserMessage(text, uploadedFiles, {
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
    acknowledgeGatewayRunStarted();
    let skillsPrompt = "";
    let memoryPrompt = "";
    /** 本轮 `/skill-name` 显式提及块;没有提及时恒为空串,不会挂出任何内容。 */
    let explicitSkillMentionBlock = "";
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
      options?: {
        includeAbortedMessages?: boolean;
        includeUploadedFilesMetadata?: boolean;
        includeMemoryTurnUpdates?: boolean;
      },
    ): Context {
      return buildPreparedConversationContext({
        state,
        tools,
        activeAgentPrompt,
        skillsPrompt,
        memoryPrompt,
        // 每次组装都现取:增量块按消息 id 绑定,已挂上的块在后续轮次原样重放,
        // 历史区间的字节因此保持稳定。
        // 只有发给主模型的上下文才需要增量块;记忆抽取这类复用同一份消息的旁路
        // 必须显式关掉,否则块里的索引行会被当成用户说的话再抽一遍。
        memoryTurnUpdates:
          options?.includeMemoryTurnUpdates === false
            ? null
            : memoryTurnInjection.getMessageUpdates(conversationId),
        // 显式提及块与 memory 增量同一个口径:同样是合成出来的上下文,不能被
        // 记忆抽取这类旁路当成用户说的话再抽一遍。
        skillMentionUpdates:
          options?.includeMemoryTurnUpdates === false
            ? null
            : skillMentionInjection.getMessageUpdates(conversationId),
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
        memoryTurnUpdates: memoryTurnInjection.getMessageUpdates(conversationId),
        skillMentionUpdates: skillMentionInjection.getMessageUpdates(conversationId),
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
        setBridgeToolStatus: updateGatewayBridgeToolStatus,
        queueCheckpoint: (state, contextUsageTokens) =>
          gatewayBridgeEvents.queueCheckpoint(state, contextUsageTokens),
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
        // 压缩把携带 memory 增量块的 user 消息移出 active segment,增量对模型
        // 永久不可见;丢弃注入状态,下一轮把 fresh 快照重冻结进 system 段 ——
        // 压缩本来就要重建前缀,这次重冻结免费。
        onCompacted: () => memoryTurnInjection.invalidate(conversationId),
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
      if (missing.length > 0 && workspaceResources.mode !== "custom") {
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
        gatewayBridgeEvents.emitError(message, conversationId);
        releaseConversationRunUi();
        await finalizeConversationRun("failed");
        clearConversationStopHandler(conversationId, handleConversationStop);
        restoreComposerOnStartFailure();
        return true;
      }

      const selectedSkills = selectedSkillNames
        .map((name) => byName.get(name))
        .filter((skill): skill is SkillSummary => Boolean(skill));
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
      // 显式提及只对当轮有效:留在 system prompt 里会让它这轮多一段、下轮撤回去,
      // 一次 `/skill-name` 连废两次缓存前缀。这里只算出块,挂载推迟到停止检查之后。
      explicitSkillMentionBlock = formatExplicitSkillMentions(explicitSkills);
      skillsPrompt = buildSkillsSystemPrompt({
        rootDir,
        selected: selectedSkills,
      });
    }

    // memory 索引每轮都可能变(模型刚写完一条,下一轮索引就跟着变)。整块塞进
    // system prompt 会让 system 段跟着漂,把整条缓存前缀连同全部历史一起顶掉。
    // 因此只有首轮走 system prompt(那时它本就是稳定前缀的一部分),之后 system
    // 段冻结,变化改挂到当轮 user 消息尾部 —— 复用 pi-ai 已经打在最后一条 user
    // 消息上的那个断点,不额外占用 Anthropic 的 4 个 cache_control 名额。
    let memoryOverview: string | null = null;
    try {
      memoryOverview = await buildMemoryOverviewSection(effectiveWorkdir);
    } catch (error) {
      console.warn("Failed to build memory overview prompt", error);
      // null 表示这轮没读到,基线维持原样;空串是「一条记忆都没有」,属于正常内容。
      memoryOverview = null;
    }
    if (await finishRequestedStopBeforeRuntime()) {
      return true;
    }
    // 放在停止检查之后:这一轮被停掉时请求根本没发出去,提前推进基线会让下一轮
    // 漏报这次变化。
    memoryPrompt = memoryTurnInjection.planTurn({
      conversationId,
      messageId: pendingUserMessage.id,
      overview: memoryOverview,
      // project 段随 workdir 换血,增量 diff 无法保真表达;基线记录冻结时的
      // workdir,切换时由 planTurn 触发重冻结。
      workdir: effectiveWorkdir,
    }).systemText;
    // 同样放在停止检查之后:这一轮被停掉时消息根本没发出去,提前记账只会给一个
    // 永远对不上的消息 id 留下垃圾块。空块不会创建任何状态。
    skillMentionInjection.record({
      conversationId,
      messageId: pendingUserMessage.id,
      block: explicitSkillMentionBlock,
    });

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
      applyConversationState(finalState);
      freezeGatewayFinalProjection(finalState, true);
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
      freezeGatewayFinalProjection(finalState, true);
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

    // Run 级任务清单存储:先落盘、成功后才应用到运行时状态,失败时状态从未
    // 变更(无需回滚)。持久化走非终态通道——中途任务写盘失败只属于本次工具
    // 调用(模型收到错误可重试),绝不能点亮 terminalHistoryPersistFailed 把
    // 已成功收尾的 run 误报为 history_persist_failed。
    const taskStateStore: TaskStateStore = {
      runId: gatewayBridgeRequestId,
      getState: () => nextConversationState.meta.taskList,
      commitState: async (taskList) => {
        const persisted = await persistConversationWithHistorySync({
          conversationId,
          sessionId,
          providerId,
          model,
          selectedModel,
          cwd: conversationCwd,
          state: setTaskListState(nextConversationState, taskList),
          fallbackTitle,
          createdAt,
          titlePromise,
        }).catch(() => false);
        if (!persisted) {
          throw new Error("Failed to persist task state.");
        }
        applyConversationState(setTaskListState(nextConversationState, taskList));
      },
    };

    try {
      if (effectiveIsAgentMode) {
        await chatRuntimeHost.runTurn({
          mode: "agent",
          params: {
            providerId,
            model,
            runtime: providerConfig,
            failover: failoverParams,
            runtimeModel,
            selectedModel,
            memoryExtractionModel,
            onMemoryExtractionModelFailure: handleMemoryExtractionModelFailure,
            memoryExtractionStatusText,
            effectiveWorkdir,
            additionalRoots,
            effectiveSkillsEnabled,
            showSilentMemoryExtraction: effectiveIsAgentDevExecutionMode,
            skillsRootDir: skillsRootDirForTools,
            skillAccessPolicy: skillAccessPolicyForTools,
            onManagedSkillsChanged: (change) => {
              if (change.action !== "delete") {
                enableManagedSkills(change.names);
                return;
              }
              setSettings((prev) =>
                removeWorkspaceResourceReferences(
                  updateSkills(prev, {
                    selected: prev.skills.selected.filter((name) => !change.names.includes(name)),
                  }),
                  { skillNames: change.names },
                ),
              );
            },
            agentTemplates: settings.agents,
            getMcpSettings: getEffectiveMcpSettings,
            getToolPolicies,
            applyMcpOps: (ops) => {
              const removedIds = ops.filter((op) => op.kind === "remove").map((op) => op.serverId);
              setSettings((prev) =>
                removeWorkspaceResourceReferences(applyMcpOpsToAppSettings(prev, ops), {
                  mcpServerIds: removedIds,
                }),
              );
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
            taskStateStore,
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
            settleLiveTranscript,
            batchLiveRoundsUpdate,
            updateToolStatus,
            updateRetryAttempts: updateGatewayBridgeRetryAttempts,
            updatePersistableAgentProgress: (progress) => {
              persistableAgentProgress = progress;
            },
            commitVisibleAbortedConversation,
            persistConversationWithHistorySync: persistTerminalConversation,
            freezeGatewayFinalProjection,
          },
        });
      } else {
        await chatRuntimeHost.runTurn({
          mode: "text",
          params: {
            providerId,
            model,
            runtime: providerConfig,
            failover: failoverParams,
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
            settleLiveTranscript,
            appendDraftAssistantText,
            batchLiveRoundsUpdate,
            updateGatewayBridgeToolStatus,
            updateRetryAttempts: updateGatewayBridgeRetryAttempts,
            commitVisibleAbortedConversation,
            persistConversationWithHistorySync: persistTerminalConversation,
            freezeGatewayFinalProjection,
          },
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
        requestRemoteGatewayCancellation();
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
      gatewayBridgeEvents.emitError(remoteErrorMessage, conversationId);
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
        requestRemoteGatewayCancellation();
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
