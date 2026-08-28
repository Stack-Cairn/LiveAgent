import "@xterm/xterm/css/xterm.css";

import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XTerm } from "@xterm/xterm";
import {
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useLocale } from "../../i18n/index";
import {
  absoluteWorkspacePath,
  clearActiveWorkspacePathDrag,
  getActiveWorkspacePathDrag,
  hasWorkspacePathDragPayload,
  quoteWorkspacePathForShell,
  readWorkspacePathDragPayload,
  workspacePathDragMatchesProject,
} from "../../lib/chat/workspacePathDrag";
import { CODE_FONT_FAMILY_CHANGE_EVENT, getCodeFontFamily } from "../../lib/shared/fontFamily";
import { cn } from "../../lib/shared/utils";
import type {
  TerminalClient,
  TerminalSession,
  TerminalSnapshot,
  TerminalStreamChunk,
  TerminalStreamHandle,
  TerminalStreamInputState,
} from "../../lib/terminal/types";

type XTermViewportProps = {
  client: TerminalClient;
  session: TerminalSession;
  theme: "light" | "dark";
  isActive: boolean;
  initialSnapshot?: TerminalSnapshot;
  className?: string;
  onError: (sessionId: string, message: string | null) => void;
  onInitialSnapshotConsumed?: (sessionId: string) => void;
};

const SNAPSHOT_ATTACH_RETRY_MIN_MS = 500;
const SNAPSHOT_ATTACH_RETRY_MAX_MS = 5_000;
// 容器连续变化（divider 拖动）时的两级节流：视觉 fit 周期性执行保持跟手，
// PTY resize 只在尺寸稳定后（尾沿）提交一次，避免拖动过程向后端刷 resize。
const FIT_THROTTLE_MS = 80;
const PTY_RESIZE_DEBOUNCE_MS = 100;

function terminalTheme(theme: "light" | "dark") {
  if (theme === "dark") {
    return {
      background: "#0b0f14",
      foreground: "#4ade80",
      cursor: "#f8fafc",
      cursorAccent: "#0b0f14",
      selectionBackground: "#2c3e57",
      selectionInactiveBackground: "#22304a",
      scrollbarSliderBackground: "rgba(148, 163, 184, 0.18)",
      scrollbarSliderHoverBackground: "rgba(148, 163, 184, 0.3)",
      scrollbarSliderActiveBackground: "rgba(148, 163, 184, 0.42)",
      // xterm 的 css.toColor 不认关键字 "transparent"(canvas 回退路径遇到
      // alpha<255 直接 throw),解析失败会静默落回默认色 #ffffff——overview
      // ruler 每帧都会用该色画一条 1px 竖线(_renderRulerOutline),即终端右缘
      // 的白线。8 位 hex 走独立分支不校验 alpha,才是真正的透明写法。
      overviewRulerBorder: "#00000000",
      black: "#1b2733",
      red: "#ef4444",
      green: "#22c55e",
      yellow: "#eab308",
      blue: "#38bdf8",
      magenta: "#c084fc",
      cyan: "#2dd4bf",
      white: "#cbd5e1",
      brightBlack: "#64748b",
      brightRed: "#f87171",
      brightGreen: "#4ade80",
      brightYellow: "#fde047",
      brightBlue: "#7dd3fc",
      brightMagenta: "#d8b4fe",
      brightCyan: "#5eead4",
      brightWhite: "#f8fafc",
    };
  }
  return {
    background: "#fcfcfd",
    foreground: "#1f2933",
    cursor: "#111827",
    cursorAccent: "#fcfcfd",
    selectionBackground: "#bfdbfe",
    selectionInactiveBackground: "#dbeafe",
    scrollbarSliderBackground: "rgba(100, 116, 139, 0.16)",
    scrollbarSliderHoverBackground: "rgba(100, 116, 139, 0.26)",
    scrollbarSliderActiveBackground: "rgba(100, 116, 139, 0.36)",
    // 同暗色主题:8 位 hex 透明,勿改回 "transparent"(见上)。
    overviewRulerBorder: "#00000000",
    black: "#1f2933",
    red: "#dc2626",
    green: "#16a34a",
    yellow: "#b45309",
    blue: "#2563eb",
    magenta: "#9333ea",
    cyan: "#0891b2",
    white: "#e2e8f0",
    brightBlack: "#64748b",
    brightRed: "#ef4444",
    brightGreen: "#22c55e",
    brightYellow: "#d97706",
    brightBlue: "#3b82f6",
    brightMagenta: "#a855f7",
    brightCyan: "#06b6d4",
    brightWhite: "#f8fafc",
  };
}

