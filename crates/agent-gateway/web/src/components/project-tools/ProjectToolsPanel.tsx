import "@xterm/xterm/css/xterm.css";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocale } from "@/i18n";
import type {
  ProjectToolsFileTreeProjectState,
  ProjectToolsFileTreeStatePatch,
  ProjectToolsPanelTab,
} from "@/lib/settings";
import { cn } from "@/lib/shared/utils";
import type {
  TerminalClient,
  TerminalEvent,
  TerminalSession,
  TerminalShellOption,
  TerminalSnapshot,
} from "@/lib/terminal/types";
import { Check, ChevronRight, FolderTree, GripVertical, Plus, Terminal, X } from "../icons";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { ProjectFileTreePanel } from "./ProjectFileTreePanel";

const MIN_PANEL_WIDTH = 320;
const MAX_PANEL_WIDTH = 720;
const DEFAULT_TERMINAL_COLS = 80;
const DEFAULT_TERMINAL_ROWS = 24;
const FILE_TREE_TAB_ID = "__file_tree__";

type ProjectToolsPanelProps = {
  isOpen: boolean;
  projectPathKey: string;
  cwd: string;
  sessions?: TerminalSession[];
  width: number;
  theme: "light" | "dark";
  disabledMessage?: string;
  activeTab: ProjectToolsPanelTab;
  tabOrder?: string[];
  fileTreeOpen: boolean;
  fileTreeState: ProjectToolsFileTreeProjectState;
  client: TerminalClient;
  onWidthChange: (width: number) => void;
  onActiveTabChange: (tab: ProjectToolsPanelTab) => void;
  onTabOrderChange?: (tabOrder: string[]) => void;
  onFileTreeOpenChange: (open: boolean) => void;
  onFileTreeStateChange: (patch: ProjectToolsFileTreeStatePatch) => void;
  onSessionsChange?: (sessions: TerminalSession[]) => void;
  onInsertFileMention?: (path: string, kind: "file" | "dir") => void;
  onClose?: () => void;
};

function sortSessions(sessions: TerminalSession[]) {
  return [...sessions].sort((a, b) => a.createdAt - b.createdAt);
}

function areSessionsEqual(left: TerminalSession[], right: TerminalSession[]) {
  if (left.length !== right.length) return false;
  return left.every((session, index) => {
    const other = right[index];
    return (
      other &&
      session.id === other.id &&
      session.projectPathKey === other.projectPathKey &&
      session.cwd === other.cwd &&
      session.shell === other.shell &&
      session.title === other.title &&
      session.pid === other.pid &&
      session.cols === other.cols &&
      session.rows === other.rows &&
      session.createdAt === other.createdAt &&
      session.updatedAt === other.updatedAt &&
      session.finishedAt === other.finishedAt &&
      session.exitCode === other.exitCode &&
      session.running === other.running
    );
  });
}

function formatTerminalSessionTitle(title: string, terminalLabel: string) {
  const match = /^Terminal(?:\s+(\d+))?$/.exec(title.trim());
  if (!match) return title;
  return match[1] ? `${terminalLabel} ${match[1]}` : terminalLabel;
}

type ProjectToolsTab =
  | {
      id: string;
      kind: "terminal";
      session: TerminalSession;
    }
  | {
      id: typeof FILE_TREE_TAB_ID;
      kind: "fileTree";
    };

type TabDragState = {
  pointerId: number;
  draggedId: string;
  startX: number;
  startY: number;
  hasMoved: boolean;
  order: string[];
  previousUserSelect: string;
  captureElement: HTMLElement;
};

function tabOrderIdsEqual(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function orderProjectToolsTabs(tabs: ProjectToolsTab[], tabOrder: readonly string[]) {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const used = new Set<string>();
  const ordered: ProjectToolsTab[] = [];
  for (const id of tabOrder) {
    const tab = byId.get(id);
    if (!tab || used.has(id)) continue;
    used.add(id);
    ordered.push(tab);
  }
  for (const tab of tabs) {
    if (used.has(tab.id)) continue;
    ordered.push(tab);
  }
  return ordered;
}

function getReorderedTabIdsFromPointer(
  container: HTMLElement | null,
  draggedId: string,
  clientX: number,
) {
  if (!container) return null;
  const tabElements = Array.from(
    container.querySelectorAll<HTMLElement>("[data-project-tools-tab-id]"),
  );
  const currentIds = tabElements
    .map((element) => element.dataset.projectToolsTabId ?? "")
    .filter(Boolean);
  if (!currentIds.includes(draggedId)) return null;

  const idsWithoutDragged = currentIds.filter((id) => id !== draggedId);
  let insertIndex = idsWithoutDragged.length;
  let visibleIndex = 0;
  for (const element of tabElements) {
    const id = element.dataset.projectToolsTabId ?? "";
    if (!id || id === draggedId) continue;
    const rect = element.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) {
      insertIndex = visibleIndex;
      break;
    }
    visibleIndex += 1;
  }
  return [
    ...idsWithoutDragged.slice(0, insertIndex),
    draggedId,
    ...idsWithoutDragged.slice(insertIndex),
  ];
}

function autoScrollTabsForPointer(container: HTMLElement | null, clientX: number) {
  if (!container) return;
  const maxScrollLeft = container.scrollWidth - container.clientWidth;
  if (maxScrollLeft <= 1) return;
  const rect = container.getBoundingClientRect();
  const edgeSize = 32;
  const scrollStep = 18;
  if (clientX < rect.left + edgeSize) {
    container.scrollLeft = Math.max(0, container.scrollLeft - scrollStep);
  } else if (clientX > rect.right - edgeSize) {
    container.scrollLeft = Math.min(maxScrollLeft, container.scrollLeft + scrollStep);
  }
}

function reorderTabIdsByKeyboard(tabIds: readonly string[], tabId: string, key: string) {
  const currentIndex = tabIds.indexOf(tabId);
  if (currentIndex < 0) return null;

  let targetIndex = currentIndex;
  if (key === "ArrowLeft") {
    targetIndex = currentIndex - 1;
  } else if (key === "ArrowRight") {
    targetIndex = currentIndex + 1;
  } else if (key === "Home") {
    targetIndex = 0;
  } else if (key === "End") {
    targetIndex = tabIds.length - 1;
  } else {
    return null;
  }

  targetIndex = Math.max(0, Math.min(tabIds.length - 1, targetIndex));
  if (targetIndex === currentIndex) return null;

  const nextTabIds = [...tabIds];
  const [movedTabId] = nextTabIds.splice(currentIndex, 1);
  if (!movedTabId) return null;
  nextTabIds.splice(targetIndex, 0, movedTabId);
  return nextTabIds;
}

