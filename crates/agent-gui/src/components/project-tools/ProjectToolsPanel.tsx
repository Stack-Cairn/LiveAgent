import "@xterm/xterm/css/xterm.css";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocale } from "../../i18n";
import type {
  ProjectToolsFileTreeProjectState,
  ProjectToolsFileTreeStatePatch,
  ProjectToolsPanelTab,
} from "../../lib/settings";
import type { GitClient } from "../../lib/git/types";
import { cn } from "../../lib/shared/utils";
import type {
  TerminalClient,
  TerminalEvent,
  TerminalSession,
  TerminalShellOption,
  TerminalSnapshot,
} from "../../lib/terminal/types";
import {
  Check,
  ChevronRight,
  FolderTree,
  GitBranch,
  GripVertical,
  Plus,
  Terminal,
  X,
} from "../icons";
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
import {
  GitReviewPanel,
  type GitCommitContextPayload,
  type GitFileContextPayload,
} from "./GitReviewPanel";
import { ProjectFileTreePanel } from "./ProjectFileTreePanel";

const MIN_PANEL_WIDTH = 320;
const DEFAULT_MAX_PANEL_WIDTH = 720;
const ABSOLUTE_MAX_PANEL_WIDTH = 1280;
const MIN_MAIN_CONTENT_WIDTH = 420;
const DEFAULT_TERMINAL_COLS = 80;
const DEFAULT_TERMINAL_ROWS = 24;
const FILE_TREE_TAB_ID = "__file_tree__";
const GIT_REVIEW_TAB_ID = "__git_review__";
const PROJECT_TOOLS_RESIZE_END_EVENT = "liveagent:project-tools-resize-end";

type ProjectToolsPanelProps = {
  isOpen: boolean;
  collapseImmediately?: boolean;
  projectPathKey: string;
  cwd: string;
  sessions?: TerminalSession[];
  width: number;
  theme: "light" | "dark";
  disabledMessage?: string;
  terminalDisabledMessage?: string;
  activeTab: ProjectToolsPanelTab;
  tabOrder?: string[];
  fileTreeOpen: boolean;
  fileTreeState: ProjectToolsFileTreeProjectState;
  gitReviewOpen: boolean;
  client: TerminalClient;
  gitClient?: GitClient | null;
  gitWriteEnabled?: boolean;
  gitDisabledMessage?: string;
  onWidthChange: (width: number) => void;
  onActiveTabChange: (tab: ProjectToolsPanelTab) => void;
  onTabOrderChange?: (tabOrder: string[]) => void;
  onFileTreeOpenChange: (open: boolean) => void;
  onFileTreeStateChange: (patch: ProjectToolsFileTreeStatePatch) => void;
  onGitReviewOpenChange: (open: boolean) => void;
  onSessionsChange?: (sessions: TerminalSession[]) => void;
  onInsertFileMention?: (path: string, kind: "file" | "dir") => void;
  onOpenFile?: (path: string) => void;
  onInsertCommitMention?: (commit: GitCommitContextPayload) => void;
  onInsertGitFileMention?: (file: GitFileContextPayload) => void;
  onClose?: () => void;
};

function sortSessions(sessions: TerminalSession[]) {
  return [...sessions].sort((a, b) => a.createdAt - b.createdAt);
}

function getFallbackMaxPanelWidth() {
  if (typeof window === "undefined") return DEFAULT_MAX_PANEL_WIDTH;
  return Math.max(
    DEFAULT_MAX_PANEL_WIDTH,
    Math.min(ABSOLUTE_MAX_PANEL_WIDTH, window.innerWidth - MIN_MAIN_CONTENT_WIDTH),
  );
}

function getDynamicMaxPanelWidth(panel: HTMLElement | null) {
  if (!panel) return getFallbackMaxPanelWidth();
  const parent = panel.parentElement;
  const sibling = panel.previousElementSibling;
  const parentRect = parent?.getBoundingClientRect();
  const siblingRect = sibling instanceof HTMLElement ? sibling.getBoundingClientRect() : null;
  const hostWidth =
    parentRect && siblingRect
      ? parentRect.right - siblingRect.left
      : (parentRect?.width ?? panel.getBoundingClientRect().width);
  if (!Number.isFinite(hostWidth) || hostWidth <= 0) {
    return getFallbackMaxPanelWidth();
  }
  return Math.max(
    MIN_PANEL_WIDTH,
    Math.min(ABSOLUTE_MAX_PANEL_WIDTH, Math.floor(hostWidth - MIN_MAIN_CONTENT_WIDTH)),
  );
}

