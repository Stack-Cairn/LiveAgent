/**
 * 轨迹视图外壳。
 *
 * 数据来源有三条，在这里汇合：
 * - 已落盘事件（宿主拉取）
 * - 实时事件（当前回合进行中，宿主推送）
 * - 正文与子代理运行（从已加载的消息与宿主预取）
 *
 * 没有事件时回落到从消息推导的降级账本——结构完整、时间为空，甘特图锁在 sequence。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TrajectoryHost } from "../../contracts/trajectory";
import { useLocale } from "../../i18n/index";
import type { UiMessage } from "../../lib/chat/uiMessages";
import { buildTrajectoryContentIndex } from "../../lib/trajectory/contentIndex";
import { DEFAULT_TRAJECTORY_DETAILS_WIDTH } from "../../lib/trajectory/detailsResize";
import {
  collapsibleTrajectoryAssistants,
  collapsibleTrajectoryTurns,
} from "../../lib/trajectory/displayItems";
import {
  buildTrajectoryLedger,
  mergeTrajectoryEventWindows,
  parseTrajectoryEvents,
  trajectoryLiveEventIdentities,
} from "../../lib/trajectory/eventLog";
import {
  deriveLedgerFromMessages,
  mergeTrajectoryLedgerWithMessages,
} from "../../lib/trajectory/fromMessages";
import { deriveTrajectoryLayout } from "../../lib/trajectory/layout";
import { trajectoryLedgerHasPartialTiming } from "../../lib/trajectory/presentation";
import {
  TrajectorySearchIndex,
  trajectorySearchMatchIndexes,
} from "../../lib/trajectory/searchIndex";
import {
  type TrajectoryTimelineMode,
  type TrajectoryTimeRange,
  trajectoryTimelineFocusIndexes,
} from "../../lib/trajectory/timeline";
import type {
  TrajectoryEvent,
  TrajectoryRecord,
  TrajectorySubagentRun,
} from "../../lib/trajectory/types";
import { TrajectoryDetailsPanel } from "./TrajectoryDetailsPanel";
import { TrajectoryTable } from "./TrajectoryTable";
import { TrajectoryTimeline } from "./TrajectoryTimeline";
import { TrajectoryToolbar } from "./TrajectoryToolbar";

const EMPTY_TURNS: ReadonlySet<number> = new Set();
const EMPTY_IDS: ReadonlySet<string> = new Set();
const EMPTY_EVENTS: readonly TrajectoryEvent[] = [];
const EMPTY_RUNS: readonly TrajectorySubagentRun[] = [];
/** 子代理批次加载失败后的最大自动重试次数（每次失败 1.5s 退避）。 */
const SUBAGENT_LOAD_MAX_ATTEMPTS = 3;
const SUBAGENT_LOAD_RETRY_DELAY_MS = 1500;

