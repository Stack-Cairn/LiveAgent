/**
 * 会话统计状态栏的桌面端薄包装：把共享层的取数 hook 接到本地实时事件源与
 * Tauri 轨迹宿主上（docs/design/composer-context-stats-bar.md §4.4）。
 *
 * 取数代码与 ConversationTrajectorySurface 同款；实时事件与落盘窗口的合并、
 * 去重、缓存全在共享层完成，这里只负责注入。
 */

import { ConversationStatsBar } from "@liveagent/ui/components/chat/ConversationStatsBar";
import type { TrajectoryHost } from "@liveagent/ui/contracts/trajectory";
import { useConversationStats } from "@liveagent/ui/lib/trajectory/useConversationStats";
import type { ContextUsageTokensSource } from "@liveagent/ui/pages/chat/ChatComposerBar";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createTauriTrajectoryHost } from "../../../agent-ui-adapters/trajectory";
import { isKBrainBackendEnabled } from "../../../lib/host";
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
  const backendOwned = isKBrainBackendEnabled();
  const [backendRevision, setBackendRevision] = useState(0);
  const trajectoryHostRef = useRef(trajectoryHost);
  trajectoryHostRef.current = trajectoryHost;
  useEffect(() => {
    if (!backendOwned || !enabled || conversationId === "") return;
    // K-brain 持有轨迹 journal：用便宜的 stats 轮询做变化门控，只在 lastSeq
    // 前进时才失效统计缓存。此前的无条件 2s 触发会让大轨迹会话（几十万事件）
    // 每次都整窗重分页：读数在近似/精确间摆动，还带来持续的读放大。
    const host = trajectoryHostRef.current as TrajectoryHost & {
      loadStats?: (id: string) => Promise<{ lastSeq?: number }>;
    };
    if (typeof host.loadStats !== "function") {
      return trajectoryHost.subscribeRefresh?.(() => setBackendRevision((value) => value + 1));
    }
    let lastSeq: number | undefined;
    let stopped = false;
    const poll = async () => {
      if (stopped) return;
      try {
        const stats = await host.loadStats?.(conversationId);
        if (stopped || stats?.lastSeq === undefined || stats.lastSeq === lastSeq) return;
        lastSeq = stats.lastSeq;
        setBackendRevision((value) => value + 1);
      } catch {
        // 后端暂不可达时保持现状；下一个周期再探。
      }
    };
    void poll();
    const timer = globalThis.setInterval(() => void poll(), 2_000);
    return () => {
      stopped = true;
      globalThis.clearInterval(timer);
    };
  }, [backendOwned, enabled, conversationId]);
  const { stats } = useConversationStats({
    conversationId,
    host: trajectoryHost,
    liveEvents,
    // 桌面端持有权威实时尾巴：空集也是「进程已重启」的证据，遗留 running 收敛为中断。
    liveOwnership: backendOwned ? "observed" : "authoritative",
    authoritativeRevision: backendOwned ? 0 : authoritativeRevision,
    tailRevision: backendOwned ? backendRevision : 0,
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
