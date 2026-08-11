import { deriveContextUsageTokens } from "@liveagent/ui/lib/chat/contextUsage";
import { invoke } from "@tauri-apps/api/core";
import type { MutableRefObject } from "react";
import { useCallback } from "react";
import { readMessageContextUsage } from "../../../lib/chat/compaction/contextUsageMetadata";
import type {
  CompactionController,
  CompactionSinks,
  ManualContextUsageSnapshot,
} from "../../../lib/chat/compaction/controller";
import { getActiveSegment } from "../../../lib/chat/conversation/conversationState";
import type { LiveTranscriptStore } from "../../../lib/chat/conversation/liveTranscriptStore";
import { createGatewayBridgeEventController } from "../../../lib/chat/conversation/run/gatewayBridgeEvents";
import { createTurnCancellation } from "../../../lib/chat/conversation/turnCancellation";
import { createProviderRuntimeConfig } from "../../../lib/providers/llm";
import type { AppSettings } from "../../../lib/settings";
import { createLocalGatewayChatRunId } from "../gateway/gatewayRuntimeStatusModel";
import type { FinishGatewayRunMirrorInput } from "../gateway/useGatewayRunMirrorCoordinator";
import type { PersistConversationParams } from "../history/useConversationHistoryActions";
import type { ConversationRuntimeEntry } from "./chatPageRuntime";
import { buildCompactionContext } from "./conversationContextBuilders";
import { resolveEffectiveChatModelSelection } from "./modelSelection";

export type ManualCompactionResult = {
  status: "compacted" | "failed" | "busy" | "skipped";
  message?: string;
};

export type ManualCompactionRequest = {
  conversationId?: string;
  operationId?: string;
};

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

/**
 * 手动压缩的装配单点：把发送链路同源的 sinks / providerConfig / gateway bridge
 * 组装为一次 CompactionController.compactManually 调用。仅空闲时执行；
 * 压缩进行状态与检查点经既有 bridge 通道镜像到 WebUI，并发送带 operationId
 * 的专用终态事件，避免受理回包掩盖后续失败或跳过。
 *
 * 桥接事件走可靠 ingress，网关会为这条合成 runId 建立真实 run activity——
 * 因此必须走完整 run 生命周期：开始时 gateway_chat_mark_local_started 记入
 * 桌面 ledger（2s 心跳的 active_runs 为压缩静默期续命，否则 15s 即被判
 * desktop_run_lost），结束时 finishGatewayRunMirror 提交终态（否则 WebUI 的
 * activeRun 永不收敛，压缩后一直悬挂 Vibing）。
 */