function terminalTheme(theme: "light" | "dark") {
  if (theme === "dark") {
    return {
      background: "#0b0f14",
      foreground: "#d6deeb",
      cursor: "#f8fafc",
      selectionBackground: "#334155",
      black: "#0f172a",
      red: "#ef4444",
      green: "#22c55e",
      yellow: "#eab308",
      blue: "#38bdf8",
      magenta: "#c084fc",
      cyan: "#2dd4bf",
      white: "#e5e7eb",
    };
  }
  return {
    background: "#ffffff",
    foreground: "#172033",
    cursor: "#111827",
    selectionBackground: "#dbeafe",
    black: "#111827",
    red: "#dc2626",
    green: "#16a34a",
    yellow: "#ca8a04",
    blue: "#2563eb",
    magenta: "#9333ea",
    cyan: "#0891b2",
    white: "#f8fafc",
  };
}

function XTermViewport({
  client,
  session,
  theme,
  onError,
}: {
  client: TerminalClient;
  session: TerminalSession;
  theme: "light" | "dark";
  onError: (message: string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const resizeTimerRef = useRef<number | null>(null);
  const clientRef = useRef(client);
  const sessionRef = useRef(session);
  const themeRef = useRef(theme);
  const onErrorRef = useRef(onError);
  clientRef.current = client;
  sessionRef.current = session;
  themeRef.current = theme;
  onErrorRef.current = onError;

  const termRef = useRef<XTerm | null>(null);

  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.theme = terminalTheme(theme);
  }, [theme]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let snapshotLoaded = false;
    let loadingSnapshot = false;
    let lastOutputOffset = 0;
    const bufferedEvents: TerminalEvent[] = [];
    const term = new XTerm({
      cursorBlink: true,
      disableStdin: true,
      fontFamily:
        '"SF Mono", SFMono-Regular, Menlo, Monaco, "Cascadia Code", Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      fontWeight: "normal",
      fontWeightBold: "bold",
      lineHeight: 1.1,
      letterSpacing: 0,
      scrollback: 5000,
      theme: terminalTheme(themeRef.current),
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    const fitAndResize = () => {
      if (disposed) return;
      try {
        fit.fit();
        const s = sessionRef.current;
        void clientRef.current
          .resize(s.id, term.cols, term.rows, s.projectPathKey)
          .catch(() => undefined);
      } catch {
        // xterm fit can throw while the panel is hidden or measuring at zero size.
      }
    };

    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
      }
      resizeTimerRef.current = window.setTimeout(fitAndResize, 40);
    });
    resizeObserver.observe(container);
    window.setTimeout(fitAndResize, 0);

    const dataDisposable = term.onData((data) => {
      if (!snapshotLoaded) return;
      const s = sessionRef.current;
      void clientRef.current.input(s.id, data, s.projectPathKey).catch((error) => {
        onErrorRef.current(error instanceof Error ? error.message : String(error));
      });
    });

    const replayBufferedEvents = () => {
      const events = bufferedEvents.splice(0);
      for (const event of events) {
        writeTerminalEvent(term, event, (nextOffset) => {
          lastOutputOffset = nextOffset;
        }, lastOutputOffset);
      }
    };

    const loadSnapshot = () => {
      if (disposed || loadingSnapshot) return;
      loadingSnapshot = true;
      const s = sessionRef.current;
      void clientRef.current
        .snapshot(s.id, undefined, s.projectPathKey)
        .then((snapshot) => {
          if (disposed) return;
          if (snapshot.output) {
            term.write(snapshot.output);
          }
          lastOutputOffset = terminalSnapshotEndOffset(snapshot);
          snapshotLoaded = true;
          loadingSnapshot = false;
          term.options.disableStdin = !snapshot.session.running;
          replayBufferedEvents();
          window.setTimeout(fitAndResize, 0);
        })
        .catch((error) => {
          loadingSnapshot = false;
          if (!disposed) {
            onErrorRef.current(error instanceof Error ? error.message : String(error));
          }
        });
    };

    const unsubscribe = clientRef.current.subscribe((event) => {
      if (disposed || event.sessionId !== session.id) return;
      if (event.kind === "output" && event.data) {
        if (snapshotLoaded && !loadingSnapshot) {
          writeTerminalEvent(term, event, (nextOffset) => {
            lastOutputOffset = nextOffset;
          }, lastOutputOffset);
        } else {
          bufferedEvents.push(event);
        }
      }
      if (event.kind === "exit" || event.kind === "closed") {
        term.options.disableStdin = true;
      }
    });

    loadSnapshot();

    return () => {
      disposed = true;
      termRef.current = null;
      unsubscribe();
      dataDisposable.dispose();
      resizeObserver.disconnect();
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      const s = sessionRef.current;
      void clientRef.current.detach(s.id, s.projectPathKey).catch(() => undefined);
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.projectPathKey]);

  return <div ref={containerRef} className="h-full min-h-0 w-full overflow-hidden px-2 py-2" />;
}

function terminalSnapshotEndOffset(snapshot: TerminalSnapshot) {
  if (
    typeof snapshot.outputEndOffset === "number" &&
    Number.isFinite(snapshot.outputEndOffset) &&
    snapshot.outputEndOffset >= 0
  ) {
    return snapshot.outputEndOffset;
  }
  const startOffset =
    typeof snapshot.outputStartOffset === "number" &&
    Number.isFinite(snapshot.outputStartOffset) &&
    snapshot.outputStartOffset >= 0
      ? snapshot.outputStartOffset
      : 0;
  return startOffset + utf8ByteLength(snapshot.output);
}

