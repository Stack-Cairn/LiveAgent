export type WorkbenchDragWindowListeners = {
  onPointerMove: (event: PointerEvent) => void;
  onPointerUp: (event: PointerEvent) => void;
  onPointerCancel: () => void;
  onBlur: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
};

/**
 * Install the window-level adapter for a pointer-driven workbench drag.
 *
 * Pointer move/up/cancel deliberately run in the capture phase. Right Dock
 * terminal tabs live below menu and terminal widgets which may stop bubbling
 * pointer events; a bubble-only window listener therefore leaves the drag
 * armed or previewing without ever committing the pane. Capturing at the
 * window boundary observes the gesture before any nested widget can consume
 * it, while pointerId filtering remains owned by the drag session itself.
 */
export function installWorkbenchDragWindowListeners(
  target: Window,
  listeners: WorkbenchDragWindowListeners,
): () => void {
  target.addEventListener("pointermove", listeners.onPointerMove, true);
  target.addEventListener("pointerup", listeners.onPointerUp, true);
  target.addEventListener("pointercancel", listeners.onPointerCancel, true);
  target.addEventListener("blur", listeners.onBlur);
  target.addEventListener("keydown", listeners.onKeyDown, true);

  return () => {
    target.removeEventListener("pointermove", listeners.onPointerMove, true);
    target.removeEventListener("pointerup", listeners.onPointerUp, true);
    target.removeEventListener("pointercancel", listeners.onPointerCancel, true);
    target.removeEventListener("blur", listeners.onBlur);
    target.removeEventListener("keydown", listeners.onKeyDown, true);
  };
}
