/**
 * 会话累计统计的取数 hook。
 *
 * 首窗同步拿到读数，剩余段在空闲期向前分页补齐；实时事件与落盘事件用账本层的
 * 收敛身份去重，因此断线重放不会双算。重建节流到 1s，与运行中时长的心跳同频。
 *
 * 模块级缓存让多 pane 打开同一会话共享一份事件与聚合快照——切走再切回不重新分页。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { TrajectoryHost } from "../../contracts/trajectory";
import {
  buildTrajectoryLedger,
  mergeTrajectoryEventWindows,
  parseTrajectoryEvents,
  trajectoryLiveEventIdentities,
} from "./eventLog";
import { aggregateTrajectoryStats, type ConversationStats } from "./stats";
import type { TrajectoryEvent } from "./types";

/** 重建节流窗口，与状态栏运行中心跳同频。 */
export const STATS_REBUILD_THROTTLE_MS = 1_000;

/** 极端长会话的保险丝：累计事件数超过此值停止向前分页，读数保持 approximate。 */
export const STATS_EVENT_CEILING = 50_000;

const CACHE_LIMIT = 8;

type CacheEntry = {
  events: readonly TrajectoryEvent[];
  /** 已读到的最早 segment；0 表示读完，null 表示还没读过首窗。 */
  oldestSegmentIndex: number | null;
  truncated: boolean;
  /** 向前分页是否已经走完（含触顶挡板的情况）。 */
  complete: boolean;
  revision: number;
  /** 事件集合的版本号，用于跳过无变化的重建。 */
  version: number;
};

const cache = new Map<string, CacheEntry>();

function touch(conversationId: string, entry: CacheEntry): void {
  cache.delete(conversationId);
  cache.set(conversationId, entry);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done === true || oldest.value === conversationId) break;
    cache.delete(oldest.value);
  }
}

/** 测试与会话删除用：丢掉某个会话（省略参数则全清）的缓存。 */
export function clearConversationStatsCache(conversationId?: string): void {
  if (conversationId === undefined) {
    cache.clear();
    return;
  }
  cache.delete(conversationId.trim());
}

function scheduleIdle(callback: () => void): () => void {
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => number })
    .requestIdleCallback;
  if (typeof idle === "function") {
    const handle = idle(callback);
    const cancel = (globalThis as { cancelIdleCallback?: (handle: number) => void })
      .cancelIdleCallback;
    return () => cancel?.(handle);
  }
  const timer = setTimeout(callback, 0);
  return () => clearTimeout(timer);
}

export type UseConversationStatsOptions = {
  conversationId: string;
  host: Pick<TrajectoryHost, "loadWindow">;
  /** `useSyncExternalStore` 产物，宿主传入。 */
  liveEvents: readonly TrajectoryEvent[];
  /**
   * live 事件为空时的中断收敛语义，沿用轨迹视图：
   * - `authoritative`（桌面）：空集也是权威证据，持久化里仍 running 的条目收敛为 aborted；
   * - `observed`（WebUI，默认）：仅在已观察到实时事件时收敛，避免页面刚重载时误判。
   */
  liveOwnership?: "authoritative" | "observed";
  /** edit-resend / rebase 后整体重载。 */
  authoritativeRevision?: number;
  /** 条为空或隐藏时不加载。 */
  enabled: boolean;
};

export type UseConversationStatsResult = {
  stats: ConversationStats | null;
  loading: boolean;
};

