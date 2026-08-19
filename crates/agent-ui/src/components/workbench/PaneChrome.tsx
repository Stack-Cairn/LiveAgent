import { cn } from "../../lib/shared/utils";
import { MessageSquareText, Waypoints, X } from "../IconSet";

export type PaneChromeTrajectoryToggle = {
  /** Current view: true renders the "back to conversation" icon. */
  isTrajectory: boolean;
  /** Accessible label describing the view the click switches to. */
  label: string;
  onToggle: () => void;
};

export type PaneChromeProps = {
  paneId: string;
  /** Conversation title — exposed via tooltip/aria only, never rendered. */
  title: string;
  isFocused: boolean;
  /** Narrow-pane rendering: the grab pill shrinks so it never crowds the close dot. */
  isCompact?: boolean;
  /** Accessible labels; the chrome itself stays i18n-agnostic. */
  dragHandleLabel: string;
  closeLabel: string;
  onClose?: () => void;
  /**
   * Conversation/trajectory view switch, rendered as a top-left dot that
   * mirrors the close dot. Every conversation pane passes its own switch so
   * both edge controls share the same pane-level reveal lifecycle.
   */
  trajectoryToggle?: PaneChromeTrajectoryToggle;
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
    isCompact,
    dragHandleLabel,
    closeLabel,
    onClose,
    trajectoryToggle,
    onDragHandlePointerDown,
  } = props;

  const revealClass = cn(
    "pointer-events-auto opacity-0 transition-opacity duration-150 motion-reduce:transition-none",
    "group-hover/workbench-pane:opacity-100 focus-visible:opacity-100",
  );

  return (
    <div
      data-workbench-pane-chrome={paneId}
      data-workbench-pane-chrome-compact={isCompact ? "true" : undefined}
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
          "group/pane-grip flex h-full cursor-grab items-center justify-center",
          isCompact ? "w-12" : "w-24",
          "focus-visible:outline-none",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "h-1 rounded-full transition-all duration-150 motion-reduce:transition-none",
            isCompact ? "w-6" : "w-9",
            isFocused ? "bg-muted-foreground/45" : "bg-muted-foreground/25",
            isCompact
              ? "group-hover/pane-grip:h-[6px] group-hover/pane-grip:w-7 group-hover/pane-grip:bg-muted-foreground/60"
              : "group-hover/pane-grip:h-[6px] group-hover/pane-grip:w-11 group-hover/pane-grip:bg-muted-foreground/60",
            "group-focus-visible/pane-grip:bg-ring",
            // The pill is the drag handle's only focus indicator (the button
            // suppresses its outline), so it needs a system colour to survive
            // forced-colors modes.
            "forced-colors:bg-[CanvasText] group-focus-visible/pane-grip:forced-colors:bg-[Highlight]",
          )}
        />
      </button>
      {trajectoryToggle ? (
        <button
          type="button"
          data-workbench-pane-trajectory-toggle={paneId}
          aria-label={trajectoryToggle.label}
          aria-pressed={trajectoryToggle.isTrajectory}
          title={trajectoryToggle.label}
          onClick={trajectoryToggle.onToggle}
          className={cn(
            revealClass,
            "absolute left-1.5 top-1/2 flex h-3.5 w-3.5 -translate-y-1/2 items-center justify-center rounded-full",
            "bg-muted-foreground/25 text-background",
            "hover:bg-muted-foreground/55 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
        >
          {/* Icon previews the view the click switches to, not the current one. */}
          {trajectoryToggle.isTrajectory ? (
            <MessageSquareText className="h-2 w-2" />
          ) : (
            <Waypoints className="h-2 w-2" />
          )}
        </button>
      ) : null}
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
