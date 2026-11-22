import { ChevronDown } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { chatTimestamp, workDuration } from "@liveagent/ui/lib/chat/workTiming";
import { isDocumentHidden } from "@liveagent/ui/lib/shared/documentVisibility";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { LazyCollapse } from "./LazyCollapse";
import { useExpandProcessByDefault, useProcessDefaultChange } from "./processDisclosure";
import { useAttentionDisclosure } from "./useAttentionDisclosure";

export function formatElapsedTime(elapsedMs: number) {
  if (workDuration(elapsedMs) === undefined) return "";
  const totalSeconds = Math.floor(elapsedMs / 1_000);
  if (totalSeconds < 1) return "";
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours > 0 ? `${hours}h` : "", minutes > 0 ? `${minutes}m` : "", `${seconds}s`]
    .filter(Boolean)
    .join("");
}

/**
 * Elapsed time of a turn: the persisted duration once known, otherwise the time
 * since the turn's real start (or since mount). With `tick` it re-reads the
 * clock every second while the turn runs — only the live status row needs
 * that; the work trace header only reads the settled value.
 */
export function useTurnElapsedMs(options: {
  running: boolean;
  startedAtMs?: number;
  durationMs?: number;
  tick?: boolean;
}) {
  const { running, tick = false } = options;
  const validStartedAt = chatTimestamp(options.startedAtMs);
  const validDuration = workDuration(options.durationMs);
  const [elapsedMs, setElapsedMs] = useState(
    () =>
      validDuration ??
      (running && validStartedAt !== undefined ? Math.max(0, Date.now() - validStartedAt) : 0),
  );
  const startedAtRef = useRef<number | null>(running ? (validStartedAt ?? Date.now()) : null);

  useEffect(() => {
    if (!running) {
      if (validDuration !== undefined) {
        setElapsedMs(validDuration);
      } else if (startedAtRef.current !== null) {
        setElapsedMs(Math.max(0, Date.now() - startedAtRef.current));
      }
      return;
    }

    if (validStartedAt !== undefined) startedAtRef.current = validStartedAt;
    else if (startedAtRef.current === null) startedAtRef.current = Date.now();
    if (!tick) return;
    const updateElapsed = () => {
      const startedAt = startedAtRef.current;
      if (startedAt !== null) setElapsedMs(Math.max(0, Date.now() - startedAt));
    };
    updateElapsed();
    // 不可见时停表：秒表只服务于"看着它跑"的观感，隐藏窗口里的每秒重渲染
    // 纯属白烧 CPU；重新可见时 effect 重跑，读数立即补上。
    const timer = setInterval(() => {
      if (isDocumentHidden()) return;
      updateElapsed();
    }, 1_000);
    return () => clearInterval(timer);
  }, [validDuration, running, validStartedAt, tick]);

  return elapsedMs;
}

export type WorkTraceStats = {
  /** Tool calls made so far. */
  toolCount: number;
  /** Settled reasoning time, or null when none was measured (e.g. after a reload). */
  thinkingMs: number | null;
};

/** "3 个工具 · 思考 8s": the trace's summary parts, empty when there is nothing to count. */
export function formatWorkTraceStats(
  stats: WorkTraceStats | undefined,
  t: (key: string) => string,
): string[] {
  if (!stats) return [];
  const parts: string[] = [];
  if (stats.toolCount > 0) {
    parts.push(
      stats.toolCount === 1
        ? t("chat.work.toolCountOne")
        : t("chat.work.toolCount").replace("{count}", String(stats.toolCount)),
    );
  }
  const thinking = stats.thinkingMs === null ? "" : formatElapsedTime(stats.thinkingMs);
  if (thinking) parts.push(t("chat.work.thinkingTotal").replace("{duration}", thinking));
  return parts;
}

/**
 * The collapsible processing trace of one turn. Its header is a summary, not a
 * status: while the turn runs it reads "执行过程 · 3 个工具 · 思考 8s" with no
 * spinner or ticking clock (the turn's single live status row carries those),
 * and once the turn ends it folds — when there is an answer — into one
 * "已处理 12s · 3 个工具 · 思考 8s" row so the answer is the visual focus.
 */
