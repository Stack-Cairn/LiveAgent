import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";

function syncTaskbarActivity(count: number) {
  invoke("taskbar_set_activity", { count }).catch(() => {
    // Desktop indicator failures must never break the chat flow.
  });
}

/**
 * Mirrors the number of running conversations onto the desktop shell:
 * Windows tints the taskbar icon and overlays a count badge, macOS shows
 * the native Dock badge. Cleared on unmount so no stale badge survives.
 */
export function useTaskbarActivity(runningCount: number) {
  useEffect(() => {
    syncTaskbarActivity(runningCount);
  }, [runningCount]);

  useEffect(
    () => () => {
      syncTaskbarActivity(0);
    },
    [],
  );
}
