import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Camera,
  Download,
  ExternalLink,
  Globe,
  Loader2,
  MoreHorizontal,
  Plus,
  RotateCw,
  SquareMousePointer,
  Trash2,
  X,
} from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  type FormEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type CompositionEvent as ReactCompositionEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type BrowserLoadErrorKind,
  browserAddressDisplay,
  browserTabLabel,
  cdpModifiers,
  cdpMouseButton,
  classifyBrowserLoadError,
  EMBEDDED_BROWSER_MAX_TABS,
  EMPTY_EMBEDDED_BROWSER_STATE,
  type EmbeddedBrowserClient,
  type EmbeddedBrowserFrame,
  type EmbeddedBrowserMouseInput,
  type EmbeddedBrowserState,
  type EmbeddedBrowserViewport,
  formatPickedElementsMarkdown,
  isBlankBrowserTab,
  mapPointerToViewport,
  normalizeBrowserAddress,
  shouldForwardBrowserKey,
} from "../../lib/browser/embeddedBrowser";
import { cn } from "../../lib/shared/utils";
import { Button, buttonVariants } from "../ui/button";
import { useConfirmDialog } from "../ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { EmbeddedBrowserImportDialog } from "./EmbeddedBrowserImportDialog";

export type EmbeddedBrowserPanelProps = {
  active: boolean;
  client: EmbeddedBrowserClient | null;
  onOpenExternal?: (url: string) => void;
};

type Notice = { tone: "info" | "error"; text: string };

const LOAD_ERROR_HINT_KEYS = {
  certificate: "projectTools.browserLoadErrorHint.certificate",
  dns: "projectTools.browserLoadErrorHint.dns",
  refused: "projectTools.browserLoadErrorHint.refused",
  timeout: "projectTools.browserLoadErrorHint.timeout",
  offline: "projectTools.browserLoadErrorHint.offline",
  other: "projectTools.browserLoadErrorHint.other",
} as const satisfies Record<BrowserLoadErrorKind, string>;

const NOTICE_TIMEOUT_MS = 2600;
const MULTI_CLICK_INTERVAL_MS = 450;
const MULTI_CLICK_DISTANCE_PX = 5;

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : String(error);
}

function measureViewport(element: HTMLElement | null): EmbeddedBrowserViewport | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  const width = Math.floor(rect.width);
  const height = Math.floor(rect.height);
  if (width < 40 || height < 40) return null;
  return {
    width,
    height,
    deviceScaleFactor: Math.min(3, Math.max(1, window.devicePixelRatio || 1)),
  };
}

/**
 * Embedded browser pane: tab strip, navigation toolbar and a live view of the
 * active tab streamed from the host's headless browser. Pointer and keyboard
 * input on the view is forwarded to the page; the element picker and the
 * screenshot button hand page context to the chat composer.
 */
