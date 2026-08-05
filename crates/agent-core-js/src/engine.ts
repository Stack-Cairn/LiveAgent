// 无头 chat 引擎:桌面版 useSendChatTurn 的 Node 化。
// 差异只在宿主:UI 状态(sidebar/scroll/composer)没有了,增量改经
// emitEvent 回流 Rust 再 WS 广播;其余(状态机、压缩、审批、持久化)
// 与桌面路径共用同一批模块。
//
// 并发模型(决策 6):多会话 async 并发,同会话内一条 Promise 链串行。
// 崩溃语义(决策 5):进程守护在 Rust;这里不做任何断点续跑。

import type { Context } from "@earendil-works/pi-ai";
import { createHookRunScope } from "./automation/hookRunner";
import { getAutomationState } from "./automation/store";
import { buildPersistableMessagesFromSnapshot } from "./chat/conversation/chatAbort";
import {
  appendMessagesToConversation,
  buildRequestContext,
  type ConversationViewState,
  createConversationStateFromContext,
} from "./chat/conversation/conversationState";
import { createLiveTranscriptStore, type LiveTranscriptStore, type RetryAttemptRecord } from "./chat/conversation/liveTranscriptStore";
import type { LiveRound } from "./chat/messages/uiMessages";
import {
  createConversationHookLifecycle,
  createGatewayBridgeEventController,
} from "./chat/conversation/run";
import { createTurnCancellation, type TurnCancellation } from "./chat/conversation/turnCancellation";
import { createCompactionControllerRegistry } from "./chat/compaction/controller";
import {
  buildConversationStateFromWindow,
  CHAT_HISTORY_WINDOW_MESSAGES,
  type ConversationPersistenceCursor,
  getChatHistoryWindow,
  persistConversationRuntime,
} from "./chat/history/chatHistory";
import { createUserMessageWithUploads } from "./chat/messages/uploadedFiles";
import {
  buildFallbackConversationTitle,
  getFirstUserMessageText,
} from "./chat/page/chatPageHelpers";
import { createStreamDebugLogger } from "./debug/agentDebug";
import { emitEvent } from "./events";
import { buildMemoryOverviewSection } from "./memory/prompts/injection";
import { createModelFromConfig, createProviderRuntimeConfig } from "./providers/llm";
import { loadPersistedSettingsWithDefaults } from "./settings/storage";
import type { SelectedModel } from "./settings";
import { buildSkillsSystemPrompt, discoverSkills, resolveExplicitSkillMentions } from "./skills";
import type { SkillAccessPolicy } from "./tools/skillAccessPolicy";
import { buildErrorAssistantMessage } from "./turns/chatPageRuntime";
import {
  buildPreparedContext as buildPreparedConversationContext,
  buildResumeContext as buildResumeConversationContext,
} from "./turns/conversationContextBuilders";
import { resolveEffectiveChatModelSelection } from "./turns/modelSelection";
import { resolveMemorySummaryModelSelection } from "./turns/providerRuntimeConfig";
import {
  runAgentConversationTurn,
  type PersistConversationParams,
} from "./turns/runAgentConversationTurn";
import { runTextConversationTurn } from "./turns/runTextConversationTurn";

export type ChatSendRequest = {
  conversationId: string;
  clientRequestId?: string;
  mode?: "agent" | "text";
  text: string;
  sessionId?: string;
  workdir?: string;
  skillsEnabled?: boolean;
  selectedModel?: SelectedModel;
  selectedSkillNames?: string[];
};

type LiveSession = {
  sessionId: string;
  createdAt: number;
  transcriptStore: LiveTranscriptStore;
  state: ConversationViewState | null;
  persistenceCursor: ConversationPersistenceCursor | null;
  cancellation: TurnCancellation | null;
  /** 同会话串行队列:后到的 turn 链在前一个后面。 */
  queue: Promise<void>;
  seenClientRequestIds: Set<string>;
  isRunning: boolean;
};

const sessions = new Map<string, LiveSession>();
const compactionRegistry = createCompactionControllerRegistry();

