import { memo, useMemo, useState } from "react";
import { ChevronRight, Terminal } from "../../../components/icons";
import { useLocale } from "../../../i18n";
import type { ToolTraceItem } from "../../../lib/chat/uiMessages";
import { cn } from "../../../lib/shared/utils";
import { getToolDisplayName, getToolMeta, getToolTraceKey } from "./assistantBubbleUtils";
import { AssistantStatus } from "./StatusText";
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

function getToolGroupComposition(items: ToolTraceItem[]) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const name = getToolDisplayName(item.toolCall.name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([name, count]) => `${name} ${count}`)
    .join(" · ");
}

function getDominantToolName(items: ToolTraceItem[]) {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.toolCall.name, (counts.get(item.toolCall.name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Tool";
}

function ToolTraceGroupInner(props: {
  items: ToolTraceItem[];
  runningToolCallIds?: string[];
  readOnly?: boolean;
  redactToolContent?: boolean;
}) {
  const { items, runningToolCallIds = [], readOnly = false, redactToolContent = false } = props;
  const { t } = useLocale();
  const counts = useMemo(
    () => getToolGroupCounts(items, runningToolCallIds),
    [items, runningToolCallIds],
  );
  const composition = useMemo(() => getToolGroupComposition(items), [items]);
  const dominantToolName = useMemo(() => getDominantToolName(items), [items]);
  const allBash = useMemo(() => items.every((item) => item.toolCall.name === "Bash"), [items]);
  const meta = useMemo(
    () => (allBash ? getToolMeta("Bash") : getToolMeta(dominantToolName)),
    [allBash, dominantToolName],
  );
  const ToolIcon = allBash ? Terminal : meta.Icon;
  const [open, setOpen] = useState(false);

  const statusLabel =
    counts.failed > 0
      ? `${counts.failed} ${t("chat.tool.failed")}`
      : counts.running > 0
        ? `${counts.running} ${t("chat.tool.running")}`
        : counts.waiting > 0
          ? `${counts.waiting} ${t("chat.tool.waiting")}`
          : t("chat.tool.success");

  const statusTextClass =
    counts.failed > 0 ? "text-[hsl(var(--chat-error))]" : "text-muted-foreground/60";

  const countLabel = `${items.length} tools`;
  const title = allBash ? "Bash Batch" : "Tool Activity";

  return (
    <div className="group/tool-trace min-w-0 max-w-full">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? t("chat.tool.collapseActivity") : t("chat.tool.expandActivity")}
        className="grid w-full cursor-pointer select-none grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 py-1.5 text-left"
        onClick={() => setOpen((prev) => !prev)}
      >
        <ToolIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 group-hover/tool-trace:text-foreground/75" />

        <div className="min-w-0 truncate text-[calc(11px*var(--zone-font-scale,1))] leading-5 text-muted-foreground/55">
          <span className="font-sans text-[calc(13px*var(--zone-font-scale,1))] font-normal text-muted-foreground/80 group-hover/tool-trace:text-foreground">
            {title}
          </span>
          <span className="ml-2">{countLabel}</span>
          {composition ? <span className="ml-2 font-mono">{composition}</span> : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {counts.running > 0 ? (
            <AssistantStatus
              className="min-h-0 gap-1.5 text-[calc(11px*var(--zone-font-scale,1))] text-muted-foreground/60"
              iconClassName="h-3 w-3"
            >
              {statusLabel}
            </AssistantStatus>
          ) : (
            <span className={cn("text-[calc(11px*var(--zone-font-scale,1))]", statusTextClass)}>
              {statusLabel}
            </span>
          )}
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 text-muted-foreground/60 transition-transform duration-200 ease-out",
              open ? "rotate-90" : "",
            )}
          />
        </div>
      </button>

      <div
        aria-hidden={!open}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
          open ? "grid-rows-[1fr] opacity-100" : "pointer-events-none grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="space-y-0.5 pb-2 pl-[22px] pt-1">
            {items.map((item, index) => (
              <MemoToolCallItem
                key={getToolTraceKey(item, index)}
                item={item}
                readOnly={readOnly}
                redactToolContent={redactToolContent}
                isRunning={Boolean(
                  item.toolCall.id && runningToolCallIds.includes(item.toolCall.id),
                )}
              />
            ))}
          </div>
        </div>
      </div>
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
    previous.items.length === next.items.length &&
    previous.items.every(
      (item, index) =>
        item === next.items[index] || areToolTraceItemsEqual(item, next.items[index]),
    ) &&
    areRunningIdsEqual(previous.runningToolCallIds, next.runningToolCallIds),
);
