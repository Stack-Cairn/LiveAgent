import {
  buildContextUsageScanItems,
  deriveContextUsageTokens,
} from "@liveagent/ui/lib/chat/contextUsage";
import { useMemo } from "react";
import type { CompactionController } from "../../../lib/chat/compaction/controller";
import type { RenderTimelineItem } from "../../../lib/chat/conversation/conversationState";
import type { LiveTranscriptStore } from "../../../lib/chat/conversation/liveTranscriptStore";

export type ContextUsageTokensSourceParams = {
  isRunning: boolean;
  conversationId: string;
  transcriptItems: readonly RenderTimelineItem[];
  liveTranscriptStore: LiveTranscriptStore;
  getCompactionController: (conversationId: string) => CompactionController;
};

/**
 * Pure factory shared by the current conversation (memoized via the hook
 * below) and workbench background panes, which build one source per pane
 * from their runtime cache entry and per-conversation live store.
 */
export function createContextUsageTokensSource(params: ContextUsageTokensSourceParams) {
  const {
    isRunning,
    conversationId,
    transcriptItems,
    liveTranscriptStore,
    getCompactionController,
  } = params;

  let cache: {
    rounds: unknown;
    draft: string;
    runtimeValue: number | undefined;
    fixedTokens: number | undefined;
    value: number | undefined;
  } | null = null;
  return {
    subscribe: liveTranscriptStore.subscribe,
    getContextUsageTokens: () => {
      const live = liveTranscriptStore.getSnapshot();
      const includeLive = isRunning && !live.isSettled;
      const rounds = includeLive ? live.liveRounds : null;
      const draft = includeLive ? live.draftAssistantText : "";
      const controller = getCompactionController(conversationId);
      const runtimeValue = controller.contextUsageTokens;
      // 供应商不回传 usage 时倒扫全程无锚点：不补 fixed（system+tools 估算）
      // 会让空闲读数与运行中账本读数（含 fixed）来回跳变。
      const fixedTokens = controller.contextFixedTokens;
      if (
        cache &&
        cache.rounds === rounds &&
        cache.draft === draft &&
        cache.runtimeValue === runtimeValue &&
        cache.fixedTokens === fixedTokens
      ) {
        return cache.value;
      }
      // 优先级（#426 引入时的原始设计，文件拆分时注释曾丢失）：运行中（发送/
      // 压缩）转录尾部滞后于账本，账本读数优先；空闲时转录含权威锚点
      //（edit-resend 截断历史后账本仍冻结在截断前读数），转录扫描才准。
      // 惰性求值：命中账本优先项即跳过全量转录扫描（流式期每帧对大工具结果
      // JSON.stringify 后丢弃的开销）。因此 GUI 环在流式期按消息落定跳变而
      // 非逐帧估算；live 尾部联合倒扫仅在运行中而账本尚无读数时可达
      //（如中继压缩落在本会话新建的控制器上）。
      let value: number | undefined;
      if (isRunning && runtimeValue !== undefined) {
        value = runtimeValue;
      } else {
        const transcriptValue = deriveContextUsageTokens(
          buildContextUsageScanItems(transcriptItems, includeLive ? live : null),
          { unanchoredFixedTokens: fixedTokens },
        );
        value = transcriptValue ?? runtimeValue;
      }
      cache = { rounds, draft, runtimeValue, fixedTokens, value };
      return value;
    },
  };
}

export function useContextUsageTokensSource(params: ContextUsageTokensSourceParams) {
  const {
    isRunning,
    conversationId,
    transcriptItems,
    liveTranscriptStore,
    getCompactionController,
  } = params;

  return useMemo(
    () =>
      createContextUsageTokensSource({
        isRunning,
        conversationId,
        transcriptItems,
        liveTranscriptStore,
        getCompactionController,
      }),
    [conversationId, getCompactionController, isRunning, liveTranscriptStore, transcriptItems],
  );
}
