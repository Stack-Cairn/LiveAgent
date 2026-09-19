import { SwitchRoot, SwitchThumb } from "@liveagent/ui/components/ui/switch";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { type SyntheticEvent, useRef } from "react";

export function ResourceActivationSwitch(props: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  compact?: boolean;
  stopPropagation?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const compact = props.compact === true;
  const stopEventPropagation = (event: SyntheticEvent) => {
    if (props.stopPropagation) event.stopPropagation();
  };

  return (
    // The primitive dispatches a second click from its hidden input. Keep that
    // internal event out of cards while preserving the visible button's policy.
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard activation is handled by the inner native switch
    // biome-ignore lint/a11y/noStaticElementInteractions: noninteractive event boundary, not an action target
    <span
      className="contents"
      onClick={(event) => {
        if (event.target === inputRef.current) event.stopPropagation();
      }}
    >
      <SwitchRoot
        inputRef={inputRef}
        nativeButton
        render={<button type="button" />}
        checked={props.checked}
        aria-label={props.label}
        title={props.label}
        disabled={props.disabled}
        onPointerDown={stopEventPropagation}
        onMouseDown={stopEventPropagation}
        onClick={(event) => {
          stopEventPropagation(event);
        }}
        onCheckedChange={props.onCheckedChange}
        onKeyDown={stopEventPropagation}
        className={cn(
          "relative inline-flex shrink-0 items-center rounded-full ring-1 ring-border/40 transition-all",
          "disabled:cursor-not-allowed disabled:opacity-45",
          compact ? "h-5 w-9" : "h-6 w-11",
          props.checked ? "bg-sky-500 dark:bg-sky-400" : "bg-muted-foreground/25",
        )}
      >
        <SwitchThumb
          className={cn(
            "pointer-events-none inline-block rounded-full bg-white shadow-sm transition-transform",
            compact ? "size-3.5" : "size-18px",
            props.checked
              ? compact
                ? "translate-x-4.75"
                : "translate-x-23px"
              : compact
                ? "translate-x-0.75"
                : "translate-x-3px",
          )}
        />
      </SwitchRoot>
    </span>
  );
}
