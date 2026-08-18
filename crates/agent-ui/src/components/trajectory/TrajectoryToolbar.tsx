/**
 * 轨迹工具栏：投影切换、整表折叠、实时搜索。
 */

import { useLocale } from "../../i18n/index";
import { cn } from "../../lib/shared/utils";
import { Search } from "../IconSet";

export function TrajectoryToolbar(props: {
  /** 是否按真实耗时排布；账本无时间时强制为 false。 */
  actualDuration: boolean;
  /** 账本是否带时间；false 时 Duration 不可用。 */
  hasTiming: boolean;
  onActualDurationChange: (next: boolean) => void;
  allTurnsCollapsed: boolean;
  onToggleAllTurns: () => void;
  allCallsCollapsed: boolean;
  onToggleAllCalls: () => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
}) {
  const { t } = useLocale();
  const durationTitle = !props.hasTiming
    ? t("trajectory.toolbar.durationUnavailable")
    : props.actualDuration
      ? t("trajectory.toolbar.useEqualWidth")
      : t("trajectory.toolbar.useActualDuration");

  return (
    <div
      role="toolbar"
      aria-label={t("trajectory.toolbar.aria")}
      className="flex shrink-0 items-center gap-1 border-b border-border/60 px-3 py-1.5 max-[520px]:flex-wrap max-[520px]:gap-y-1.5 max-[520px]:px-2"
    >
      <ToolbarButton
        pressed={props.actualDuration}
        disabled={!props.hasTiming}
        title={durationTitle}
        onClick={() => props.onActualDurationChange(!props.actualDuration)}
      >
        <ClockGlyph />
        {t("trajectory.toolbar.duration")}
      </ToolbarButton>

      <ToolbarButton
        pressed={props.allTurnsCollapsed}
        title={
          props.allTurnsCollapsed
            ? t("trajectory.toolbar.expandTurns")
            : t("trajectory.toolbar.collapseTurns")
        }
        onClick={props.onToggleAllTurns}
      >
        <FoldGlyph collapsed={props.allTurnsCollapsed} />
        {t("trajectory.toolbar.turns")}
      </ToolbarButton>

      <ToolbarButton
        pressed={props.allCallsCollapsed}
        title={
          props.allCallsCollapsed
            ? t("trajectory.toolbar.expandCalls")
            : t("trajectory.toolbar.collapseCalls")
        }
        onClick={props.onToggleAllCalls}
      >
        <FoldGlyph collapsed={props.allCallsCollapsed} />
        {t("trajectory.toolbar.calls")}
      </ToolbarButton>

      <div className="ml-auto flex min-w-0 items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 focus-within:border-primary/60 max-[520px]:order-last max-[520px]:ml-0 max-[520px]:w-full">
        <Search className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          type="search"
          aria-label={t("trajectory.toolbar.search")}
          placeholder={t("trajectory.toolbar.searchPlaceholder")}
          value={props.searchQuery}
          onChange={(event) => props.onSearchQueryChange(event.currentTarget.value)}
          className="w-40 min-w-0 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground max-[520px]:w-full"
        />
      </div>
    </div>
  );
}

function ToolbarButton(props: {
  pressed: boolean;
  disabled?: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.pressed}
      aria-label={props.title}
      title={props.title}
      disabled={props.disabled === true}
      onClick={props.onClick}
      className={cn(
        "flex items-center gap-1 rounded-md px-2 py-1 text-[12px] transition-colors max-[520px]:flex-1 max-[520px]:justify-center",
        "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        props.pressed && "bg-muted text-foreground",
        props.disabled === true && "pointer-events-none opacity-40",
      )}
    >
      {props.children}
    </button>
  );
}

function ClockGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="5.25" />
      <path d="M8 4.75V8l2.25 1.5" />
    </svg>
  );
}

function FoldGlyph(props: { collapsed: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M5 8h6" />
      {props.collapsed && <path d="M8 5v6" />}
    </svg>
  );
}
