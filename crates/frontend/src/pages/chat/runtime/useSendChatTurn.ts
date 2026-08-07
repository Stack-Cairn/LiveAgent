import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  MentionComposerDraft,
  MentionComposerHandle,
} from "../../../components/chat/MentionComposer";
import { backendFetch } from "../../../lib/backend/client";
import {
  buildPersistableMessagesFromSnapshot,
  type SuppressedToolTraceSnapshot,
} from "../../../lib/chat/conversation/chatAbort";
import {
  appendMessagesToConversation,
  buildRequestContext,
  type ConversationViewState,
  type HistoryMessageRef,
} from "../../../lib/chat/conversation/conversationState";
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
import { resolveRuntimeModelIdentity } from "../../../lib/models/runtimeModelIdentity";
import type { AppSettings, ChatRuntimeControls } from "../../../lib/settings";
import type { SidebarStore } from "../../../lib/sidebar/store";
import type { SkillSummary } from "../../../lib/skills";
import type { SubagentStoreManager } from "../../../lib/subagents";
import { asErrorMessage } from "../chatPageUtils";
import {
  buildTextFromComposerDraft,
  importPastedTextsAsFiles,
} from "../composer/composerDraftText";
import type { PersistConversationParams } from "../history/useConversationHistoryActions";
import type { useChatPageRuntimeStore } from "../hooks/useChatPageRuntimeStore";
import type { useLiveTranscriptController } from "../hooks/useLiveTranscriptController";
import { buildErrorAssistantMessage, buildPartialAssistantMessage } from "./chatPageRuntime";
import {
  finalizeChatRunInOrder,
  releaseChatRunUi,
  settleChatRunFinalization,
  trackTerminalHistoryPersist,
} from "./chatRunFinalization";
import { startConversationTitleJob } from "./conversationTitleJob";
import {
  type EffectiveChatModelSelection,
  resolveEffectiveChatModelSelection,
} from "./modelSelection";
import { selectedModelsMatch } from "./providerRuntimeConfig";
import { waitForRunEnded } from "./runEndedWaiters";

type LiveTranscriptController = ReturnType<typeof useLiveTranscriptController>;
type ChatPageRuntimeStore = ReturnType<typeof useChatPageRuntimeStore>;

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
  clearAbortSnapshot: LiveTranscriptController["clearAbortSnapshot"];
  getAbortSnapshot: LiveTranscriptController["getAbortSnapshot"];
  resetLiveTranscript: LiveTranscriptController["resetLiveTranscript"];
  settleLiveTranscript: LiveTranscriptController["settleLiveTranscript"];
  updateToolStatus: LiveTranscriptController["updateToolStatus"];
  backendBridgeHistorySummaryRef: MutableRefObject<Map<string, ChatHistorySummary>>;
  availableSkills: SkillSummary[];
  refreshSkills: () => Promise<{ skills: SkillSummary[]; rootDir: string } | null>;
  selectedSkillNames: string[];
  ensureTunnelToolTab: (projectPathKey?: string) => void;
  ensureSshTunnelToolTab: (projectPathKey?: string) => void;
  persistConversation: (params: PersistConversationParams) => Promise<boolean>;
  reloadConversationFromHistory: (conversationId: string) => Promise<ConversationViewState>;
  pruneIdleConversationCaches: (extraKeepIds?: Iterable<string>) => void;
  requestQueuedChatTurnProcessing: (conversationId: string) => void;
};

