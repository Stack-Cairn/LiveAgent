/**
 * 账本单行。
 *
 * 一行一条记录：角色徽标 + 摘要 + 工具结果 + 自身耗时。溢出交给 CSS 省略，
 * 完整内容在详情面板里看。
 */

import { useLocale } from "../../i18n/index";
import { cn } from "../../lib/shared/utils";
import {
  formatTrajectorySeconds,
  trajectoryFallbackLabelKey,
  trajectoryKindLabelKey,
} from "../../lib/trajectory/presentation";
import type { TrajectoryRecord, TrajectoryRecordKind } from "../../lib/trajectory/types";

const KIND_BADGE: Record<TrajectoryRecordKind, string> = {
  system: "bg-slate-500/15 text-slate-600 dark:text-slate-300",
  user: "bg-blue-500/15 text-blue-600 dark:text-blue-300",
  context: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
  compacted: "bg-amber-500/15 text-amber-600 dark:text-amber-300",
  message: "bg-violet-500/15 text-violet-600 dark:text-violet-300",
  tool: "bg-orange-500/15 text-orange-600 dark:text-orange-300",
  subtool: "bg-orange-500/10 text-orange-600/80 dark:text-orange-300/80",
};

export function TrajectoryRow(props: {
  record: TrajectoryRecord;
  selected: boolean;
  focused: boolean;
  dimmed: boolean;
  onSelect: (index: number) => void;
}) {
  const { t, locale } = useLocale();
  const { record } = props;
  const fallbackKey = trajectoryFallbackLabelKey(record);
  const label = fallbackKey === undefined ? record.text : t(fallbackKey);

  return (
    <button
      type="button"
      data-trajectory-index={record.index}
      aria-current={props.selected ? "true" : undefined}
      onClick={() => props.onSelect(record.index)}
      className={cn(
        "flex h-[30px] w-full min-w-0 items-center gap-2 px-3 text-left text-[12px] transition-colors @max-[520px]:gap-1.5 @max-[520px]:px-2",
        "border-l-2 border-transparent hover:bg-muted/50",
        props.selected && "border-primary bg-muted/70",
        props.focused && !props.selected && "bg-muted/40",
        props.dimmed && "opacity-35",
        record.kind === "subtool" && "pl-8 @max-[520px]:pl-5",
      )}
    >
      <span
        className={cn(
          "shrink-0 rounded px-1.5 py-px font-medium text-[10px] tracking-wide",
          record.isError ? "bg-red-500/15 text-red-600 dark:text-red-300" : KIND_BADGE[record.kind],
        )}
      >
        {t(trajectoryKindLabelKey(record.kind))}
      </span>

      <span className="min-w-0 flex-1 truncate text-foreground/90">
        {record.toolName !== undefined && record.kind !== "message" && (
          <span className="font-medium">{record.toolName}</span>
        )}
        {record.toolName !== undefined && label !== record.toolName && label !== "" && (
          <span className="ml-1.5 text-muted-foreground">{label}</span>
        )}
        {record.toolName === undefined && label}
      </span>

      {record.result !== undefined && record.result !== "" && (
        <span className="hidden min-w-0 max-w-[38%] shrink-0 truncate text-muted-foreground md:inline">
          <span aria-hidden="true" className="mr-1">
            →
          </span>
          {record.result}
        </span>
      )}

      {record.status === "running" && (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {t("trajectory.status.running")}
        </span>
      )}

      <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground @max-[520px]:w-12 @max-[520px]:text-[11px]">
        {record.timeSeconds === null ? "" : formatTrajectorySeconds(record.timeSeconds, locale)}
      </span>
    </button>
  );
}