export function AssistantWorkTrace({
  children,
  collapsedTail,
  className,
  durationMs,
  hasDetails,
  attentionRequired = false,
  running,
  startedAtMs,
  stats,
  collapseAfterAnswer = false,
}: {
  children: ReactNode;
  /**
   * 当前正在进行的活动区块（运行中的工具组 / 思考 / 正在流式输出的
   * 进度文本）。仅在「运行中且用户手动折叠了本区块」时渲染在折叠头下方，
   * 这样折叠后外面不至于空无一物；展开时内容本就可见，不再重复。
   */
  collapsedTail?: ReactNode;
  className?: string;
  durationMs?: number;
  hasDetails: boolean;
  attentionRequired?: boolean;
  running: boolean;
  /**
   * 回合真实起点（epoch ms，通常是触发本回合的用户消息时间戳）。组件会随
   * 切换会话、虚拟列表回收而卸载重挂；只靠挂载时刻计时会让「已处理」读数归零。
   * 缺省时退回挂载时刻。
   */
  startedAtMs?: number;
  /** Counts for the summary header. */
  stats?: WorkTraceStats;
  /** 回复有总结文案（answer）时：回合结束（流停止）后自动折叠一次。 */
  collapseAfterAnswer?: boolean;
}) {
  const { t } = useLocale();
  // 没有总结文案的回合（被打断、失败、只有过程）挂载时展开：折叠后只剩标题，
  // 用户看不到已经执行过的步骤。有文案的历史回合仍折叠，只露出回答。
  // 设置里开了「默认展开执行过程」时，过程区块始终以展开态挂载，且回合结束后不再自动折叠。
  const expandProcessByDefault = useExpandProcessByDefault();
  const [expanded, setExpanded] = useAttentionDisclosure(
    attentionRequired,
    running || !collapseAfterAnswer || expandProcessByDefault,
  );

  // 有总结文案时，回合完成（running 变 false）后自动折叠过程区块一次；
  // 之后 disclosure 所有权交还给用户，手动展开/折叠不再被强制收回，
  // 也不会和 attentionRequired（待用户交互的卡片）的强制展开打架。
  useEffect(() => {
    if (!running && !attentionRequired && collapseAfterAnswer && !expandProcessByDefault) {
      setExpanded(false);
    }
  }, [running, attentionRequired, collapseAfterAnswer, expandProcessByDefault, setExpanded]);
  useProcessDefaultChange(expandProcessByDefault, (expand) =>
    setExpanded(expand || running || !collapseAfterAnswer || attentionRequired),
  );
  const elapsedMs = useTurnElapsedMs({ running, startedAtMs, durationMs });

  // A running turn with nothing to show yet renders no header at all: the
  // live status row says what is happening.
  if (running && !hasDetails) return null;

  const elapsedLabel = running ? "" : formatElapsedTime(elapsedMs);
  const lead = running
    ? t("chat.work.trace")
    : `${t("chat.work.activity")}${elapsedLabel ? ` ${elapsedLabel}` : ""}`;
  const label = [lead, ...formatWorkTraceStats(stats, t)].join(" · ");
  const header = (
    <>
      <span className="min-w-0 truncate text-foreground/65" data-chat-work-summary="">
        {label}
      </span>
      {hasDetails ? (
        <ChevronDown
          className={cn(
            "size-3 shrink-0 text-foreground/40 opacity-0 transition-[opacity,transform] duration-150",
            "group-hover/work-trace:opacity-100 group-focus-visible/work-trace:opacity-100 motion-reduce:transition-none",
            !expanded && "-rotate-90",
          )}
        />
      ) : null}
      <span aria-hidden="true" className="h-px min-w-8 flex-1 bg-foreground/10" />
    </>
  );

  return (
    <section
      className={cn("my-0 text-foreground/60", className)}
      aria-label={t("chat.work.activity")}
      aria-busy={running}
      data-chat-work-trace=""
    >
      {hasDetails ? (
        <button
          type="button"
          className={cn(
            "group/work-trace flex w-full items-center gap-2 rounded-lg py-1",
            "text-sm font-book transition-colors",
            "hover:text-foreground/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {header}
        </button>
      ) : (
        <div className="flex items-center gap-2 py-1 text-sm font-book">{header}</div>
      )}

      {hasDetails ? (
        <LazyCollapse className="[contain:layout_paint]" open={expanded}>
          {() => (
            // 行距由本容器统一负责：各行组件不再自带 pb/my，
            // 否则不同行类型会凑出不同的间隙。
            <div className="mt-1 space-y-2 [scrollbar-gutter:stable]">{children}</div>
          )}
        </LazyCollapse>
      ) : null}
      {running && hasDetails && !expanded && collapsedTail ? (
        <div className="mt-1" data-chat-work-collapsed-tail="">
          {collapsedTail}
        </div>
      ) : null}
    </section>
  );
}
