import { deriveContextUsageTokens } from "@liveagent/ui/lib/chat/contextUsage";
import { invoke } from "@tauri-apps/api/core";
import type { MutableRefObject } from "react";
import { useCallback } from "react";
import { readMessageContextUsage } from "../../../lib/chat/compaction/contextUsageMetadata";
import type {
  CompactionController,
  CompactionSinks,
  ManualCompactionOutcome,
  ManualContextUsageSnapshot,
} from "../../../lib/chat/compaction/controller";
import type { CompactionDecisionReason } from "../../../lib/chat/compaction/types";
import { getActiveSegment } from "../../../lib/chat/conversation/conversationState";
import type { LiveTranscriptStore } from "../../../lib/chat/conversation/liveTranscriptStore";
import { createGatewayBridgeEventController } from "../../../lib/chat/conversation/run/gatewayBridgeEvents";
import { createTurnCancellation } from "../../../lib/chat/conversation/turnCancellation";
import { createProviderRuntimeConfig } from "../../../lib/providers/llm";
import type { AppSettings } from "../../../lib/settings";
import { createLocalGatewayChatRunId } from "../gateway/gatewayRuntimeStatusModel";
import type {
  FinishGatewayRunMirrorInput,
  RegisterGatewayRunMirrorInput,
} from "../gateway/useGatewayRunMirrorCoordinator";
import type { PersistConversationParams } from "../history/useConversationHistoryActions";
import type { ConversationRuntimeEntry } from "./chatPageRuntime";
import {
  buildPreparedContext as buildPreparedConversationContext,
  buildResumeContext as buildResumeConversationContext,
} from "./conversationContextBuilders";
import { resolveEffectiveChatModelSelection } from "./modelSelection";

export type ManualCompactionResult = {
  status: "compacted" | "failed" | "busy" | "skipped";
  message?: string;
};

export type ManualCompactionRequest = {
  conversationId?: string;
  operationId?: string;
  // 中继层受理回调：探针通过、真正开始压缩时同步调用一次。被拒绝的压缩
  // 从不触发它，中继层据返回值同步回包（accepted:false + message）。
  onAccepted?: () => void;
};

// 手动压缩的读数快照：优先用控制器账本，缺失才退到转录扫描与最近一条
// 带 fixedTokens 的消息元数据。
function resolveManualContextUsage(
  controller: CompactionController,
  runtimeEntry: ConversationRuntimeEntry,
): ManualContextUsageSnapshot {
  const runtimeSnapshot = controller.contextUsageSnapshot;
  const messages = getActiveSegment(runtimeEntry.state)?.messages ?? [];
  let fixedTokens: number | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const usage = readMessageContextUsage(messages[index]);
    if (usage) {
      fixedTokens = usage.fixedTokens;
      break;
    }
  }
  return {
    totalTokens:
      runtimeSnapshot?.totalTokens ?? deriveContextUsageTokens(runtimeEntry.state.transcript.items),
    fixedTokens: runtimeSnapshot?.fixedTokens ?? fixedTokens,
  };
}

type ConversationStopHandler = (options: { force: boolean; requestVersion: number }) => void;

/**
 * 手动压缩的装配单点：把发送链路同源的 sinks / providerConfig / gateway bridge
 * 组装为一次 CompactionController.compactManually 调用。仅空闲时执行；压缩进行
 * 状态与检查点经既有 bridge 通道镜像到 WebUI。
 *
 * 不变量（run 生命周期只在真正压缩时成立）：桥接事件走可靠 ingress，网关会
 * 为任意 run 的首个 delta 建立真实 run activity——因此任何 run 痕迹都必须推迟
 * 到探针通过之后。前置校验（running/runtime/模型/compactionStatus）全程零 run
 * 痕迹；gateway_chat_mark_local_started、registerGatewayRunMirror 只在
 * compactManually 的 onProceed 回调里发生（onProceed=true 才置 proceeded）；
 * finally 的 queueManualCompactionResult / finishGatewayRunMirror 只在 proceeded
 * 时执行。被拒绝的压缩什么事件都不发，结果经返回值由中继层同步回包，避免伪造
 * 空 run（WebUI 折叠转录、composer 忙碌、空 run 永久重放）。
 *
 * 停止语义：压缩期间注册与发送链路同款的停止处理器 + abort controller。用户
 * 停止时经 cancellation.userStop.abort() 中止 compactManually（返回 aborted），
 * 并在 finally 消费 stop intent（否则吞掉下一条消息 / 二次 force 与队列 drain
 * 并发）。
 */