function clampPanelWidth(width: number, maxWidth: number) {
  return Math.min(maxWidth, Math.max(MIN_PANEL_WIDTH, width));
}

function panelWidthStyleValue(width: number) {
  return `${Math.round(width)}px`;
}

function applyPanelWidthStyle(panel: HTMLElement | null, width: number) {
  panel?.style.setProperty("--project-tools-panel-width", panelWidthStyleValue(width));
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

function dirname(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : "";
}

function expandedPathsForFileTreePath(path: string) {
  const normalized = path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  const parts = normalized.split("/").filter(Boolean);
  const dirs = parts.slice(0, -1);
  return ["", ...dirs.map((_, index) => parts.slice(0, index + 1).join("/"))];
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
    }
  | {
      id: typeof GIT_REVIEW_TAB_ID;
      kind: "gitReview";
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
        writeTerminalEvent(
          term,
          event,
          (nextOffset) => {
            lastOutputOffset = nextOffset;
          },
          lastOutputOffset,
        );
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
          writeTerminalEvent(
            term,
            event,
            (nextOffset) => {
              lastOutputOffset = nextOffset;
            },
            lastOutputOffset,
          );
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

export function ProjectToolsPanel(props: ProjectToolsPanelProps) {
  const {
    isOpen,
    collapseImmediately = false,
    projectPathKey,
    cwd,
    sessions: externalSessions,
    width,
    theme,
    disabledMessage,
    terminalDisabledMessage,
    activeTab,
    tabOrder = [],
    fileTreeOpen,
    fileTreeState,
    gitReviewOpen,
    client,
    gitClient,
    gitWriteEnabled = true,
    gitDisabledMessage,
    onWidthChange,
    onActiveTabChange,
    onTabOrderChange,
    onFileTreeOpenChange,
    onFileTreeStateChange,
    onGitReviewOpenChange,
    onSessionsChange,
    onInsertFileMention,
    onOpenFile,
    onInsertCommitMention,
    onInsertGitFileMention,
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
  const [isResizing, setIsResizing] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const [maxPanelWidth, setMaxPanelWidth] = useState(getFallbackMaxPanelWidth);
  const projectReady = projectPathKey.trim() !== "" && cwd.trim() !== "" && !disabledMessage;
  const terminalReady = projectReady && !terminalDisabledMessage;
  const clampedWidth = clampPanelWidth(width, maxPanelWidth);
  const [draftWidth, setDraftWidth] = useState(clampedWidth);
  const lastProjectPathKeyRef = useRef(projectPathKey);
  const pendingResizeWidthRef = useRef(clampedWidth);
  const resizeFrameRef = useRef<number | null>(null);
  const resizingRef = useRef(false);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const tabsScrollRef = useRef<HTMLDivElement | null>(null);
  const tabDragRef = useRef<TabDragState | null>(null);
  const suppressedTabClickRef = useRef("");
  const panelWidth = clampPanelWidth(draftWidth, maxPanelWidth);
  const panelStyleWidth = resizingRef.current ? pendingResizeWidthRef.current : panelWidth;
  const panelStyle = {
    "--project-tools-panel-width": panelWidthStyleValue(panelStyleWidth),
  } as CSSProperties;
  const effectiveWidthCollapsed = !isOpen && collapseImmediately ? true : widthCollapsed;
  const effectiveShouldRenderContent = !isOpen && collapseImmediately ? false : shouldRenderContent;
  const isControlled = externalSessions !== undefined;
  const fileTreeInitialized = Boolean(projectPathKey && fileTreeOpen);
  const gitReviewInitialized = Boolean(projectPathKey && gitReviewOpen);
  const previousFileTreeInitializedRef = useRef(fileTreeInitialized);
  const previousGitReviewInitializedRef = useRef(gitReviewInitialized);
  const currentActiveTab: ProjectToolsPanelTab =
    activeTab === "gitReview" && gitReviewInitialized
      ? "gitReview"
      : activeTab === "fileTree" && fileTreeInitialized
        ? "fileTree"
        : "terminal";

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
    const nextTabs: ProjectToolsTab[] = [...terminalTabs];
    if (fileTreeInitialized) {
      nextTabs.push({ id: FILE_TREE_TAB_ID, kind: "fileTree" });
    }
    if (gitReviewInitialized) {
      nextTabs.push({ id: GIT_REVIEW_TAB_ID, kind: "gitReview" });
    }
    return nextTabs;
  }, [fileTreeInitialized, gitReviewInitialized, sessions]);
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

  useEffect(() => {
    const previousGitReviewInitialized = previousGitReviewInitializedRef.current;
    previousGitReviewInitializedRef.current = gitReviewInitialized;
    if (gitReviewInitialized && !previousGitReviewInitialized) {
      onActiveTabChange("gitReview");
      return;
    }
    if (!gitReviewInitialized && previousGitReviewInitialized && activeTab === "gitReview") {
      onActiveTabChange("terminal");
    }
  }, [activeTab, gitReviewInitialized, onActiveTabChange]);

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
    if (!terminalReady) {
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
  }, [client, isControlled, projectPathKey, publishSessions, terminalReady]);

  useEffect(() => {
    if (!isOpen || isControlled) return;
    refreshSessions();
  }, [isControlled, isOpen, refreshSessions]);

  useEffect(() => {
    if (resizingRef.current) return;
    pendingResizeWidthRef.current = clampedWidth;
    applyPanelWidthStyle(panelRef.current, clampedWidth);
    setDraftWidth(clampedWidth);
  }, [clampedWidth]);

  useEffect(() => {
    if (!isOpen) return;
    const panel = panelRef.current;
    let frameId = 0;
    const updateMaxWidth = () => {
      frameId = 0;
      if (resizingRef.current) return;
      setMaxPanelWidth(getDynamicMaxPanelWidth(panel));
    };
    const scheduleUpdate = () => {
      if (frameId !== 0) return;
      frameId = window.requestAnimationFrame(updateMaxWidth);
    };
    scheduleUpdate();
    window.addEventListener("resize", scheduleUpdate);
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleUpdate);
    if (panel) {
      resizeObserver?.observe(panel);
      if (panel.previousElementSibling instanceof HTMLElement) {
        resizeObserver?.observe(panel.previousElementSibling);
      }
      if (panel.parentElement) {
        resizeObserver?.observe(panel.parentElement);
      }
    }
    return () => {
      window.removeEventListener("resize", scheduleUpdate);
      if (frameId !== 0) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver?.disconnect();
    };
  }, [isOpen]);

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
    if (collapseImmediately) {
      setShouldRenderContent(false);
      setWidthCollapsed(true);
      return;
    }
    const timer = window.setTimeout(() => {
      setShouldRenderContent(false);
      setWidthCollapsed(true);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [collapseImmediately, isOpen]);

  useEffect(() => {
    if (!terminalReady) {
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
  }, [client, terminalReady]);

  useEffect(() => {
    if (!terminalReady || isControlled) return;
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
  }, [client, isControlled, onSessionsChange, projectPathKey, terminalReady]);

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
      if (!terminalReady || creating) return;
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
    [client, creating, cwd, onActiveTabChange, onSessionsChange, projectPathKey, terminalReady],
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
        });
      }
    },
    [onTabOrderChange, orderedProjectTabIds],
  );

  const handleTabPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
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
  }, []);

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
    },
    [onTabOrderChange],
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
      const dragMaxWidth = getDynamicMaxPanelWidth(panelRef.current);
      const startWidth = clampPanelWidth(panelWidth, dragMaxWidth);
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      resizingRef.current = true;
      setMaxPanelWidth(dragMaxWidth);
      setIsResizing(true);
      pendingResizeWidthRef.current = startWidth;
      applyPanelWidthStyle(panelRef.current, startWidth);
      panelRef.current?.setAttribute("data-project-tools-resizing", "true");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const schedulePanelWidth = (nextWidth: number) => {
        pendingResizeWidthRef.current = nextWidth;
        if (resizeFrameRef.current !== null) return;
        resizeFrameRef.current = window.requestAnimationFrame(() => {
          resizeFrameRef.current = null;
          applyPanelWidthStyle(panelRef.current, pendingResizeWidthRef.current);
        });
      };

      const cleanupResize = () => {
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
        window.removeEventListener("blur", handleUp);
        if (resizeFrameRef.current !== null) {
          window.cancelAnimationFrame(resizeFrameRef.current);
          resizeFrameRef.current = null;
        }
        panelRef.current?.removeAttribute("data-project-tools-resizing");
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        resizingRef.current = false;
        resizeCleanupRef.current = null;
      };

      const handleMove = (moveEvent: globalThis.MouseEvent) => {
        const nextWidth = clampPanelWidth(startWidth + startX - moveEvent.clientX, dragMaxWidth);
        schedulePanelWidth(nextWidth);
      };

      const handleUp = () => {
        cleanupResize();
        const finalWidth = pendingResizeWidthRef.current;
        applyPanelWidthStyle(panelRef.current, finalWidth);
        setDraftWidth(finalWidth);
        if (finalWidth !== clampedWidth) {
          onWidthChange(finalWidth);
        }
        setIsResizing(false);
        window.dispatchEvent(new Event(PROJECT_TOOLS_RESIZE_END_EVENT));
      };

      resizeCleanupRef.current = cleanupResize;
      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
      window.addEventListener("blur", handleUp);
    },
    [clampedWidth, onWidthChange, panelWidth],
  );

  const showProjectToolsChooser =
    projectReady && currentActiveTab === "terminal" && !activeSession;

  const startFileTree = useCallback(() => {
    setFileTreeInitialized(true);
    onActiveTabChange("fileTree");
  }, [onActiveTabChange, setFileTreeInitialized]);

  const revealPathInFileTree = useCallback(
    (path: string) => {
      const normalizedPath = path
        .trim()
        .replace(/\\/g, "/")
        .replace(/^\/+|\/+$/g, "");
      if (!projectReady) return;
      const selectedPath = normalizedPath.endsWith("/") ? dirname(normalizedPath) : normalizedPath;
      const expandedPaths = Array.from(
        new Set([...fileTreeState.expandedPaths, ...expandedPathsForFileTreePath(selectedPath)]),
      );
      setFileTreeInitialized(true);
      onFileTreeStateChange({
        query: "",
        selectedPath,
        expandedPaths,
        bumpRevision: true,
        bumpStateVersion: true,
      });
      onActiveTabChange("fileTree");
    },
    [
      fileTreeState.expandedPaths,
      onActiveTabChange,
      onFileTreeStateChange,
      projectReady,
      setFileTreeInitialized,
    ],
  );

  const closeFileTree = useCallback(() => {
    setFileTreeInitialized(false);
    if (activeTab === "fileTree") {
      onActiveTabChange("terminal");
    }
  }, [activeTab, onActiveTabChange, setFileTreeInitialized]);

  const startGitReview = useCallback(() => {
    if (!projectReady) return;
    onGitReviewOpenChange(true);
    onActiveTabChange("gitReview");
  }, [onActiveTabChange, onGitReviewOpenChange, projectReady]);

  const closeGitReview = useCallback(() => {
    onGitReviewOpenChange(false);
    if (activeTab === "gitReview") {
      onActiveTabChange("terminal");
    }
  }, [activeTab, onActiveTabChange, onGitReviewOpenChange]);

  const renderCreateTerminalMenuItem = () => {
    if (shellOptions.length > 1) {
      return (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={!terminalReady || creating} className="gap-2 text-xs">
            <Terminal className="h-3.5 w-3.5" />
            <span className="min-w-0 flex-1">{t("projectTools.newTerminal")}</span>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-36">
            {shellOptions.map((option) => (
              <DropdownMenuItem
                key={option.id}
                onSelect={() => createTerminal(option.id)}
                disabled={!terminalReady || creating}
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
        disabled={!terminalReady || creating}
        className="gap-2 text-xs"
        title={terminalDisabledMessage}
      >
        <Terminal className="h-3.5 w-3.5" />
        {t("projectTools.newTerminal")}
      </DropdownMenuItem>
    );
  };

  return (
    <aside
      ref={panelRef}
      aria-hidden={!isOpen}
      inert={!isOpen}
      data-state={isOpen ? "open" : "closed"}
      data-project-tools-resizing={isResizing ? "true" : undefined}
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 flex h-[min(72vh,34rem)] min-h-0 w-full shrink-0 flex-col overflow-hidden bg-background shadow-2xl transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none md:relative md:inset-auto md:z-10 md:h-full md:overflow-visible md:shadow-none",
        isOpen
          ? "pointer-events-auto translate-y-0 border-t border-border opacity-100 md:w-[var(--project-tools-panel-width)] md:translate-x-0 md:border-l md:border-t-0"
          : "pointer-events-none translate-y-full border-t border-transparent opacity-0 md:translate-x-3 md:translate-y-0 md:border-l-0 md:border-t-0",
        effectiveWidthCollapsed ? "md:w-0" : "md:w-[var(--project-tools-panel-width)]",
      )}
      style={panelStyle}
    >
      <div
        className={cn(
          "flex h-full min-h-0 w-full flex-col transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none md:w-[var(--project-tools-panel-width)] md:min-w-[var(--project-tools-panel-width)]",
          isOpen
            ? "translate-y-0 opacity-100 md:translate-x-0"
            : "translate-y-3 opacity-0 md:translate-x-2 md:translate-y-0",
        )}
      >
        {effectiveShouldRenderContent ? (
          <>
            <button
              type="button"
              aria-label={t("projectTools.resizePanel")}
              title={t("projectTools.resizePanel")}
              className={cn(
                "group absolute inset-y-0 left-0 z-[90] hidden w-4 -translate-x-1/2 cursor-col-resize touch-none items-center justify-center border-0 bg-transparent p-0 md:flex",
                "focus-visible:outline-none",
              )}
              onMouseDown={handleResizeStart}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "h-10 w-0.5 rounded-full bg-muted-foreground/25 opacity-70 shadow-sm transition-[height,background-color,opacity]",
                  "group-hover:h-16 group-hover:bg-primary/60 group-hover:opacity-100 group-focus-visible:h-16 group-focus-visible:bg-primary group-focus-visible:opacity-100",
                  isResizing && "h-20 bg-primary opacity-100",
                )}
              />
            </button>
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
              <div
                ref={tabsScrollRef}
                className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
              >
                {orderedProjectTabs.map((tab) => {
                  if (tab.kind === "fileTree") {
                    return (
                      <div
                        key={tab.id}
                        data-project-tools-tab-id={tab.id}
                        className={cn(
                          "group flex h-8 max-w-[12rem] shrink-0 select-none items-center gap-1 rounded-md border border-transparent px-1.5 text-xs text-muted-foreground transition-[background-color,border-color,color,opacity,transform,box-shadow] hover:bg-muted/80 hover:text-foreground",
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

                  if (tab.kind === "gitReview") {
                    return (
                      <div
                        key={tab.id}
                        data-project-tools-tab-id={tab.id}
                        className={cn(
                          "group flex h-8 max-w-[12rem] shrink-0 select-none items-center gap-1 rounded-md border border-transparent px-1.5 text-xs text-muted-foreground transition-[background-color,border-color,color,opacity,transform,box-shadow] hover:bg-muted/80 hover:text-foreground",
                          currentActiveTab === "gitReview" &&
                            "border-border bg-muted text-foreground shadow-sm",
                          draggingTabId === tab.id &&
                            "z-10 scale-[0.98] opacity-80 shadow-md ring-1 ring-ring",
                        )}
                        title={t("projectTools.gitReviewTitle")}
                      >
                        {renderTabDragHandle(tab.id, t("projectTools.gitReviewTitle"))}
                        <button
                          type="button"
                          onClick={() => {
                            if (consumeSuppressedTabClick(tab.id)) return;
                            onActiveTabChange("gitReview");
                          }}
                          className="flex min-w-0 flex-1 items-center gap-1.5 bg-transparent p-0 text-left text-inherit"
                        >
                          <GitBranch className="h-3.5 w-3.5 shrink-0" />
                          <span className="min-w-0 truncate">
                            {t("projectTools.gitReviewTitle")}
                          </span>
                        </button>
                        <button
                          type="button"
                          data-project-tools-tab-action="close"
                          aria-label={t("projectTools.closeGitReview")}
                          title={t("projectTools.closeGitReview")}
                          className="ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-background hover:text-foreground focus-visible:bg-background focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                          onPointerDown={(event) => {
                            event.stopPropagation();
                          }}
                          onMouseDown={(event) => {
                            event.stopPropagation();
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                            closeGitReview();
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
                        "group flex h-8 max-w-[12rem] shrink-0 select-none items-center gap-1 rounded-md border border-transparent px-1.5 text-xs text-muted-foreground transition-[background-color,border-color,color,opacity,transform,box-shadow] hover:bg-muted/80 hover:text-foreground",
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
              <DropdownMenu open={createMenuOpen} onOpenChange={setCreateMenuOpen}>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={!projectReady || creating}
                      title={t("projectTools.newProjectTool")}
                      className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground"
                    />
                  }
                >
                  <Plus className="h-4 w-4" />
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
                  <DropdownMenuItem
                    onSelect={startGitReview}
                    disabled={!projectReady}
                    className="gap-2 text-xs"
                  >
                    <GitBranch className="h-3.5 w-3.5" />
                    {t("projectTools.newGitReview")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {onClose ? (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onClose}
                  title={t("projectTools.closePanel")}
                  className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground md:hidden"
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
            ) : showProjectToolsChooser ? (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-5 py-6">
                <div className="flex flex-col items-center gap-1">
                  <h3 className="text-sm font-medium text-foreground">
                    {t("projectTools.getStarted")}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    {t("projectTools.getStartedHint")}
                  </p>
                </div>
                <div className="flex w-full max-w-xs flex-col gap-2">
                  <button
                    type="button"
                    onClick={handleCreate}
                    disabled={!terminalReady || creating}
                    title={terminalDisabledMessage}
                    className="group flex items-center gap-3 rounded-lg border border-border/60 bg-background px-3.5 py-3 text-left text-sm text-foreground transition-all hover:border-border hover:bg-muted/60 hover:shadow-sm disabled:pointer-events-none disabled:opacity-50"
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted/80 text-muted-foreground transition-colors group-hover:bg-muted group-hover:text-foreground">
                      <Terminal className="h-4.5 w-4.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium leading-tight">
                        {t("projectTools.newTerminal")}
                      </div>
                      <div className="mt-0.5 text-xs leading-tight text-muted-foreground">
                        {t("projectTools.terminalDescription")}
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={startFileTree}
                    className="group flex items-center gap-3 rounded-lg border border-border/60 bg-background px-3.5 py-3 text-left text-sm text-foreground transition-all hover:border-border hover:bg-muted/60 hover:shadow-sm"
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted/80 text-muted-foreground transition-colors group-hover:bg-muted group-hover:text-foreground">
                      <FolderTree className="h-4.5 w-4.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium leading-tight">
                        {t("projectTools.newFileTree")}
                      </div>
                      <div className="mt-0.5 text-xs leading-tight text-muted-foreground">
                        {t("projectTools.fileTreeDescription")}
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={startGitReview}
                    className="group flex items-center gap-3 rounded-lg border border-border/60 bg-background px-3.5 py-3 text-left text-sm text-foreground transition-all hover:border-border hover:bg-muted/60 hover:shadow-sm"
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted/80 text-muted-foreground transition-colors group-hover:bg-muted group-hover:text-foreground">
                      <GitBranch className="h-4.5 w-4.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium leading-tight">
                        {t("projectTools.newGitReview")}
                      </div>
                      <div className="mt-0.5 text-xs leading-tight text-muted-foreground">
                        {t("projectTools.gitReviewDescription")}
                      </div>
                    </div>
                  </button>
                </div>
                {loading ? (
                  <div className="text-center text-xs text-muted-foreground">
                    {t("projectTools.loading")}
                  </div>
                ) : null}
                {error ? <div className="text-center text-xs text-destructive">{error}</div> : null}
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
                      onOpenFile={onOpenFile}
                    />
                  </div>
                ) : null}
                {gitReviewInitialized ? (
                  <div
                    className={cn(
                      "min-h-0 flex-1",
                      currentActiveTab === "gitReview" ? "flex flex-col" : "hidden",
                    )}
                  >
                    <GitReviewPanel
                      key={`${projectPathKey}:git-review`}
                      cwd={cwd}
                      gitClient={gitClient}
                      canWrite={gitWriteEnabled}
                      disabledMessage={gitDisabledMessage}
                      onRevealInFileTree={revealPathInFileTree}
                      onInsertCommitMention={onInsertCommitMention}
                      onInsertGitFileMention={onInsertGitFileMention}
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
                    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
                      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted/80">
                        <Terminal className="h-6 w-6 text-muted-foreground" />
                      </div>
                      <div className="flex flex-col gap-1">
                        <div className="text-sm font-medium text-foreground">
                          {t("projectTools.newTerminal")}
                        </div>
                        {terminalDisabledMessage ? (
                          <div className="max-w-xs text-xs text-muted-foreground">
                            {terminalDisabledMessage}
                          </div>
                        ) : (
                          <div className="text-xs text-muted-foreground">
                            {t("projectTools.terminalDescription")}
                          </div>
                        )}
                      </div>
                      <Button
                        onClick={handleCreate}
                        disabled={!terminalReady || creating}
                        size="sm"
                      >
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