export function TrajectoryView(props: {
  conversationId: string;
  host: TrajectoryHost;
  messages: readonly UiMessage[];
  workdir?: string;
  hasMoreMessages?: boolean;
  loadEarlierMessages?: () => void | Promise<void>;
  /** 当前回合的实时事件；与已落盘事件合并后由账本层去重。 */
  liveEvents?: readonly TrajectoryEvent[];
  /**
   * live 事件为空时的中断收敛语义。
   * - `authoritative`（桌面）：空集同样是权威证据 —— 本进程重启后不持有任何实时
   *   尾巴，持久化里仍 running 的条目一律收敛为 aborted。
   * - `observed`（WebUI，默认）：仅在已观察到实时事件时才收敛未被覆盖的运行条目，
   *   避免页面刚重载、尚未收到实时流时误判仍在运行的回合。
   */
  liveOwnership?: "authoritative" | "observed";
  /** edit-resend 等本地权威变更后的递增版本；变化时替换读取尾部窗口。 */
  authoritativeRevision?: number;
}) {
  const { t } = useLocale();
  const [persisted, setPersisted] = useState<readonly TrajectoryEvent[]>(EMPTY_EVENTS);
  const [truncated, setTruncated] = useState(false);
  const [oldestSegmentIndex, setOldestSegmentIndex] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [subagentRuns, setSubagentRuns] = useState<readonly TrajectorySubagentRun[]>(EMPTY_RUNS);
  const [subagentReloadToken, setSubagentReloadToken] = useState(0);
  // 子代理批次加载失败后的有界自动重试：每个 runId 最多 3 次，1.5s 退避。
  const [subagentRetryTick, setSubagentRetryTick] = useState(0);

  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(EMPTY_TURNS);
  const [collapsedAssistants, setCollapsedAssistants] = useState<ReadonlySet<string>>(EMPTY_IDS);
  const [searchQuery, setSearchQuery] = useState("");
  const [actualDuration, setActualDuration] = useState(false);
  const [range, setRange] = useState<TrajectoryTimeRange | null>(null);
  // Numeric row indexes shift when older pages are prepended; selection must follow the
  // business-stable recordId instead.
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const [detailsWidth, setDetailsWidth] = useState(DEFAULT_TRAJECTORY_DETAILS_WIDTH);

  const { host, conversationId } = props;
  const loadGeneration = useRef(0);
  const authoritativeRevisionRef = useRef<{ conversationId: string; revision: number } | null>(
    null,
  );
  const subagentLoadEpoch = useRef(0);
  const requestedSubagentRunIds = useRef(new Set<string>());
  const subagentRetryCounts = useRef(new Map<string, number>());
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setLoadingMore(false);
    setPersisted(EMPTY_EVENTS);
    setTruncated(false);
    setOldestSegmentIndex(null);
    subagentLoadEpoch.current += 1;
    requestedSubagentRunIds.current.clear();
    subagentRetryCounts.current.clear();
    setSubagentRuns(EMPTY_RUNS);
    setSubagentReloadToken(0);
    setCollapsedTurns(EMPTY_TURNS);
    setCollapsedAssistants(EMPTY_IDS);
    setSearchQuery("");
    setActualDuration(false);
    setRange(null);
    setSelectedRecordId(null);

    host
      .loadWindow(conversationId)
      .then((payload) => {
        if (generation !== loadGeneration.current) return;
        setPersisted(parseTrajectoryEvents(payload.eventsJson));
        setTruncated(payload.truncated);
        setOldestSegmentIndex(payload.oldestSegmentIndex);
      })
      .catch((error) => {
        if (generation !== loadGeneration.current) return;
        console.warn("[trajectory] failed to load event window", error);
        setPersisted(EMPTY_EVENTS);
        setTruncated(true);
      })
      .finally(() => {
        if (generation === loadGeneration.current) setLoading(false);
      });
    return () => {
      if (generation === loadGeneration.current) loadGeneration.current += 1;
    };
  }, [host, conversationId]);

  const reconcileAuthoritativeWindow = useCallback(() => {
    const generation = ++loadGeneration.current;
    // Keep the last known-good view painted while the authoritative tail is refreshed.
    // 整体替换（而非合并）：edit-resend / 断线期间的 rebase 可能删掉了旧轮次，
    // 合并会让已被裁剪的事件复活。
    void host
      .loadWindow(conversationId)
      .then((payload) => {
        if (generation !== loadGeneration.current) return;
        setPersisted(parseTrajectoryEvents(payload.eventsJson));
        setTruncated(payload.truncated);
        setOldestSegmentIndex(payload.oldestSegmentIndex);
        setRange(null);
      })
      .catch((error) => {
        if (generation !== loadGeneration.current) return;
        console.warn("[trajectory] failed to reconcile authoritative window", error);
        setTruncated(true);
      })
      .finally(() => {
        if (generation === loadGeneration.current) setLoading(false);
      });

    subagentLoadEpoch.current += 1;
    requestedSubagentRunIds.current.clear();
    setSubagentReloadToken((token) => token + 1);
  }, [host, conversationId]);

  useEffect(() => {
    const revision = props.authoritativeRevision;
    if (revision === undefined) return;
    const previous = authoritativeRevisionRef.current;
    authoritativeRevisionRef.current = { conversationId, revision };
    if (previous === null || previous.conversationId !== conversationId) return;
    if (previous.revision === revision) return;
    reconcileAuthoritativeWindow();
  }, [conversationId, props.authoritativeRevision, reconcileAuthoritativeWindow]);

  useEffect(() => {
    if (host.subscribeRefresh === undefined) return;
    const unsubscribe = host.subscribeRefresh(reconcileAuthoritativeWindow);
    return unsubscribe;
  }, [host, reconcileAuthoritativeWindow]);

  const liveEvents = props.liveEvents ?? EMPTY_EVENTS;
  // 与后端 `has_more_before = returned > 0 && oldest > 0` 同义：最老已读边界之前还有段。
  // 由 oldestSegmentIndex 推导而不是独立 state，保证「向前分页 + 尾部合并」两边不会各说各话。
  const hasMoreBefore = oldestSegmentIndex !== null && oldestSegmentIndex > 0;
  const latestTerminalEventKey = useMemo(() => {
    for (let index = liveEvents.length - 1; index >= 0; index -= 1) {
      const event = liveEvents[index];
      if (event.k === "turn_end" || event.k === "compaction_end") {
        return `${event.k}:${event.t ?? "-"}:${event.at}:${event.st}`;
      }
    }
    return null;
  }, [liveEvents]);

  // Reconcile the desktop-local live tail after recorder flush, and give WebUI the same
  // authoritative convergence point after a completed run. Keep the current view visible;
  // this is a quiet refresh, not a navigation load.
  useEffect(() => {
    if (latestTerminalEventKey === null) return;
    const generation = loadGeneration.current;
    const timer = setTimeout(() => {
      void host
        .loadWindow(conversationId)
        .then((payload) => {
          if (generation !== loadGeneration.current) return;
          // 同进程的终态对账按事件身份合并：尾部窗口只补新事件，不整体替换 ——
          // 用户已向前分页出的更早事件窗口不能因为一次回合结束被静默重置。
          const fresh = parseTrajectoryEvents(payload.eventsJson);
          setPersisted((current) =>
            fresh.length === 0 ? current : mergeTrajectoryEventWindows(current, fresh),
          );
          setTruncated((current) => current || payload.truncated);
          // 合并后最老边界取较小值，保证「加载更早」从真正的最老已读段继续。
          setOldestSegmentIndex((current) =>
            current === null
              ? payload.oldestSegmentIndex
              : Math.min(current, payload.oldestSegmentIndex),
          );
        })
        .catch((error) => {
          console.warn(
            "[trajectory] terminal reconciliation failed; live tail remains active",
            error,
          );
        });
    }, 350);
    return () => clearTimeout(timer);
  }, [conversationId, host, latestTerminalEventKey]);

  const ledger = useMemo(() => {
    const events = liveEvents.length === 0 ? persisted : [...persisted, ...liveEvents];
    if (events.length > 0) {
      // 中断收敛：崩溃/强退后遗留的 running 条目按 aborted 收敛。authoritative 模式下
      // 空集也参与判定（本进程重启即证明不持有实时尾巴）；observed 模式保留旧行为。
      const liveIdentities =
        props.liveOwnership === "authoritative" || liveEvents.length > 0
          ? trajectoryLiveEventIdentities(liveEvents)
          : undefined;
      return mergeTrajectoryLedgerWithMessages(
        buildTrajectoryLedger(events, { liveIdentities }),
        props.messages,
      );
    }
    // 轨迹功能上线前的会话没有事件；降级路径给出结构，但绝不伪造耗时。
    return deriveLedgerFromMessages(props.messages);
  }, [persisted, liveEvents, props.liveOwnership, props.messages]);

  const referencedSubagentRunIds = useMemo(() => {
    const ids = new Set<string>();
    for (const turn of ledger.turns) {
      for (const step of turn.steps) {
        for (const tool of step.tools) {
          for (const runId of tool.subagentRunIds) {
            const normalized = runId.trim();
            if (normalized !== "") ids.add(normalized);
          }
        }
      }
    }
    return [...ids].sort();
  }, [ledger]);

  useEffect(() => {
    void subagentReloadToken;
    const referenced = new Set(referencedSubagentRunIds);
    setSubagentRuns((current) => {
      const retained = current.filter((run) => referenced.has(run.runId));
      return retained.length === current.length ? current : retained;
    });
    if (host.loadSubagentRuns === undefined || referencedSubagentRunIds.length === 0) return;
    const missing = referencedSubagentRunIds.filter(
      (runId) => !requestedSubagentRunIds.current.has(runId),
    );
    if (missing.length === 0) return;
    for (const runId of missing) requestedSubagentRunIds.current.add(runId);
    const epoch = subagentLoadEpoch.current;
    void subagentRetryTick;
    void host
      .loadSubagentRuns(conversationId, missing)
      .then((runs) => {
        if (epoch !== subagentLoadEpoch.current) return;
        for (const runId of missing) subagentRetryCounts.current.delete(runId);
        setSubagentRuns((current) => {
          const byId = new Map(
            current.filter((run) => referenced.has(run.runId)).map((run) => [run.runId, run]),
          );
          for (const run of runs) {
            if (referenced.has(run.runId)) byId.set(run.runId, run);
          }
          return referencedSubagentRunIds.flatMap((runId) => {
            const run = byId.get(runId);
            return run === undefined ? [] : [run];
          });
        });
      })
      .catch((error) => {
        if (epoch !== subagentLoadEpoch.current) return;
        // 失败后从「已请求」集合移除，并做有界自动重试：ref 变化不会触发 effect
        // 重跑，这里显式 bump 一个 tick；重试耗尽的 runId 等待下一次 ledger
        // 变化自然重试。
        for (const runId of missing) {
          requestedSubagentRunIds.current.delete(runId);
        }
        const retriable = missing.filter((runId) => {
          const attempts = (subagentRetryCounts.current.get(runId) ?? 0) + 1;
          subagentRetryCounts.current.set(runId, attempts);
          return attempts <= SUBAGENT_LOAD_MAX_ATTEMPTS;
        });
        console.warn("[trajectory] failed to load referenced subagent runs", error);
        if (retriable.length > 0) {
          setTimeout(() => setSubagentRetryTick((tick) => tick + 1), SUBAGENT_LOAD_RETRY_DELAY_MS);
        }
      });
  }, [conversationId, host, referencedSubagentRunIds, subagentReloadToken, subagentRetryTick]);

  const content = useMemo(
    () => buildTrajectoryContentIndex(props.messages, ledger),
    [props.messages, ledger],
  );
  const turns = useMemo(
    () => deriveTrajectoryLayout({ ledger, content, subagentRuns }),
    [ledger, content, subagentRuns],
  );

  const searchIndex = useMemo(() => new TrajectorySearchIndex(), []);
  const layouts = useMemo(() => [turns] as const, [turns]);
  const searchMatchIndexes = useMemo(() => {
    if (searchQuery.trim() === "") return null;
    searchIndex.update(layouts);
    return trajectorySearchMatchIndexes(layouts, searchIndex.search(searchQuery));
  }, [searchIndex, layouts, searchQuery]);

  const hasTiming = ledger.hasTiming;
  const hasPartialTiming = trajectoryLedgerHasPartialTiming(ledger);
  const notice = truncated
    ? t("trajectory.truncated")
    : !hasTiming
      ? t("trajectory.degraded")
      : hasPartialTiming
        ? t("trajectory.partialTiming")
        : null;
  const mode: TrajectoryTimelineMode = hasTiming && actualDuration ? "duration" : "sequence";
  const timelineFocusIndexes = useMemo(
    () => (range === null ? null : trajectoryTimelineFocusIndexes(turns, range, mode)),
    [range, turns, mode],
  );

  const { recordsByIndex, recordsById } = useMemo(() => {
    const byIndex = new Map<number, TrajectoryRecord>();
    const byId = new Map<string, TrajectoryRecord>();
    for (const turn of turns) {
      for (const group of turn.groups) {
        for (const record of group.records) {
          byIndex.set(record.index, record);
          byId.set(record.recordId, record);
        }
      }
    }
    return { recordsByIndex: byIndex, recordsById: byId };
  }, [turns]);
  const selectedRecord =
    selectedRecordId === null ? null : (recordsById.get(selectedRecordId) ?? null);
  const selectedIndex = selectedRecord?.index ?? null;
  const selectRecordAtIndex = useCallback(
    (index: number) => setSelectedRecordId(recordsByIndex.get(index)?.recordId ?? null),
    [recordsByIndex],
  );

  const collapsibleTurns = useMemo(() => collapsibleTrajectoryTurns(turns), [turns]);
  const collapsibleAssistants = useMemo(() => collapsibleTrajectoryAssistants(turns), [turns]);
  const allTurnsCollapsed =
    collapsibleTurns.length > 0 && collapsibleTurns.every((turn) => collapsedTurns.has(turn));
  const allCallsCollapsed =
    collapsibleAssistants.length > 0 &&
    collapsibleAssistants.every((id) => collapsedAssistants.has(id));

  const loadEarlier = useCallback(async () => {
    const canLoadEvents = hasMoreBefore && oldestSegmentIndex !== null;
    const canLoadMessages =
      props.hasMoreMessages === true && props.loadEarlierMessages !== undefined;
    if (loadingMore || (!canLoadEvents && !canLoadMessages)) return;
    const generation = loadGeneration.current;
    setLoadingMore(true);
    try {
      const [payload] = await Promise.all([
        canLoadEvents
          ? host.loadWindow(conversationId, oldestSegmentIndex ?? undefined)
          : Promise.resolve(null),
        canLoadMessages ? Promise.resolve(props.loadEarlierMessages?.()) : Promise.resolve(),
      ]);
      if (generation !== loadGeneration.current) return;
      // Message-only pagination also prepends visual records and shifts numeric projection indexes.
      setRange(null);
      if (payload === null) return;
      const older = parseTrajectoryEvents(payload.eventsJson);
      setPersisted((current) =>
        older.length === 0 ? current : mergeTrajectoryEventWindows(older, current),
      );
      setTruncated((current) => current || payload.truncated);
      setOldestSegmentIndex(payload.oldestSegmentIndex);
    } catch (error) {
      if (generation === loadGeneration.current) {
        console.warn("[trajectory] failed to load earlier data", error);
        setTruncated(true);
      }
    } finally {
      if (generation === loadGeneration.current) setLoadingMore(false);
    }
  }, [
    conversationId,
    hasMoreBefore,
    host,
    loadingMore,
    oldestSegmentIndex,
    props.hasMoreMessages,
    props.loadEarlierMessages,
  ]);

  const loadSections = useCallback(
    (sectionIds: readonly string[]) => host.loadSections(conversationId, sectionIds),
    [host, conversationId],
  );

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
        {t("trajectory.loading")}
      </div>
    );
  }

  return (
    <div className="@container flex h-full min-h-0 flex-1 flex-col">
      <TrajectoryToolbar
        actualDuration={actualDuration}
        hasTiming={hasTiming}
        onActualDurationChange={(next) => {
          setActualDuration(next);
          setRange(null);
        }}
        allTurnsCollapsed={allTurnsCollapsed}
        onToggleAllTurns={() =>
          setCollapsedTurns(allTurnsCollapsed ? EMPTY_TURNS : new Set(collapsibleTurns))
        }
        allCallsCollapsed={allCallsCollapsed}
        onToggleAllCalls={() =>
          setCollapsedAssistants(allCallsCollapsed ? EMPTY_IDS : new Set(collapsibleAssistants))
        }
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
      />

      {(hasMoreBefore || props.hasMoreMessages === true) && (
        <div className="shrink-0 border-b border-border/60 px-3 py-1.5 text-center">
          <button
            type="button"
            className="rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-wait disabled:opacity-60"
            disabled={loadingMore}
            onClick={() => void loadEarlier()}
          >
            {loadingMore ? t("trajectory.loadingEarlier") : t("trajectory.loadEarlier")}
          </button>
        </div>
      )}

      {notice !== null && (
        <p className="shrink-0 border-b border-border/60 bg-muted/30 px-3 py-1 text-[11px] text-muted-foreground">
          {notice}
        </p>
      )}

      <TrajectoryTimeline
        turns={turns}
        mode={mode}
        range={range}
        selectedIndex={selectedIndex}
        searchMatchIndexes={searchMatchIndexes}
        onRangeChange={setRange}
        onRecordSelect={selectRecordAtIndex}
      />

      <div ref={contentRef} className="relative flex min-h-0 flex-1 overflow-hidden">
        <TrajectoryTable
          turns={turns}
          collapsedTurns={collapsedTurns}
          collapsedAssistants={collapsedAssistants}
          searchMatchIndexes={searchMatchIndexes}
          timelineFocusIndexes={timelineFocusIndexes}
          selectedIndex={selectedIndex}
          onSelect={selectRecordAtIndex}
          onToggleTurn={(turn) =>
            setCollapsedTurns((current) => {
              const next = new Set(current);
              if (next.has(turn)) next.delete(turn);
              else next.add(turn);
              return next;
            })
          }
        />
        <TrajectoryDetailsPanel
          record={selectedRecord}
          header={
            selectedRecord?.headerId === undefined
              ? undefined
              : ledger.headers.get(selectedRecord.headerId)
          }
          previousHeader={
            selectedRecord?.previousHeaderId === undefined
              ? undefined
              : ledger.headers.get(selectedRecord.previousHeaderId)
          }
          loadSections={loadSections}
          workdir={props.workdir}
          onOpenFileLink={host.openFileLink}
          onClose={() => setSelectedRecordId(null)}
          containerRef={contentRef}
          width={detailsWidth}
          onWidthChange={setDetailsWidth}
        />
      </div>
    </div>
  );
}
