/**
 * 会话统计状态栏的桌面端薄包装：把共享层的取数 hook 接到本地实时事件源与
 * Tauri 轨迹宿主上（docs/design/composer-context-stats-bar.md §4.4）。
 *
 * 取数代码与 ConversationTrajectorySurface 同款；实时事件与落盘窗口的合并、
 * 去重、缓存全在共享层完成，这里只负责注入。
 */

import { ConversationStatsBar } from "@liveagent/ui/components/chat/ConversationStatsBar";
import { useConversationStats } from "@liveagent/ui/lib/trajectory/useConversationStats";
import type { ContextUsageTokensSource } from "@liveagent/ui/pages/chat/ChatComposerBar";
import { useSyncExternalStore } from "react";
import { createTauriTrajectoryHost } from "../../../agent-ui-adapters/trajectory";
import {
  desktopLiveTrajectoryEvents,
  desktopTrajectoryReloadVersion,
  subscribeDesktopLiveTrajectory,
} from "../../../lib/trajectory/liveTrajectory";

// 宿主无状态（只是 invoke 的包装），模块级复用一份即可。
const trajectoryHost = createTauriTrajectoryHost();

const noopSubscribe = () => () => {};
const readNoTokens = () => undefined;

export function ConversationStatsBarHost(props: {
  conversationId: string;
  enabled?: boolean;
  /** 提供且占用达标时整条可点击，弹出确认后触发手动压缩；缺省为纯展示。 */
  onManualCompactConfirm?: (() => void) | (() => Promise<unknown>);
  manualCompactBlocked?: boolean;
  /** 与 composer 用量环同一订阅源，供状态栏恒显分组读取当前上下文占用。 */
  contextUsageTokensSource?: ContextUsageTokensSource;
  contextWindow?: number;
}) {
  const {
    conversationId,
    enabled = true,
    onManualCompactConfirm,
    manualCompactBlocked,
    contextUsageTokensSource,
    contextWindow,
  } = props;
  const liveEvents = useSyncExternalStore(subscribeDesktopLiveTrajectory, () =>
    desktopLiveTrajectoryEvents(conversationId),
  );
  const authoritativeRevision = useSyncExternalStore(subscribeDesktopLiveTrajectory, () =>
    desktopTrajectoryReloadVersion(conversationId),
  );
  const { stats } = useConversationStats({
    conversationId,
    host: trajectoryHost,
    liveEvents,
    // 桌面端持有权威实时尾巴：空集也是「进程已重启」的证据，遗留 running 收敛为中断。
    liveOwnership: "authoritative",
    authoritativeRevision,
    enabled,
  });
  const contextUsageTokens = useSyncExternalStore(
    contextUsageTokensSource?.subscribe ?? noopSubscribe,
    contextUsageTokensSource?.getContextUsageTokens ?? readNoTokens,
    contextUsageTokensSource?.getContextUsageTokens ?? readNoTokens,
  );

  return (
    <ConversationStatsBar
      stats={stats}
      contextUsageTokens={contextUsageTokens}
      contextWindow={contextWindow}
      manualCompactBlocked={manualCompactBlocked}
      {...(onManualCompactConfirm === undefined ? {} : { onManualCompactConfirm })}
    />
  );
}
