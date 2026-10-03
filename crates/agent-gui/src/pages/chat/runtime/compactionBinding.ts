import type {
  CompactionController,
  CompactionSinks,
} from "../../../lib/chat/compaction/controller";
import type { ConversationViewState } from "../../../lib/chat/conversation/conversationState";
import type { LiveTranscriptStore } from "../../../lib/chat/conversation/liveTranscriptStore";
import type { GatewayBridgeEventController } from "../../../lib/chat/conversation/run";
import { memoryTurnInjection } from "../../../lib/chat/memory/injectionController";
import type { TrajectoryRecorder } from "../../../lib/trajectory/recorder";
import { updateTrajectoryRecorderSegment } from "../../../lib/trajectory/recorderRegistry";
import type { ConversationRuntimeEntry } from "./chatPageRuntime";

/**
 * 压缩 sinks 的装配单点（发送链路与手动压缩共用）。两端只差在状态落地与回滚：
 * 发送链路把状态写进本轮闭包并能回滚输入框，手动压缩只写运行时缓存。
 */
export function createCompactionSinks(deps: {
  conversationId: string;
  transcriptStore: LiveTranscriptStore;
  gatewayBridgeEvents: Pick<GatewayBridgeEventController, "queueToolStatus" | "queueCheckpoint">;
  updateConversationRuntimeEntry: (
    conversationId: string,
    updater: (prev: ConversationRuntimeEntry) => ConversationRuntimeEntry,
  ) => void;
  updateToolStatus: (status: string | null, store: LiveTranscriptStore) => void;
  resetLiveTranscript: (store: LiveTranscriptStore) => void;
  applyState: (state: ConversationViewState) => void;
  persist: NonNullable<CompactionSinks["persist"]>;
  restoreComposer?: CompactionSinks["restoreComposer"];
  persistRollback?: CompactionSinks["persistRollback"];
}): CompactionSinks {
  const { conversationId, transcriptStore, gatewayBridgeEvents } = deps;
  return {
    applyState: deps.applyState,
    // 压缩结果落地后，对应的 live transcript 已过期，必须清空。
    applyStateMidRun: (state) => {
      deps.applyState(state);
      deps.resetLiveTranscript(transcriptStore);
    },
    publishStatus: (status) =>
      deps.updateConversationRuntimeEntry(conversationId, (prev) => ({
        ...prev,
        compactionStatus: status,
      })),
    setBridgeToolStatus: (status, isCompaction = false, wire = true) => {
      if (wire) gatewayBridgeEvents.queueToolStatus(status, isCompaction);
      deps.updateToolStatus(status, transcriptStore);
    },
    queueCheckpoint: (state, contextUsageTokens) =>
      gatewayBridgeEvents.queueCheckpoint(state, contextUsageTokens),
    persist: deps.persist,
    restoreComposer: deps.restoreComposer,
    persistRollback: deps.persistRollback,
    // 压缩把携带 memory 增量块的 user 消息移出 active segment,增量对模型永久不可见;
    // 丢弃注入状态,下一轮把 fresh 快照重冻结进 system 段——压缩本来就要重建前缀,
    // 这次重冻结免费。
    onCompacted: () => memoryTurnInjection.invalidate(conversationId),
  };
}

/**
 * 压缩有四条触发路径，逐个调用点埋点必漏；订阅控制器生命周期一次覆盖全部。
 * manual 发生在两轮之间，不属于任何 turn。
 */
export function observeCompactionTrajectory(
  controller: CompactionController,
  recorder: TrajectoryRecorder,
  conversationId: string,
) {
  controller.setObserver({
    onStart: ({ trigger }) => {
      recorder.compactionStart({ standalone: trigger === "manual" });
    },
    onEnd: ({ trigger, status, tokensBefore, tokensAfter, newSegmentIndex, error }) => {
      recorder.compactionEnd({
        status,
        standalone: trigger === "manual",
        ...(tokensBefore === undefined ? {} : { tokensBefore }),
        ...(tokensAfter === undefined ? {} : { tokensAfter }),
        ...(error === undefined ? {} : { error }),
      });
      if (status === "complete" && newSegmentIndex !== undefined) {
        updateTrajectoryRecorderSegment(conversationId, newSegmentIndex);
      }
    },
  });
}
