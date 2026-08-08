import { AssistantStatus } from "@liveagent/ui/components/chat/AssistantStatus";
import { LazyCollapse } from "@liveagent/ui/components/chat/LazyCollapse";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { memo, useMemo, useState } from "react";
import { ChevronRight, Terminal } from "../../../../components/icons";
import type { ToolTraceItem } from "../../../../lib/chat/messages/uiMessages";
import {
  getDominantToolName,
  getToolGroupComposition,
  getToolGroupCounts,
  getToolMeta,
  getToolTraceKey,
} from "./assistantBubbleUtils";
import { areToolTraceItemsEqual, MemoToolCallItem } from "./ToolCallItem";

function ToolTraceGroupInner(props: {
  items: ToolTraceItem[];
  runningToolCallIds?: string[];
  isAborted?: boolean;
}) {
  const { items, runningToolCallIds = [], isAborted = false } = props;
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

  if (items.length === 1) {
    const item = items[0];
    return item ? (
      <MemoToolCallItem
        item={item}
        isAborted={isAborted}
        isRunning={Boolean(item.toolCall.id && runningToolCallIds.includes(item.toolCall.id))}
      />
    ) : null;
  }

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

      <LazyCollapse open={open} retainWhileClosed={counts.running > 0}>
        {() => (
          <div className="space-y-0.5 pb-2 pl-[22px] pt-1">
            {items.map((item, index) => (
              <MemoToolCallItem
                key={getToolTraceKey(item, index)}
                item={item}
                isAborted={isAborted}
                isRunning={Boolean(
                  item.toolCall.id && runningToolCallIds.includes(item.toolCall.id),
                )}
              />
            ))}
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
    previous.items.length === next.items.length &&
    previous.items.every(
      (item, index) =>
        item === next.items[index] || areToolTraceItemsEqual(item, next.items[index]),
    ) &&
    previous.isAborted === next.isAborted &&
    areRunningIdsEqual(previous.runningToolCallIds, next.runningToolCallIds),
);
