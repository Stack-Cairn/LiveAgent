import { retainRunningToolContent } from "@liveagent/adapters/assistantBubble";
import { AssistantStatus } from "@liveagent/ui/components/chat/AssistantStatus";
import { LazyCollapse } from "@liveagent/ui/components/chat/LazyCollapse";
import { useAttentionDisclosure } from "@liveagent/ui/components/chat/useAttentionDisclosure";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { ToolTraceItem } from "@liveagent/ui/lib/chat/assistantBubbleAdapter";
import type { ChatFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { memo, useMemo } from "react";
import {
  Bot,
  ChevronRight,
  Eye,
  FilePenLine,
  FolderTree,
  type IconComponent,
  Search,
  Terminal,
  Wrench,
} from "../../IconSet";
import {
  compactInlineText,
  getFileOperationDisplay,
  getToolActivityCategory,
  getToolDisplayName,
  getToolTraceKey,
  hasActiveUserInteraction,
  type ToolActivityCategory,
} from "./assistantBubbleUtils";
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
    if (item.toolResult.isError) {
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
  agent: Bot,
  other: Wrench,
};

function stringArgument(item: ToolTraceItem, ...keys: string[]): string {
  const args = item.toolCall.arguments || {};
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function getRunningToolTarget(item: ToolTraceItem) {
  const fileOperation = getFileOperationDisplay(item);
  if (fileOperation) return fileOperation.fileName;

  const name = getToolDisplayName(item.toolCall.name);
  const target =
    name === "Bash"
      ? stringArgument(item, "command").split("\n")[0]
      : name === "Glob" || name === "Grep"
        ? stringArgument(item, "pattern", "query", "path")
        : name === "ToolSearch"
          ? stringArgument(item, "query", "pattern", "name")
          : name === "List"
            ? stringArgument(item, "path") || "."
            : name === "Agent"
              ? stringArgument(item, "name", "id", "prompt")
              : name === "SendMessage"
                ? stringArgument(item, "to", "channel", "subject")
                : stringArgument(item, "path", "label", "name", "query", "action", "command");

  return compactInlineText(target, 112);
}

function getRunningToolActivity(item: ToolTraceItem, t: (key: string) => string) {
  const fileOperation = getFileOperationDisplay(item);
  const category = getToolActivityCategory(item.toolCall.name);
  const action = fileOperation
    ? t(`chat.tool.file.${fileOperation.kind}.running`)
    : category === "other"
      ? t("chat.tool.activity.other.running")
      : t(`chat.tool.activity.${category}.running`);
  const target = getRunningToolTarget(item);

  return {
    category,
    label: target ? `${action} ${target}` : action,
  };
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
  readOnly?: boolean;
  redactToolContent?: boolean;
  onOpenFileLink?: (link: ChatFileLink) => void;
  showTurnStatus?: boolean;
}) {
  const {
    items,
    runningToolCallIds = [],
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
  const attentionRequired = useMemo(
    () => hasActiveUserInteraction(items, runningToolCallIds),
    [items, runningToolCallIds],
  );
  const [open, setOpen] = useAttentionDisclosure(attentionRequired);

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

  // 中文标签之间没有天然的词边界（"读取了文件运行了命令"会黏成一句），
  // 用全角竖线分隔；全角字符自带留白，两侧不再加空格。
  const countLabel = batchCounts
    .map(({ category }) => t(`chat.tool.batch.${category}`))
    .join(locale === "zh-CN" ? "｜" : " | ");
  const runningActivity = useMemo(() => {
    const item = findLatestRunningTool(items, runningToolCallIds);
    return item ? getRunningToolActivity(item, t) : null;
  }, [items, runningToolCallIds, t]);
  const headerLabel = runningActivity?.label ?? countLabel;
  const showStatus = counts.failed > 0 || counts.running > 0 || counts.waiting > 0;
  const BatchIcon =
    TOOL_BATCH_ICONS[runningActivity?.category ?? batchCounts[0]?.category ?? "other"];

  return (
    <div className="group/tool-trace min-w-0 max-w-full pb-1">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? t("chat.tool.collapseActivity") : t("chat.tool.expandActivity")}
        className="-mx-1.5 flex w-fit max-w-[calc(100%+0.75rem)] cursor-pointer select-none items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-[calc(13px*var(--zone-font-scale,1))] font-[450] text-foreground/60 transition-colors duration-150 hover:bg-foreground/[0.035] hover:text-foreground/75"
        onClick={() => setOpen((prev) => !prev)}
      >
        <BatchIcon className="h-3 w-3 shrink-0 text-foreground/45" />
        <span className="min-w-0 truncate">{headerLabel}</span>
        <ChevronRight
          className={cn(
            "h-3 w-3 shrink-0 text-foreground/40 opacity-0 transition-[opacity,transform] duration-150 ease-out group-hover/tool-trace:opacity-100 group-focus-within/tool-trace:opacity-100",
            open ? "rotate-90" : "",
          )}
        />
        {showStatus ? (
          <span className="shrink-0 text-[calc(11px*var(--zone-font-scale,1))] text-foreground/45">
            {showTurnStatus && counts.running > 0 ? (
              <AssistantStatus className="min-h-0 text-[calc(11px*var(--zone-font-scale,1))] text-foreground/45">
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
          // 横向内缩与折叠头按钮同口径（-mx-1.5 / px-1.5），组内每行的图标
          // 才和组头图标落在同一条竖线上。
          <div className="-mx-1.5 overflow-hidden px-1.5 pt-0.5">
            <div
              data-tool-trace-scroll=""
              className="flex max-h-[400px] flex-col gap-1 overflow-y-auto overscroll-contain pr-1 [scrollbar-gutter:stable]"
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
    previous.onOpenFileLink === next.onOpenFileLink &&
    previous.items.length === next.items.length &&
    previous.items.every(
      (item, index) =>
        item === next.items[index] || areToolTraceItemsEqual(item, next.items[index]),
    ) &&
    areRunningIdsEqual(previous.runningToolCallIds, next.runningToolCallIds),
);
