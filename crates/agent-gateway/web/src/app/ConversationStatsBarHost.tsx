/**
 * 会话统计状态栏的 WebUI 薄包装（docs/design/composer-context-stats-bar.md §4.4）。
 *
 * 独立组件而非直接写进 GatewayAppView：运行中状态栏每秒重渲染一次，隔在这里
 * 只重画这一行，不带着整个视图回流（与 ComposerContextUsageRing 同一考量）。
 */

import { ConversationStatsBar } from "@liveagent/ui/components/chat/ConversationStatsBar";
import type { TrajectoryHost } from "@liveagent/ui/contracts/trajectory";
import { useConversationStats } from "@liveagent/ui/lib/trajectory/useConversationStats";
import type { ContextUsageTokensSource } from "@liveagent/ui/pages/chat/ChatComposerBar";
import { useSyncExternalStore } from "react";
import {
  liveTrajectoryAuthoritativeRevision,
  liveTrajectoryEvents,
  subscribeLiveTrajectory,
} from "@/lib/trajectory/liveTrajectory";

const noopSubscribe = () => () => {};
const readNoTokens = () => undefined;

export function ConversationStatsBarHost(props: {
  conversationId: string;
  host: TrajectoryHost;
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
    host,
    enabled = true,
    onManualCompactConfirm,
    manualCompactBlocked,
    contextUsageTokensSource,
    contextWindow,
  } = props;
  const liveEvents = useSyncExternalStore(subscribeLiveTrajectory, () =>
    liveTrajectoryEvents(conversationId),
  );
  const authoritativeRevision = useSyncExternalStore(subscribeLiveTrajectory, () =>
    liveTrajectoryAuthoritativeRevision(conversationId),
  );
  const { stats } = useConversationStats({
    conversationId,
    host,
    liveEvents,
    // 观察端：页面刚重载、尚未收到实时流时不把仍在运行的回合误判为中断。
    liveOwnership: "observed",
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
