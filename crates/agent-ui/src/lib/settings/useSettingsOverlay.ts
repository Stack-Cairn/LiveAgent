import { useCallback, useEffect, useRef, useState } from "react";

export type SettingsOverlayState = "closed" | "entering" | "open" | "leaving";

// CUA-033: Chromium / WKWebView suspends requestAnimationFrame callbacks while
// the document is hidden (background launch, minimized window, etc.). Without
// a fallback the overlay would stay stuck at opacity-0 forever in those
// scenarios. 350 ms slightly exceeds the 300 ms CSS transition so the normal
// rAF chain still wins when the tab is in the foreground.
//
// CUA-034: the same is true for the close path — WebKit suppresses
// transitionend when document.hidden, so the panel would otherwise stay
// mounted in 'leaving' forever. We use the symmetric LEAVE_FALLBACK_MS timer
// (plus a visibilitychange handler) to guarantee unmount.
const ENTER_FALLBACK_MS = 350;
const LEAVE_FALLBACK_MS = 350;

export function useSettingsOverlay() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [overlay, setOverlay] = useState<SettingsOverlayState>("closed");
  const enterFallbackTimerRef = useRef<number | null>(null);
  const leaveFallbackTimerRef = useRef<number | null>(null);

  // Promote "entering" -> "open" without disturbing other states. The
  // functional updater makes it idempotent: concurrent callers (rAF chain,
  // 350 ms safety net, visibilitychange handler) all converge on the same
  // outcome.
  const promoteEntering = useCallback(() => {
    setOverlay((current) => (current === "entering" ? "open" : current));
  }, []);

  // CUA-034: Promote "leaving" -> "closed" (and unmount the panel). Symmetric
  // to promoteEntering: reads the latest overlay via ref so the check is
  // idempotent and side-effect free. We do NOT call setSettingsOpen inside
  // the setOverlay functional updater — React 18 StrictMode double-invokes
  // functional updaters in development, and setSettingsOpen(false) called
  // twice (once from each StrictMode pass) would still be idempotent but is
  // wasteful and would mask future regressions in that setter.
  const overlayRef = useRef<SettingsOverlayState>("closed");
  useEffect(() => {
    overlayRef.current = overlay;
  }, [overlay]);

  const promoteLeaving = useCallback(() => {
    if (overlayRef.current !== "leaving") return;
    setSettingsOpen(false);
    setOverlay("closed");
  }, []);

  const clearEnterFallback = useCallback(() => {
    if (enterFallbackTimerRef.current !== null) {
      window.clearTimeout(enterFallbackTimerRef.current);
      enterFallbackTimerRef.current = null;
    }
  }, []);

  const clearLeaveFallback = useCallback(() => {
    if (leaveFallbackTimerRef.current !== null) {
      window.clearTimeout(leaveFallbackTimerRef.current);
      leaveFallbackTimerRef.current = null;
    }
  }, []);

  const openSettingsOverlay = useCallback(() => {
    clearLeaveFallback();
    setSettingsOpen(true);
    setOverlay("entering");
    clearEnterFallback();

    // Hard fallback: if neither the rAF chain nor a visibility change
    // promotes us, force 'open' so the overlay is never stuck invisible.
    enterFallbackTimerRef.current = window.setTimeout(() => {
      enterFallbackTimerRef.current = null;
      promoteEntering();
    }, ENTER_FALLBACK_MS);

    if (typeof document === "undefined" || document.visibilityState !== "visible") {
      // Hidden tab / background launch: rAF will not fire. Promote now so
      // the overlay is already in the visible state when the user brings
      // the window forward.
      promoteEntering();
      return;
    }

    requestAnimationFrame(() => requestAnimationFrame(() => promoteEntering()));
  }, [clearEnterFallback, clearLeaveFallback, promoteEntering]);

  // CUA-033/CUA-034: if the document becomes visible while we're still in
  // 'entering' or 'leaving', promote immediately so the overlay is not
  // waiting on the 350 ms safety net or the next user interaction. For
  // 'leaving' this matters because WebKit suppresses transitionend while
  // hidden, so without this the panel would stay mounted in the leaving
  // state forever.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        promoteEntering();
        promoteLeaving();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [promoteEntering, promoteLeaving]);

  // Drop any pending fallbacks on unmount so we never fire after teardown.
  useEffect(
    () => () => {
      clearEnterFallback();
      clearLeaveFallback();
    },
    [clearEnterFallback, clearLeaveFallback],
  );

  const closeSettingsOverlay = useCallback(() => {
    clearEnterFallback();
    clearLeaveFallback();
    setOverlay("leaving");

    // CUA-034: hard fallback for the close path. WebKit does not fire
    // transitionend while document.hidden, so without this timer the panel
    // stays mounted in 'leaving' forever. transitionend (when fired) will
    // also call promoteLeaving, and the functional updater in setOverlay
    // makes whichever path wins idempotent.
    leaveFallbackTimerRef.current = window.setTimeout(() => {
      leaveFallbackTimerRef.current = null;
      promoteLeaving();
    }, LEAVE_FALLBACK_MS);
  }, [clearEnterFallback, clearLeaveFallback, promoteLeaving]);

  const handleSettingsOverlayTransitionEnd = useCallback(() => {
    // CUA-034: route through promoteLeaving so the leave fallback timer is
    // observed (transitionend usually wins, but we still cancel the safety
    // net so it doesn't run after teardown). Functional setOverlay keeps
    // this idempotent if the timer already fired.
    promoteLeaving();
  }, [promoteLeaving]);

  const resetSettingsOverlay = useCallback(() => {
    clearEnterFallback();
    clearLeaveFallback();
    setSettingsOpen(false);
    setOverlay("closed");
  }, [clearEnterFallback, clearLeaveFallback]);

  return {
    settingsOpen,
    overlay,
    openSettingsOverlay,
    closeSettingsOverlay,
    handleSettingsOverlayTransitionEnd,
    resetSettingsOverlay,
  };
}