export function useManualCompaction(params: {
  settings: AppSettings;
  t: (key: string) => string;
  currentConversationIdRef: MutableRefObject<string>;
  isConversationRunning: (conversationId: string) => boolean;
  setConversationRunningState: (conversationId: string, value: boolean) => void;
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
  finishGatewayRunMirror: (input: FinishGatewayRunMirrorInput) => Promise<void>;
  persistConversation: (params: PersistConversationParams) => Promise<boolean>;
  setErrorMessage: (message: string | null) => void;
}) {
  const {
    settings,
    t,
    currentConversationIdRef,
    isConversationRunning,
    setConversationRunningState,
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
    finishGatewayRunMirror,
    persistConversation,
    setErrorMessage,
  } = params;

  return useCallback(
    async (request?: ManualCompactionRequest): Promise<ManualCompactionResult> => {
      const conversationId =
        request?.conversationId?.trim() || currentConversationIdRef.current.trim();
      if (!conversationId.trim()) {
        return { status: "skipped", message: t("chat.manualCompactRejected") };
      }

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
      let result: ManualCompactionResult = {
        status: "failed",
        message: t("chat.manualCompactFailed"),
      };
      let runningStateClaimed = false;
      try {
        if (isConversationRunning(conversationId)) {
          result = { status: "busy", message: t("chat.manualCompactRejected") };
          return result;
        }
        let runtimeEntry: ConversationRuntimeEntry;
        if (conversationId === currentConversationIdRef.current.trim()) {
          runtimeEntry = buildRuntimeEntryFromVisibleState();
        } else {
          await ensureConversationReady(conversationId);
          const cached = conversationRuntimeCacheRef.current.get(conversationId);
          if (!cached) {
            throw new Error("Conversation runtime is unavailable after history hydration");
          }
          runtimeEntry = cached;
        }
        if (isConversationRunning(conversationId)) {
          result = { status: "busy", message: t("chat.manualCompactRejected") };
          return result;
        }
        setConversationRunningState(conversationId, true);
        runningStateClaimed = true;
        if (runtimeEntry.compactionStatus.phase === "running") {
          result = { status: "busy", message: t("chat.manualCompactRejected") };
          return result;
        }

        if (hasRemoteGatewayTarget) {
          // 与 useSendChatTurn 的本地镜像 run 同款记账：ledger 有账，2s 运行时
          // 心跳的 active_runs 才会在 summarizer 静默期为这条 run 续命。
          try {
            await invoke("gateway_chat_mark_local_started", {
              request_id: bridgeRequestId,
              conversation_id: conversationId,
            });
          } catch (error) {
            console.warn("gateway_chat_mark_local_started failed", error);
          }
        }

        let effective: ReturnType<typeof resolveEffectiveChatModelSelection>;
        try {
          effective = resolveEffectiveChatModelSelection({
            settings,
            conversationSelectedModel: runtimeEntry.selectedModel,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (conversationId === currentConversationIdRef.current.trim()) {
            setErrorMessage(message);
          }
          result = { status: "failed", message };
          return result;
        }
        const { provider, providerId, model, selectedModel } = effective;
        const runtime = createProviderRuntimeConfig(provider, model, settings.chatRuntimeControls);
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
            cancellation: createTurnCancellation(),
            sinks,
            buildPreparedContext: (state, tools, options) =>
              buildCompactionContext(state, tools, options),
            buildResumeContext: (state, resumeMessage, tools, options) => {
              const base = buildCompactionContext(state, tools, options);
              return resumeMessage
                ? { ...base, messages: [...base.messages, resumeMessage] }
                : base;
            },
          },
          runtimeEntry.state,
          resolveManualContextUsage(compactionController, runtimeEntry),
        );
        result =
          outcome.status === "compacted"
            ? { status: outcome.status }
            : outcome.status === "skipped"
              ? {
                  status: outcome.status,
                  message:
                    outcome.reason === "below-manual-threshold"
                      ? t("chat.manualCompactBelowThreshold")
                      : outcome.reason === "no-active-messages"
                        ? t("chat.manualCompactEmpty")
                        : t("chat.manualCompactUnavailable"),
                }
              : outcome.status === "busy"
                ? { status: outcome.status, message: t("chat.manualCompactRejected") }
                : {
                    status: outcome.status,
                    message: compactionFailureMessage || t("chat.manualCompactFailed"),
                  };
        if (
          result.status === "failed" &&
          result.message &&
          conversationId === currentConversationIdRef.current.trim()
        ) {
          setErrorMessage(result.message);
        }
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (conversationId === currentConversationIdRef.current.trim()) {
          setErrorMessage(message);
        }
        result = { status: "failed", message };
        return result;
      } finally {
        if (runningStateClaimed) setConversationRunningState(conversationId, false);
        gatewayBridgeEvents.queueManualCompactionResult(
          resultOperationId,
          result.status,
          result.message,
        );
        try {
          await gatewayBridgeEvents.close();
        } catch (error) {
          console.warn("manual compaction bridge flush failed", error);
        }
        if (hasRemoteGatewayTarget) {
          // 终态记账（对 skipped/busy 也必须做：上面的 result 事件本身就会让
          // 网关建立 run activity）。压缩成功时检查点无法用快照条目表达，
          // historyRequired 让 WebUI 保留现有行并经持久化历史收敛。
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
    },
    [
      buildRuntimeEntryFromVisibleState,
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
      resetLiveTranscript,
      setErrorMessage,
      setConversationRunningState,
      settings,
      t,
      updateConversationRuntimeEntry,
      updateToolStatus,
    ],
  );
}