export function useManualCompaction(params: {
  settings: AppSettings;
  t: (key: string) => string;
  currentConversationIdRef: MutableRefObject<string>;
  isConversationRunning: (conversationId: string) => boolean;
  setConversationRunningState: (conversationId: string, value: boolean) => void;
  setConversationAbortController: (
    conversationId: string,
    controller: AbortController | null,
  ) => void;
  setConversationStopHandler: (
    conversationId: string,
    handler: ConversationStopHandler | null,
  ) => void;
  clearConversationStopHandler: (conversationId: string, handler: ConversationStopHandler) => void;
  consumeConversationStop: (conversationId: string, expectedVersion?: number) => boolean;
  buildRuntimeEntryFromVisibleState: () => ConversationRuntimeEntry;
  conversationRuntimeCacheRef: MutableRefObject<Map<string, ConversationRuntimeEntry>>;
  ensureConversationReady: (conversationId: string) => Promise<string>;
  getCompactionController: (conversationId: string) => CompactionController;
  getConversationLiveTranscriptStore: (conversationId: string) => LiveTranscriptStore;
  updateConversationRuntimeEntry: (
    conversationId: string,
    updater: (prev: ConversationRuntimeEntry) => ConversationRuntimeEntry,
  ) => void;
  resetLiveTranscript: (store?: LiveTranscriptStore) => void;
  updateToolStatus: (status: string | null, store?: LiveTranscriptStore) => void;
  queueGatewayBridgeEventForRequest: (
    requestId: string,
    event: Record<string, unknown>,
    options?: { workerId?: string },
  ) => Promise<void> | void;
  flushGatewayBridgeEventsForRequest: (requestId: string) => Promise<void>;
  registerGatewayRunMirror: (input: RegisterGatewayRunMirrorInput) => void;
  finishGatewayRunMirror: (input: FinishGatewayRunMirrorInput) => Promise<void>;
  persistConversation: (params: PersistConversationParams) => Promise<boolean>;
  setErrorMessage: (message: string | null) => void;
  activeAgentPrompt: string;
  // 与发送链路同源的提示词构建：当前会话据当前工作区解析 skills/memory 提示词；
  // 后台会话（跨会话中继）拿不到这些上下文，返回空串（见调用点注释）。
  resolveManualCompactionPromptInputs: (input: {
    isCurrentConversation: boolean;
    workdir?: string;
  }) => Promise<{ skillsPrompt: string; memoryPrompt: string }>;
}) {
  const {
    settings,
    t,
    currentConversationIdRef,
    isConversationRunning,
    setConversationRunningState,
    setConversationAbortController,
    setConversationStopHandler,
    clearConversationStopHandler,
    consumeConversationStop,
    buildRuntimeEntryFromVisibleState,
    conversationRuntimeCacheRef,
    ensureConversationReady,
    getCompactionController,
    getConversationLiveTranscriptStore,
    updateConversationRuntimeEntry,
    resetLiveTranscript,
    updateToolStatus,
    queueGatewayBridgeEventForRequest,
    flushGatewayBridgeEventsForRequest,
    registerGatewayRunMirror,
    finishGatewayRunMirror,
    persistConversation,
    setErrorMessage,
    activeAgentPrompt,
    resolveManualCompactionPromptInputs,
  } = params;

  return useCallback(
    async (request?: ManualCompactionRequest): Promise<ManualCompactionResult> => {
      const conversationId =
        request?.conversationId?.trim() || currentConversationIdRef.current.trim();
      if (!conversationId) {
        return { status: "skipped", message: t("chat.manualCompactRejected") };
      }

      // await 后 ref 可能已切换会话，重读判定，勿冻结在闭包创建时。
      const isCurrentConversation = () =>
        conversationId === currentConversationIdRef.current.trim();
      const hasRemoteGatewayTarget =
        settings.remote.enabled &&
        settings.remote.gatewayUrl.trim() !== "" &&
        settings.remote.token.trim() !== "";
      const bridgeRequestId = createLocalGatewayChatRunId(conversationId);
      const transcriptStore = getConversationLiveTranscriptStore(conversationId);
      const gatewayBridgeEvents = createGatewayBridgeEventController({
        conversationId,
        requestId: bridgeRequestId,
        workerId: "gui-live",
        enabled: hasRemoteGatewayTarget,
        sendEvent: queueGatewayBridgeEventForRequest,
        flushEvents: flushGatewayBridgeEventsForRequest,
        resolveErrorConversationId: () => conversationId,
      });
      const resultOperationId =
        request?.operationId?.trim() || createLocalGatewayChatRunId(conversationId);

      const cancellation = createTurnCancellation();
      let proceeded = false;
      let runningStateClaimed = false;
      let stopHandlerRegistered = false;
      let stopRequestVersion: number | null = null;
      // 停止处理器与发送链路 handleConversationStop 同款：记录版本号供 finally
      // 消费 stop intent；abort 使 compactManually 中止（controller 返回 aborted）。
      const handleStop: ConversationStopHandler = (options) => {
        stopRequestVersion = options.requestVersion;
        cancellation.userStop.abort();
      };

      const messageForSkipReason = (reason: CompactionDecisionReason): string => {
        switch (reason) {
          case "below-manual-threshold":
            return t("chat.manualCompactBelowThreshold");
          case "no-active-messages":
            return t("chat.manualCompactEmpty");
          default:
            return t("chat.manualCompactUnavailable");
        }
      };

      const mapOutcome = (
        outcome: ManualCompactionOutcome,
        compactionFailureMessage: string,
      ): ManualCompactionResult => {
        switch (outcome.status) {
          case "compacted":
            return { status: "compacted" };
          case "busy":
            return { status: "busy", message: t("chat.manualCompactRejected") };
          case "skipped":
            return { status: "skipped", message: messageForSkipReason(outcome.reason) };
          default:
            // 中止（用户停止）落到 skipped + 取消文案；其余失败带失败详情。
            return outcome.aborted
              ? { status: "skipped", message: t("chat.manualCompactCancelled") }
              : {
                  status: "failed",
                  message: compactionFailureMessage || t("chat.manualCompactFailed"),
                };
        }
      };

      let result: ManualCompactionResult = {
        status: "failed",
        message: t("chat.manualCompactFailed"),
      };

      const run = async (): Promise<ManualCompactionResult> => {
        if (isConversationRunning(conversationId)) {
          return { status: "busy", message: t("chat.manualCompactRejected") };
        }

        // 运行时快照解析：当前会话用可见状态，但历史仍在水合时可见状态为空，
        // active segment 无消息即复核一次 runtime cache（否则误报"无可压缩内容"）。
        let runtimeEntry: ConversationRuntimeEntry;
        if (isCurrentConversation()) {
          const visibleEntry = buildRuntimeEntryFromVisibleState();
          const visibleMessages = getActiveSegment(visibleEntry.state)?.messages ?? [];
          if (visibleMessages.length > 0) {
            runtimeEntry = visibleEntry;
          } else {
            await ensureConversationReady(conversationId);
            runtimeEntry = conversationRuntimeCacheRef.current.get(conversationId) ?? visibleEntry;
          }
        } else {
          await ensureConversationReady(conversationId);
          const cached = conversationRuntimeCacheRef.current.get(conversationId);
          if (!cached) {
            throw new Error("Conversation runtime is unavailable after history hydration");
          }
          runtimeEntry = cached;
        }

        // 水合可能耗时，重核一次运行态后再占用 running 标志。
        if (isConversationRunning(conversationId)) {
          return { status: "busy", message: t("chat.manualCompactRejected") };
        }
        setConversationRunningState(conversationId, true);
        runningStateClaimed = true;
        // 注册停止处理器与 abort controller（若已请求停止会立刻回调并 abort）。
        setConversationStopHandler(conversationId, handleStop);
        setConversationAbortController(conversationId, cancellation.userStop);
        stopHandlerRegistered = true;

        if (runtimeEntry.compactionStatus.phase === "running") {
          return { status: "busy", message: t("chat.manualCompactRejected") };
        }

        let effective: ReturnType<typeof resolveEffectiveChatModelSelection>;
        try {
          effective = resolveEffectiveChatModelSelection({
            settings,
            conversationSelectedModel: runtimeEntry.selectedModel,
          });
        } catch (error) {
          return {
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          };
        }
        const { provider, providerId, model, selectedModel } = effective;
        const runtime = createProviderRuntimeConfig(provider, model, settings.chatRuntimeControls);

        // 与发送链路同源的检查点上下文：注入 agent/skills/memory 提示词与 tools，
        // 使 checkpoint contextTokensAfter（两端环的权威锚点）计入系统提示词与
        // 工具重量，否则少算导致压缩后两端环读数偏低。
        const { skillsPrompt, memoryPrompt } = await resolveManualCompactionPromptInputs({
          isCurrentConversation: isCurrentConversation(),
          workdir: runtimeEntry.workdir,
        });

        let compactionFailureMessage = "";
        const sinks: CompactionSinks = {
          applyState: (state) =>
            updateConversationRuntimeEntry(conversationId, (prev) => ({ ...prev, state })),
          applyStateMidRun: (state) => {
            updateConversationRuntimeEntry(conversationId, (prev) => ({ ...prev, state }));
            resetLiveTranscript(transcriptStore);
          },
          publishStatus: (status) => {
            if (status.phase === "failed") compactionFailureMessage = status.message;
            updateConversationRuntimeEntry(conversationId, (prev) => ({
              ...prev,
              compactionStatus: status,
            }));
          },
          setBridgeToolStatus: (status, isCompaction = false) => {
            gatewayBridgeEvents.queueToolStatus(status, isCompaction);
            updateToolStatus(status, transcriptStore);
          },
          queueCheckpoint: (state, contextUsageTokens) =>
            gatewayBridgeEvents.queueCheckpoint(state, contextUsageTokens),
          persist: (state) =>
            persistConversation({
              conversationId,
              sessionId: runtimeEntry.sessionId,
              providerId,
              model,
              selectedModel,
              cwd: runtimeEntry.workdir,
              state,
              fallbackTitle: t("chat.pendingTitle"),
              createdAt: runtimeEntry.createdAt,
              titlePromise: null,
            }),
        };

        const compactionController = getCompactionController(conversationId);
        const outcome = await compactionController.compactManually(
          {
            providerId,
            model,
            runtime,
            cancellation,
            sinks,
            buildPreparedContext: (state, tools, options) =>
              buildPreparedConversationContext({
                state,
                tools,
                activeAgentPrompt,
                skillsPrompt,
                memoryPrompt,
                includeAbortedMessages: options?.includeAbortedMessages,
                includeUploadedFilesMetadata: options?.includeUploadedFilesMetadata,
              }),
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
          },
          runtimeEntry.state,
          resolveManualContextUsage(compactionController, runtimeEntry),
          {
            tools: runtimeEntry.state.meta.tools,
            onProceed: () => {
              proceeded = true;
              if (hasRemoteGatewayTarget) {
                // 与 useSendChatTurn 同款注册镜像：userMessage 取最近一条用户消息
                // （已在历史里的真实消息），transcriptStore 现成。缺 userMessage 会让
                // 网关 checkpoint 请求撞 lastError、TTL 清扫器判死未注册 mirror。
                const activeMessages = getActiveSegment(runtimeEntry.state)?.messages ?? [];
                let lastUserMessage: (typeof activeMessages)[number] | undefined;
                for (let index = activeMessages.length - 1; index >= 0; index -= 1) {
                  if (activeMessages[index]?.role === "user") {
                    lastUserMessage = activeMessages[index];
                    break;
                  }
                }
                if (lastUserMessage) {
                  registerGatewayRunMirror({
                    runId: bridgeRequestId,
                    conversationId,
                    workerId: "gui-live",
                    userMessage: lastUserMessage,
                    transcriptStore,
                    state: "running",
                  });
                }
                // ledger 记账：2s 心跳的 active_runs 为 summarizer 静默期续命。
                void invoke("gateway_chat_mark_local_started", {
                  request_id: bridgeRequestId,
                  conversation_id: conversationId,
                }).catch((error) => {
                  console.warn("gateway_chat_mark_local_started failed", error);
                });
              }
              request?.onAccepted?.();
            },
          },
        );

        return mapOutcome(outcome, compactionFailureMessage);
      };

      try {
        result = await run();
        if (result.status === "failed" && result.message && isCurrentConversation()) {
          setErrorMessage(result.message);
        }
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isCurrentConversation()) {
          setErrorMessage(message);
        }
        result = { status: "failed", message };
        return result;
      } finally {
        if (stopHandlerRegistered) {
          clearConversationStopHandler(conversationId, handleStop);
          setConversationAbortController(conversationId, null);
        }
        if (runningStateClaimed) {
          setConversationRunningState(conversationId, false);
        }
        // 停止意图必须消费，否则残留会吞掉该会话的下一条消息。版本号不匹配
        // 说明其后又有新的停止请求，交由后续路径处理。
        if (stopRequestVersion !== null) {
          consumeConversationStop(conversationId, stopRequestVersion);
        }
        // 只有真正开始压缩才有 run 痕迹需要收尾；被拒绝的压缩什么都不发。
        if (proceeded) {
          try {
            gatewayBridgeEvents.queueManualCompactionResult(
              resultOperationId,
              result.status,
              result.message,
            );
          } catch (error) {
            console.warn("manual compaction result event failed", error);
          }
          try {
            await gatewayBridgeEvents.close();
          } catch (error) {
            console.warn("manual compaction bridge flush failed", error);
          }
          if (hasRemoteGatewayTarget) {
            // 终态记账：compacted→completed+historyRequired（WebUI 保留检查点行经
            // 持久化历史收敛）；failed→failed；skipped（含取消）走完成态收敛。
            try {
              await finishGatewayRunMirror({
                runId: bridgeRequestId,
                conversationId,
                entriesJson: "[]",
                state: result.status === "failed" ? "failed" : "completed",
                errorCode: result.status === "failed" ? "manual_compaction_failed" : undefined,
                errorMessage: result.status === "failed" ? result.message : undefined,
                contentComplete: result.status !== "compacted",
                historyRequired: result.status === "compacted",
              });
            } catch (error) {
              console.warn("manual compaction terminal commit failed", error);
            }
          }
        }
      }
    },
    [
      activeAgentPrompt,
      buildRuntimeEntryFromVisibleState,
      clearConversationStopHandler,
      consumeConversationStop,
      conversationRuntimeCacheRef,
      currentConversationIdRef,
      ensureConversationReady,
      finishGatewayRunMirror,
      flushGatewayBridgeEventsForRequest,
      getCompactionController,
      getConversationLiveTranscriptStore,
      isConversationRunning,
      persistConversation,
      queueGatewayBridgeEventForRequest,
      registerGatewayRunMirror,
      resetLiveTranscript,
      resolveManualCompactionPromptInputs,
      setConversationAbortController,
      setConversationRunningState,
      setConversationStopHandler,
      setErrorMessage,
      settings,
      t,
      updateConversationRuntimeEntry,
      updateToolStatus,
    ],
  );
}
