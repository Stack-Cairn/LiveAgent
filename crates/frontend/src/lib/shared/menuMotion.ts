import { useEffect, useState } from "react";

// Must match the .editor-context-menu-exit animation duration in index.css.
export const MENU_EXIT_MS = 120;

/**
 * Presence driver for hand-rolled context menus that keep their open state as
 * a nullable position snapshot. Clearing the snapshot no longer unmounts the
 * menu instantly: the last snapshot is retained while the exit animation
 * plays (`isExiting`), then released. Re-opening mid-exit swaps the retained
 * snapshot in place, which restarts the enter animation (the animation-name
 * change cancels the exit animation and replays the enter one).
 */
export function useMenuExitPresence<T>(snapshot: T | null): {
  rendered: T | null;
  isExiting: boolean;
} {
  const [retained, setRetained] = useState<T | null>(snapshot);
  // Derived-state adjustment during render (idempotent, StrictMode-safe) so a
  // fresh open — and every position clamp while open — paints on the same
  // commit with no effect-lag frame.
  if (snapshot !== null && snapshot !== retained) {
    setRetained(snapshot);
  }

  const isExiting = snapshot === null && retained !== null;

  useEffect(() => {
    if (!isExiting) return;
    const timer = window.setTimeout(() => {
      setRetained(null);
    }, MENU_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [isExiting]);

  return { rendered: snapshot ?? retained, isExiting };
}
