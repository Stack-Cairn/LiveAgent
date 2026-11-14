import { useEffect, useState, useSyncExternalStore } from "react";
import {
  getRecordedWebSearchFallbackState,
  getWebSearchFallbackVersion,
  recordWebSearchFallbackState,
  subscribeWebSearchFallbackState,
  WEB_SEARCH_SETTINGS_CHANGED_EVENT,
  type WebSearchFallbackState,
} from "./webSearchFallback";

/**
 * The backend's web search fallback state for the composer. While `active` it is read again
 * whenever `refreshKey` changes (for example each time a menu opens) and when K-brain
 * settings are saved elsewhere. Until a read answers, the last recorded state is used; a
 * failed read keeps it rather than turning the switch off.
 */
export function useWebSearchFallbackState(
  load: () => Promise<WebSearchFallbackState | null>,
  active: boolean,
  refreshKey?: unknown,
): WebSearchFallbackState | null {
  const [state, setState] = useState(getRecordedWebSearchFallbackState);
  const [changes, setChanges] = useState(0);
  useEffect(
    () => subscribeWebSearchFallbackState(() => setState(getRecordedWebSearchFallbackState())),
    [],
  );
  useEffect(() => {
    if (!active) return;
    const onChanged = () => setChanges((value) => value + 1);
    window.addEventListener(WEB_SEARCH_SETTINGS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(WEB_SEARCH_SETTINGS_CHANGED_EVENT, onChanged);
  }, [active]);
  useEffect(() => {
    // refreshKey and changes only schedule a re-read; their values are unused.
    void refreshKey;
    void changes;
    if (!active) return;
    let disposed = false;
    load()
      .then((next) => {
        if (disposed) return;
        recordWebSearchFallbackState(next);
        setState(next);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [active, load, refreshKey, changes]);
  return state;
}

/**
 * Changes whenever the recorded fallback state does. Memos that gate web search with
 * normalizeChatRuntimeControlsForProvider list it as a dependency so they follow it.
 */
export function useWebSearchFallbackVersion(): number {
  return useSyncExternalStore(
    subscribeWebSearchFallbackState,
    getWebSearchFallbackVersion,
    getWebSearchFallbackVersion,
  );
}
