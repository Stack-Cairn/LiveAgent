import { retainRunningToolContent } from "@liveagent/adapters/assistantBubble";
import { AssistantStatus } from "@liveagent/ui/components/chat/AssistantStatus";
import { LazyCollapse } from "@liveagent/ui/components/chat/LazyCollapse";
import { useLiveProcessDisclosure } from "@liveagent/ui/components/chat/processDisclosure";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { ToolTraceItem } from "@liveagent/ui/lib/chat/assistantBubbleAdapter";
import type { ChatFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { memo, useMemo } from "react";
import {
  AppWindow,
  Bot,
  Braces,
  Brain,
  CalendarDays,
  ChevronRight,
  Eye,
  FilePenLine,
  FolderTree,
  Globe,
  Hand,
  type IconComponent,
  RotateCcw,
  Search,
  Terminal,
  Timer,
  Waypoints,
  Wrench,
} from "../../IconSet";
import {
  getFileOperationDisplay,
  getShellSessionDisplayDetails,
  getToolActivityCategory,
  getToolTraceKey,
  hasActiveUserInteraction,
  type ToolActivityCategory,
} from "./assistantBubbleUtils";
import { getConciseToolTarget } from "./conciseToolTarget";
import { areToolTraceItemsEqual, MemoToolCallItem } from "./ToolCallItem";

function getToolGroupCounts(items: ToolTraceItem[], runningToolCallIds: string[]) {
  const runningIds = new Set(runningToolCallIds);
  let running = 0;
  let failed = 0;
  let completed = 0;
  let waiting = 0;

  for (const item of items) {
    if (item.toolCall.id && runningIds.has(item.toolCall.id)) {
      running += 1;
      continue;
    }
    if (!item.toolResult) {
      waiting += 1;
      continue;
    }
    // A shell command that exited non-zero or timed out failed even when the
    // tool call itself returned normally.
    const shellStatus = getShellSessionDisplayDetails(item.toolResult)?.status;
    if (item.toolResult.isError || shellStatus === "failed" || shellStatus === "timed_out") {
      failed += 1;
      continue;
    }
    completed += 1;
  }

  return { running, failed, completed, waiting };
}

export function getToolBatchCounts(items: ToolTraceItem[]) {
  const counts = new Map<ToolActivityCategory, number>();
  for (const item of items) {
    const category = getToolActivityCategory(item.toolCall.name);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return Array.from(counts, ([category, count]) => ({ category, count }));
}

const TOOL_BATCH_ICONS: Record<ToolActivityCategory, IconComponent> = {
  read: Eye,
  search: Search,
  edit: FilePenLine,
  command: Terminal,
  list: FolderTree,
  code: Braces,
  fetch: Globe,
  agent: Bot,
  planning: CalendarDays,
  wait: Timer,
  workflow: Waypoints,
  result: Braces,
  memory: Brain,
  context: RotateCcw,
  browser: AppWindow,
  computer: Hand,
  other: Wrench,
};

function getRunningToolActivity(item: ToolTraceItem, t: (key: string) => string) {
  const fileOperation = getFileOperationDisplay(item);
  const category = getToolActivityCategory(item.toolCall.name);
  const action = fileOperation
    ? t(`chat.tool.file.${fileOperation.kind}.running`)
    : category === "other"
      ? t("chat.tool.activity.other.running")
      : t(`chat.tool.activity.${category}.running`);
  const target = getConciseToolTarget(item);

  return {
    category,
    label: target.text ? `${action} ${target.text}` : action,
    title: target.full ? `${action} ${target.full}` : action,
  };
}

function getActiveToolCategories(items: ToolTraceItem[], runningToolCallIds: string[]) {
  const categories = new Set<ToolActivityCategory>();
  if (runningToolCallIds.length === 0) return categories;
  const runningIds = new Set(runningToolCallIds);
  for (const item of items) {
    if (item.toolCall.id && runningIds.has(item.toolCall.id)) {
      categories.add(getToolActivityCategory(item.toolCall.name));
    }
  }
  return categories;
}

function findLatestRunningTool(items: ToolTraceItem[], runningToolCallIds: string[]) {
  if (runningToolCallIds.length === 0) return null;
  const runningIds = new Set(runningToolCallIds);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.toolCall.id && runningIds.has(item.toolCall.id)) return item;
  }
  return null;
}

