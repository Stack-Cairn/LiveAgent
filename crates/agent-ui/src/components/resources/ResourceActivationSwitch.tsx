import type { MouseEvent } from "react";
import { cn } from "@liveagent/ui/lib/shared/utils";

export function ResourceActivationSwitch(props: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  compact?: boolean;
  stopPropagation?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const compact = props.compact === true;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        if (props.stopPropagation) event.stopPropagation();
        props.onCheckedChange(!props.checked);
      }}
      onKeyDown={(event) => {
        if (props.stopPropagation) event.stopPropagation();
      }}
      className={cn(
        "relative inline-flex shrink-0 items-center rounded-full ring-1 transition-all",
        "disabled:cursor-not-allowed disabled:opacity-45",
        compact ? "h-5 w-9" : "h-6 w-11",
        props.checked
          ? "bg-emerald-500 ring-emerald-400/45 shadow-[0_2px_10px_-3px_rgba(16,185,129,0.65)] dark:bg-emerald-400"
          : "bg-muted-foreground/25 ring-border/40",
      )}
    >
      <span
        className={cn(
          "pointer-events-none inline-block rounded-full bg-white shadow-sm transition-transform",
          compact ? "h-3.5 w-3.5" : "h-[18px] w-[18px]",
          props.checked
            ? compact
              ? "translate-x-[1.05rem]"
              : "translate-x-[23px]"
            : compact
              ? "translate-x-[0.15rem]"
              : "translate-x-[3px]",
        )}
      />
    </button>
  );
}
