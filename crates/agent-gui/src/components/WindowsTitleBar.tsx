import { Maximize2, Minimize2 } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { type MouseEvent, useCallback, useEffect, useRef, useState } from "react";
import iconSimpleUrl from "../../src-tauri/icons/icon-simple.png";

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

const CAPTION_BUTTON_BASE_CLASS = cn(
  "flex size-8 shrink-0 items-center justify-center rounded-lg text-foreground/60",
  "transition-[background-color,color] duration-150 ease-out",
  "outline-hidden focus-visible:outline-hidden focus-visible:ring-0",
);

const CAPTION_BUTTON_CLASS = cn(
  CAPTION_BUTTON_BASE_CLASS,
  "hover:bg-black/[0.06] hover:text-foreground active:bg-black/[0.1]",
  "focus-visible:bg-black/[0.06] focus-visible:text-foreground",
  "dark:hover:bg-white/[0.08] dark:active:bg-white/[0.05] dark:focus-visible:bg-white/[0.08]",
);

type CaptionGlyphKind = "minimize" | "close";

/**
 * Fluent-style caption glyphs drawn on a 10x10 grid with 1px strokes so they
 * stay crisp at 100% scaling and match the native Windows 11 caption buttons.
 */
function CaptionGlyph({ kind }: { kind: CaptionGlyphKind }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      aria-hidden="true"
      className="shrink-0"
    >
      {kind === "minimize" && <path d="M0 5.5h10" />}
      {kind === "close" && <path d="M0.75 0.75l8.5 8.5M9.25 0.75l-8.5 8.5" strokeLinecap="round" />}
    </svg>
  );
}

export function WindowsTitleBar({ controlsOnly = false }: { controlsOnly?: boolean }) {
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

  const controls = (
    <fieldset
      data-windows-window-controls=""
      data-tauri-drag-region="false"
      className={cn(
        "m-0 flex h-full shrink-0 items-center gap-1 border-0 px-1",
        !isFocused && "opacity-60",
      )}
      aria-label={t("window.controls")}
    >
      <button
        type="button"
        className={CAPTION_BUTTON_CLASS}
        aria-label={t("window.minimize")}
        title={t("window.minimize")}
        onClick={minimizeWindow}
      >
        <CaptionGlyph kind="minimize" />
      </button>
      <button
        type="button"
        className={CAPTION_BUTTON_CLASS}
        aria-label={maximizeLabel}
        title={maximizeLabel}
        onClick={toggleMaximize}
      >
        {isMaximized ? (
          <Minimize2 className="size-12px" strokeWidth={1.4} />
        ) : (
          <Maximize2 className="size-12px" strokeWidth={1.4} />
        )}
      </button>
      <button
        type="button"
        className={cn(
          CAPTION_BUTTON_BASE_CLASS,
          "hover:bg-ui-e81123 hover:text-white active:bg-ui-e81123/80 active:text-white/90",
          "focus-visible:bg-ui-e81123 focus-visible:text-white",
        )}
        aria-label={t("window.close")}
        title={t("window.close")}
        onClick={closeWindow}
      >
        <CaptionGlyph kind="close" />
      </button>
    </fieldset>
  );
  if (controlsOnly) return controls;

  return (
    <header
      className={cn(
        "relative z-50 flex h-8 shrink-0 select-none items-center",
        "border-b border-black/[0.06] bg-white/65 text-foreground/90 backdrop-blur-2xl backdrop-saturate-150",
        "supports-[backdrop-filter]:bg-white/55 dark:border-white/[0.06] dark:bg-neutral-900/70 dark:supports-[backdrop-filter]:bg-neutral-900/55",
        "shadow-ui-windowstitlebar-52 dark:shadow-ui-planmodecard-11",
        !isFocused && "text-foreground/55",
      )}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: The native titlebar drag/maximize region is intentionally pointer-only; adjacent window buttons provide keyboard controls. */}
      <div
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-2.5 pr-3"
        onDoubleClick={handleTitleDoubleClick}
        onMouseDown={startDragging}
      >
        <img
          src={iconSimpleUrl}
          alt=""
          className="size-15px shrink-0 rounded-xs"
          draggable={false}
        />
        <span className="truncate text-xs font-medium leading-1p45 tracking-0p01em text-foreground/80">
          {t("app.name")}
        </span>
      </div>

      {controls}
    </header>
  );
}
