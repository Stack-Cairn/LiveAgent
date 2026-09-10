import { cn } from "@liveagent/ui/lib/shared/utils";
import type { SyntheticEvent } from "react";

export function ResourceActivationSwitch(props: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  compact?: boolean;
  stopPropagation?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const compact = props.compact === true;
  const stopEventPropagation = (event: SyntheticEvent) => {
    if (props.stopPropagation) event.stopPropagation();
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onPointerDown={stopEventPropagation}
      onMouseDown={stopEventPropagation}
      onClick={(event) => {
        stopEventPropagation(event);
        props.onCheckedChange(!props.checked);
      }}
      onKeyDown={stopEventPropagation}
      className={cn(
        "relative inline-flex shrink-0 items-center rounded-full ring-1 transition-all",
        "disabled:cursor-not-allowed disabled:opacity-45",
        compact ? "h-5 w-9" : "h-6 w-11",
        props.checked
          ? "bg-emerald-500 ring-emerald-400/45 shadow-ui-resourceactivationswitch-32 dark:bg-emerald-400"
          : "bg-muted-foreground/25 ring-border/40",
      )}
    >
      <span
        className={cn(
          "pointer-events-none inline-block rounded-full bg-white shadow-sm transition-transform",
          compact ? "size-3.5" : "size-18px",
          props.checked
            ? compact
              ? "translate-x-1p05rem"
              : "translate-x-23px"
            : compact
              ? "translate-x-0p15rem"
              : "translate-x-3px",
        )}
      />
    </button>
  );
}