function ToolTraceGroupInner(props: {
  items: ToolTraceItem[];
  runningToolCallIds?: string[];
  /**
   * The batch is the trailing activity of a running turn, so the next call may
   * still join it. Together with a running call this keeps the batch live (open
   * by default); it settles once the turn moves on to reasoning or prose, or ends.
   * Gaps between consecutive calls therefore never fold and reopen the batch.
   */
  live?: boolean;
  readOnly?: boolean;
  redactToolContent?: boolean;
  onOpenFileLink?: (link: ChatFileLink) => void;
  showTurnStatus?: boolean;
}) {
  const {
    items,
    runningToolCallIds = [],
    live: trailingLive = false,
    readOnly = false,
    redactToolContent = false,
    onOpenFileLink,
    showTurnStatus = false,
  } = props;
  const { locale, t } = useLocale();
  const counts = useMemo(
    () => getToolGroupCounts(items, runningToolCallIds),
    [items, runningToolCallIds],
  );
  const batchCounts = useMemo(() => getToolBatchCounts(items), [items]);
  const activeCategories = useMemo(
    () => getActiveToolCategories(items, runningToolCallIds),
    [items, runningToolCallIds],
  );
  const attentionRequired = useMemo(
    () => hasActiveUserInteraction(items, runningToolCallIds),
    [items, runningToolCallIds],
  );
  // Open while the batch is live so its output shows as it happens; folded once
  // done. A batch with a failed call stays open when it settles so the error
  // stays in view; on history reload it mounts folded with its failed count.
  const [open, toggleOpen] = useLiveProcessDisclosure({
    live: trailingLive || counts.running > 0,
    keepOpenWhenSettled: counts.failed > 0,
    attentionRequired,
  });

  // The latest live batch drops the count prefix ("运行中" instead of
  // "1 运行中"), nothing more. Idle phases render no filler status here:
  // an active reasoning segment shows its own 思考中 row and the turn-level
  // sparkle covers the gaps in between.
  const statusLabel =
    counts.failed > 0
      ? `${counts.failed} ${t("chat.tool.failed")}`
      : counts.running > 0
        ? showTurnStatus
          ? t("chat.tool.running")
          : `${counts.running} ${t("chat.tool.running")}`
        : counts.waiting > 0
          ? `${counts.waiting} ${t("chat.tool.waiting")}`
          : t("chat.tool.success");

  // A category with a call still running reads in the present tense ("正在运行命令"),
  // and switches to the past tense once its calls are done. Calls without a result
  // that are not running belong to a settled or interrupted turn, so they read as past.
  // 中文标签之间没有天然的词边界（"读取了文件运行了命令"会黏成一句），
  // 用全角竖线分隔；全角字符自带留白，两侧不再加空格。
  const countLabel = batchCounts
    .map(({ category }) =>
      activeCategories.has(category)
        ? t(`chat.tool.batch.${category}.running`)
        : t(`chat.tool.batch.${category}`),
    )
    .join(locale === "zh-CN" ? "｜" : " | ");
  // Collapsed, the header stands in for the batch: it names the call that is running
  // and carries the batch status. Expanded, every call shows its own row with its
  // running or failed status, so the header only labels the batch; repeating the
  // running call there would show one command as two running rows. Rows carry no
  // waiting status, so the header keeps that one.
  const runningActivity = useMemo(() => {
    if (open) return null;
    const item = findLatestRunningTool(items, runningToolCallIds);
    return item ? getRunningToolActivity(item, t) : null;
  }, [items, open, runningToolCallIds, t]);
  const headerLabel = runningActivity?.label ?? countLabel;
  const showStatus = open
    ? counts.failed === 0 && counts.running === 0 && counts.waiting > 0
    : counts.failed > 0 || counts.running > 0 || counts.waiting > 0;
  const BatchIcon =
    TOOL_BATCH_ICONS[runningActivity?.category ?? batchCounts[0]?.category ?? "other"];

  return (
    <div className="group/tool-trace min-w-0 max-w-full">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? t("chat.tool.collapseActivity") : t("chat.tool.expandActivity")}
        className={cn(
          "-mx-1.5 flex w-fit max-w-bleed-0p75rem cursor-pointer select-none items-center gap-1.5",
          "rounded-lg px-1.5 py-1",
          "text-left text-sm font-[450] text-foreground/60 transition-colors duration-150 hover:bg-foreground/[0.04] hover:text-foreground/75",
        )}
        onClick={toggleOpen}
      >
        <BatchIcon className="size-3 shrink-0 text-foreground/45" />
        <span className="min-w-0 truncate" title={runningActivity?.title}>
          {headerLabel}
        </span>
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-foreground/40 opacity-0",
            "transition-[opacity,transform] duration-150 ease-out group-hover/tool-trace:opacity-100 group-focus-within/tool-trace:opacity-100",
            open ? "rotate-90" : "",
          )}
        />
        {showStatus ? (
          <span className="shrink-0 text-xs text-foreground/45">
            {showTurnStatus && counts.running > 0 ? (
              <AssistantStatus
                className="min-h-0 text-xs text-foreground/45"
                iconClassName="size-3"
              >
                {statusLabel}
              </AssistantStatus>
            ) : (
              statusLabel
            )}
          </span>
        ) : null}
      </button>

      <LazyCollapse open={open} retainWhileClosed={retainRunningToolContent && counts.running > 0}>
        {() => (
          // 横向内缩与折叠头按钮同口径（外扩量恒等于内补量），组内每行的图标
          // 才和组头图标落在同一条竖线上；12px 的外扩给行内 6px 的悬停底色和
          // 圆角留出裁剪余量。
          <div className="-mx-3 overflow-hidden px-3 pt-0.5">
            <div
              data-tool-trace-scroll=""
              className={cn(
                "-mx-3 flex max-h-400px flex-col gap-1 overflow-y-auto overscroll-contain px-3",
                "[scrollbar-gutter:stable]",
              )}
            >
              {items.map((item, index) => (
                <MemoToolCallItem
                  key={getToolTraceKey(item, index)}
                  item={item}
                  readOnly={readOnly}
                  redactToolContent={redactToolContent}
                  onOpenFileLink={onOpenFileLink}
                  compactChip
                  isRunning={Boolean(
                    item.toolCall.id && runningToolCallIds.includes(item.toolCall.id),
                  )}
                />
              ))}
            </div>
          </div>
        )}
      </LazyCollapse>
    </div>
  );
}

function areRunningIdsEqual(previous?: string[], next?: string[]) {
  if (previous === next) return true;
  if (!previous || !next || previous.length !== next.length) return false;
  return previous.every((id, index) => id === next[index]);
}

// A streaming text delta rebuilds the round's grouped-block structure with
// fresh arrays but unchanged tool items — compare element-wise so the whole
// group (every child card) bails unless a tool actually changed.
export const ToolTraceGroup = memo(
  ToolTraceGroupInner,
  (previous, next) =>
    previous.readOnly === next.readOnly &&
    previous.redactToolContent === next.redactToolContent &&
    previous.showTurnStatus === next.showTurnStatus &&
    previous.live === next.live &&
    previous.onOpenFileLink === next.onOpenFileLink &&
    previous.items.length === next.items.length &&
    previous.items.every(
      (item, index) =>
        item === next.items[index] || areToolTraceItemsEqual(item, next.items[index]),
    ) &&
    areRunningIdsEqual(previous.runningToolCallIds, next.runningToolCallIds),
);
