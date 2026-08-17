import {
  decodeWorkbenchLayout,
  isWorkbenchLayoutValid,
  type WorkbenchLayout,
} from "@liveagent/ui/lib/workbench/index";

export const WORKBENCH_LAYOUT_STORAGE_KEY = "liveagent.sessionWorkbench.layout.v1";

export function readWorkbenchLayoutCrashShadow(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(WORKBENCH_LAYOUT_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function readRestorableWorkbenchLayoutCrashShadow(): WorkbenchLayout | null {
  const raw = readWorkbenchLayoutCrashShadow();
  if (!raw) return null;
  const decoded = decodeWorkbenchLayout(raw);
  if (
    !decoded.ok ||
    !decoded.layout.root ||
    !decoded.layout.focusedPaneId ||
    Object.keys(decoded.layout.panes).length < 2 ||
    !isWorkbenchLayoutValid(decoded.layout)
  ) {
    return null;
  }
  return decoded.layout;
}
