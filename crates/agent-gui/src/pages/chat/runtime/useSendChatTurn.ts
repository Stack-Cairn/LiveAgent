import type { Context, UserMessage } from "@liveagent/app/lib/agentTypes";
import { invoke } from "@liveagent/app/shims/tauriCore";
import type {
  MentionComposerDraft,
  MentionComposerHandle,
} from "@liveagent/ui/components/chat/MentionComposer";
import { getAutomationState } from "@liveagent/ui/lib/automation/index";
import {
  COMPOSER_ACTION_COMMAND_NAMES,
  type ComposerTurnCommand,
} from "@liveagent/ui/lib/chat/composerCommands";
import { normalizeLogicalLineEndings } from "@liveagent/ui/lib/chat/composerText";
import { normalizeConversationMentionReferences } from "@liveagent/ui/lib/chat/mentionReferences";
import {
  createUserMessageWithUploads,
  mergePendingUploadedFiles,
  type PendingUploadedFile,
} from "@liveagent/ui/lib/chat/uploadedFiles";
import { appendManagedSkillSelections } from "@liveagent/ui/lib/chat/useComposerActions";
import type { ScrollFollowHandle } from "@liveagent/ui/lib/chat-scroll/useScrollFollow";
import { buildGatewayPublicBaseUrl } from "@liveagent/ui/lib/shared/gatewayPublicUrl";
import type { SidebarStore } from "@liveagent/ui/lib/sidebar/store";
import {
  buildSkillsSystemPrompt,
  formatExplicitSkillMentions,
  resolveExplicitSkillMentions,
  type SkillSummary,
} from "@liveagent/ui/lib/skills/index";
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
  getActiveSegment,
  type HistoryMessageRef,
  setTaskListState,
} from "../../../lib/chat/conversation/conversationState";
import {
  createConversationHookLifecycle,
  createGatewayBridgeEventController,
} from "../../../lib/chat/conversation/run";
import { createTurnCancellation } from "../../../lib/chat/conversation/turnCancellation";
import type { ChatHistorySummary } from "../../../lib/chat/history/chatHistory";
import {
  BRANCH_CONVERSATION_DEFAULT_TITLE,
  buildFallbackConversationTitle,
  createPendingHistoryItem,
  getFirstUserMessageText,
  isAbortLikeError,
} from "../../../lib/chat/page/chatPageHelpers";
import { skillMentionInjection } from "../../../lib/chat/skills/mentionInjection";
import { createStreamDebugLogger } from "../../../lib/debug/agentDebug";
import { isTauriHost, liveAgentRuntimeCapabilities } from "../../../lib/host";
import { showGoalProgress } from "../../../lib/kbrain/goalNotice";
import { createModelFromConfig, createProviderRuntimeConfig } from "../../../lib/providers/llm";
import {
  type AppSettings,
  applyConversationThinking,
  applyMcpOpsToAppSettings,
  type ChatRuntimeControls,
  type CommandSafetyMode,
  type ExecutionMode,
  filterMcpSettingsForWorkspace,
  getSshProjectHostIds,
  isAgentDevMode,
  isAgentExecutionMode,
  normalizeChatRuntimeControlsForProvider,
  removeWorkspaceResourceReferences,
  resolveEffectivePromptSettings,
  resolveWorkspaceResources,
  type SelectedModel,
  serializeSelectedModelJson,
  strictestCommandSafetyMode,
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
import {
  clearLocalTrajectory,
  invalidateDesktopTrajectory,
} from "../../../lib/trajectory/liveTrajectory";
import {
  acquireTrajectoryRecorder,
  releaseTrajectoryRecorder,
  resolveTrajectoryTurnNumber,
  trajectorySlotCapture,
} from "../../../lib/trajectory/recorderRegistry";
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
import type { PersistConversationAction } from "../history/useConversationHistoryActions";
import type { useChatPageRuntimeStore } from "../hooks/useChatPageRuntimeStore";
import type { useLiveTranscriptController } from "../hooks/useLiveTranscriptController";
import type { createChatRuntimeHost } from "./ChatRuntimeHost";
import {
  buildErrorAssistantMessage,
  formatHookWarningMessage,
  resolveConversationPromptWorkdir,
  resolveEffectiveConversationWorkdir,
} from "./chatPageRuntime";
import {
  finalizeChatRunInOrder,
  releaseChatRunUi,
  settleChatRunFinalization,
  trackTerminalHistoryPersist,
} from "./chatRunFinalization";
import { buildPreparedContext as buildPreparedConversationContext } from "./conversationContextBuilders";
import { startConversationTitleJob } from "./conversationTitleJob";
import {
  type EffectiveChatModelSelection,
  resolveEffectiveChatModelSelection,
} from "./modelSelection";

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
  ensureTunnelToolTab: (projectPathKey?: string) => void;
  ensureSshTunnelToolTab: (projectPathKey?: string) => void;
  persistConversation: PersistConversationAction;
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
    params: Parameters<PersistConversationAction>[0],
  ): Promise<boolean> {
    return (await persistConversation(params)) !== null;
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
    commandSafetyModeOverride?: CommandSafetyMode;
    runtimeControlsOverride?: ChatRuntimeControls;
    /** 输入框“/”指令带来的单轮语义；planMode 已并入 runtimeControlsOverride。 */
    composerCommand?: ComposerTurnCommand;
    gatewayBridgeRequestOverride?: ActiveGatewayBridgeRequest | null;
    preserveComposerOnStart?: boolean;
    beforeRuntimeStart?: () => Promise<void>;
    afterInitialHistoryPersist?: () => Promise<void>;
    editResendBaseMessageRef?: HistoryMessageRef;
  }) {
    const capabilities = liveAgentRuntimeCapabilities();
    if (!isTauriHost() && overrides?.gatewayBridgeRequestOverride) {
      setErrorMessage("LiveAgent Gateway chat requests are unavailable on this host.");
      return false;
    }
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
    // 命令安全模式:远端 WebUI / 网关 / 排队快照带来的模式只能“收紧”,不能放宽
    // (P3#9)。桌面端是工具唯一执行处,一份陈旧的浏览器快照不得把本地刻意选定的
    // sandboxOffline 静默降级成 auto —— 故与本地 settings.system 取更严格者。
    const requestedCommandSafetyMode =
      overrides?.commandSafetyModeOverride ?? gatewayBridgeRequest?.commandSafetyModeOverride;
    const effectiveCommandSafetyMode = requestedCommandSafetyMode
      ? strictestCommandSafetyMode(requestedCommandSafetyMode, settings.system.commandSafetyMode)
      : settings.system.commandSafetyMode;
    const effectiveIsAgentMode = isAgentExecutionMode(effectiveExecutionMode);
    // Plan mode:限制性开关,合并方向同 commandSafetyMode 的"只能收紧"——任一
    // 来源(本地 settings / 队列快照 / 网关覆盖)要求 plan mode 即生效,远端
    // 陈旧快照的 false 不得关闭本地已开启的 plan mode。仅 agent 模式有意义。
    const effectivePlanModeEnabled =
      effectiveIsAgentMode &&
      (settings.chatRuntimeControls.planModeEnabled ||
        overrides?.runtimeControlsOverride?.planModeEnabled === true ||
        gatewayBridgeRequest?.runtimeControlsOverride?.planModeEnabled === true);
    const workdirResolution = {
      isAgentMode: effectiveIsAgentMode,
      workdirOverride: overrides?.workdirOverride,
      gatewayWorkdirOverride: gatewayBridgeRequest?.workdirOverride,
      persistedWorkdir: sidebarStore.peek(conversationId)?.cwd,
      runtimeWorkdir: runtimeEntry?.workdir,
      globalWorkdir: settings.system.workdir,
    };
    const effectiveWorkdir = resolveEffectiveConversationWorkdir(workdirResolution);
    const promptWorkdir = resolveConversationPromptWorkdir(workdirResolution);
    const effectiveAgentPrompt = resolveEffectivePromptSettings(settings, promptWorkdir).prompt;
    const effectiveProjectPathKey = workspaceProjectPathKey(effectiveWorkdir);
    const effectiveProject = workspaceProjects.find(
      (project) => workspaceProjectPathKey(project.path) === effectiveProjectPathKey,
    );
    let additionalRoots: AdditionalProjectRoot[] = [];
    if (capabilities.frontendContext && effectiveIsAgentMode && effectiveProject) {
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
    const effectiveSkillsEnabled =
      capabilities.frontendContext && workspaceResources.skillsEnabled && effectiveIsAgentMode;
    const selectedSkillNames = effectiveSkillsEnabled ? workspaceResources.skillNames : [];
    const getEffectiveMcpSettings = () =>
      filterMcpSettingsForWorkspace(getMcpSettings(), workspaceResources);
    const hasRemoteGatewayTarget =
      capabilities.gatewayMirror &&
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

    const { provider, providerId, model } = effectiveSelectedModel;
    // 远程请求携带目标会话的思考设置；本地发送叠加会话选择中的思考设置。
    const runtimeControls = applyConversationThinking(
      gatewayBridgeRequest?.runtimeControlsOverride ??
        overrides?.runtimeControlsOverride ??
        settings.chatRuntimeControls,
      effectiveSelectedModel.selectedModel,
    );
    // 本轮实际使用的思考设置随模型写入会话选择，草稿首次发送与远程发送也会保存。
    const turnThinking = normalizeChatRuntimeControlsForProvider(runtimeControls, {
      providerId: provider.type,
      requestFormat: provider.requestFormat,
      modelId: model,
    });
    const selectedModel: SelectedModel = {
      ...effectiveSelectedModel.selectedModel,
      thinkingEnabled: turnThinking.thinkingEnabled,
      reasoning: turnThinking.reasoning,
    };
    updateConversationRuntimeEntry(conversationId, (prev) =>
      serializeSelectedModelJson(prev.selectedModel) === serializeSelectedModelJson(selectedModel)
        ? prev
        : { ...prev, selectedModel },
    );
    const providerConfig = createProviderRuntimeConfig(provider, model, runtimeControls);
    const runtimeModel = createModelFromConfig(
      providerId,
      model,
      providerConfig.baseUrl.trim(),
      providerConfig.requestFormat,
      providerConfig.modelConfig,
    );

    const textOverride =
      typeof overrides?.textOverride === "string" ? overrides.textOverride : null;
    const hasTextOverride = textOverride !== null;
    const composerDraft =
      overrides?.composerDraftOverride ??
      (hasTextOverride ? null : (composerRef.current?.getDraft() ?? null));
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
        }).catch((error) => {
          console.warn("gateway_chat_cancel_request failed", error);
        });
      }
      consumeConversationStop(conversationId, stopRequestVersion);
      void settleChatRunFinalization(gatewayBridgeEvents.close());
      return false;
    }

    // 粘贴等路径可能让草稿携带超限/重复/自引用的会话引用；发送边界统一
    // 归一化（带当前会话 ID 过滤自引用），与 gateway 队列路径语义一致。
    const referencedConversations = normalizeConversationMentionReferences(
      composerDraft?.conversationMentions ?? [],
      conversationId,
    );
    const userMessage = createUserMessageWithUploads(
      text,
      uploadedFiles,
      Date.now(),
      referencedConversations,
    );
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
    const historyCwd = promptWorkdir || undefined;
    updateConversationRuntimeEntry(conversationId, (prev) => ({
      ...prev,
      workdir: historyCwd,
    }));
    const transcriptStore = getConversationLiveTranscriptStore(conversationId);
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
      const titleModelSelection = effectiveSelectedModel;
      const titleProviderConfig = providerConfig;
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
          cwd: historyCwd,
          createdAt,
        }),
      );
    }

    clearAbortSnapshot(transcriptStore);

    let nextConversationState = appendMessagesToConversation(baseConversationState, [
      pendingUserMessage,
    ]);
    // Safe fallback only: the exact absolute number is resolved from every persisted segment
    // before history persistence starts. totalMessageCount may leave gaps but cannot collide.
    let trajectoryTurn = Math.max(1, baseConversationState.meta.totalMessageCount + 1);
    let trajectoryMessageIndex = Math.max(0, baseConversationState.meta.totalMessageCount);
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
      // still pin here; transient-state cleanup must never move the viewport.
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
      void invoke(command, payload).catch((error) => {
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
      });
      localGatewayRunStarted = true;
    }

    if (overrides?.editResendBaseMessageRef) {
      try {
        // Flush and forget the old content-addressing state before the database truncates
        // its suffix. Otherwise an unchanged header can reference a section pruned by rebase.
        clearLocalTrajectory(conversationId);
        await releaseTrajectoryRecorder(conversationId);
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
        // The authoritative SQLite suffix has now been replaced; invalidate only after that
        // barrier so an open trajectory view cannot race and reload the stale pre-rebase window.
        invalidateDesktopTrajectory(conversationId);
        trajectoryMessageIndex = Math.max(0, nextConversationState.meta.totalMessageCount - 1);
        if (capabilities.trajectory) {
          trajectoryTurn = await resolveTrajectoryTurnNumber({
            conversationId,
            currentUserPersisted: true,
            fallbackTurn: nextConversationState.meta.totalMessageCount,
          });
        }
        const keepParentToolCallIds =
          collectRetainedSubagentParentToolCallIds(nextConversationState);
        subagentStoresRef.current.invalidate(conversationId);
        if (capabilities.frontendContext)
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

    if (capabilities.trajectory && !initialUserTurnPersisted) {
      trajectoryTurn = await resolveTrajectoryTurnNumber({
        conversationId,
        currentUserPersisted: false,
        fallbackTurn: nextConversationState.meta.totalMessageCount,
      });
      if (await finishRequestedStopBeforeRuntime()) {
        return true;
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
          cwd: historyCwd,
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
      referencedConversations,
      // The new message's own stable identity: lets remote transcripts bind
      // their user bubble's messageRef immediately, so a follow-up edit of
      // this message can anchor its rebase without a history round-trip.
      messageRef: findHistoryMessageRefByMessageId(nextConversationState, pendingUserMessage.id),
    });
    if (capabilities.checkpoints && effectiveIsAgentMode) {
      try {
        await invoke("checkpoint_begin_turn", {
          conversation_id: conversationId,
          turn_id: pendingUserMessage.id,
        });
      } catch (error) {
        console.warn("checkpoint turn boundary failed", error);
      }
    }
    if (await finishRequestedStopBeforeRuntime()) {
      return true;
    }
    acknowledgeGatewayRunStarted();
    let skillsPrompt = "";
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

    // recorder 跨轮存活：header 分段去重靠的就是「上一份 refs」，每轮新建会让
    // 去重立刻失效。这里只更新本轮的活动 segment。
    const trajectoryRecording = capabilities.trajectory
      ? acquireTrajectoryRecorder(
          conversationId,
          getActiveSegment(nextConversationState)?.segmentIndex ??
            nextConversationState.meta.activeSegmentIndex,
          // registry 已写入桌面实时缓存；这里只下发给 WebUI 轨迹页。
          (events) => {
            for (const event of events) {
              gatewayBridgeEvents.queueEvent({
                type: "trajectory",
                event,
                conversation_id: conversationId,
              });
            }
          },
        )
      : undefined;
    function buildPreparedContext(
      state: ConversationViewState,
      tools?: Context["tools"],
      options?: {
        includeAbortedMessages?: boolean;
        includeUploadedFilesMetadata?: boolean;
      },
    ): Context {
      if (!capabilities.frontendContext) {
        const context = buildRequestContext(state, options);
        return { messages: context.messages };
      }
      return buildPreparedConversationContext({
        state,
        tools,
        activeAgentPrompt: effectiveAgentPrompt,
        skillsPrompt,
        // 显式提及块与 memory 增量同一个口径:同样是合成出来的上下文,不能被
        // 记忆抽取这类旁路当成用户说的话再抽一遍。
        skillMentionUpdates: skillMentionInjection.getMessageUpdates(conversationId),
        includeAbortedMessages: options?.includeAbortedMessages,
        includeUploadedFilesMetadata: options?.includeUploadedFilesMetadata,
        captureSlots: trajectorySlotCapture(conversationId),
      });
    }

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
        excludedCommandNames: COMPOSER_ACTION_COMMAND_NAMES,
      });
      // 显式提及只对当轮有效:留在 system prompt 里会让它这轮多一段、下轮撤回去,
      // 一次 `/skill-name` 连废两次缓存前缀。这里只算出块,挂载推迟到停止检查之后。
      explicitSkillMentionBlock = formatExplicitSkillMentions(explicitSkills);
      skillsPrompt = buildSkillsSystemPrompt({
        rootDir,
        selected: selectedSkills,
      });
    }

    if (capabilities.frontendContext) {
      skillMentionInjection.record({
        conversationId,
        messageId: pendingUserMessage.id,
        block: explicitSkillMentionBlock,
      });
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
        cwd: historyCwd,
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
        cwd: historyCwd,
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
          cwd: historyCwd,
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
            locale: settings.locale,
            providerId,
            model,
            runtime: providerConfig,
            runtimeModel,
            selectedModel,
            effectiveWorkdir,
            additionalRoots,
            effectiveSkillsEnabled,
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
            getCuaAllowSelfTargeting: () => settings.system.cuaAllowSelfTargeting === true,
            commandSafetyMode: effectiveCommandSafetyMode,
            planModeEnabled: effectivePlanModeEnabled,
            applyMcpOps: (ops) => {
              const removedIds = ops.filter((op) => op.kind === "remove").map((op) => op.serverId);
              setSettings((prev) =>
                removeWorkspaceResourceReferences(applyMcpOpsToAppSettings(prev, ops), {
                  mcpServerIds: removedIds,
                }),
              );
            },
            remoteWebTunnelsEnabled: settings.remote.enableWebTunnels,
            tunnelPublicBaseUrl: buildGatewayPublicBaseUrl(
              settings.remote.gatewayUrl,
              settings.remote.gatewayPort,
            ),
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
            clientRequestId: gatewayBridgeRequest?.clientRequestId,
            composerCommand: overrides?.composerCommand,
            onGoalUpdate: (state) => showGoalProgress(conversationId, state, t),
            taskStateStore,
            conversationId,
            referencedConversations,
            checkpointTurnId: pendingUserMessage.id,
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
            trajectory: trajectoryRecording?.recorder,
            trajectoryTurn,
            trajectoryMessageIndex,
            trajectoryMessageId: pendingUserMessage.id,
            readTrajectorySlots: trajectoryRecording?.readSlots,
          },
        });
      } else {
        await chatRuntimeHost.runTurn({
          mode: "text",
          params: {
            locale: settings.locale,
            providerId,
            model,
            runtime: providerConfig,
            runtimeModel,
            selectedModel,
            sessionId,
            clientRequestId: gatewayBridgeRequest?.clientRequestId,
            conversationId,
            conversationCwd,
            historyCwd,
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
            trajectory: trajectoryRecording?.recorder,
            trajectoryTurn,
            trajectoryMessageIndex,
            trajectoryMessageId: pendingUserMessage.id,
            readTrajectorySlots: trajectoryRecording?.readSlots,
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
          commitVisibleAbortedConversation();
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
      hookLifecycle.endAgent();
      hookScope.close();
      clearAbortSnapshot(transcriptStore);
      const stopped = runStopRequestVersion !== null || cancellation.userStop.signal.aborted;
      if (stopped) {
        gatewayRuntimeFinalState = "cancelled";
        requestRemoteGatewayCancellation();
      }
      const trajectoryStatus =
        gatewayRuntimeFinalState === "completed"
          ? "complete"
          : gatewayRuntimeFinalState === "cancelled"
            ? "aborted"
            : "error";
      trajectoryRecording?.recorder.endTurn({
        status: trajectoryStatus,
        ...(gatewayRuntimeErrorMessage ? { error: gatewayRuntimeErrorMessage } : {}),
      });
      await trajectoryRecording?.recorder.flush();
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
