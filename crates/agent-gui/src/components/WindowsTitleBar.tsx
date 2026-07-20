import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";

import { useLocale } from "../i18n";
import { cn } from "../lib/shared/utils";
import { Maximize2, Minimize2, Minus, X } from "./icons";

type TauriRuntimeWindow = Window & {
  __TAURI__?: unknown;
  __TAURI_INTERNALS__?: unknown;
};

type AppWindow = ReturnType<typeof getCurrentWindow>;

function isWindowsTauriRuntime() {
  if (typeof window === "undefined") {
    return false;
  }

  const runtimeWindow = window as TauriRuntimeWindow;
  const hasTauriRuntime =
    runtimeWindow.__TAURI__ !== undefined || runtimeWindow.__TAURI_INTERNALS__ !== undefined;
  const platformText = `${navigator.userAgent} ${navigator.platform}`;
  return hasTauriRuntime && /\bWindows\b|Win32|Win64|WOW64/i.test(platformText);
}

function reportWindowChromeError(action: string, error: unknown) {
  console.error(`failed to ${action} LiveAgent window`, error);
}

export function WindowsTitleBar() {
  const { t } = useLocale();
  const [isVisible, setIsVisible] = useState(() => isWindowsTauriRuntime());
  const [isMaximized, setIsMaximized] = useState(false);
  const [isFocused, setIsFocused] = useState(true);
  const appWindowRef = useRef<AppWindow | null>(null);

  const getAppWindow = useCallback(() => {
    if (!appWindowRef.current) {
      appWindowRef.current = getCurrentWindow();
    }
    return appWindowRef.current;
  }, []);

  const syncMaximized = useCallback(() => {
    if (!isVisible) {
      return;
    }
    void getAppWindow()
      .isMaximized()
      .then(setIsMaximized)
      .catch((error) => reportWindowChromeError("read maximized state for", error));
  }, [getAppWindow, isVisible]);

  useEffect(() => {
    setIsVisible(isWindowsTauriRuntime());
  }, []);

  useEffect(() => {
    if (!isVisible) {
      return undefined;
    }

    const appWindow = getAppWindow();
    let disposed = false;
    let unlistenResize: (() => void) | undefined;
    let unlistenFocus: (() => void) | undefined;

    void appWindow
      .isMaximized()
      .then((maximized) => {
        if (!disposed) {
          setIsMaximized(maximized);
        }
      })
      .catch((error) => reportWindowChromeError("read maximized state for", error));

    void appWindow
      .isFocused()
      .then((focused) => {
        if (!disposed) {
          setIsFocused(focused);
        }
      })
      .catch((error) => reportWindowChromeError("read focus state for", error));

    void appWindow
      .onResized(() => {
        if (!disposed) {
          syncMaximized();
        }
      })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenResize = unlisten;
        }
      })
      .catch((error) => reportWindowChromeError("subscribe resize events for", error));

    void appWindow
      .onFocusChanged(({ payload }) => {
        if (!disposed) {
          setIsFocused(payload);
        }
      })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenFocus = unlisten;
        }
      })
      .catch((error) => reportWindowChromeError("subscribe focus events for", error));

    return () => {
      disposed = true;
      unlistenResize?.();
      unlistenFocus?.();
    };
  }, [getAppWindow, isVisible, syncMaximized]);

  // 悬浮胶囊会盖住窗口右上角：把预留宽度暴露成全局 CSS 变量，各视图的
  // 顶右头部（ChatHeader / 右侧面板 / 编辑器覆盖层）据此加内边距让位。
  useEffect(() => {
    if (!isVisible || typeof document === "undefined") {
      return undefined;
    }
    const root = document.documentElement;
    root.style.setProperty("--win-chrome-reserve", "128px");
    return () => {
      root.style.removeProperty("--win-chrome-reserve");
    };
  }, [isVisible]);

  const toggleMaximize = useCallback(() => {
    const appWindow = getAppWindow();
    void appWindow
      .toggleMaximize()
      .then(() => appWindow.isMaximized())
      .then(setIsMaximized)
      .catch((error) => reportWindowChromeError("toggle maximized state for", error));
  }, [getAppWindow]);

  const minimizeWindow = useCallback(() => {
    void getAppWindow()
      .minimize()
      .catch((error) => reportWindowChromeError("minimize", error));
  }, [getAppWindow]);

  const closeWindow = useCallback(() => {
    void getAppWindow()
      .close()
      .catch((error) => reportWindowChromeError("close", error));
  }, [getAppWindow]);

  if (!isVisible) {
    return null;
  }

  const maximizeLabel = isMaximized ? t("window.restore") : t("window.maximize");

  return (
    <>
      {/* 顶缘拖拽热区：内容顶到窗顶后，这 6px 承担拖拽与双击最大化
          （data-tauri-drag-region 由 Tauri 核心处理，二者内建）。 */}
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 z-[95] h-1.5" />

      <div
        className={cn(
          "absolute z-[100] flex select-none items-stretch overflow-hidden border backdrop-blur-xl transition-all duration-200",
          "border-border/50 bg-background/70 shadow-[0_1px_0_rgba(255,255,255,0.55)_inset,0_8px_24px_-16px_rgba(15,23,42,0.25)] dark:border-white/[0.08] dark:bg-white/[0.06] dark:shadow-[0_1px_0_rgba(255,255,255,0.06)_inset,0_8px_24px_-16px_rgba(0,0,0,0.5)]",
          // 最大化时贴角：让「关闭」命中屏幕右上角（Fitts 法则），只留左下圆角。
          isMaximized
            ? "right-0 top-0 rounded-none rounded-bl-xl border-r-0 border-t-0"
            : "right-2 top-2 rounded-full",
          !isFocused && "opacity-55",
        )}
      >
        <button
          type="button"
          className="flex h-8 w-10 items-center justify-center text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-hidden focus-visible:bg-foreground/[0.06] focus-visible:text-foreground"
          aria-label={t("window.minimize")}
          title={t("window.minimize")}
          onClick={minimizeWindow}
        >
          <Minus className="h-[13px] w-[13px]" strokeWidth={1.4} />
        </button>
        <button
          type="button"
          className="flex h-8 w-10 items-center justify-center text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-hidden focus-visible:bg-foreground/[0.06] focus-visible:text-foreground"
          aria-label={maximizeLabel}
          title={maximizeLabel}
          onClick={toggleMaximize}
        >
          {isMaximized ? (
            <Minimize2 className="h-[12px] w-[12px]" strokeWidth={1.4} />
          ) : (
            <Maximize2 className="h-[12px] w-[12px]" strokeWidth={1.4} />
          )}
        </button>
        <button
          type="button"
          className="flex h-8 w-10 items-center justify-center text-muted-foreground transition-colors duration-150 hover:bg-red-500/15 hover:text-red-600 focus-visible:outline-hidden focus-visible:bg-red-500/15 focus-visible:text-red-600 dark:hover:text-red-400 dark:focus-visible:text-red-400"
          aria-label={t("window.close")}
          title={t("window.close")}
          onClick={closeWindow}
        >
          <X className="h-[13px] w-[13px]" strokeWidth={1.5} />
        </button>
      </div>
    </>
  );
}
