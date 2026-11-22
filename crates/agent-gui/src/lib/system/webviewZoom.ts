import { isTauri } from "@liveagent/app/shims/tauriCore";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Whole-window zoom of the desktop webview. The factor is a device preference
 * (localStorage, not synced settings) and is re-applied when the app starts.
 */
export const WEBVIEW_ZOOM_STORAGE_KEY = "liveagent.webviewZoom.v1";
export const WEBVIEW_ZOOM_LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;
export const DEFAULT_WEBVIEW_ZOOM = 1;

const MIN_ZOOM = WEBVIEW_ZOOM_LEVELS[0];
const MAX_ZOOM = WEBVIEW_ZOOM_LEVELS[WEBVIEW_ZOOM_LEVELS.length - 1];

export function clampWebviewZoom(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_WEBVIEW_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(numeric * 100) / 100));
}

/** The next preset in `direction`; a factor between presets snaps to the neighbour. */
export function stepWebviewZoom(current: number, direction: 1 | -1): number {
  const value = clampWebviewZoom(current);
  if (direction > 0) return WEBVIEW_ZOOM_LEVELS.find((level) => level > value + 0.001) ?? MAX_ZOOM;
  return [...WEBVIEW_ZOOM_LEVELS].reverse().find((level) => level < value - 0.001) ?? MIN_ZOOM;
}

export function readStoredWebviewZoom(storage: Pick<Storage, "getItem"> | null = safeStorage()) {
  try {
    const raw = storage?.getItem(WEBVIEW_ZOOM_STORAGE_KEY);
    return raw == null ? DEFAULT_WEBVIEW_ZOOM : clampWebviewZoom(Number(raw));
  } catch {
    return DEFAULT_WEBVIEW_ZOOM;
  }
}

function writeStoredWebviewZoom(value: number) {
  try {
    const storage = safeStorage();
    if (!storage) return;
    if (value === DEFAULT_WEBVIEW_ZOOM) storage.removeItem(WEBVIEW_ZOOM_STORAGE_KEY);
    else storage.setItem(WEBVIEW_ZOOM_STORAGE_KEY, String(value));
  } catch {
    // Storage blocked: the zoom still applies for this session.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

async function setWebviewZoom(value: number) {
  if (!isTauri()) return;
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  await getCurrentWebview().setZoom(value);
}

export type WebviewZoomControls = {
  level: number;
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
};

/** Restores the stored zoom once and exposes the zoom commands. */
export function useWebviewZoom(): WebviewZoomControls {
  const [level, setLevel] = useState(readStoredWebviewZoom);
  const levelRef = useRef(level);

  useEffect(() => {
    // The default needs no call: a fresh webview already renders at 100%.
    const stored = readStoredWebviewZoom();
    if (stored === DEFAULT_WEBVIEW_ZOOM) return;
    setWebviewZoom(stored).catch((error) => console.warn("webview zoom restore failed", error));
  }, []);

  const apply = useCallback((next: number) => {
    levelRef.current = next;
    setLevel(next);
    writeStoredWebviewZoom(next);
    setWebviewZoom(next).catch((error) => console.warn("webview zoom failed", error));
  }, []);

  return {
    level,
    zoomIn: useCallback(() => apply(stepWebviewZoom(levelRef.current, 1)), [apply]),
    zoomOut: useCallback(() => apply(stepWebviewZoom(levelRef.current, -1)), [apply]),
    reset: useCallback(() => apply(DEFAULT_WEBVIEW_ZOOM), [apply]),
  };
}