export function EmbeddedBrowserPanel(props: EmbeddedBrowserPanelProps) {
  const { active, client, onOpenExternal } = props;
  const { t } = useLocale();
  const [state, setState] = useState<EmbeddedBrowserState>(EMPTY_EMBEDDED_BROWSER_STATE);
  const [addressDraft, setAddressDraft] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [picking, setPicking] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [hasFrame, setHasFrame] = useState(false);
  const [viewFocused, setViewFocused] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const { confirm, dialog: confirmDialog } = useConfirmDialog();

  const viewRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const keyboardRef = useRef<HTMLTextAreaElement | null>(null);
  const addressRef = useRef<HTMLInputElement | null>(null);
  const frameSizeRef = useRef<{ width: number; height: number } | null>(null);
  const activeTabIdRef = useRef<string | null>(null);
  const lastViewportRef = useRef<string>("");
  const pendingMoveRef = useRef<EmbeddedBrowserMouseInput | null>(null);
  const moveInFlightRef = useRef(false);
  const lastDownRef = useRef<{ time: number; x: number; y: number; count: number } | null>(null);
  const noticeTimerRef = useRef<number | null>(null);

  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
  activeTabIdRef.current = state.activeTabId;
  const running = state.running;
  const blank = !running || isBlankBrowserTab(activeTab);

  const showNotice = useCallback((next: Notice) => {
    setNotice(next);
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => {
      noticeTimerRef.current = null;
      setNotice(null);
    }, NOTICE_TIMEOUT_MS);
  }, []);

  useEffect(
    () => () => {
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    },
    [],
  );

  const applyFrame = useCallback((frame: EmbeddedBrowserFrame) => {
    if (frame.tabId !== activeTabIdRef.current) return;
    const image = imageRef.current;
    if (!image) return;
    frameSizeRef.current = { width: frame.deviceWidth, height: frame.deviceHeight };
    image.src = `data:image/jpeg;base64,${frame.data}`;
    setHasFrame(true);
  }, []);

  // Live state + frames from the host. The initial getState also restores a
  // session that outlived this panel instance (dock ↔ workbench moves).
  useEffect(() => {
    if (!client) return;
    let disposed = false;
    const unsubscribe = client.subscribe({
      onState: (next) => {
        if (!disposed) setState(next);
      },
      onFrame: (frame) => {
        if (!disposed) applyFrame(frame);
      },
    });
    client
      .getState()
      .then((next) => {
        if (!disposed) setState(next);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [applyFrame, client]);

  // A different active tab means the current image belongs to another page.
  const activeTabId = state.activeTabId;
  useEffect(() => {
    void activeTabId;
    frameSizeRef.current = null;
    setHasFrame(false);
  }, [activeTabId]);

  useEffect(() => {
    if (!running) {
      setHasFrame(false);
      setPicking(false);
      lastViewportRef.current = "";
    }
  }, [running]);

  const ensureStarted = useCallback(
    async (url?: string) => {
      if (!client) return null;
      setStarting(true);
      try {
        const viewport = measureViewport(viewRef.current) ?? undefined;
        if (viewport) lastViewportRef.current = JSON.stringify(viewport);
        const next = await client.open({ url, viewport });
        setState(next);
        return next;
      } catch (error) {
        showNotice({ tone: "error", text: errorMessage(error) });
        return null;
      } finally {
        setStarting(false);
      }
    },
    [client, showNotice],
  );

  // Keep the page viewport in sync with the pane size (debounced).
  useEffect(() => {
    if (!client || !running || !active) return;
    const element = viewRef.current;
    if (!element) return;
    let timer: number | null = null;
    const sync = () => {
      const viewport = measureViewport(element);
      if (!viewport) return;
      const key = JSON.stringify(viewport);
      if (key === lastViewportRef.current) return;
      lastViewportRef.current = key;
      client.resize(viewport).catch(() => {});
    };
    const observer = new ResizeObserver(() => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(sync, 120);
    });
    observer.observe(element);
    sync();
    return () => {
      observer.disconnect();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [active, client, running]);

  const navigateTo = useCallback(
    async (input: string) => {
      if (!client) return;
      const normalized = normalizeBrowserAddress(input);
      if (normalized.kind === "rejected") {
        if (normalized.reason !== "empty") {
          showNotice({ tone: "error", text: t("projectTools.browserInvalidAddress") });
        }
        return;
      }
      setAddressDraft(null);
      addressRef.current?.blur();
      if (!running) {
        await ensureStarted(normalized.url);
        return;
      }
      try {
        setState(await client.navigate(normalized.url, state.activeTabId ?? undefined));
      } catch (error) {
        showNotice({ tone: "error", text: errorMessage(error) });
      }
    },
    [client, ensureStarted, running, showNotice, state.activeTabId, t],
  );

  const runHistory = useCallback(
    async (action: "back" | "forward" | "reload" | "stop") => {
      if (!client || !running) return;
      try {
        setState(await client.history(action, state.activeTabId ?? undefined));
      } catch (error) {
        showNotice({ tone: "error", text: errorMessage(error) });
      }
    },
    [client, running, showNotice, state.activeTabId],
  );

  const retryLoad = useCallback(() => {
    if (activeTab?.error && activeTab.url && !isBlankBrowserTab(activeTab)) {
      void navigateTo(activeTab.url);
    } else {
      void runHistory("reload");
    }
  }, [activeTab, navigateTo, runHistory]);

  const openNewTab = useCallback(async () => {
    if (!client) return;
    if (!running) {
      await ensureStarted();
      addressRef.current?.focus();
      return;
    }
    try {
      setState(await client.newTab());
      setAddressDraft("");
      window.requestAnimationFrame(() => addressRef.current?.focus());
    } catch (error) {
      showNotice({ tone: "error", text: errorMessage(error) });
    }
  }, [client, ensureStarted, running, showNotice]);

  const closeTab = useCallback(
    async (tabId: string) => {
      if (!client) return;
      try {
        setState(await client.closeTab(tabId));
      } catch (error) {
        showNotice({ tone: "error", text: errorMessage(error) });
      }
    },
    [client, showNotice],
  );

  const activateTab = useCallback(
    async (tabId: string) => {
      if (!client || tabId === state.activeTabId) return;
      try {
        setState(await client.activateTab(tabId));
        setAddressDraft(null);
      } catch (error) {
        showNotice({ tone: "error", text: errorMessage(error) });
      }
    },
    [client, showNotice, state.activeTabId],
  );

  const togglePicker = useCallback(async () => {
    if (!client || !running || blank) return;
    if (picking) {
      setPicking(false);
      client.cancelPick().catch(() => {});
      return;
    }
    setPicking(true);
    keyboardRef.current?.focus();
    try {
      const element = await client.pickElement();
      if (!element) return;
      const markdown = formatPickedElementsMarkdown([element]);
      const inserted = client.insertIntoComposer?.(markdown) ?? false;
      showNotice(
        inserted
          ? { tone: "info", text: t("projectTools.browserElementAdded") }
          : { tone: "error", text: t("projectTools.browserComposerUnavailable") },
      );
    } catch (error) {
      showNotice({ tone: "error", text: errorMessage(error) });
    } finally {
      setPicking(false);
    }
  }, [blank, client, picking, running, showNotice, t]);

  const attachScreenshot = useCallback(async () => {
    if (!client || !running || blank || capturing) return;
    if (!client.attachScreenshotToComposer) {
      showNotice({ tone: "error", text: t("projectTools.browserScreenshotUnavailable") });
      return;
    }
    setCapturing(true);
    try {
      const data = await client.screenshot();
      const attached = await client.attachScreenshotToComposer({
        data,
        url: activeTab?.url ?? "",
        title: activeTab?.title ?? "",
      });
      showNotice(
        attached
          ? { tone: "info", text: t("projectTools.browserScreenshotAdded") }
          : { tone: "error", text: t("projectTools.browserScreenshotUnavailable") },
      );
    } catch (error) {
      showNotice({ tone: "error", text: errorMessage(error) });
    } finally {
      setCapturing(false);
    }
  }, [activeTab, blank, capturing, client, running, showNotice, t]);

  const closeBrowser = useCallback(async () => {
    if (!client) return;
    try {
      await client.close();
      setState(await client.getState());
    } catch (error) {
      showNotice({ tone: "error", text: errorMessage(error) });
    }
  }, [client, showNotice]);

  const importClient = useMemo(() => {
    const listImportSources = client?.listImportSources;
    const importCookies = client?.importCookies;
    return listImportSources && importCookies ? { listImportSources, importCookies } : null;
  }, [client]);

  // Imported cookies only reach a page on its next request: reload what the
  // user is looking at so they see the signed-in version.
  const reloadAfterImport = useCallback(() => {
    showNotice({ tone: "info", text: t("projectTools.browserImportReloaded") });
    const tabId = activeTabIdRef.current;
    if (!client || !tabId) return;
    client.history("reload", tabId).then(setState, () => {});
  }, [client, showNotice, t]);

  const clearBrowsingData = useCallback(async () => {
    if (!client?.clearBrowsingData) return;
    const confirmed = await confirm({
      title: t("projectTools.browserClearDataTitle"),
      description: t("projectTools.browserClearDataDescription"),
      confirmLabel: t("projectTools.browserClearDataConfirm"),
      cancelLabel: t("projectTools.browserImportCancel"),
      preferCancel: true,
    });
    if (!confirmed) return;
    try {
      await client.clearBrowsingData();
      setState(await client.getState());
      showNotice({ tone: "info", text: t("projectTools.browserClearDataDone") });
    } catch (error) {
      showNotice({ tone: "error", text: errorMessage(error) });
    }
  }, [client, confirm, showNotice, t]);

  // --- Input forwarding -------------------------------------------------

  const toViewport = useCallback((clientX: number, clientY: number) => {
    const image = imageRef.current;
    const size = frameSizeRef.current;
    if (!image || !size) return null;
    return mapPointerToViewport(clientX, clientY, image.getBoundingClientRect(), size);
  }, []);

  const flushMove = useCallback(() => {
    if (!client || moveInFlightRef.current) return;
    const next = pendingMoveRef.current;
    if (!next) return;
    pendingMoveRef.current = null;
    moveInFlightRef.current = true;
    client
      .mouse(next)
      .catch(() => {})
      .finally(() => {
        moveInFlightRef.current = false;
        if (pendingMoveRef.current) flushMove();
      });
  }, [client]);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!client || !running || blank) return;
      const point = toViewport(event.clientX, event.clientY);
      keyboardRef.current?.focus({ preventScroll: true });
      if (!point) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const now = performance.now();
      const last = lastDownRef.current;
      const count =
        last &&
        now - last.time < MULTI_CLICK_INTERVAL_MS &&
        Math.abs(last.x - point.x) < MULTI_CLICK_DISTANCE_PX &&
        Math.abs(last.y - point.y) < MULTI_CLICK_DISTANCE_PX
          ? Math.min(3, last.count + 1)
          : 1;
      lastDownRef.current = { time: now, x: point.x, y: point.y, count };
      client
        .mouse({
          kind: "down",
          x: point.x,
          y: point.y,
          button: cdpMouseButton(event.button),
          buttons: event.buttons,
          clickCount: count,
          modifiers: cdpModifiers(event),
        })
        .catch(() => {});
    },
    [blank, client, running, toViewport],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!client || !running || blank) return;
      const point = toViewport(event.clientX, event.clientY);
      if (!point) return;
      pendingMoveRef.current = {
        kind: "move",
        x: point.x,
        y: point.y,
        button: event.buttons & 1 ? "left" : "none",
        buttons: event.buttons,
        modifiers: cdpModifiers(event),
      };
      flushMove();
    },
    [blank, client, flushMove, running, toViewport],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!client || !running || blank) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      const point = toViewport(event.clientX, event.clientY);
      if (!point) return;
      client
        .mouse({
          kind: "up",
          x: point.x,
          y: point.y,
          button: cdpMouseButton(event.button),
          buttons: event.buttons,
          clickCount: lastDownRef.current?.count ?? 1,
          modifiers: cdpModifiers(event),
        })
        .catch(() => {});
    },
    [blank, client, running, toViewport],
  );

  const handleWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (!client || !running || blank) return;
      const point = toViewport(event.clientX, event.clientY);
      if (!point) return;
      const lineScale = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1;
      client
        .mouse({
          kind: "wheel",
          x: point.x,
          y: point.y,
          deltaX: event.deltaX * lineScale,
          deltaY: event.deltaY * lineScale,
          modifiers: cdpModifiers(event),
        })
        .catch(() => {});
    },
    [blank, client, running, toViewport],
  );

  const sendKey = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>, kind: "down" | "up") => {
      if (!client || !running) return;
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (!shouldForwardBrowserKey(event)) return;
      event.preventDefault();
      event.stopPropagation();
      client
        .key({
          kind,
          key: event.key,
          code: event.code,
          keyCode: event.keyCode,
          modifiers: cdpModifiers(event),
        })
        .catch(() => {});
    },
    [client, running],
  );

  const handleCompositionEnd = useCallback(
    (event: ReactCompositionEvent<HTMLTextAreaElement>) => {
      const text = event.data;
      event.currentTarget.value = "";
      if (client && running && text) client.insertText(text).catch(() => {});
    },
    [client, running],
  );

  const handlePaste = useCallback(
    (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
      const text = event.clipboardData.getData("text/plain");
      event.preventDefault();
      if (client && running && text) client.insertText(text).catch(() => {});
    },
    [client, running],
  );

  const submitAddress = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void navigateTo(addressDraft ?? browserAddressDisplay(activeTab?.url ?? ""));
    },
    [activeTab?.url, addressDraft, navigateTo],
  );

  if (!client) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {t("projectTools.browserUnsupportedHost")}
      </div>
    );
  }

  const addressValue = addressDraft ?? browserAddressDisplay(activeTab?.url ?? "");
  const loading = Boolean(activeTab?.loading);
  const tabLimitReached = state.tabs.length >= EMBEDDED_BROWSER_MAX_TABS;
  const pageControlsDisabled = !running || blank;
  const showUnavailable = !running && !state.browserAvailable;
  const loadError = running && activeTab?.error ? activeTab.error : null;
  const toolbarButtonClass =
    "size-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground disabled:opacity-40";

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
      data-embedded-browser=""
    >
      {running && state.tabs.length > 0 ? (
        <div
          className="flex h-8 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-border/60 bg-muted/30 px-1.5 [scrollbar-width:none]"
          role="tablist"
          aria-label={t("projectTools.browserTabs")}
        >
          {state.tabs.map((tab) => {
            const selected = tab.id === state.activeTabId;
            const label = browserTabLabel(tab, t("projectTools.browserNewTab"));
            return (
              <div
                key={tab.id}
                className={cn(
                  "group flex h-7 min-w-0 max-w-44 shrink-0 items-center gap-1 rounded-t-md pl-2 pr-0.5 text-xs",
                  selected
                    ? "bg-background text-foreground shadow-[0_-1px_0_0_var(--border)_inset]"
                    : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  title={tab.url || label}
                  onClick={() => void activateTab(tab.id)}
                >
                  {tab.loading ? (
                    <Loader2 className="size-3 shrink-0 animate-spin" />
                  ) : (
                    <Globe className="size-3 shrink-0 opacity-70" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                </button>
                <button
                  type="button"
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground",
                    selected ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                  )}
                  title={t("projectTools.browserCloseTab")}
                  aria-label={t("projectTools.browserCloseTab")}
                  onClick={() => void closeTab(tab.id)}
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="mb-0.5 size-6 shrink-0 rounded-md text-muted-foreground hover:text-foreground"
            disabled={tabLimitReached}
            title={t("projectTools.browserNewTab")}
            aria-label={t("projectTools.browserNewTab")}
            onClick={() => void openNewTab()}
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
      ) : null}

      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/60 px-1.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={toolbarButtonClass}
          disabled={!running || !activeTab?.canGoBack}
          title={t("projectTools.browserBack")}
          aria-label={t("projectTools.browserBack")}
          onClick={() => void runHistory("back")}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={toolbarButtonClass}
          disabled={!running || !activeTab?.canGoForward}
          title={t("projectTools.browserForward")}
          aria-label={t("projectTools.browserForward")}
          onClick={() => void runHistory("forward")}
        >
          <ArrowRight className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={toolbarButtonClass}
          disabled={pageControlsDisabled}
          title={loading ? t("projectTools.browserStop") : t("projectTools.browserReload")}
          aria-label={loading ? t("projectTools.browserStop") : t("projectTools.browserReload")}
          onClick={() => void runHistory(loading ? "stop" : "reload")}
        >
          {loading ? <X className="size-4" /> : <RotateCw className="size-3.5" />}
        </Button>
        <form className="min-w-0 flex-1" onSubmit={submitAddress}>
          <input
            ref={addressRef}
            type="text"
            inputMode="url"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={addressValue}
            placeholder={t("projectTools.browserAddressPlaceholder")}
            aria-label={t("projectTools.browserAddress")}
            onChange={(event) => setAddressDraft(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={() => setAddressDraft(null)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setAddressDraft(null);
                event.currentTarget.blur();
              }
            }}
            className={cn(
              "h-7 w-full min-w-0 rounded-full border border-border/70 bg-muted/40 px-3",
              "text-xs text-foreground outline-none placeholder:text-muted-foreground/80",
              "focus:border-ring focus:bg-background focus:ring-2 focus:ring-ring/20",
            )}
          />
        </form>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={cn(
            toolbarButtonClass,
            picking && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
          )}
          disabled={pageControlsDisabled}
          aria-pressed={picking}
          title={t("projectTools.browserPickElement")}
          aria-label={t("projectTools.browserPickElement")}
          onClick={() => void togglePicker()}
        >
          <SquareMousePointer className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={toolbarButtonClass}
          disabled={pageControlsDisabled || capturing}
          title={t("projectTools.browserScreenshot")}
          aria-label={t("projectTools.browserScreenshot")}
          onClick={() => void attachScreenshot()}
        >
          {capturing ? <Loader2 className="size-4 animate-spin" /> : <Camera className="size-4" />}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(
              buttonVariants({ variant: "ghost", size: "icon-xs" }),
              toolbarButtonClass,
            )}
            title={t("projectTools.browserMore")}
            aria-label={t("projectTools.browserMore")}
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent variant="soft" align="end" sideOffset={6} className="min-w-44">
            <DropdownMenuItem
              className="gap-2"
              disabled={pageControlsDisabled || !onOpenExternal}
              onSelect={() => {
                if (activeTab?.url) onOpenExternal?.(activeTab.url);
              }}
            >
              <ExternalLink className="size-3.5" />
              {t("projectTools.browserOpenExternal")}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="gap-2"
              disabled={!running}
              onSelect={() => void closeBrowser()}
            >
              <X className="size-3.5" />
              {t("projectTools.browserCloseBrowser")}
            </DropdownMenuItem>
            {importClient || client?.clearBrowsingData ? <DropdownMenuSeparator /> : null}
            {importClient ? (
              <DropdownMenuItem className="gap-2" onSelect={() => setImportOpen(true)}>
                <Download className="size-3.5" />
                {t("projectTools.browserImportMenu")}
              </DropdownMenuItem>
            ) : null}
            {client?.clearBrowsingData ? (
              <DropdownMenuItem className="gap-2" onSelect={() => void clearBrowsingData()}>
                <Trash2 className="size-3.5" />
                {t("projectTools.browserClearDataMenu")}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-background">
        {running && loading ? (
          <div className="absolute inset-x-0 top-0 z-20 h-0.5 animate-pulse bg-primary/60" />
        ) : null}
        {/* Interactive surface: the image is pointer-transparent so every
            event lands here and is mapped into page coordinates. */}
        <div
          ref={viewRef}
          role="application"
          aria-label={t("projectTools.browserPage")}
          className={cn(
            "absolute inset-0 overflow-hidden outline-none",
            picking ? "cursor-crosshair" : "cursor-default",
            viewFocused && !blank && "ring-1 ring-inset ring-ring/40",
          )}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onWheel={handleWheel}
          onContextMenu={(event) => event.preventDefault()}
        >
          <img
            ref={imageRef}
            alt=""
            draggable={false}
            className={cn(
              "pointer-events-none absolute inset-0 h-full w-full select-none object-contain object-left-top",
              (!hasFrame || blank) && "invisible",
            )}
          />
          <textarea
            ref={keyboardRef}
            aria-label={t("projectTools.browserPageInput")}
            tabIndex={-1}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="pointer-events-none absolute left-0 top-0 size-px resize-none opacity-0"
            onFocus={() => setViewFocused(true)}
            onBlur={() => setViewFocused(false)}
            onKeyDown={(event) => sendKey(event, "down")}
            onKeyUp={(event) => sendKey(event, "up")}
            onCompositionEnd={handleCompositionEnd}
            onPaste={handlePaste}
            onInput={(event) => {
              if (!event.nativeEvent || !(event.nativeEvent as InputEvent).isComposing) {
                event.currentTarget.value = "";
              }
            }}
          />
        </div>

        {showUnavailable ? (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background px-8 text-center">
            <AlertTriangle className="size-6 text-muted-foreground" />
            <div className="text-sm font-medium text-foreground">
              {t("projectTools.browserUnavailableTitle")}
            </div>
            <div className="max-w-72 text-xs leading-relaxed text-muted-foreground">
              {t("projectTools.browserUnavailableHint")}
            </div>
          </div>
        ) : loadError ? (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background px-8 text-center">
            <AlertTriangle className="size-6 text-amber-500" />
            <div className="text-sm font-medium text-foreground">
              {t("projectTools.browserLoadErrorTitle")}
            </div>
            <div className="max-w-80 text-xs leading-relaxed text-muted-foreground">
              {t(LOAD_ERROR_HINT_KEYS[classifyBrowserLoadError(loadError)])}
            </div>
            <div className="max-w-80 break-all font-mono text-[11px] leading-relaxed text-muted-foreground/80">
              {activeTab?.url ? <div>{activeTab.url}</div> : null}
              <div>{loadError}</div>
            </div>
            <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 rounded-lg px-3 text-xs"
                onClick={retryLoad}
              >
                <RotateCw className="size-3.5" />
                {t("projectTools.browserRetry")}
              </Button>
              {onOpenExternal && activeTab?.url ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 rounded-lg px-3 text-xs"
                  onClick={() => onOpenExternal(activeTab.url)}
                >
                  <ExternalLink className="size-3.5" />
                  {t("projectTools.browserOpenExternal")}
                </Button>
              ) : null}
            </div>
          </div>
        ) : blank ? (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background px-8 text-center">
            <div className="flex size-11 items-center justify-center rounded-xl bg-muted/80 text-muted-foreground">
              {starting ? (
                <Loader2 className="size-5 animate-spin" />
              ) : (
                <Globe className="size-5" />
              )}
            </div>
            <div className="text-sm font-medium text-foreground">
              {starting ? t("projectTools.browserStarting") : t("projectTools.browserEmptyTitle")}
            </div>
            <div className="max-w-72 text-xs leading-relaxed text-muted-foreground">
              {t("projectTools.browserEmptyHint")}
            </div>
          </div>
        ) : !hasFrame ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : null}

        {picking ? (
          <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center px-3">
            <div className="rounded-full bg-foreground/85 px-3 py-1 text-[11px] font-medium text-background shadow-sm">
              {t("projectTools.browserPickingHint")}
            </div>
          </div>
        ) : null}
        {notice ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3">
            <div
              role="status"
              className={cn(
                "max-w-full truncate rounded-full px-3 py-1 text-[11px] font-medium shadow-sm",
                notice.tone === "error"
                  ? "bg-destructive text-destructive-foreground"
                  : "bg-foreground/85 text-background",
              )}
            >
              {notice.text}
            </div>
          </div>
        ) : null}
      </div>
      {importOpen && importClient ? (
        <EmbeddedBrowserImportDialog
          client={importClient}
          onClose={() => setImportOpen(false)}
          onImported={reloadAfterImport}
        />
      ) : null}
      {confirmDialog}
    </div>
  );
}
