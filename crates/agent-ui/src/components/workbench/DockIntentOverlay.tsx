import type { WorkbenchRect } from "../../lib/workbench/geometry";

export type DockIntentOverlayProps = {
  /** Final rect the drop would produce, in canvas coordinates. */
  rect: WorkbenchRect;
  /** Action text, e.g. "Open on the right". */
  label?: string;
};

/**
 * Drop preview shown only while a workbench drag is active. Pure overlay:
 * never intercepts pointer events and never affects layout.
 */
export function DockIntentOverlay(props: DockIntentOverlayProps) {
  const { rect, label } = props;
  return (
    <div
      data-workbench-drop-preview=""
      aria-hidden="true"
      className="pointer-events-none absolute z-20 flex items-center justify-center rounded-lg border border-primary/50 bg-primary/[0.08] shadow-[inset_0_0_0_1px_var(--color-background)]"
      style={{
        left: rect.left + 3,
        top: rect.top + 3,
        width: Math.max(0, rect.width - 6),
        height: Math.max(0, rect.height - 6),
      }}
    >
      {label ? (
        <span className="max-w-[80%] truncate rounded-full border border-border/60 bg-background/95 px-3 py-1 text-xs font-medium text-foreground shadow-md">
          {label}
        </span>
      ) : null}
    </div>
  );
}