function getOrCreateSession(conversationId: string): LiveSession {
  let session = sessions.get(conversationId);
  if (!session) {
    session = {
      sessionId: `node-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      createdAt: Date.now(),
      transcriptStore: createLiveTranscriptStore(),
      state: null,
      persistenceCursor: null,
      cancellation: null,
      queue: Promise.resolve(),
      seenClientRequestIds: new Set(),
      isRunning: false,
    };
    sessions.set(conversationId, session);
  }
  return session;
}

/** 快照源是引擎内存(P3-07 铁律):含正在生成的半条消息。会话不存在返回 null。 */
export function getConversationLiveSnapshot(conversationId: string) {
  const session = sessions.get(conversationId);
  if (!session) return null;
  return {
    conversationId,
    isRunning: session.isRunning,
    live: session.transcriptStore.getSnapshot(),
    // 已落定的可见历史(重连恢复的基线);turn 中为最近一次 applyState 的结果。
    messageCount: session.state?.meta.totalMessageCount ?? null,
  };
}

export function abortConversation(conversationId: string): boolean {
  const session = sessions.get(conversationId);
  if (!session?.cancellation) return false;
  session.cancellation.userStop.abort();
  return true;
}

/** 受理一次 chat_send:同步去重 + 入队,立即返回;turn 在队列里异步跑。 */
export function acceptChatSend(request: ChatSendRequest): { accepted: boolean; duplicate?: boolean } {
  const conversationId = request.conversationId.trim();
  if (!conversationId) throw new Error("conversationId required");
  if (!request.text?.trim()) throw new Error("text required");

  const session = getOrCreateSession(conversationId);
  const clientRequestId = request.clientRequestId?.trim();
  if (clientRequestId) {
    if (session.seenClientRequestIds.has(clientRequestId)) {
      return { accepted: true, duplicate: true };
    }
    session.seenClientRequestIds.add(clientRequestId);
  }

  session.queue = session.queue.then(() =>
    runOneTurn(conversationId, session, request).catch((error) => {
      // 队列不能因单个 turn 失败而断链;错误已在 runOneTurn 内广播过终态。
      console.error(`[engine] turn failed for ${conversationId}:`, error);
    }),
  );
  return { accepted: true };
}

async function loadConversationState(
  conversationId: string,
  session: LiveSession,
): Promise<ConversationViewState> {
  if (session.state) return session.state;
  try {
    const record = await getChatHistoryWindow({
      id: conversationId,
      maxMessages: CHAT_HISTORY_WINDOW_MESSAGES,
      includeActiveSegment: true,
    });
    session.persistenceCursor = {
      activeSegmentIndex: record.meta.activeSegmentIndex,
      activeSegmentId: record.activeSegment?.segmentId ?? "",
    };
    return buildConversationStateFromWindow(record);
  } catch {
    // 历史里没有 → 新会话。
    session.persistenceCursor = null;
    return createConversationStateFromContext({ messages: [] } as unknown as Context);
  }
}

async function runOneTurn(conversationId: string, session: LiveSession, request: ChatSendRequest) {
  const { settings } = await loadPersistedSettingsWithDefaults();
  const isAgentMode = (request.mode ?? "agent") === "agent";
  // ExecutionMode 三值:text / tools / agent-dev;网络请求只区分 agent|text。
  const executionMode = isAgentMode ? ("tools" as const) : ("text" as const);

  const effective = resolveEffectiveChatModelSelection({
    settings,
    conversationSelectedModel: request.selectedModel,
  });
  const { selectedModel, provider, providerId, model } = effective;
  const runtimeControls = settings.chatRuntimeControls;
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

  const effectiveWorkdir = request.workdir?.trim() || settings.system.workdir || "";
  const skillsEnabled = isAgentMode && (request.skillsEnabled ?? true);

  const text = request.text.trim();
  const userMessage = createUserMessageWithUploads(text, [], Date.now());
  if (!userMessage) throw new Error("Message is required.");

  const baseState = await loadConversationState(conversationId, session);
  const isFirstTurn = baseState.meta.totalMessageCount === 0;
  const fallbackTitle = buildFallbackConversationTitle(
    getFirstUserMessageText(buildRequestContext(baseState)) || text,
  );

  const transcriptStore = session.transcriptStore;
  const compaction = compactionRegistry.get(conversationId);
  const cancellation = createTurnCancellation();
  session.cancellation = cancellation;
  session.isRunning = true;

  const disabledLogger = () =>
    createStreamDebugLogger({
      enabled: false,
      conversationId,
      executionMode: executionMode,
      streamKind: "conversation",
      providerId,
      model,
    });

  // 事件回流:gatewayBridge 的 wire 事件翻译成前端订阅的扁平事件名。
  // token → token_delta、tool_status → tool_status_change,其余原样打包转发。
  const bridgeEvents = createGatewayBridgeEventController({
    conversationId,
    requestId: `run-${Date.now()}`,
    enabled: true,
    sendEvent: (_requestId, event) => {
      const type = event.type;
      if (type === "token") {
        void emitEvent("token_delta", { conversation_id: conversationId, delta: event.text });
      } else if (type === "tool_status") {
        void emitEvent("tool_status_change", {
          conversation_id: conversationId,
          status: event.status ?? null,
          isCompaction: event.isCompaction === true,
          retryAttempts: event.retryAttempts,
        });
      } else {
        void emitEvent("chat:run-event", { conversation_id: conversationId, ...event });
      }
    },
  });

  let nextConversationState = appendMessagesToConversation(baseState, [userMessage]);
  const applyConversationState = (state: ConversationViewState) => {
    nextConversationState = state;
    session.state = state;
  };
  applyConversationState(nextConversationState);

  const persistConversation = async (params: PersistConversationParams) => {
    try {
      await persistConversationRuntime({
        conversationId: params.conversationId,
        providerId: params.providerId,
        model: params.model,
        sessionId: params.sessionId,
        cwd: params.cwd,
        selectedModelJson: JSON.stringify(selectedModel),
        title: (await params.titlePromise?.catch(() => null)) || params.fallbackTitle,
        createdAt: params.createdAt,
        updatedAt: Date.now(),
        state: params.state,
        getPersistenceCursor: () => session.persistenceCursor,
        commitPersistenceCursor: (cursor) => {
          session.persistenceCursor = cursor;
        },
      });
      return true;
    } catch (error) {
      console.error(`[engine] persist failed for ${conversationId}:`, error);
      return false;
    }
  };

  // prompts:skills(进阶披露,只给元数据)+ memory 概览 + agent 模板。
  let skillsPrompt = "";
  let memoryPrompt = "";
  let skillsRootDirForTools: string | undefined;
  let skillAccessPolicyForTools: SkillAccessPolicy | undefined = skillsEnabled
    ? {
        allowedSkillNames: [],
        allowedSkillBaseDirs: [],
        allowSkillInventory: false,
        allowSkillManagement: false,
        allowSkillMutation: true,
      }
    : undefined;
  const selectedSkillNames = request.selectedSkillNames ?? settings.skills.selected ?? [];
  if (skillsEnabled && selectedSkillNames.length > 0) {
    try {
      const discovery = await discoverSkills();
      const byName = new Map(discovery.skills.map((s) => [s.name, s]));
      const selectedSkills = selectedSkillNames
        .map((n) => byName.get(n))
        .filter((s): s is NonNullable<typeof s> => Boolean(s));
      const allowBuiltinSkillManagement = selectedSkills.some(
        (skill) => skill.name === "skills-creator" || skill.name === "skills-installer",
      );
      skillsRootDirForTools = discovery.rootDir;
      skillAccessPolicyForTools = {
        allowedSkillNames: selectedSkills.map((skill) => skill.name),
        allowedSkillBaseDirs: selectedSkills.map((skill) => skill.baseDir),
        protectedSkillNames: selectedSkills.filter((s) => s.builtIn === true).map((s) => s.name),
        protectedSkillBaseDirs: selectedSkills
          .filter((s) => s.builtIn === true)
          .map((s) => s.baseDir),
        allowSkillInventory: true,
        allowSkillManagement: allowBuiltinSkillManagement,
        allowSkillMutation: true,
      };
      skillsPrompt = buildSkillsSystemPrompt({
        rootDir: discovery.rootDir,
        selected: selectedSkills,
        explicit: resolveExplicitSkillMentions({
          text,
          structured: [],
          enabledSkills: selectedSkills,
        }),
      });
    } catch (error) {
      console.warn("[engine] skills discovery failed:", error);
    }
  }
  try {
    memoryPrompt = await buildMemoryOverviewSection(effectiveWorkdir);
  } catch {
    memoryPrompt = "";
  }
  const activeAgentPrompt = "";

  const buildPreparedContext = (
    state: ConversationViewState,
    tools?: Context["tools"],
    options?: { includeAbortedMessages?: boolean; includeUploadedFilesMetadata?: boolean },
  ): Context =>
    buildPreparedConversationContext({
      state,
      tools,
      activeAgentPrompt,
      skillsPrompt,
      memoryPrompt,
      includeAbortedMessages: options?.includeAbortedMessages,
      includeUploadedFilesMetadata: options?.includeUploadedFilesMetadata,
    });

  const hookScope = createHookRunScope({
    hooks: getAutomationState().hooks.hooks,
    conversationId,
    workdir: effectiveWorkdir,
    onWarning: (warning) => {
      void emitEvent("chat:hook-warning", { conversation_id: conversationId, warning });
    },
  });
  const hookLifecycle = createConversationHookLifecycle((event) => {
    hookScope.dispatch(event);
  });

  let persistableAgentProgress = { completedThroughRound: 0, suppressedToolTrace: [] as never[] };
  let abortedConversationCommitted = false;
  const commitVisibleAbortedConversation = () => {
    if (abortedConversationCommitted) return true;
    const snapshot = transcriptStore.getSnapshot();
    const partialMessages = buildPersistableMessagesFromSnapshot({
      executionMode: executionMode,
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
    transcriptStore.settle();
    void persistConversation({
      conversationId,
      sessionId: session.sessionId,
      providerId,
      model,
      cwd: effectiveWorkdir || undefined,
      state: finalState,
      fallbackTitle,
      createdAt: session.createdAt,
      titlePromise: null,
    });
    return true;
  };

  compaction.bindTurn({
    providerId,
    model,
    runtime: providerConfig,
    cancellation,
    debugLogger: disabledLogger(),
    buildPreparedContext,
    buildResumeContext: (state, resumeMessage, tools, options) =>
      buildResumeConversationContext({
        state,
        resumeMessage,
        tools,
        activeAgentPrompt,
        skillsPrompt,
        memoryPrompt,
        includeAbortedMessages: options?.includeAbortedMessages,
        includeUploadedFilesMetadata: options?.includeUploadedFilesMetadata,
      }),
    presend: {
      baseState,
      pendingUserText: text,
      composerText: text,
      uploadedFiles: [],
      composeAppliedState: (state) => appendMessagesToConversation(state, [userMessage]),
    },
    sinks: {
      applyState: applyConversationState,
      applyStateMidRun: (state) => {
        applyConversationState(state);
        transcriptStore.reset();
      },
      publishStatus: (status) =>
        void emitEvent("chat:compaction-status", { conversation_id: conversationId, status }),
      setBridgeToolStatus: (status, isCompaction) =>
        bridgeEvents.queueToolStatus(status, isCompaction),
      queueCheckpoint: (state) => bridgeEvents.queueCheckpoint(state),
      persist: (state) =>
        persistConversation({
          conversationId,
          sessionId: session.sessionId,
          providerId,
          model,
          cwd: effectiveWorkdir || undefined,
          state,
          fallbackTitle,
          createdAt: session.createdAt,
          titlePromise: null,
        }),
      restoreComposer: () => {
        // 无头引擎没有输入框可恢复;压缩失败回滚时前端经 run_ended 事件得知。
      },
      persistRollback: async (state) => {
        abortedConversationCommitted = true;
        await persistConversation({
          conversationId,
          sessionId: session.sessionId,
          providerId,
          model,
          cwd: effectiveWorkdir || undefined,
          state,
          fallbackTitle,
          createdAt: session.createdAt,
          titlePromise: null,
        });
      },
    },
  });

  const memorySummarySelection = resolveMemorySummaryModelSelection(settings);
  const memoryExtractionModel = memorySummarySelection
    ? {
        providerId: memorySummarySelection.providerId,
        model: memorySummarySelection.model,
        runtime: createProviderRuntimeConfig(
          memorySummarySelection.provider,
          memorySummarySelection.model,
          runtimeControls,
          settings.customSettings.providerIdentities,
        ),
        selectedModel: memorySummarySelection.selectedModel,
      }
    : undefined;

  transcriptStore.reset();
  await bridgeEvents.queueUserMessage(text, [], { messageId: userMessage.id });

  let finalState: "completed" | "failed" | "cancelled" = "completed";
  let finalErrorMessage = "";
  try {
    const sharedParams = {
      providerId,
      model,
      runtime: providerConfig,
      runtimeModel,
      selectedModel,
      sessionId: session.sessionId,
      conversationId,
      conversationCwd: effectiveWorkdir || undefined,
      fallbackTitle,
      createdAt: session.createdAt,
      titlePromise: null,
      transcriptStore,
      gatewayBridgeEvents: bridgeEvents,
      hookLifecycle,
      conversationDebugLogger: disabledLogger(),
      getNextConversationState: () => nextConversationState,
      applyConversationState,
      buildPreparedContext,
      compaction,
      cancellation,
      resetLiveTranscript: (store: LiveTranscriptStore) => store.reset(),
      settleLiveTranscript: (store: LiveTranscriptStore) => store.settle(),
      batchLiveRoundsUpdate: (
        updater: (prev: LiveRound[]) => LiveRound[],
        store: LiveTranscriptStore,
      ) => store.updateLiveRounds(updater),
      updateRetryAttempts: (attempts: RetryAttemptRecord[], store: LiveTranscriptStore) =>
        store.setRetryAttempts(attempts),
      commitVisibleAbortedConversation,
      freezeGatewayFinalProjection: () => {
        // 无 gateway 镜像可冻结:旧 Go 中继路径专属,这里保持空实现以满足签名。
      },
      persistConversationWithHistorySync: persistConversation,
    };

    if (isAgentMode) {
      await runAgentConversationTurn({
        ...sharedParams,
        effectiveWorkdir,
        effectiveSkillsEnabled: skillsEnabled,
        showSilentMemoryExtraction: false,
        skillsRootDir: skillsRootDirForTools,
        skillAccessPolicy: skillAccessPolicyForTools,
        agentTemplates: settings.agents,
        getMcpSettings: () => settings.mcp,
        getToolPolicies: () => settings.system.toolPolicies,
        remoteWebTunnelsEnabled: settings.remote.enableWebTunnels,
        tunnelPublicBaseUrl: "",
        sshHosts: settings.ssh.hosts,
        sshManagerRemoteAllowed: true,
        updateToolStatus: (status: string | null, store: LiveTranscriptStore) =>
          store.setToolStatus(status),
        updatePersistableAgentProgress: (progress) => {
          persistableAgentProgress = progress as typeof persistableAgentProgress;
        },
        memoryExtractionModel,
      });
    } else {
      await runTextConversationTurn({
        ...sharedParams,
        recoveryDebugLogger: disabledLogger(),
        appendDraftAssistantText: (delta: string, store: LiveTranscriptStore) =>
          store.appendDraftAssistantText(delta),
        updateGatewayBridgeToolStatus: (status, isCompaction) =>
          bridgeEvents.queueToolStatus(status, isCompaction),
      });
    }
  } catch (error) {
    const aborted = cancellation.userStop.signal.aborted;
    finalState = aborted ? "cancelled" : "failed";
    finalErrorMessage = error instanceof Error ? error.message : String(error);
    if (!aborted) {
      // 错误终态落库:部分输出 + 错误 assistant 消息,与桌面版行为一致。
      const errorAssistant = buildErrorAssistantMessage({
        model: runtimeModel,
        errorMessage: finalErrorMessage,
        timestamp: Date.now(),
      });
      const stateWithError = appendMessagesToConversation(nextConversationState, [errorAssistant]);
      applyConversationState(stateWithError);
      await persistConversation({
        conversationId,
        sessionId: session.sessionId,
        providerId,
        model,
        cwd: effectiveWorkdir || undefined,
        state: stateWithError,
        fallbackTitle,
        createdAt: session.createdAt,
        titlePromise: null,
      });
    }
    bridgeEvents.emitError(finalErrorMessage, conversationId);
  } finally {
    if (cancellation.userStop.signal.aborted && finalState === "completed") {
      finalState = "cancelled";
    }
    compaction.unbindTurn();
    hookLifecycle.endAgent();
    hookScope.close();
    transcriptStore.settle();
    session.cancellation = null;
    session.isRunning = false;
    await bridgeEvents.close();
    void emitEvent("run_ended", {
      conversation_id: conversationId,
      state: finalState,
      errorMessage: finalErrorMessage || undefined,
    });
  }
}
