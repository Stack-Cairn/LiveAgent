import { getCurrentWindow } from "@tauri-apps/api/window";
import { type MouseEvent, useCallback, useEffect, useRef, useState } from "react";

import iconSimpleUrl from "../../src-tauri/icons/icon-simple.png";
import { useLocale } from "../i18n";
import { cn } from "../lib/shared/utils";
import { hasWindowControls } from "../lib/shell/capabilities";
import { Maximize2, Minimize2, Minus, X } from "./icons";

type AppWindow = ReturnType<typeof getCurrentWindow>;

// 自绘标题栏（最小化/最大化/关闭）要的是真窗口控制能力。浏览器里既没有这些
// 按钮的对应物，tauriShim 装的假 internals 也会让直接探 __TAURI__ 的写法误判。
function isWindowsTauriRuntime() {
  if (typeof window === "undefined") {
    return false;
  }

  const platformText = `${navigator.userAgent} ${navigator.platform}`;
  return hasWindowControls() && /\bWindows\b|Win32|Win64|WOW64/i.test(platformText);
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

  const startDragging = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0 || event.detail !== 1) {
        return;
      }
      void getAppWindow()
        .startDragging()
        .catch((error) => reportWindowChromeError("drag", error));
    },
    [getAppWindow],
  );

  const toggleMaximize = useCallback(() => {
    const appWindow = getAppWindow();
    void appWindow
      .toggleMaximize()
      .then(() => appWindow.isMaximized())
      .then(setIsMaximized)
      .catch((error) => reportWindowChromeError("toggle maximized state for", error));
  }, [getAppWindow]);

  const handleTitleDoubleClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }
      toggleMaximize();
    },
    [toggleMaximize],
  );

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
    <header
      className={cn(
        "relative z-50 flex h-8 shrink-0 select-none items-center border-b border-black/[0.06] bg-white/65 text-foreground/90 backdrop-blur-2xl backdrop-saturate-150 supports-[backdrop-filter]:bg-white/55 dark:border-white/[0.06] dark:bg-neutral-900/70 dark:supports-[backdrop-filter]:bg-neutral-900/55",
        "shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
        !isFocused && "text-foreground/55",
      )}
    >
      <div
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-2.5 pr-3"
        onDoubleClick={handleTitleDoubleClick}
        onMouseDown={startDragging}
      >
        <img
          src={iconSimpleUrl}
          alt=""
          className="h-[15px] w-[15px] shrink-0 rounded-[3.5px]"
          draggable={false}
        />
        <span className="truncate text-[12px] font-medium leading-[1.45] tracking-[0.01em] text-foreground/80">
          {t("app.name")}
        </span>
      </div>

      <fieldset
        className="m-0 flex h-full shrink-0 items-stretch border-0 p-0"
        aria-label={t("window.controls")}
      >
        <button
          type="button"
          className="group flex h-full w-[38px] items-center justify-center text-foreground/55 transition-colors duration-150 hover:bg-black/[0.05] hover:text-foreground/90 focus-visible:outline-hidden focus-visible:bg-black/[0.05] focus-visible:text-foreground/90 dark:hover:bg-white/[0.07] dark:focus-visible:bg-white/[0.07]"
          aria-label={t("window.minimize")}
          title={t("window.minimize")}
          onClick={minimizeWindow}
        >
          <Minus className="h-[13px] w-[13px]" strokeWidth={1.4} />
        </button>
        <button
          type="button"
          className="group flex h-full w-[38px] items-center justify-center text-foreground/55 transition-colors duration-150 hover:bg-black/[0.05] hover:text-foreground/90 focus-visible:outline-hidden focus-visible:bg-black/[0.05] focus-visible:text-foreground/90 dark:hover:bg-white/[0.07] dark:focus-visible:bg-white/[0.07]"
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
          className="group flex h-full w-[42px] items-center justify-center text-foreground/55 transition-colors duration-150 hover:bg-[#e81123] hover:text-white focus-visible:outline-hidden focus-visible:bg-[#e81123] focus-visible:text-white"
          aria-label={t("window.close")}
          title={t("window.close")}
          onClick={closeWindow}
        >
          <X className="h-[13px] w-[13px]" strokeWidth={1.5} />
        </button>
      </fieldset>
    </header>
  );
}
