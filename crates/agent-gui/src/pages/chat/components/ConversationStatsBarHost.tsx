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
  // 没有 loadStats 的宿主只能报「变了」；有的话直接把 journal 游标交给 hook。
  const [backendRevision, setBackendRevision] = useState(0);
  const [backendCursor, setBackendCursor] = useState<number | undefined>(undefined);
  const trajectoryHostRef = useRef(trajectoryHost);
  trajectoryHostRef.current = trajectoryHost;
  useEffect(() => {
    if (!backendOwned || !enabled || conversationId === "") return;
    // K-brain 持有轨迹 journal：用便宜的 stats 轮询拿 lastSeq 游标交给 hook，由它
    // 与已读窗口的位置比较后决定要不要取尾部一窗。此前的无条件 2s 触发会让大轨迹
    // 会话（几十万事件）每次都整窗重分页：读数在近似/精确间摆动，还带来持续的读放大。
    // 传游标而不是「变了」的计数：打开会话后的第一次轮询必然是一次变化，按计数
    // 会把刚取过的首窗原样再取一遍。
    const host = trajectoryHostRef.current as TrajectoryHost & {
      loadStats?: (id: string) => Promise<{ lastSeq?: number }>;
    };
    if (typeof host.loadStats !== "function") {
      return trajectoryHost.subscribeRefresh?.(() => setBackendRevision((value) => value + 1));
    }
    let stopped = false;
    // 切会话时宿主按 key 重挂载；这里仍显式归零，防止同一实例换 id 后沿用旧游标。
    setBackendCursor(undefined);
    const poll = async () => {
      if (stopped) return;
      try {
        const stats = await host.loadStats?.(conversationId);
        const lastSeq = stats?.lastSeq;
        if (stopped || typeof lastSeq !== "number" || !Number.isFinite(lastSeq)) return;
        // 原样透传，相同值由 React 自行跳过。不取最大值：本地会话被重新映射到新的
        // 后端会话后 journal 从头计数，回落本身就是 hook 需要看到的信号。
        setBackendCursor(lastSeq);
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
    ...(backendOwned && backendCursor !== undefined ? { tailCursor: backendCursor } : {}),
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