/**
 * The chat send pipeline: resolves effective overrides (queue / composer),
 * imports large pastes, persists the user turn, builds skills/memory prompts
 * and hook scopes, then submits the turn to the backend engine (chat_send +
 * run_ended) and commits abort/error tails. Extracted verbatim from
 * ChatPage — the send closure is recreated per render so it always reads
 * current settings.
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
    clearAbortSnapshot,
    getAbortSnapshot,
    resetLiveTranscript,
    settleLiveTranscript,
    updateToolStatus,
    backendBridgeHistorySummaryRef,
    availableSkills,
    refreshSkills,
    selectedSkillNames,
    persistConversation,
    reloadConversationFromHistory,
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
    workdirOverride?: string;
    runtimeControlsOverride?: ChatRuntimeControls;
    preserveComposerOnStart?: boolean;
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

    const effectiveWorkdir = (
      overrides?.workdirOverride ??
      runtimeEntry?.workdir ??
      settings.system.workdir
    ).trim();
    const effectiveSkillsEnabled = settings.skills.enabled;
    const setConversationErrorState = (message: string | null) => {
      updateConversationRuntimeEntry(conversationId, (prev) => ({
        ...prev,
        errorMessage: message,
      }));
    };
    if (!runtimeEntry) {
      throw new Error(`Conversation runtime not found: ${conversationId}`);
    }
    if (runtimeEntry.isSending) {
      return false;
    }
    if (isImportingPastedTextRef.current && typeof overrides?.textOverride !== "string") {
      return false;
    }
    if (hydratingConversationIdRef.current === conversationId) {
      setConversationErrorState("当前会话仍在加载，请稍候。");
      return false;
    }
    if (hydrationFailedConversationIdRef.current === conversationId) {
      setConversationErrorState("当前会话加载失败，请重新打开该会话后再继续。");
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
      });
    } catch (error) {
      setConversationErrorState(asErrorMessage(error, "当前模型配置不可用，请重新选择后重试。"));
      return false;
    }

    const { selectedModel, provider, providerId, model } = effectiveSelectedModel;
    updateConversationRuntimeEntry(conversationId, (prev) =>
      selectedModelsMatch(prev.selectedModel, selectedModel) ? prev : { ...prev, selectedModel },
    );
    // 落库消息的模型三元组兜底；权威值由 core 经 round_meta 逐轮上报
    // （chatAbort 落库时优先取 round.meta）。请求装配与模型目录归 crates/core。
    const runtimeModel = resolveRuntimeModelIdentity(providerId, model, provider.requestFormat);

    const textOverride =
      typeof overrides?.textOverride === "string" ? overrides.textOverride : null;
    const hasTextOverride = textOverride !== null;
    const composerDraft = hasTextOverride
      ? null
      : (overrides?.composerDraftOverride ?? composerRef.current?.getDraft() ?? null);
    let text = hasTextOverride
      ? textOverride.trim()
      : composerDraft
        ? (composerDraft.largePastes.length > 0
            ? composerDraft.textWithoutLargePastes
            : buildTextFromComposerDraft(composerDraft)
          ).trim()
        : "";
    let uploadedFiles = overrides?.uploadedFilesOverride ?? pendingUploadedFiles;

    if (composerDraft && composerDraft.largePastes.length > 0 && !hasTextOverride) {
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
        return false;
      } finally {
        isImportingPastedTextRef.current = false;
        setIsImportingPastedText(false);
      }
    }
    if (isConversationStopRequested(conversationId)) {
      const stopRequestVersion = getConversationStopRequestVersion(conversationId);
      consumeConversationStop(conversationId, stopRequestVersion);
      return false;
    }

    const userMessage = createUserMessageWithUploads(text, uploadedFiles, Date.now());
    if (!userMessage) {
      return false;
    }
    const pendingUserMessage = userMessage;

    const titleSourceText = text || uploadedFiles.map((file) => file.fileName).join(", ");

    const sessionId = runtimeEntry.sessionId;
    const createdAt = runtimeEntry.createdAt;
    const conversationCwd = effectiveWorkdir || undefined;
    updateConversationRuntimeEntry(conversationId, (prev) => ({
      ...prev,
      workdir: conversationCwd,
    }));
    const transcriptStore = getConversationLiveTranscriptStore(conversationId);
    const isConversationVisible = () => currentConversationIdRef.current === conversationId;
    // 轮次级取消：会话 abort controller 只注册 userStop 一次；每个 LLM 请求
    // （主请求/压缩摘要/标题任务）各自派生子 scope，杜绝 abort 换代丢停止的窗口。
    const cancellation = createTurnCancellation();
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
      titlePromise = startConversationTitleJob({
        signal: cancellation.deriveScope().controller.signal,
        conversationId,
        titleSourceText,
        selectedModel,
        sidebarStore,
        titleJobRef,
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
    let initialUserTurnPersisted = false;
    let initialPersistPromise: Promise<boolean> | null = null;
    let terminalHistoryPersistPromise: Promise<boolean> | null = null;
    let runCleanupPromise: Promise<void> = Promise.resolve();
    let runStopRequestVersion: number | null = null;

    async function persistTerminalConversation(
      input: Parameters<typeof persistConversationWithHistorySync>[0],
    ) {
      // 编辑重发对齐失败时本地 state 仍带旧尾巴，落库会把被截断的历史
      // 复活；此时终态历史以引擎侧持久化为准，前端整轮禁写。
      if (suppressFrontendHistoryPersist) return true;
      return trackTerminalHistoryPersist(() => persistConversationWithHistorySync(input));
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

    const handleConversationStop = (options: { force: boolean; requestVersion: number }) => {
      runStopRequestVersion = options.requestVersion;
      cancellation.userStop.abort();
      if (!options.force) return;
      // Force stop is the escape hatch for a stuck run: release the UI
      // immediately instead of waiting on the persist barrier (which may
      // itself be hung). The run's own finally block will additionally do
      // the ordered persist-first finalization if it ever completes.
      releaseConversationRunUi();
    };

    async function finalizeConversationRun() {
      const result = await settleChatRunFinalization(
        finalizeChatRunInOrder({
          waitForPersistBarrier: async () => {
            await runCleanupPromise.catch(() => undefined);
            await waitForTerminalHistoryPersist(initialPersistPromise);
            await waitForTerminalHistoryPersist(terminalHistoryPersistPromise);
          },
        }),
      );
      if (result === "timed_out") {
        console.warn(`chat run finalization timed out: ${conversationId}`);
      }
    }

    async function finishRequestedStopBeforeRuntime() {
      if (runStopRequestVersion === null) return false;
      cancellation.userStop.abort();
      releaseConversationRunUi();
      clearAbortSnapshot(transcriptStore);
      await finalizeConversationRun();
      clearConversationStopHandler(conversationId, handleConversationStop);
      consumeConversationStop(conversationId, runStopRequestVersion);
      pruneIdleConversationCaches([conversationId]);
      return true;
    }

    // 编辑重发:截断与子代理清理已迁入 core 引擎（chat_send 带
    // editResendBaseMessageRef，引擎在受理响应前完成截断+清理）。前端不再
    // 本地改写历史；受理成功后重拉历史窗口对齐本地基线（见 chat_send 之后）。
    // 初始用户消息落库随截断由引擎完成，这里跳过前端的 initial persist。
    const editResendBaseMessageRef = overrides?.editResendBaseMessageRef ?? null;
    let suppressFrontendHistoryPersist = false;
    if (editResendBaseMessageRef) {
      initialUserTurnPersisted = true;
    }

    setConversationStopHandler(conversationId, handleConversationStop);
    markConversationRunStarted();
    if (await finishRequestedStopBeforeRuntime()) {
      return true;
    }
    // Clear the composer in the same beat as the optimistic user bubble.
    // Everything below until the runtime turn starts (initial history
    // persist, skills refresh, memory overview read) may await for seconds;
    // the input box must not keep the sent text visible in the meantime.
    // Early-failure paths below restore the cleared draft.
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
    void initialPersistPromise
      .then((persisted) => {
        if (!persisted) {
          console.warn("initial conversation history persist did not complete before chat runtime");
        }
      })
      .catch((error) => {
        console.warn("initial conversation history persist confirmation failed", error);
      });
    if (await finishRequestedStopBeforeRuntime()) {
      return true;
    }

    // Optionally append skills metadata to system prompt (progressive disclosure).
    if (effectiveSkillsEnabled && selectedSkillNames.length > 0) {
      // In case the user sends quickly after startup (availableSkills not loaded yet),
      // do a best-effort refresh before failing.
      let skillsList = availableSkills;
      let byName = new Map(skillsList.map((s) => [s.name, s]));
      let missing = selectedSkillNames.filter((n) => !byName.has(n));
      if (missing.length > 0) {
        const fresh = await refreshSkills();
        if (await finishRequestedStopBeforeRuntime()) {
          return true;
        }
        if (fresh) {
          skillsList = fresh.skills;
          byName = new Map(skillsList.map((s) => [s.name, s]));
          missing = selectedSkillNames.filter((n) => !byName.has(n));
        }
      }

      if (missing.length > 0) {
        const message = `找不到以下 Skills：${missing.join(", ")}（请先重新扫描固定 Skills 目录）`;
        setConversationErrorState(message);
        releaseConversationRunUi();
        await finalizeConversationRun();
        clearConversationStopHandler(conversationId, handleConversationStop);
        restoreComposerOnStartFailure();
        return true;
      }
    }
    if (await finishRequestedStopBeforeRuntime()) {
      return true;
    }

    // hook 编排跑在 core 引擎回合生命周期里（crates/core/src/engine.ts）；
    // 前端只消费 hook_warning wire 事件做展示，这里不再建 hook scope。

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
        model: runtimeModel,
        draftAssistantText: "",
        liveRounds: snapshot.liveRounds,
        completedThroughRound: persistableAgentProgress.completedThroughRound,
        suppressedToolTrace: persistableAgentProgress.suppressedToolTrace,
      });

      if (partialMessages.length === 0) return false;

      const finalState = appendMessagesToConversation(nextConversationState, partialMessages);
      abortedConversationCommitted = true;
      applyConversationState(finalState);
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
        model: runtimeModel,
        draftAssistantText: "",
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

    try {
      // 引擎在后端进程里跑：chat_send 只是受理（202），增量走 WS 事件，
      // 终态是 run_ended。waiter 必须在提交**之前**注册，否则短回复的
      // run_ended 可能赶在注册前到达，这轮就永远等不到了。
      // clientRequestId 供引擎幂等去重——网络重试不会跑出第二个 turn。
      const runEndedPromise = waitForRunEnded(conversationId, cancellation.userStop.signal);
      await backendFetch<void>("chat_send", {
        conversationId,
        clientRequestId: pendingUserMessage.id,
        sessionId,
        text,
        selectedModel,
        workdir: effectiveWorkdir,
        skillsEnabled: effectiveSkillsEnabled,
        selectedSkillNames,
        // 菜单点选的 skill mention 带 skillFile/baseDir 消歧;text 里的 /name 引擎自行解析。
        ...(composerDraft && composerDraft.skillMentions.length > 0
          ? { skillMentions: composerDraft.skillMentions }
          : {}),
        // 只传元数据(路径引用),文件内容已由导入流程落盘,引擎侧模型用 Read 自取。
        ...(uploadedFiles.length > 0 ? { uploadedFiles } : {}),
        // WireMessageRef 契约形态（crates/core/src/protocol/wireEvents.ts）。
        ...(editResendBaseMessageRef
          ? {
              editResendBaseMessageRef: {
                segment_index: editResendBaseMessageRef.segmentIndex,
                message_index: editResendBaseMessageRef.messageIndex,
                segment_id: editResendBaseMessageRef.segmentId,
                message_id: editResendBaseMessageRef.messageId,
                role: editResendBaseMessageRef.role,
                content_hash: editResendBaseMessageRef.contentHash,
              },
            }
          : {}),
      });
      if (editResendBaseMessageRef) {
        // 受理返回即代表引擎已把截断落库；重拉权威窗口替换本地基线，
        // 后续终态追加/落库都以它为底。子代理花名册同步失效。
        try {
          const reloaded = await reloadConversationFromHistory(conversationId);
          applyConversationState(reloaded);
          subagentStoresRef.current.invalidate(conversationId);
        } catch (error) {
          suppressFrontendHistoryPersist = true;
          console.warn("edit-resend 历史窗口对齐失败，本轮跳过前端历史落库", error);
        }
      }
      const runEnded = await runEndedPromise;
      if (runEnded.state === "cancelled") {
        throw new Error("已取消");
      }
      if (runEnded.state === "failed") {
        throw new Error(runEnded.errorMessage || "Request failed");
      }
      // 完成态：把这轮跑出来的内容落进会话历史并持久化。
      // live 快照在 run_ended 时已被 settle 清空，内容从 waiter 带回来。
      // 优先用 liveRounds 快照——它带完整的思考/工具调用链；轮次事件全丢
      // （如 WS 掉帧）时回退到纯正文。
      const completedMessages =
        runEnded.liveRounds.length > 0
          ? buildPersistableMessagesFromSnapshot({
              model: runtimeModel,
              draftAssistantText: runEnded.draftAssistantText,
              liveRounds: runEnded.liveRounds,
              completedThroughRound: runEnded.liveRounds[runEnded.liveRounds.length - 1].round,
            })
          : (() => {
              const assistantMessage = buildPartialAssistantMessage({
                model: runtimeModel,
                text: runEnded.draftAssistantText,
                stopReason: "stop",
              });
              return assistantMessage ? [assistantMessage] : [];
            })();
      if (completedMessages.length > 0) {
        const finalState = appendMessagesToConversation(nextConversationState, completedMessages);
        applyConversationState(finalState);
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
      }
    } catch (err) {
      const aborted = cancellation.userStop.signal.aborted || isAbortLikeError(err);
      if (aborted) {
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
      if (titleJobRef.current?.conversationId === conversationId) {
        titleJobRef.current = null;
      }
    } finally {
      releaseConversationRunUi();
      clearAbortSnapshot(transcriptStore);
      const stopped = runStopRequestVersion !== null || cancellation.userStop.signal.aborted;
      await finalizeConversationRun();
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