function writeTerminalEvent(
  term: XTerm,
  event: TerminalEvent,
  setLastOutputOffset: (offset: number) => void,
  lastOutputOffset: number,
): "written" | "skipped" {
  const data = event.data ?? "";
  if (!data) return "skipped";
  const startOffset = event.outputStartOffset;
  const endOffset = event.outputEndOffset;
  if (
    typeof startOffset === "number" &&
    Number.isFinite(startOffset) &&
    typeof endOffset === "number" &&
    Number.isFinite(endOffset) &&
    endOffset >= startOffset
  ) {
    if (endOffset <= lastOutputOffset) return "skipped";
    const alreadyWritten = Math.max(0, lastOutputOffset - startOffset);
    term.write(alreadyWritten > 0 ? sliceUtf8Bytes(data, alreadyWritten) : data);
    setLastOutputOffset(endOffset);
    return "written";
  }
  term.write(data);
  setLastOutputOffset(lastOutputOffset + utf8ByteLength(data));
  return "written";
}

function sliceUtf8Bytes(value: string, byteOffset: number) {
  if (byteOffset <= 0) return value;
  let consumed = 0;
  let index = 0;
  for (const segment of value) {
    const next = consumed + utf8ByteLengthOfCodePoint(segment);
    if (next <= byteOffset) {
      consumed = next;
      index += segment.length;
      continue;
    }
    if (consumed < byteOffset) {
      index += segment.length;
    }
    return value.slice(index);
  }
  return "";
}

function utf8ByteLength(value: string) {
  let length = 0;
  for (const segment of value) {
    length += utf8ByteLengthOfCodePoint(segment);
  }
  return length;
}