export function useConversationStats(
  options: UseConversationStatsOptions,
): UseConversationStatsResult {
  const { host, liveEvents, liveOwnership, authoritativeRevision = 0, enabled } = options;
  const conversationId = options.conversationId.trim();

  const [loading, setLoading] = useState(false);
  // 事件集合的版本号；持久层分页与 live 事件都通过它触发重建。
  const [eventVersion, setEventVersion] = useState(0);

  const hostRef = useRef(host);
  hostRef.current = host;

  const entryFor = useCallback((): CacheEntry => {
    const existing = cache.get(conversationId);
    if (existing !== undefined && existing.revision === authoritativeRevision) {
      touch(conversationId, existing);
      return existing;
    }
    const fresh: CacheEntry = {
      events: [],
      oldestSegmentIndex: null,
      truncated: false,
      complete: false,
      revision: authoritativeRevision,
      version: 0,
    };
    touch(conversationId, fresh);
    return fresh;
  }, [conversationId, authoritativeRevision]);

  // 首窗 + 后台向前分页。整个链路一个 effect：conversationId 或权威版本变化即重来。
  useEffect(() => {
    if (!enabled || conversationId === "") {
      setLoading(false);
      return;
    }

    let cancelled = false;
    let cancelIdle: (() => void) | null = null;
    const entry = entryFor();

    const advance = () => {
      if (cancelled) return;
      const current = cache.get(conversationId);
      if (current === undefined || current.revision !== authoritativeRevision) return;
      if (current.complete) {
        setLoading(false);
        return;
      }
      if (current.events.length >= STATS_EVENT_CEILING) {
        // 触顶挡板：停止分页，读数保持 approximate。
        cache.set(conversationId, { ...current, complete: true });
        setLoading(false);
        setEventVersion((value) => value + 1);
        return;
      }

      const cursor = current.oldestSegmentIndex === null ? undefined : current.oldestSegmentIndex;
      setLoading(true);
      hostRef.current
        .loadWindow(conversationId, cursor)
        .then((payload) => {
          if (cancelled) return;
          const latest = cache.get(conversationId);
          if (latest === undefined || latest.revision !== authoritativeRevision) return;
          const parsed = parseTrajectoryEvents(payload.eventsJson);
          const merged = mergeTrajectoryEventWindows(latest.events, parsed);
          const oldest =
            latest.oldestSegmentIndex === null
              ? payload.oldestSegmentIndex
              : Math.min(latest.oldestSegmentIndex, payload.oldestSegmentIndex);
          const next: CacheEntry = {
            events: merged,
            oldestSegmentIndex: oldest,
            truncated: latest.truncated || payload.truncated,
            complete: !payload.hasMoreBefore,
            revision: authoritativeRevision,
            version: latest.version + 1,
          };
          touch(conversationId, next);
          setEventVersion((value) => value + 1);
          if (payload.hasMoreBefore) {
            cancelIdle = scheduleIdle(advance);
          } else {
            setLoading(false);
          }
        })
        .catch((error) => {
          if (cancelled) return;
          console.warn("[trajectory] conversation stats window failed", error);
          // 失败不重试：读数是诊断信息，宁可停在已有窗口也不打扰会话主链路。
          const latest = cache.get(conversationId);
          if (latest !== undefined && latest.revision === authoritativeRevision) {
            cache.set(conversationId, { ...latest, complete: true });
          }
          setLoading(false);
          setEventVersion((value) => value + 1);
        });
    };

    if (entry.complete) {
      // 缓存已完整：直接用，不再打后端。
      setEventVersion((value) => value + 1);
      setLoading(false);
    } else {
      advance();
    }

    return () => {
      cancelled = true;
      cancelIdle?.();
    };
  }, [conversationId, authoritativeRevision, enabled, entryFor]);

  // live 事件到达时节流 1s 再重建：流式期间事件密集，逐条重建账本没有意义。
  const [liveVersion, setLiveVersion] = useState(0);
  const liveEventsRef = useRef(liveEvents);
  liveEventsRef.current = liveEvents;
  const pendingLiveRef = useRef(false);
  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled || conversationId === "") return;
    if (liveTimerRef.current !== null) {
      // 节流窗口内的后续通知合并进本次待处理，不额外排定时器。
      pendingLiveRef.current = true;
      return;
    }
    setLiveVersion((value) => value + 1);
    liveTimerRef.current = setTimeout(() => {
      liveTimerRef.current = null;
      if (pendingLiveRef.current) {
        pendingLiveRef.current = false;
        setLiveVersion((value) => value + 1);
      }
    }, STATS_REBUILD_THROTTLE_MS);
  }, [liveEvents, enabled, conversationId]);

  useEffect(
    () => () => {
      if (liveTimerRef.current !== null) clearTimeout(liveTimerRef.current);
      liveTimerRef.current = null;
      pendingLiveRef.current = false;
    },
    [],
  );

  const stats = useMemo(() => {
    if (!enabled || conversationId === "") return null;
    const entry = cache.get(conversationId);
    const persisted = entry?.revision === authoritativeRevision ? entry.events : [];
    const live = liveEventsRef.current;
    if (persisted.length === 0 && live.length === 0) return null;

    const events = mergeTrajectoryEventWindows(persisted, live);
    // 中断收敛沿用轨迹视图：authoritative 下空集也参与判定（进程重启的权威证据），
    // observed 下只有观察到实时事件后才收敛，避免刚重载就把运行中的回合判成中断。
    const liveIdentities =
      liveOwnership === "authoritative" || live.length > 0
        ? trajectoryLiveEventIdentities(live)
        : undefined;
    const ledger = buildTrajectoryLedger(events, { liveIdentities });
    const approximate =
      entry === undefined ||
      entry.truncated ||
      !entry.complete ||
      events.length >= STATS_EVENT_CEILING;
    return aggregateTrajectoryStats(ledger, { approximate });
    // eventVersion / liveVersion 是重建触发器：前者跟随分页，后者被节流到 1s。
  }, [conversationId, authoritativeRevision, enabled, liveOwnership, eventVersion, liveVersion]);

  return { stats, loading };
}
