import { useEffect, useMemo, useRef, useState } from "react";

import { ChevronRight, Terminal } from "../../../../components/icons";
import { useLocale } from "../../../../i18n";
import type { ToolTraceItem } from "../../../../lib/chat/messages/uiMessages";
import { cn } from "../../../../lib/shared/utils";
import {
  getDominantToolName,
  getToolGroupComposition,
  getToolGroupCounts,
  getToolMeta,
  getToolTraceKey,
} from "./assistantBubbleUtils";
import { MemoToolCallItem } from "./ToolCallItem";

export function ToolTraceGroup(props: { items: ToolTraceItem[]; runningToolCallIds?: string[] }) {
  const { items, runningToolCallIds = [] } = props;
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
  const shouldAutoOpen = counts.failed > 0 || (counts.running > 0 && items.length <= 3);
  // Auto-collapse is state-driven, not remount-driven: the live bubble can
  // keep this instance mounted long after the burst settles, so the group
  // must fold itself once every call has a non-error result. Failed groups
  // stay open (mirroring auto-open); `waiting` keeps groups whose results
  // never landed (e.g. aborted runs) untouched.
  const shouldAutoClose = counts.running === 0 && counts.waiting === 0 && counts.failed === 0;
  const [open, setOpen] = useState(shouldAutoOpen);
  const userInteractedRef = useRef(false);

  useEffect(() => {
    if (userInteractedRef.current) return;
    if (shouldAutoOpen) {
      setOpen(true);
    } else if (shouldAutoClose) {
      setOpen(false);
    }
  }, [shouldAutoOpen, shouldAutoClose]);

  const statusLabel =
    counts.failed > 0
      ? `${counts.failed} ${t("chat.tool.failed")}`
      : counts.running > 0
        ? `${counts.running} ${t("chat.tool.running")}`
        : counts.waiting > 0
          ? `${counts.waiting} ${t("chat.tool.waiting")}`
          : t("chat.tool.success");

  const statusBgClass =
    counts.failed > 0
      ? "bg-[hsl(var(--chat-error)/0.1)] text-[hsl(var(--chat-error))]"
      : counts.running > 0
        ? "bg-[hsl(var(--chat-running)/0.1)] text-[hsl(var(--chat-running))]"
        : counts.waiting > 0
          ? "bg-black/[0.05] text-muted-foreground dark:bg-white/[0.08]"
          : "bg-[hsl(var(--chat-success)/0.1)] text-[hsl(var(--chat-success))]";

  const dotClass =
    counts.failed > 0
      ? "bg-[hsl(var(--chat-error))]"
      : counts.running > 0
        ? "bg-[hsl(var(--chat-running))] animate-pulse"
        : counts.waiting > 0
          ? "bg-zinc-400"
          : "bg-[hsl(var(--chat-success))]";

  const countLabel = `${items.length} tools`;
  const title = allBash ? "Bash Batch" : "Tool Activity";

  return (
    <div className="tool-trace-group overflow-hidden rounded-[12px] border border-black/[0.06] bg-white/[0.62] shadow-[0_1px_2px_rgba(0,0,0,0.03)] backdrop-blur-xl backdrop-saturate-[1.6] dark:border-white/[0.1] dark:bg-white/[0.055] dark:shadow-none">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? t("chat.tool.collapseActivity") : t("chat.tool.expandActivity")}
        className="grid w-full cursor-pointer select-none grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-black/[0.018] dark:hover:bg-white/[0.025]"
        onClick={() => {
          userInteractedRef.current = true;
          setOpen((prev) => !prev);
        }}
      >
        <div
          className="flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-[7px]"
          style={{
            background: `linear-gradient(135deg, hsl(${meta.accent} / 0.13), hsl(${meta.accent} / 0.06))`,
          }}
        >
          <ToolIcon className="h-3.5 w-3.5" style={{ color: `hsl(${meta.accent})` }} />
        </div>

        <div className="grid min-w-0 grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-2">
          <span className="min-w-0 truncate text-[calc(12.5px*var(--zone-font-scale,1))] font-semibold leading-5 text-foreground/90">
            {title}
          </span>
          <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-black/[0.04] px-1.5 text-[calc(10.5px*var(--zone-font-scale,1))] font-semibold leading-none text-muted-foreground/70 dark:bg-white/[0.06]">
            {countLabel}
          </span>
          {composition ? (
            <span className="inline-flex h-5 min-w-0 items-center truncate font-mono text-[calc(11px*var(--zone-font-scale,1))] leading-none text-muted-foreground/55">
              {composition}
            </span>
          ) : null}
        </div>

        <div className="flex h-5 shrink-0 items-center gap-1.5">
          <span className={cn("inline-block h-1.5 w-1.5 rounded-full", dotClass)} />
          <span
            className={cn(
              "inline-flex h-5 items-center rounded-full px-1.5 text-[calc(10px*var(--zone-font-scale,1))] font-semibold leading-none",
              statusBgClass,
            )}
          >
            {statusLabel}
          </span>
          <ChevronRight
            className={cn(
              "h-3 w-3 text-muted-foreground/35 transition-transform duration-200 ease-out",
              open ? "rotate-90" : "",
            )}
          />
        </div>
      </button>

      {open ? (
        <div className="tool-trace-group-body space-y-1.5 border-t border-black/[0.04] p-1.5 dark:border-white/[0.05]">
          {items.map((item, index) => (
            <MemoToolCallItem
              key={getToolTraceKey(item, index)}
              item={item}
              variant="grouped"
              isRunning={Boolean(item.toolCall.id && runningToolCallIds.includes(item.toolCall.id))}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
