import { useCallback, useEffect, useRef, useState } from "react";

export type SettingsOverlayState = "closed" | "entering" | "open" | "leaving";

/**
 * 进场 / 退场的兜底时长。
 *
 * 需要兜底是因为两条推进路径在文档隐藏时都不发生：`requestAnimationFrame`
 * 的回调被挂起，`transitionend` 被 WebKit 抑制。后台启动或最小化时打开设置
 * 页，进场会永远停在 opacity-0（整页看起来是空白），退场会永远停在 leaving
 * （面板不卸载）。
 *
 * 350ms 略大于 300ms 的 CSS 过渡：前台时正常路径总是先到，兜底只在异常时生效。
 */
const OVERLAY_FALLBACK_MS = 350;

/**
 * 设置页浮层的开合状态机。
 *
 * 只有一个状态：`settingsOpen` 由 `overlay` 推导（非 closed 即为开）。曾经是
 * 两个 useState 并行维护，于是需要一个 ref 去读最新的 overlay、还要小心
 * StrictMode 下重复调用 setter——都是同一份事实存两遍带来的负担。
 */
export function useSettingsOverlay() {
  const [overlay, setOverlay] = useState<SettingsOverlayState>("closed");
  const fallbackTimerRef = useRef<number | null>(null);

  const clearFallback = useCallback(() => {
    if (fallbackTimerRef.current !== null) {
      window.clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  }, []);

  /**
   * 把状态从 `from` 推进到 `to`。用函数式更新，因此谁先到都一样：rAF 链、
   * 350ms 兜底、visibilitychange 三条路径彼此幂等。
   */
  const promote = useCallback((from: SettingsOverlayState, to: SettingsOverlayState) => {
    setOverlay((current) => (current === from ? to : current));
  }, []);

  const armFallback = useCallback(
    (from: SettingsOverlayState, to: SettingsOverlayState) => {
      clearFallback();
      fallbackTimerRef.current = window.setTimeout(() => {
        fallbackTimerRef.current = null;
        promote(from, to);
      }, OVERLAY_FALLBACK_MS);
    },
    [clearFallback, promote],
  );

  const openSettingsOverlay = useCallback(() => {
    setOverlay("entering");
    armFallback("entering", "open");

    if (typeof document === "undefined" || document.visibilityState !== "visible") {
      // 隐藏状态下 rAF 不会回调。直接推进，等用户把窗口切到前台时浮层已经
      // 处于可见状态，而不是停在 opacity-0。
      promote("entering", "open");
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => promote("entering", "open")));
  }, [armFallback, promote]);

  const closeSettingsOverlay = useCallback(() => {
    setOverlay("leaving");
    armFallback("leaving", "closed");
  }, [armFallback]);

  const handleSettingsOverlayTransitionEnd = useCallback(() => {
    promote("leaving", "closed");
  }, [promote]);

  const resetSettingsOverlay = useCallback(() => {
    clearFallback();
    setOverlay("closed");
  }, [clearFallback]);

  // 文档重新可见时立刻推进，不必再等兜底计时器——后台时计时器会被浏览器
  // 降频，用户切回来可能正好卡在那一段。
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      promote("entering", "open");
      promote("leaving", "closed");
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [promote]);

  // 卸载后不该再有计时器落地。
  useEffect(() => clearFallback, [clearFallback]);

  return {
    settingsOpen: overlay !== "closed",
    overlay,
    openSettingsOverlay,
    closeSettingsOverlay,
    handleSettingsOverlayTransitionEnd,
    resetSettingsOverlay,
  };
}