function terminalContainerHasSize(container: HTMLElement) {
  const rect = container.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

// execCommand("copy") 兜底：textarea.select() 会抢走焦点，复制完把焦点还给
// 原元素（终端），避免用户复制一次后键盘输入丢失。
function fallbackCopyTextToClipboard(text: string) {
  const active = document.activeElement;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
  if (active instanceof HTMLElement) active.focus();
}

// 非安全上下文（http 直连 gateway web）里 navigator.clipboard 整个不存在，
// 所以「API 缺失」和「writeText 被拒绝」都必须落到 execCommand 兜底——
// 只把兜底挂在 catch 上会让最需要它的环境静默失败。
function writeTextToClipboard(text: string) {
  if (!text) return;
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => fallbackCopyTextToClipboard(text));
    return;
  }
  fallbackCopyTextToClipboard(text);
}

export function XTermViewport({
  client,
  session,
  theme,
  isActive,
  initialSnapshot,
  className,
  onError,
  onInitialSnapshotConsumed,
}: XTermViewportProps) {
  const { t } = useLocale();
  const containerRef = useRef<HTMLDivElement>(null);
  const [workspacePathDropState, setWorkspacePathDropState] = useState<"accept" | "blocked" | null>(
    null,
  );
  const resizeTimerRef = useRef<number | null>(null);
  const sessionRef = useRef(session);
  const themeRef = useRef(theme);
  const onErrorRef = useRef(onError);
  const initialSnapshotRef = useRef(initialSnapshot);
  const onInitialSnapshotConsumedRef = useRef(onInitialSnapshotConsumed);
  sessionRef.current = session;
  themeRef.current = theme;
  onErrorRef.current = onError;
  onInitialSnapshotConsumedRef.current = onInitialSnapshotConsumed;

  const termRef = useRef<XTerm | null>(null);
  const fitAndResizeRef = useRef<(() => void) | null>(null);
  const viewportStyle = {
    "--project-terminal-background": terminalTheme(theme).background,
  } as CSSProperties;

  const canAcceptWorkspacePath = useCallback(
    (payload = getActiveWorkspacePathDrag()) =>
      Boolean(
        payload &&
          session.kind === "local" &&
          workspacePathDragMatchesProject(payload, session.cwd) &&
          !termRef.current?.options.disableStdin,
      ),
    [session.cwd, session.kind],
  );

  const handleWorkspacePathDragOver = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!hasWorkspacePathDragPayload(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      const state = canAcceptWorkspacePath() ? "accept" : "blocked";
      event.dataTransfer.dropEffect = state === "accept" ? "copy" : "none";
      setWorkspacePathDropState(state);
    },
    [canAcceptWorkspacePath],
  );

  const handleWorkspacePathDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!hasWorkspacePathDragPayload(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      const payload = readWorkspacePathDragPayload(event.dataTransfer);
      setWorkspacePathDropState(null);
      clearActiveWorkspacePathDrag();
      if (!payload || !canAcceptWorkspacePath(payload)) return;
      const absolutePath = absoluteWorkspacePath(payload);
      const quotedPath = absolutePath
        ? quoteWorkspacePathForShell(absolutePath, session.shell)
        : null;
      if (!quotedPath) return;
      termRef.current?.paste(quotedPath);
      termRef.current?.focus();
    },
    [canAcceptWorkspacePath, session.shell],
  );

  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.theme = terminalTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (!isActive) {
      termRef.current?.blur();
      return;
    }
    termRef.current?.focus();
    window.setTimeout(() => {
      fitAndResizeRef.current?.();
    }, 0);
  }, [isActive]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: project identity intentionally recreates the terminal session viewport
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let snapshotLoaded = false;
    let loadingSnapshot = false;
    let renderedOutput = false;
    let lastOutputOffset = 0;
    let streamHandle: TerminalStreamHandle | null = null;
    let inputPausedByStream = false;
    let inputBackpressureMessageActive = false;
    let snapshotRetryTimer: number | null = null;
    let snapshotRetryDelayMs = SNAPSHOT_ATTACH_RETRY_MIN_MS;
    const bufferedChunks: TerminalStreamChunk[] = [];
    const encoder = new TextEncoder();
    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: "block",
      cursorInactiveStyle: "outline",
      disableStdin: true,
      fontFamily: getCodeFontFamily(),
      fontSize: 13,
      fontWeight: "normal",
      fontWeightBold: "bold",
      lineHeight: 1.3,
      letterSpacing: 0,
      scrollback: 5000,
      overviewRuler: {
        width: 8,
      },
      theme: terminalTheme(themeRef.current),
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    // 终端复制/粘贴快捷键：xterm 的键盘映射不处理 Ctrl+Shift+字母（^C 控制
    // 字符分支要求无 shift）和 Cmd 组合，所以选中后按 Ctrl+Shift+C/Cmd+C
    // 什么都不发生（#355）。挂自定义键盘处理：Ctrl+Shift+C/V（Linux/Windows）
    // 和 Cmd+C/V（macOS）走剪贴板，其余按键全部放行由 xterm 自行处理。
    // 命中分支必须 event.preventDefault()：返回 false 只跳过 xterm 自身处理，
    // 浏览器默认行为仍会执行——Chromium 的 Ctrl+Shift+V 和 macOS 的 Cmd+V
    // 会另行派发原生 paste 事件（xterm 在 textarea 上有原生 paste 监听），
    // 不拦截同一次按键会粘贴两遍。
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const key = event.key.toLowerCase();
      const isMod =
        (event.ctrlKey && event.shiftKey) || (event.metaKey && !event.ctrlKey && !event.altKey);
      if (isMod && key === "c") {
        const selection = term.getSelection();
        if (!selection) return true;
        event.preventDefault();
        writeTextToClipboard(selection);
        term.focus();
        return false;
      }
      if (isMod && key === "v") {
        const clipboard = navigator.clipboard;
        // 非安全上下文里 readText 不存在，此时放行让原生 paste 事件路径
        // （macOS Cmd+V / Chromium Ctrl+Shift+V）作为仅剩的粘贴通道。
        if (!clipboard?.readText) return true;
        event.preventDefault();
        void clipboard.readText().then((text) => {
          if (text) term.paste(text);
        });
        return false;
      }
      return true;
    });
    // WebGL 渲染器：多 Pane 同时渲染时 DOM 渲染器主线程压力线性叠加，WebGL
    // 走 GPU。上下文创建失败（WebGL2 不可用）或运行中丢失时回退默认渲染器。
    let webglAddon: WebglAddon | null = null;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        addon.dispose();
        if (webglAddon === addon) webglAddon = null;
      });
      term.loadAddon(addon);
      webglAddon = addon;
    } catch {
      webglAddon = null;
    }
    let touchScrollActive = false;
    let touchScrollCancelled = false;
    let lastTouchX = 0;
    let lastTouchY = 0;
    let touchScrollRemainder = 0;

    const reportError = (message: string | null) => {
      onErrorRef.current(sessionRef.current.id, message);
    };

    const focusTerminal = () => {
      if (disposed || !sessionRef.current.running) return;
      term.focus();
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      focusTerminal();
    };

    let ptyResizeTimer: number | null = null;
    let lastVisualFitAt = 0;

    // 视觉 fit：只重排 xterm 网格（term.cols/rows 随之更新），不触发后端。
    const fitVisual = () => {
      if (disposed) return;
      if (!terminalContainerHasSize(container)) return;
      lastVisualFitAt = Date.now();
      try {
        fit.fit();
      } catch {
        // xterm fit can throw while the panel is hidden or measuring at zero size.
      }
    };

    // PTY resize 提交：尾沿去抖，尺寸稳定后一定提交最终值（streamBuffer 内部
    // 还有 16ms 合并，双层叠加后拖动过程后端只收到稳定尺寸）。
    const schedulePtyResizeCommit = () => {
      if (ptyResizeTimer !== null) {
        window.clearTimeout(ptyResizeTimer);
      }
      ptyResizeTimer = window.setTimeout(() => {
        ptyResizeTimer = null;
        if (disposed) return;
        streamHandle?.resize(term.cols, term.rows);
      }, PTY_RESIZE_DEBOUNCE_MS);
    };

    const fitAndResize = () => {
      if (disposed) return;
      if (!terminalContainerHasSize(container)) return;
      fitVisual();
      schedulePtyResizeCommit();
    };
    fitAndResizeRef.current = fitAndResize;

    const handleCodeFontFamilyChange = (event: Event) => {
      const codeFontFamily = (event as CustomEvent<string>).detail;
      if (typeof codeFontFamily !== "string") return;
      term.options.fontFamily = codeFontFamily;
      window.setTimeout(fitAndResize, 0);
    };
    window.addEventListener(CODE_FONT_FAMILY_CHANGE_EVENT, handleCodeFontFamilyChange);

    const resizeObserver = new ResizeObserver(() => {
      // 拖动中周期性做视觉 fit 保持跟手（节流 FIT_THROTTLE_MS）……
      if (Date.now() - lastVisualFitAt >= FIT_THROTTLE_MS) {
        fitVisual();
      }
      // ……尾沿再做一次最终 fit + PTY resize 提交，保证结束尺寸一定生效。
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
      }
      resizeTimerRef.current = window.setTimeout(fitAndResize, 40);
    });
    resizeObserver.observe(container);
    window.setTimeout(fitAndResize, 0);

    const applyStdinState = () => {
      term.options.disableStdin = !sessionRef.current.running || inputPausedByStream;
    };

    const applyInputState = (state: TerminalStreamInputState) => {
      inputPausedByStream = state.paused;
      applyStdinState();
      if (state.paused) {
        inputBackpressureMessageActive = true;
        reportError(terminalInputPausedMessage(state));
      } else if (inputBackpressureMessageActive) {
        inputBackpressureMessageActive = false;
        reportError(null);
      }
    };

    const dataDisposable = term.onData((data) => {
      if (!streamHandle || term.options.disableStdin) return;
      const accepted = streamHandle.write(encoder.encode(data));
      if (!accepted && !inputPausedByStream) {
        applyInputState({
          paused: true,
          queuedBytes: 0,
          highWaterBytes: 256 * 1024,
          reason: "slow",
        });
      }
    });

    const getTouchScrollRowHeight = () =>
      Math.max(8, Math.floor(container.clientHeight / Math.max(1, term.rows)));

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        touchScrollCancelled = true;
        touchScrollActive = false;
        touchScrollRemainder = 0;
        return;
      }
      const touch = event.touches[0];
      if (!touch) return;
      touchScrollCancelled = false;
      touchScrollActive = false;
      touchScrollRemainder = 0;
      lastTouchX = touch.clientX;
      lastTouchY = touch.clientY;
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (touchScrollCancelled || event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (!touch) return;

      const deltaX = touch.clientX - lastTouchX;
      const deltaY = touch.clientY - lastTouchY;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);
      if (!touchScrollActive) {
        if (absX > absY && absX > 8) {
          touchScrollCancelled = true;
          return;
        }
        if (absY < 8) return;
        touchScrollActive = true;
      }

      lastTouchX = touch.clientX;
      lastTouchY = touch.clientY;
      touchScrollRemainder += -deltaY;
      const rowHeight = getTouchScrollRowHeight();
      const rows = Math.trunc(touchScrollRemainder / rowHeight);
      if (rows !== 0) {
        term.scrollLines(rows);
        touchScrollRemainder -= rows * rowHeight;
      }
      event.preventDefault();
    };

    const resetTouchScroll = () => {
      touchScrollActive = false;
      touchScrollCancelled = false;
      touchScrollRemainder = 0;
    };

    const handleTouchEnd = () => {
      const shouldFocus = !touchScrollActive && !touchScrollCancelled;
      resetTouchScroll();
      if (shouldFocus) {
        focusTerminal();
      }
    };

    const handleTouchCancel = () => {
      resetTouchScroll();
    };

    container.addEventListener("pointerdown", handlePointerDown);
    container.addEventListener("touchstart", handleTouchStart, { passive: true });
    container.addEventListener("touchmove", handleTouchMove, { passive: false });
    container.addEventListener("touchend", handleTouchEnd);
    container.addEventListener("touchcancel", handleTouchCancel);

    const snapshotBytes = (snapshot: TerminalSnapshot) => {
      if (snapshot.outputBytes) return snapshot.outputBytes;
      return encoder.encode(snapshot.output);
    };

    const writeChunk = (chunk: TerminalStreamChunk) => {
      const result = writeTerminalChunk(
        term,
        chunk,
        (nextOffset) => {
          lastOutputOffset = nextOffset;
        },
        lastOutputOffset,
      );
      if (result !== "skipped") {
        renderedOutput = true;
      }
    };

    const applySnapshot = (snapshot: TerminalSnapshot) => {
      const bytes = snapshotBytes(snapshot);
      const startOffset = terminalSnapshotStartOffset(snapshot);
      const endOffset = terminalSnapshotEndOffset(snapshot);
      if (!renderedOutput) {
        if (bytes.byteLength > 0) {
          term.write(bytes);
          renderedOutput = true;
        }
        lastOutputOffset = endOffset;
      } else if (startOffset > lastOutputOffset || snapshot.truncated) {
        // The snapshot no longer lines up with what is already on screen
        // (output was dropped while detached, or the agent ring truncated):
        // replay from scratch instead of appending duplicated/garbled bytes.
        term.reset();
        if (bytes.byteLength > 0) {
          term.write(bytes);
        }
        lastOutputOffset = endOffset;
      } else if (endOffset > lastOutputOffset) {
        const alreadyWritten = lastOutputOffset - startOffset;
        const pending = alreadyWritten > 0 ? bytes.subarray(alreadyWritten) : bytes;
        if (pending.byteLength > 0) {
          term.write(pending);
        }
        lastOutputOffset = endOffset;
      }
      snapshotLoaded = true;
      loadingSnapshot = false;
      applyStdinState();
      replayBufferedChunks();
      window.setTimeout(fitAndResize, 0);
    };

    const replayBufferedChunks = () => {
      const chunks = bufferedChunks.splice(0);
      for (const chunk of chunks) {
        writeChunk(chunk);
      }
    };

    const clearSnapshotRetryTimer = () => {
      if (snapshotRetryTimer !== null) {
        window.clearTimeout(snapshotRetryTimer);
        snapshotRetryTimer = null;
      }
    };

    const scheduleSnapshotRetry = () => {
      if (disposed || streamHandle || snapshotRetryTimer !== null) return;
      const delay = snapshotRetryDelayMs;
      snapshotRetryDelayMs = Math.min(snapshotRetryDelayMs * 2, SNAPSHOT_ATTACH_RETRY_MAX_MS);
      snapshotRetryTimer = window.setTimeout(() => {
        snapshotRetryTimer = null;
        loadSnapshot();
      }, delay);
    };

    const loadSnapshot = () => {
      if (disposed || loadingSnapshot) return;
      loadingSnapshot = true;
      const s = sessionRef.current;
      void client.stream
        .attach(s)
        .then((handle) => {
          if (disposed) {
            handle.dispose();
            return;
          }
          streamHandle = handle;
          clearSnapshotRetryTimer();
          snapshotRetryDelayMs = SNAPSHOT_ATTACH_RETRY_MIN_MS;
          reportError(null);
          streamOutputUnsubscribe = handle.subscribeOutput((chunk) => {
            if (disposed || chunk.sessionId !== sessionRef.current.id) return;
            if (snapshotLoaded && !loadingSnapshot) {
              writeChunk(chunk);
            } else {
              bufferedChunks.push(chunk);
            }
          });
          streamInputUnsubscribe = handle.subscribeInputState((state) => {
            if (disposed) return;
            applyInputState(state);
          });
          const snapshot: TerminalSnapshot = {
            session: handle.snapshot.session,
            output: "",
            outputBytes: handle.snapshot.bytes,
            truncated: handle.snapshot.truncated,
            outputStartOffset: handle.snapshot.outputStartOffset,
            outputEndOffset: handle.snapshot.outputEndOffset,
          };
          const initial = initialSnapshotRef.current;
          if (initial?.session.id === sessionRef.current.id) {
            initialSnapshotRef.current = undefined;
            onInitialSnapshotConsumedRef.current?.(initial.session.id);
          }
          applySnapshot(snapshot);
        })
        .catch((error) => {
          loadingSnapshot = false;
          if (!disposed) {
            reportError(error instanceof Error ? error.message : String(error));
            snapshotLoaded = false;
            applyStdinState();
            scheduleSnapshotRetry();
          }
        });
    };

    let streamOutputUnsubscribe: (() => void) | null = null;
    let streamInputUnsubscribe: (() => void) | null = null;
    const unsubscribe = client.subscribe((event) => {
      if (disposed || event.sessionId !== session.id) return;
      if (event.kind === "exit" || event.kind === "closed" || event.kind === "reconnecting") {
        term.options.disableStdin = true;
      }
      if (event.kind === "reconnected") {
        applyStdinState();
        window.setTimeout(fitAndResize, 0);
      }
    });

    // Offline-first: paint the cached snapshot immediately so the terminal has
    // content while attach is pending or retrying; a successful attach then
    // trims by offset (or resets on gap/truncation). The snapshot is only
    // consumed — and its owner notified — once attach succeeds.
    const initial = initialSnapshotRef.current;
    if (initial && initial.session.id === sessionRef.current.id) {
      applySnapshot(initial);
    }

    loadSnapshot();

    return () => {
      disposed = true;
      termRef.current = null;
      fitAndResizeRef.current = null;
      unsubscribe();
      dataDisposable.dispose();
      resizeObserver.disconnect();
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      if (ptyResizeTimer !== null) {
        window.clearTimeout(ptyResizeTimer);
        ptyResizeTimer = null;
      }
      clearSnapshotRetryTimer();
      container.removeEventListener("pointerdown", handlePointerDown);
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchmove", handleTouchMove);
      container.removeEventListener("touchend", handleTouchEnd);
      container.removeEventListener("touchcancel", handleTouchCancel);
      streamOutputUnsubscribe?.();
      streamInputUnsubscribe?.();
      streamHandle?.dispose();
      // 先释放 WebGL 上下文再销毁 terminal，避免 dispose 顺序问题。
      try {
        webglAddon?.dispose();
      } catch {
        // 上下文已丢失时 dispose 可能抛错，忽略。
      }
      webglAddon = null;
      term.dispose();
      window.removeEventListener(CODE_FONT_FAMILY_CHANGE_EVENT, handleCodeFontFamilyChange);
    };
  }, [client, session.id, session.projectPathKey]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the xterm viewport is a pointer drop target; keyboard users paste or use the file-tree context menu.
    <div
      style={viewportStyle}
      className={cn(
        "project-terminal-viewport relative h-full min-h-0 w-full overflow-hidden",
        className,
      )}
      data-workspace-path-drop-zone={workspacePathDropState ?? "idle"}
      onDragEnter={handleWorkspacePathDragOver}
      onDragOver={handleWorkspacePathDragOver}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setWorkspacePathDropState(null);
      }}
      onDrop={handleWorkspacePathDrop}
    >
      <div ref={containerRef} className="h-full min-h-0 w-full" />
      {workspacePathDropState ? (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-lg border-2 border-dashed bg-background/90 text-xs font-medium backdrop-blur-sm",
            workspacePathDropState === "accept"
              ? "border-emerald-500/70 text-emerald-600 dark:text-emerald-300"
              : "border-destructive/60 text-destructive",
          )}
        >
          {workspacePathDropState === "accept"
            ? t("projectTools.workspacePathDrop.insert")
            : session.kind === "ssh"
              ? t("projectTools.workspacePathDrop.sshBlocked")
              : t("projectTools.workspacePathDrop.crossProject")}
        </div>
      ) : null}
    </div>
  );
}

