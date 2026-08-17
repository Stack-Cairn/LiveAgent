import { cn } from "../../lib/shared/utils";
import { X } from "../IconSet";

export type PaneChromeProps = {
  paneId: string;
  /** Conversation title — exposed via tooltip/aria only, never rendered. */
  title: string;
  isFocused: boolean;
  /** Accessible labels; the chrome itself stays i18n-agnostic. */
  dragHandleLabel: string;
  closeLabel: string;
  onClose?: () => void;
  /** Arms a workbench pane drag; activation happens after a move threshold. */
  onDragHandlePointerDown?: (event: React.PointerEvent<HTMLButtonElement>) => void;
};

/**
 * Minimal pane strip rendered as a fully transparent overlay: a centered grab
 * pill and a close dot, both hidden until the pane is hovered (or the pill is
 * keyboard-focused). The pill grows slightly on hover. This is pane chrome,
 * not app chrome — it must never be marked as a native window drag region,
 * otherwise pane drags would move the window instead.
 */
export function PaneChrome(props: PaneChromeProps) {
  const {
    paneId,
    title,
    isFocused,
    dragHandleLabel,
    closeLabel,
    onClose,
    onDragHandlePointerDown,
  } = props;

  const revealClass = cn(
    "pointer-events-auto opacity-0 transition-opacity duration-150 motion-reduce:transition-none",
    "group-hover/workbench-pane:opacity-100 focus-visible:opacity-100",
  );

  return (
    <div
      data-workbench-pane-chrome={paneId}
      className="pointer-events-none absolute inset-x-0 top-0 z-30 flex h-5 items-center justify-center"
    >
      <button
        type="button"
        data-workbench-pane-drag-handle={paneId}
        aria-label={dragHandleLabel}
        title={title || dragHandleLabel}
        onPointerDown={onDragHandlePointerDown}
        className={cn(
          revealClass,
          "group/pane-grip flex h-full w-24 cursor-grab items-center justify-center",
          "focus-visible:outline-none",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "h-1 w-9 rounded-full transition-all duration-150 motion-reduce:transition-none",
            isFocused ? "bg-muted-foreground/45" : "bg-muted-foreground/25",
            "group-hover/pane-grip:h-[6px] group-hover/pane-grip:w-11 group-hover/pane-grip:bg-muted-foreground/60",
            "group-focus-visible/pane-grip:bg-ring",
            // The pill is the drag handle's only focus indicator (the button
            // suppresses its outline), so it needs a system colour to survive
            // forced-colors modes.
            "forced-colors:bg-[CanvasText] group-focus-visible/pane-grip:forced-colors:bg-[Highlight]",
          )}
        />
      </button>
      {onClose ? (
        <button
          type="button"
          data-workbench-pane-close={paneId}
          aria-label={closeLabel}
          title={closeLabel}
          onClick={onClose}
          className={cn(
            revealClass,
            "absolute right-1.5 top-1/2 flex h-3.5 w-3.5 -translate-y-1/2 items-center justify-center rounded-full",
            "bg-muted-foreground/25 text-background",
            "hover:bg-muted-foreground/55 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
        >
          <X className="h-2 w-2" />
        </button>
      ) : null}
    </div>
  );
}
