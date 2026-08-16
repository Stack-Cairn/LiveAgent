import type { ReactNode } from "react";
import { cn } from "../../lib/shared/utils";
import type { WorkbenchRect } from "../../lib/workbench/geometry";

export type PaneFrameProps = {
  paneId: string;
  rect: WorkbenchRect;
  isFocused: boolean;
  /**
   * Single-pane rendering: no chrome, no background, no focus ring — the
   * frame must be visually indistinguishable from the legacy conversation
   * page.
   */
  chromeless?: boolean;
  regionLabel: string;
  /** Focus the pane on pointer-down anywhere inside the frame. */
  onFocusRequest?: () => void;
  chrome?: ReactNode;
  children: ReactNode;
};

/**
 * Stable absolutely-positioned pane container. The rect updates in place —
 * the frame (and its children) never remounts on move or resize, which keeps
 * conversation DOM, drafts, scroll and streams alive.
 *
 * Chrome is a transparent overlay on top of the content (revealed on pane
 * hover via the `workbench-pane` group), so panes carry no reserved title
 * band and no borders.
 */
export function PaneFrame(props: PaneFrameProps) {
  const { paneId, rect, isFocused, chromeless, regionLabel, onFocusRequest, chrome, children } =
    props;
  return (
    <section
      data-workbench-pane={paneId}
      data-workbench-pane-focused={isFocused ? "true" : undefined}
      aria-label={regionLabel}
      onPointerDownCapture={onFocusRequest}
      className={cn(
        "group/workbench-pane absolute flex min-h-0 min-w-0 flex-col overflow-hidden",
        !chromeless && "bg-background",
      )}
      style={{
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      }}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
      {chromeless ? null : chrome}
    </section>
  );
}