function terminalInputPausedMessage(state: TerminalStreamInputState) {
  if (state.reason === "offline") {
    return "终端连接正在恢复，已暂停输入以避免过期按键。";
  }
  if (state.reason === "closed") {
    return "终端输入已关闭。";
  }
  return "终端连接较慢，已暂停输入以避免输入队列过大。";
}

function terminalSnapshotStartOffset(snapshot: TerminalSnapshot) {
  if (
    typeof snapshot.outputStartOffset === "number" &&
    Number.isFinite(snapshot.outputStartOffset) &&
    snapshot.outputStartOffset >= 0
  ) {
    return snapshot.outputStartOffset;
  }
  return 0;
}

function terminalSnapshotEndOffset(snapshot: TerminalSnapshot) {
  if (
    typeof snapshot.outputEndOffset === "number" &&
    Number.isFinite(snapshot.outputEndOffset) &&
    snapshot.outputEndOffset >= 0
  ) {
    return snapshot.outputEndOffset;
  }
  return (
    terminalSnapshotStartOffset(snapshot) +
    (snapshot.outputBytes?.byteLength ?? new TextEncoder().encode(snapshot.output).byteLength)
  );
}

// Exported for tests: offset bookkeeping for live terminal chunks, including
// the reconnect-gap reset path.
export function writeTerminalChunk(
  term: Pick<XTerm, "write" | "reset">,
  chunk: TerminalStreamChunk,
  setLastOutputOffset: (offset: number) => void,
  lastOutputOffset: number,
): "written" | "skipped" | "reset" {
  const data = chunk.bytes;
  if (data.byteLength === 0) return "skipped";
  const startOffset = chunk.startOffset;
  const endOffset = chunk.endOffset;
  if (
    typeof startOffset === "number" &&
    Number.isFinite(startOffset) &&
    typeof endOffset === "number" &&
    Number.isFinite(endOffset) &&
    endOffset >= startOffset
  ) {
    if (endOffset <= lastOutputOffset) return "skipped";
    if (startOffset > lastOutputOffset) {
      // A hole in the byte stream: the transport replayed a snapshot after a
      // reconnect (the stream client injects the full buffered content as one
      // chunk) or the agent ring dropped bytes. Appending would duplicate or
      // garble the screen, so redraw from the authoritative chunk instead.
      term.reset();
      term.write(data);
      setLastOutputOffset(endOffset);
      return "reset";
    }
    const alreadyWritten = lastOutputOffset - startOffset;
    term.write(alreadyWritten > 0 ? data.subarray(alreadyWritten) : data);
    setLastOutputOffset(endOffset);
    return "written";
  }
  term.write(data);
  setLastOutputOffset(lastOutputOffset + data.byteLength);
  return "written";
}