function utf8ByteLengthOfCodePoint(value: string) {
  const codePoint = value.codePointAt(0) ?? 0;
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function clampScrollLeft(value: number, max: number) {
  return Math.min(max, Math.max(0, value));
}

export function ProjectToolsPanel(props: ProjectToolsPanelProps) {
  const {
    isOpen,
    projectPathKey,
    cwd,
    sessions: externalSessions,
    width,
    theme,
    disabledMessage,
    activeTab,
    tabOrder = [],
    fileTreeOpen,
    fileTreeState,
    client,
    onWidthChange,
    onActiveTabChange,
    onTabOrderChange,
    onFileTreeOpenChange,
    onFileTreeStateChange,
    onSessionsChange,
    onInsertFileMention,
    onClose,
  } = props;
  const { t } = useLocale();
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [closingSessionId, setClosingSessionId] = useState("");
  const [pendingCloseSessionId, setPendingCloseSessionId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [shellOptions, setShellOptions] = useState<TerminalShellOption[]>([]);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [shouldRenderContent, setShouldRenderContent] = useState(isOpen);
  const [widthCollapsed, setWidthCollapsed] = useState(!isOpen);
  const [, setIsResizing] = useState(false);
  const projectReady = projectPathKey.trim() !== "" && cwd.trim() !== "" && !disabledMessage;
  const clampedWidth = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, width));
  const [draftWidth, setDraftWidth] = useState(clampedWidth);
  const lastProjectPathKeyRef = useRef(projectPathKey);
  const pendingResizeWidthRef = useRef(clampedWidth);
  const resizeFrameRef = useRef<number | null>(null);
  const resizingRef = useRef(false);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const tabsScrollRef = useRef<HTMLDivElement | null>(null);
  const tabDragRef = useRef<TabDragState | null>(null);
  const suppressedTabClickRef = useRef("");
  const tabsScrollbarDragRef = useRef<{
    pointerId: number;
    startX: number;
    startScrollLeft: number;
    trackWidth: number;
    thumbWidth: number;
    maxScrollLeft: number;
  } | null>(null);
  const panelWidth = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, draftWidth));
  const panelStyle = { "--project-tools-panel-width": `${panelWidth}px` } as CSSProperties;
  const isControlled = externalSessions !== undefined;
  const fileTreeInitialized = Boolean(projectPathKey && fileTreeOpen);
  const previousFileTreeInitializedRef = useRef(fileTreeInitialized);
  const currentActiveTab: ProjectToolsPanelTab =
    activeTab === "fileTree" && fileTreeInitialized ? "fileTree" : "terminal";

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? sessions[0] ?? null,
    [activeSessionId, sessions],
  );
  const pendingCloseSession = useMemo(
    () => sessions.find((session) => session.id === pendingCloseSessionId) ?? null,
    [pendingCloseSessionId, sessions],
  );
  const [draftTabOrder, setDraftTabOrder] = useState<string[] | null>(null);
  const [draggingTabId, setDraggingTabId] = useState("");
  const visibleTabs = useMemo<ProjectToolsTab[]>(() => {
    const terminalTabs: ProjectToolsTab[] = sessions.map((session) => ({
      id: session.id,
      kind: "terminal",
      session,
    }));
    return fileTreeInitialized
      ? [...terminalTabs, { id: FILE_TREE_TAB_ID, kind: "fileTree" }]
      : terminalTabs;
  }, [fileTreeInitialized, sessions]);
  const effectiveTabOrder = draftTabOrder ?? tabOrder;
  const orderedProjectTabs = useMemo(
    () => orderProjectToolsTabs(visibleTabs, effectiveTabOrder),
    [effectiveTabOrder, visibleTabs],
  );
  const orderedProjectTabIds = useMemo(
    () => orderedProjectTabs.map((tab) => tab.id),
    [orderedProjectTabs],
  );
  const canReorderTabs = orderedProjectTabIds.length > 1;
  const [tabsScrollState, setTabsScrollState] = useState({
    clientWidth: 0,
    scrollLeft: 0,
    scrollWidth: 0,
  });
  const [tabsScrollbarDragging, setTabsScrollbarDragging] = useState(false);
  const tabsMaxScrollLeft = Math.max(
    0,
    tabsScrollState.scrollWidth - tabsScrollState.clientWidth,
  );
  const tabsHaveOverflow = tabsMaxScrollLeft > 1;
  const tabsThumbWidth =
    tabsHaveOverflow && tabsScrollState.scrollWidth > 0
      ? Math.max(
          28,
          Math.min(
            tabsScrollState.clientWidth,
            (tabsScrollState.clientWidth / tabsScrollState.scrollWidth) *
              tabsScrollState.clientWidth,
          ),
        )
      : tabsScrollState.clientWidth;
  const tabsThumbOffset =
    tabsHaveOverflow && tabsMaxScrollLeft > 0
      ? (tabsScrollState.scrollLeft / tabsMaxScrollLeft) *
        Math.max(0, tabsScrollState.clientWidth - tabsThumbWidth)
      : 0;
  const tabsScrollbarThumbStyle = {
    transform: `translateX(${tabsThumbOffset}px)`,
    width: `${tabsThumbWidth}px`,
  } as CSSProperties;

  const updateTabsScrollState = useCallback(() => {
    const element = tabsScrollRef.current;
    const next = element
      ? {
          clientWidth: element.clientWidth,
          scrollLeft: element.scrollLeft,
          scrollWidth: element.scrollWidth,
        }
      : {
          clientWidth: 0,
          scrollLeft: 0,
          scrollWidth: 0,
        };

    setTabsScrollState((current) => {
      if (
        Math.abs(current.clientWidth - next.clientWidth) < 1 &&
        Math.abs(current.scrollLeft - next.scrollLeft) < 1 &&
        Math.abs(current.scrollWidth - next.scrollWidth) < 1
      ) {
        return current;
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const previousFileTreeInitialized = previousFileTreeInitializedRef.current;
    previousFileTreeInitializedRef.current = fileTreeInitialized;
    if (fileTreeInitialized && !previousFileTreeInitialized) {
      onActiveTabChange("fileTree");
      return;
    }
    if (!fileTreeInitialized && previousFileTreeInitialized && activeTab === "fileTree") {
      onActiveTabChange("terminal");
    }
  }, [activeTab, fileTreeInitialized, onActiveTabChange]);

  const publishSessions = useCallback(
    (nextSessions: TerminalSession[], options?: { notifyParent?: boolean }) => {
      const sorted = sortSessions(nextSessions);
      setSessions(sorted);
      if (options?.notifyParent !== false) {
        onSessionsChange?.(sorted);
      }
      setActiveSessionId((current) => {
        if (current && sorted.some((session) => session.id === current)) return current;
        return sorted[0]?.id ?? "";
      });
    },
    [onSessionsChange],
  );

  useEffect(() => {
    if (!externalSessions) return;
    const sorted = sortSessions(externalSessions);
    setSessions((current) => (areSessionsEqual(current, sorted) ? current : sorted));
    setActiveSessionId((current) => {
      if (current && sorted.some((session) => session.id === current)) return current;
      return sorted[0]?.id ?? "";
    });
  }, [externalSessions]);

  const refreshSessions = useCallback(() => {
    if (!projectReady) {
      publishSessions([], { notifyParent: false });
      return;
    }
    setLoading(true);
    setError(null);
    void client
      .list(projectPathKey)
      .then((nextSessions) => {
        publishSessions(nextSessions, { notifyParent: !isControlled });
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [client, isControlled, projectPathKey, projectReady, publishSessions]);

  useEffect(() => {
    if (!isOpen || isControlled) return;
    refreshSessions();
  }, [isControlled, isOpen, refreshSessions]);

  useEffect(() => {
    if (resizingRef.current) return;
    pendingResizeWidthRef.current = clampedWidth;
    setDraftWidth(clampedWidth);
  }, [clampedWidth]);

  useEffect(() => {
    updateTabsScrollState();
    const element = tabsScrollRef.current;
    if (!element) return;

    let frameId = 0;
    const scheduleUpdate = () => {
      if (frameId !== 0) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        updateTabsScrollState();
      });
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleUpdate);
    resizeObserver?.observe(element);
    Array.from(element.children).forEach((child) => {
      if (child instanceof HTMLElement) {
        resizeObserver?.observe(child);
      }
    });
    scheduleUpdate();

    return () => {
      if (frameId !== 0) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver?.disconnect();
    };
  }, [
    activeSessionId,
    currentActiveTab,
    fileTreeInitialized,
    isOpen,
    panelWidth,
    sessions,
    shellOptions.length,
    orderedProjectTabIds,
    updateTabsScrollState,
  ]);

  useEffect(() => {
    if (!isOpen) return;
    const element = tabsScrollRef.current;
    if (!element) return;
    const targetTabId = currentActiveTab === "fileTree" ? FILE_TREE_TAB_ID : activeSession?.id;
    if (!targetTabId) return;
    const target = Array.from(
      element.querySelectorAll<HTMLElement>("[data-project-tools-tab-id]"),
    ).find((node) => node.dataset.projectToolsTabId === targetTabId);
    target?.scrollIntoView({ block: "nearest", inline: "nearest" });
    window.requestAnimationFrame(updateTabsScrollState);
  }, [activeSession?.id, currentActiveTab, isOpen, updateTabsScrollState]);

  useEffect(() => {
    return () => {
      const dragState = tabDragRef.current;
      if (dragState?.hasMoved) {
        document.body.style.userSelect = dragState.previousUserSelect;
      }
      tabDragRef.current = null;
      resizeCleanupRef.current?.();
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (isOpen) {
      setWidthCollapsed(false);
      setShouldRenderContent(true);
      return;
    }
    const timer = window.setTimeout(() => {
      setShouldRenderContent(false);
      setWidthCollapsed(true);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [isOpen]);

  useEffect(() => {
    if (!projectReady) {
      setShellOptions([]);
      return;
    }
    let cancelled = false;
    void client
      .shellOptions()
      .then((response) => {
        if (cancelled) return;
        setShellOptions(response.options);
      })
      .catch(() => {
        if (!cancelled) {
          setShellOptions([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, projectReady]);

  useEffect(() => {
    if (!projectReady || isControlled) return;
    return client.subscribe((event) => {
      if (event.projectPathKey !== projectPathKey) return;
      if (event.kind === "output") return;
      setSessions((current) => {
        let next = current;
        if (event.kind === "closed") {
          next = current.filter((session) => session.id !== event.sessionId);
        } else {
          const index = current.findIndex((session) => session.id === event.sessionId);
          if (index >= 0) {
            next = [...current];
            next[index] = event.session;
          } else if (event.kind === "created") {
            next = [...current, event.session];
          }
        }
        const sorted = sortSessions(next);
        onSessionsChange?.(sorted);
        return sorted;
      });
    });
  }, [client, isControlled, onSessionsChange, projectPathKey, projectReady]);

  useEffect(() => {
    if (lastProjectPathKeyRef.current === projectPathKey) return;
    lastProjectPathKeyRef.current = projectPathKey;
    setPendingCloseSessionId("");
    setClosingSessionId("");
    setDraftTabOrder(null);
    setDraggingTabId("");
    tabDragRef.current = null;
  }, [projectPathKey]);

  useEffect(() => {
    if (!draftTabOrder) return;
    if (tabOrderIdsEqual(draftTabOrder, tabOrder)) {
      setDraftTabOrder(null);
    }
  }, [draftTabOrder, tabOrder]);

  const setFileTreeInitialized = useCallback(
    (initialized: boolean) => {
      if (!projectPathKey) return;
      onFileTreeOpenChange(initialized);
    },
    [onFileTreeOpenChange, projectPathKey],
  );

  useEffect(() => {
    if (!pendingCloseSessionId) return;
    if (!sessions.some((session) => session.id === pendingCloseSessionId)) {
      setPendingCloseSessionId("");
    }
  }, [pendingCloseSessionId, sessions]);

  const createTerminal = useCallback(
    (shell?: string) => {
      if (!projectReady || creating) return;
      setCreating(true);
      setError(null);
      void client
        .create({
          cwd,
          projectPathKey,
          shell: shell?.trim() || undefined,
          cols: DEFAULT_TERMINAL_COLS,
          rows: DEFAULT_TERMINAL_ROWS,
        })
        .then((snapshot) => {
          setSessions((current) => {
            const next = sortSessions([
              ...current.filter((session) => session.id !== snapshot.session.id),
              snapshot.session,
            ]);
            onSessionsChange?.(next);
            return next;
          });
          setActiveSessionId(snapshot.session.id);
          onActiveTabChange("terminal");
        })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setCreating(false));
    },
    [client, creating, cwd, onActiveTabChange, onSessionsChange, projectPathKey, projectReady],
  );

  const handleCreate = useCallback(() => {
    createTerminal();
  }, [createTerminal]);

  const closeSession = useCallback(
    (session: TerminalSession) => {
      if (closingSessionId === session.id) return;
      setError(null);
      setClosingSessionId(session.id);
      void client
        .close(session.id, session.projectPathKey)
        .then(() => {
          setPendingCloseSessionId((current) => (current === session.id ? "" : current));
          setSessions((current) => {
            const next = sortSessions(current.filter((item) => item.id !== session.id));
            onSessionsChange?.(next);
            return next;
          });
        })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setClosingSessionId((current) => (current === session.id ? "" : current)));
    },
    [client, closingSessionId, onSessionsChange],
  );

  const handleCloseRequest = useCallback(
    (session: TerminalSession) => {
      setError(null);
      if (session.running && pendingCloseSessionId !== session.id) {
        setActiveSessionId(session.id);
        setPendingCloseSessionId(session.id);
        return;
      }
      closeSession(session);
    },
    [closeSession, pendingCloseSessionId],
  );

  const consumeSuppressedTabClick = useCallback((tabId: string) => {
    if (suppressedTabClickRef.current !== tabId) return false;
    suppressedTabClickRef.current = "";
    return true;
  }, []);

  const handleTabPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, tabId: string) => {
      if (event.button !== 0 || orderedProjectTabIds.length < 2) return;
      event.stopPropagation();
      tabDragRef.current = {
        pointerId: event.pointerId,
        draggedId: tabId,
        startX: event.clientX,
        startY: event.clientY,
        hasMoved: false,
        order: orderedProjectTabIds,
        previousUserSelect: "",
        captureElement: event.currentTarget,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [orderedProjectTabIds],
  );

  const handleTabReorderKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, tabId: string) => {
      if (orderedProjectTabIds.length < 2) return;
      const nextOrder = reorderTabIdsByKeyboard(orderedProjectTabIds, tabId, event.key);
      if (!nextOrder) return;

      event.preventDefault();
      event.stopPropagation();
      setDraftTabOrder(nextOrder);
      onTabOrderChange?.(nextOrder);

      const tabElement = event.currentTarget.closest("[data-project-tools-tab-id]");
      if (tabElement instanceof HTMLElement) {
        window.requestAnimationFrame(() => {
          tabElement.scrollIntoView({ block: "nearest", inline: "nearest" });
          updateTabsScrollState();
        });
      }
    },
    [onTabOrderChange, orderedProjectTabIds, updateTabsScrollState],
  );

  const handleTabPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const dragState = tabDragRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) return;

      const deltaX = event.clientX - dragState.startX;
      const deltaY = event.clientY - dragState.startY;
      if (!dragState.hasMoved && Math.hypot(deltaX, deltaY) < 5) return;
      if (!dragState.hasMoved) {
        dragState.hasMoved = true;
        dragState.previousUserSelect = document.body.style.userSelect;
        document.body.style.userSelect = "none";
        setDraggingTabId(dragState.draggedId);
      }

      event.preventDefault();
      autoScrollTabsForPointer(tabsScrollRef.current, event.clientX);
      const nextOrder = getReorderedTabIdsFromPointer(
        tabsScrollRef.current,
        dragState.draggedId,
        event.clientX,
      );
      if (!nextOrder || tabOrderIdsEqual(nextOrder, dragState.order)) return;
      dragState.order = nextOrder;
      setDraftTabOrder(nextOrder);
      updateTabsScrollState();
    },
    [updateTabsScrollState],
  );

  const finishTabDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const dragState = tabDragRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) return;

      tabDragRef.current = null;
      if (dragState.captureElement.hasPointerCapture(event.pointerId)) {
        dragState.captureElement.releasePointerCapture(event.pointerId);
      }
      if (dragState.hasMoved) {
        document.body.style.userSelect = dragState.previousUserSelect;
        suppressedTabClickRef.current = dragState.draggedId;
        onTabOrderChange?.(dragState.order);
      }
      setDraggingTabId("");
      updateTabsScrollState();
    },
    [onTabOrderChange, updateTabsScrollState],
  );

  const renderTabDragHandle = useCallback(
    (tabId: string, label: string) => (
      <button
        type="button"
        data-project-tools-tab-action="drag"
        aria-label={`${t("projectTools.reorderTab")} ${label}`}
        title={t("projectTools.reorderTabHint")}
        disabled={!canReorderTabs}
        tabIndex={canReorderTabs ? 0 : -1}
        className={cn(
          "flex h-6 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/45 opacity-70 transition-[background-color,color,opacity] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          canReorderTabs
            ? "cursor-grab touch-none hover:bg-background/80 hover:text-foreground hover:opacity-100 focus-visible:bg-background focus-visible:text-foreground focus-visible:opacity-100 active:cursor-grabbing"
            : "cursor-default opacity-30",
        )}
        onKeyDown={(event) => handleTabReorderKeyDown(event, tabId)}
        onPointerCancel={finishTabDrag}
        onPointerDown={(event) => handleTabPointerDown(event, tabId)}
        onPointerMove={handleTabPointerMove}
        onPointerUp={finishTabDrag}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
    ),
    [
      canReorderTabs,
      finishTabDrag,
      handleTabPointerDown,
      handleTabPointerMove,
      handleTabReorderKeyDown,
      t,
    ],
  );

  const handleResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      resizeCleanupRef.current?.();
      const startX = event.clientX;
      const startWidth = panelWidth;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      resizingRef.current = true;
      setIsResizing(true);
      pendingResizeWidthRef.current = startWidth;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const scheduleDraftWidth = (nextWidth: number) => {
        pendingResizeWidthRef.current = nextWidth;
        if (resizeFrameRef.current !== null) return;
        resizeFrameRef.current = window.requestAnimationFrame(() => {
          resizeFrameRef.current = null;
          setDraftWidth(pendingResizeWidthRef.current);
        });
      };

      const cleanupResize = () => {
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
        window.removeEventListener("blur", handleUp);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        resizingRef.current = false;
        resizeCleanupRef.current = null;
      };

      const handleMove = (moveEvent: globalThis.MouseEvent) => {
        const nextWidth = Math.min(
          MAX_PANEL_WIDTH,
          Math.max(MIN_PANEL_WIDTH, startWidth + startX - moveEvent.clientX),
        );
        scheduleDraftWidth(nextWidth);
      };

      const handleUp = () => {
        cleanupResize();
        if (resizeFrameRef.current !== null) {
          window.cancelAnimationFrame(resizeFrameRef.current);
          resizeFrameRef.current = null;
        }
        const finalWidth = pendingResizeWidthRef.current;
        setDraftWidth(finalWidth);
        if (finalWidth !== clampedWidth) {
          onWidthChange(finalWidth);
        }
        setIsResizing(false);
      };

      resizeCleanupRef.current = cleanupResize;
      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
      window.addEventListener("blur", handleUp);
    },
    [clampedWidth, onWidthChange, panelWidth],
  );

  const handleTabsWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      const element = tabsScrollRef.current;
      if (!element) return;
      const maxScrollLeft = element.scrollWidth - element.clientWidth;
      if (maxScrollLeft <= 1) return;

      const delta =
        Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (delta === 0) return;

      const nextScrollLeft = clampScrollLeft(element.scrollLeft + delta, maxScrollLeft);
      if (Math.abs(nextScrollLeft - element.scrollLeft) < 1) return;

      event.preventDefault();
      element.scrollLeft = nextScrollLeft;
      updateTabsScrollState();
    },
    [updateTabsScrollState],
  );

  const handleTabsScrollbarPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !tabsHaveOverflow) return;
      const element = tabsScrollRef.current;
      if (!element) return;

      event.preventDefault();
      const track = event.currentTarget;
      const rect = track.getBoundingClientRect();
      const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
      const thumbWidth =
        maxScrollLeft > 0 && element.scrollWidth > 0
          ? Math.max(
              28,
              Math.min(
                rect.width,
                (element.clientWidth / element.scrollWidth) * rect.width,
              ),
            )
          : rect.width;
      const travelWidth = Math.max(1, rect.width - thumbWidth);
      const clickedThumb =
        event.target instanceof HTMLElement &&
        event.target.closest(".project-tools-panel-tabs-scrollbar-thumb") !== null;
      const nextScrollLeft = clickedThumb
        ? element.scrollLeft
        : clampScrollLeft(
            ((event.clientX - rect.left - thumbWidth / 2) / travelWidth) * maxScrollLeft,
            maxScrollLeft,
          );

      element.scrollLeft = nextScrollLeft;
      tabsScrollbarDragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startScrollLeft: nextScrollLeft,
        trackWidth: rect.width,
        thumbWidth,
        maxScrollLeft,
      };
      setTabsScrollbarDragging(true);
      track.setPointerCapture(event.pointerId);
      updateTabsScrollState();
    },
    [tabsHaveOverflow, updateTabsScrollState],
  );

  const handleTabsScrollbarPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const dragState = tabsScrollbarDragRef.current;
      const element = tabsScrollRef.current;
      if (!dragState || !element || dragState.pointerId !== event.pointerId) return;

      event.preventDefault();
      const travelWidth = Math.max(1, dragState.trackWidth - dragState.thumbWidth);
      const scrollDelta =
        ((event.clientX - dragState.startX) / travelWidth) * dragState.maxScrollLeft;
      element.scrollLeft = clampScrollLeft(
        dragState.startScrollLeft + scrollDelta,
        dragState.maxScrollLeft,
      );
      updateTabsScrollState();
    },
    [updateTabsScrollState],
  );

  const finishTabsScrollbarDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = tabsScrollbarDragRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    tabsScrollbarDragRef.current = null;
    setTabsScrollbarDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const showFirstOpenChooser = projectReady && sessions.length === 0 && !fileTreeInitialized;

  const startFileTree = useCallback(() => {
    setFileTreeInitialized(true);
    onActiveTabChange("fileTree");
  }, [onActiveTabChange, setFileTreeInitialized]);

  const closeFileTree = useCallback(() => {
    setFileTreeInitialized(false);
    if (activeTab === "fileTree") {
      onActiveTabChange("terminal");
    }
  }, [activeTab, onActiveTabChange, setFileTreeInitialized]);

  const renderCreateTerminalMenuItem = () => {
    if (shellOptions.length > 1) {
      return (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={!projectReady || creating} className="gap-2 text-xs">
            <Terminal className="h-3.5 w-3.5" />
            <span className="min-w-0 flex-1">{t("projectTools.newTerminal")}</span>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-36">
            {shellOptions.map((option) => (
              <DropdownMenuItem
                key={option.id}
                onSelect={() => createTerminal(option.id)}
                disabled={!projectReady || creating}
                className="gap-2 text-xs"
                title={option.command || option.label}
              >
                <Terminal className="h-3.5 w-3.5" />
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      );
    }

    return (
      <DropdownMenuItem
        onSelect={handleCreate}
        disabled={!projectReady || creating}
        className="gap-2 text-xs"
      >
        <Terminal className="h-3.5 w-3.5" />
        {t("projectTools.newTerminal")}
      </DropdownMenuItem>
    );
  };

  return (
    <aside
      aria-hidden={!isOpen}
      inert={!isOpen}
      data-state={isOpen ? "open" : "closed"}
      className={cn(
        "project-tools-panel fixed inset-x-0 bottom-0 z-40 flex h-[min(72vh,34rem)] min-h-0 w-full shrink-0 flex-col overflow-hidden bg-background shadow-2xl transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none md:relative md:inset-auto md:z-10 md:h-full md:shadow-none",
        isOpen
          ? "pointer-events-auto translate-y-0 border-t border-border opacity-100 md:w-[var(--project-tools-panel-width)] md:translate-x-0 md:border-l md:border-t-0"
          : "pointer-events-none translate-y-full border-t border-transparent opacity-0 md:translate-x-3 md:translate-y-0 md:border-l-0 md:border-t-0",
        widthCollapsed ? "md:w-0" : "md:w-[var(--project-tools-panel-width)]",
      )}
      style={panelStyle}
    >
      <div
        className={cn(
          "project-tools-panel-inner flex h-full min-h-0 w-full flex-col transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none md:w-[var(--project-tools-panel-width)] md:min-w-[var(--project-tools-panel-width)]",
          isOpen
            ? "translate-y-0 opacity-100 md:translate-x-0"
            : "translate-y-3 opacity-0 md:translate-x-2 md:translate-y-0",
        )}
      >
        {shouldRenderContent ? (
          <>
            <button
              type="button"
              aria-label={t("projectTools.resizePanel")}
              title={t("projectTools.resizePanel")}
              className="absolute inset-y-0 left-0 hidden w-1 cursor-col-resize border-0 bg-transparent p-0 md:block"
              onMouseDown={handleResizeStart}
            />
            <div className="project-tools-panel-handle" aria-hidden="true" />
            <div className="project-tools-panel-header flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
              <div className="project-tools-panel-tabs-shell min-w-0 flex-1 overflow-hidden">
                <div
                  ref={tabsScrollRef}
                  className="project-tools-panel-tabs flex min-w-0 items-center gap-1 overflow-x-auto overflow-y-hidden"
                  onScroll={updateTabsScrollState}
                  onWheel={handleTabsWheel}
                >
                  {orderedProjectTabs.map((tab) => {
                    if (tab.kind === "fileTree") {
                      return (
                        <div
                          key={tab.id}
                          data-project-tools-tab-id={tab.id}
                          className={cn(
                            "project-tools-panel-tab group flex h-8 max-w-[12rem] shrink-0 select-none items-center gap-1 rounded-md border border-transparent px-1.5 text-xs text-muted-foreground transition-[background-color,border-color,color,opacity,transform,box-shadow] hover:bg-muted/80 hover:text-foreground",
                            currentActiveTab === "fileTree" &&
                              "border-border bg-muted text-foreground shadow-sm",
                            draggingTabId === tab.id &&
                              "z-10 scale-[0.98] opacity-80 shadow-md ring-1 ring-ring",
                          )}
                          title={t("projectTools.fileTreeTitle")}
                        >
                          {renderTabDragHandle(tab.id, t("projectTools.fileTreeTitle"))}
                          <button
                            type="button"
                            onClick={() => {
                              if (consumeSuppressedTabClick(tab.id)) return;
                              onActiveTabChange("fileTree");
                            }}
                            className="flex min-w-0 flex-1 items-center gap-1.5 bg-transparent p-0 text-left text-inherit"
                          >
                            <FolderTree className="h-3.5 w-3.5 shrink-0" />
                            <span className="min-w-0 truncate">
                              {t("projectTools.fileTreeTitle")}
                            </span>
                          </button>
                          <button
                            type="button"
                            data-project-tools-tab-action="close"
                            aria-label={t("projectTools.closeFileTree")}
                            title={t("projectTools.closeFileTree")}
                            className="ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-background hover:text-foreground focus-visible:bg-background focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                            onPointerDown={(event) => {
                              event.stopPropagation();
                            }}
                            onMouseDown={(event) => {
                              event.stopPropagation();
                            }}
                            onClick={(event) => {
                              event.stopPropagation();
                              closeFileTree();
                            }}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      );
                    }

                    const session = tab.session;
                    const isPendingClose = pendingCloseSessionId === session.id;
                    const isClosing = closingSessionId === session.id;
                    const sessionTitle = formatTerminalSessionTitle(
                      session.title,
                      t("projectTools.terminalTitle"),
                    );
                    return (
                      <div
                        key={session.id}
                        data-project-tools-tab-id={session.id}
                        className={cn(
                          "project-tools-panel-tab group flex h-8 max-w-[12rem] shrink-0 select-none items-center gap-1 rounded-md border border-transparent px-1.5 text-xs text-muted-foreground transition-[background-color,border-color,color,opacity,transform,box-shadow] hover:bg-muted/80 hover:text-foreground",
                          currentActiveTab === "terminal" &&
                            activeSession?.id === session.id &&
                            "border-border bg-muted text-foreground shadow-sm",
                          isPendingClose &&
                            "bg-destructive/10 text-destructive hover:bg-destructive/15",
                          draggingTabId === session.id &&
                            "z-10 scale-[0.98] opacity-80 shadow-md ring-1 ring-ring",
                        )}
                        title={sessionTitle}
                      >
                        {renderTabDragHandle(session.id, sessionTitle)}
                        <button
                          type="button"
                          onClick={() => {
                            if (consumeSuppressedTabClick(session.id)) return;
                            setActiveSessionId(session.id);
                            onActiveTabChange("terminal");
                          }}
                          className="flex min-w-0 flex-1 items-center gap-1.5 bg-transparent p-0 text-left text-inherit"
                        >
                          <Terminal className="h-3.5 w-3.5 shrink-0" />
                          <span className="min-w-0 truncate">{sessionTitle}</span>
                          {!session.running ? (
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                          ) : (
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                          )}
                        </button>
                        <button
                          type="button"
                          data-project-tools-tab-action="close"
                          aria-label={`${isPendingClose ? t("projectTools.confirmClose") : t("projectTools.close")} ${sessionTitle}`}
                          title={
                            isPendingClose
                              ? t("projectTools.confirmCloseTerminal")
                              : t("projectTools.closeTerminal")
                          }
                          disabled={isClosing}
                          className={cn(
                            "ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-background hover:text-foreground focus-visible:bg-background focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
                            isPendingClose
                              ? "bg-destructive/10 text-destructive hover:bg-destructive hover:text-destructive-foreground md:opacity-100"
                              : "md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100",
                          )}
                          onPointerDown={(event) => {
                            event.stopPropagation();
                          }}
                          onMouseDown={(event) => {
                            event.stopPropagation();
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                            handleCloseRequest(session);
                          }}
                        >
                          {isPendingClose ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                        </button>
                      </div>
                    );
                  })}
                </div>
                <div
                  aria-hidden="true"
                  className={cn(
                    "project-tools-panel-tabs-scrollbar",
                    tabsHaveOverflow && "project-tools-panel-tabs-scrollbar-visible",
                    tabsScrollbarDragging && "project-tools-panel-tabs-scrollbar-dragging",
                  )}
                  onPointerCancel={finishTabsScrollbarDrag}
                  onPointerDown={handleTabsScrollbarPointerDown}
                  onPointerMove={handleTabsScrollbarPointerMove}
                  onPointerUp={finishTabsScrollbarDrag}
                >
                  <div
                    className="project-tools-panel-tabs-scrollbar-thumb"
                    style={tabsScrollbarThumbStyle}
                  />
                </div>
              </div>
              <DropdownMenu open={createMenuOpen} onOpenChange={setCreateMenuOpen}>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={!projectReady || creating}
                    title={t("projectTools.newProjectTool")}
                    className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={6} className="min-w-40">
                  {renderCreateTerminalMenuItem()}
                  <DropdownMenuItem
                    onSelect={startFileTree}
                    disabled={!projectReady}
                    className="gap-2 text-xs"
                  >
                    <FolderTree className="h-3.5 w-3.5" />
                    {t("projectTools.newFileTree")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {onClose ? (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onClose}
                  title={t("projectTools.closePanel")}
                  className="project-tools-panel-close h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground md:hidden"
                >
                  <X className="h-4 w-4" />
                </Button>
              ) : null}
            </div>

            {pendingCloseSession ? (
              <div className="flex shrink-0 items-center gap-2 border-b border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                <span className="min-w-0 flex-1 truncate">
                  {t("projectTools.closeRunningTerminal").replace(
                    "{title}",
                    formatTerminalSessionTitle(
                      pendingCloseSession.title,
                      t("projectTools.terminalTitle"),
                    ),
                  )}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 px-2.5 text-xs"
                  onClick={() => setPendingCloseSessionId("")}
                >
                  {t("settings.cancel")}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  className="h-7 shrink-0 px-2.5 text-xs"
                  disabled={closingSessionId === pendingCloseSession.id}
                  onClick={() => closeSession(pendingCloseSession)}
                >
                  {t("projectTools.close")}
                </Button>
              </div>
            ) : null}

            {disabledMessage ? (
              <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
                {disabledMessage}
              </div>
            ) : showFirstOpenChooser ? (
              <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-4 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={handleCreate}
                  disabled={!projectReady || creating}
                  className="flex min-h-36 flex-col items-center justify-center gap-3 rounded-lg border border-border bg-background px-4 py-5 text-center text-sm text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
                >
                  <Terminal className="h-8 w-8 text-muted-foreground" />
                  <span className="font-medium">{t("projectTools.newTerminal")}</span>
                </button>
                <button
                  type="button"
                  onClick={startFileTree}
                  className="flex min-h-36 flex-col items-center justify-center gap-3 rounded-lg border border-border bg-background px-4 py-5 text-center text-sm text-foreground transition-colors hover:bg-muted"
                >
                  <FolderTree className="h-8 w-8 text-muted-foreground" />
                  <span className="font-medium">{t("projectTools.newFileTree")}</span>
                </button>
                {loading ? (
                  <div className="col-span-full text-center text-xs text-muted-foreground">
                    {t("projectTools.loading")}
                  </div>
                ) : null}
                {error ? (
                  <div className="col-span-full text-center text-xs text-destructive">
                    {error}
                  </div>
                ) : null}
              </div>
            ) : (
              <>
                {fileTreeInitialized ? (
                  <div
                    className={cn(
                      "min-h-0 flex-1",
                      currentActiveTab === "fileTree" ? "block" : "hidden",
                    )}
                  >
                    <ProjectFileTreePanel
                      key={projectPathKey}
                      projectPathKey={projectPathKey}
                      cwd={cwd}
                      initialized={fileTreeInitialized}
                      syncState={fileTreeState}
                      onInitializedChange={setFileTreeInitialized}
                      onSyncStateChange={onFileTreeStateChange}
                      onInsertFileMention={onInsertFileMention}
                    />
                  </div>
                ) : null}
                {currentActiveTab === "terminal" ? (
                  activeSession ? (
                    <div className="flex min-h-0 flex-1 flex-col">
                      {error ? (
                        <div className="border-b border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                          {error}
                        </div>
                      ) : null}
                      <div className="min-h-0 flex-1">
                        <XTermViewport
                          key={activeSession.id}
                          client={client}
                          session={activeSession}
                          theme={theme}
                          onError={setError}
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                      <Terminal className="h-8 w-8 text-muted-foreground" />
                      <Button onClick={handleCreate} disabled={!projectReady || creating}>
                        {t("projectTools.newTerminal")}
                      </Button>
                      {loading ? (
                        <div className="text-xs text-muted-foreground">
                          {t("projectTools.loading")}
                        </div>
                      ) : null}
                      {error ? <div className="text-xs text-destructive">{error}</div> : null}
                    </div>
                  )
                ) : null}
              </>
            )}
          </>
        ) : null}
      </div>
    </aside>
  );
}
