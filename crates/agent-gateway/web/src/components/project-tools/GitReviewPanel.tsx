import { DiffFile } from "@git-diff-view/file";
import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import { useVirtualizer } from "@tanstack/react-virtual";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  memo,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type UIEvent as ReactUIEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useLocale } from "../../i18n";
import { computeGitGraph, GRAPH_COLORS, type GraphColor, type GraphRow } from "../../lib/git/gitGraph";
import type {
  GitClient,
  GitCommitDetails,
  GitCommitFile,
  GitCommitSummary,
  GitDiffResponse,
  GitLogResponse,
  GitOperationResponse,
  GitRepositoryState,
  GitStatusEntry,
} from "../../lib/git/types";
import { emptyGitRepositoryState } from "../../lib/git/types";
import { cn } from "../../lib/shared/utils";
import { getFileTypeIcon } from "../chat/fileTypeIcons";
import {
  AlertTriangle,
  BrushCleaning,
  ChevronRight,
  CheckCircle2,
  Cloud,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FilePenLine,
  FolderTree,
  GitBranch,
  GitCommitHorizontal,
  History,
  Loader2,
  MessageSquareText,
  MoreHorizontal,
  RefreshCw,
  Tag,
  Target,
  Trash2,
  Upload,
  X,
  XCircle,
} from "../icons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const LARGE_DIFF_CHUNK_CHAR_LIMIT = 120 * 1024;
const LARGE_DIFF_CHUNK_LINE_LIMIT = 1800;
const RAW_DIFF_PREVIEW_CHAR_LIMIT = 60 * 1024;
const INITIAL_CHANGE_ENTRY_RENDER_COUNT = 160;
const CHANGE_ENTRY_RENDER_BATCH_SIZE = 160;
const GIT_REVIEW_TRANSIENT_SCROLLBAR_CLASS = "git-review-transient-scrollbar";
const GIT_REVIEW_SCROLLBAR_HIDE_DELAY_MS = 1000;
const GIT_REVIEW_SCROLLBAR_HOVER_CHECK_MS = 140;
const GIT_REVIEW_SCROLLBAR_THUMB_SIZE_PX = 4;
const GIT_REVIEW_SCROLLBAR_EDGE_OFFSET_PX = 2;
const GIT_REVIEW_SCROLLBAR_MIN_THUMB_PX = 28;
const GIT_REVIEW_SPLIT_LAYOUT_MIN_WIDTH = 500;
const GIT_REVIEW_SPLIT_GRID_CLASS =
  "grid-cols-[clamp(9.5rem,38%,18rem)_minmax(10rem,1fr)] grid-rows-1";
const GIT_REVIEW_STACKED_PANE_BUTTON_CLASS =
  "inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const DIFF_SELECTION_AUTOSCROLL_EDGE_PX = 40;
const DIFF_SELECTION_AUTOSCROLL_MAX_STEP_PX = 22;
const gitReviewScrollbarTimers = new WeakMap<HTMLElement, number>();
type GitReviewScrollbarAxis = "vertical" | "horizontal";
type GitReviewScrollbarOverlay = {
  vertical: HTMLDivElement;
  horizontal: HTMLDivElement;
  remove: () => void;
};
const gitReviewScrollbarOverlays = new WeakMap<HTMLElement, GitReviewScrollbarOverlay>();

function gitReviewScrollbarThumbSize(viewportSize: number, scrollSize: number, trackSize: number) {
  if (viewportSize <= 0 || scrollSize <= viewportSize || trackSize <= 0) return 0;
  return Math.min(
    trackSize,
    Math.max(GIT_REVIEW_SCROLLBAR_MIN_THUMB_PX, (viewportSize / scrollSize) * trackSize),
  );
}

function gitReviewScrollbarThumbOffset(scrollOffset: number, maxScroll: number, maxThumbOffset: number) {
  if (maxScroll <= 0 || maxThumbOffset <= 0) return 0;
  return (scrollOffset / maxScroll) * maxThumbOffset;
}

function isScrollableOverflowValue(value: string) {
  return /(auto|scroll|overlay)/.test(value);
}

function destroyGitReviewScrollbarOverlay(element: HTMLElement) {
  const overlay = gitReviewScrollbarOverlays.get(element);
  if (!overlay) return;
  overlay.remove();
  gitReviewScrollbarOverlays.delete(element);
}

function setGitReviewScrollbarOverlayVisible(element: HTMLElement, visible: boolean) {
  const overlay = gitReviewScrollbarOverlays.get(element);
  if (!overlay) return;
  const nextValue = visible ? "true" : "false";
  overlay.vertical.dataset.visible = nextValue;
  overlay.horizontal.dataset.visible = nextValue;
}

function updateGitReviewScrollbarOverlay(element: HTMLElement) {
  if (!element.isConnected) {
    destroyGitReviewScrollbarOverlay(element);
    return;
  }
  const overlay = ensureGitReviewScrollbarOverlay(element);
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  const canScrollVertically =
    isScrollableOverflowValue(style.overflowY) &&
    element.scrollHeight > element.clientHeight + 1;
  const canScrollHorizontally =
    isScrollableOverflowValue(style.overflowX) &&
    element.scrollWidth > element.clientWidth + 1;
  const visible =
    element.dataset.scrollActive === "true" || element.dataset.scrollbarHover === "true";
  const cornerOffset = GIT_REVIEW_SCROLLBAR_THUMB_SIZE_PX + GIT_REVIEW_SCROLLBAR_EDGE_OFFSET_PX;

  if (canScrollVertically && rect.width > 0 && rect.height > 0) {
    const trackSize = Math.max(
      0,
      rect.height -
        GIT_REVIEW_SCROLLBAR_EDGE_OFFSET_PX * 2 -
        (canScrollHorizontally ? cornerOffset : 0),
    );
    const thumbSize = gitReviewScrollbarThumbSize(
      element.clientHeight,
      element.scrollHeight,
      trackSize,
    );
    const thumbOffset = gitReviewScrollbarThumbOffset(
      element.scrollTop,
      element.scrollHeight - element.clientHeight,
      trackSize - thumbSize,
    );
    overlay.vertical.style.display = "";
    overlay.vertical.style.left = `${Math.round(
      rect.right - GIT_REVIEW_SCROLLBAR_THUMB_SIZE_PX - GIT_REVIEW_SCROLLBAR_EDGE_OFFSET_PX,
    )}px`;
    overlay.vertical.style.top = `${Math.round(
      rect.top + GIT_REVIEW_SCROLLBAR_EDGE_OFFSET_PX + thumbOffset,
    )}px`;
    overlay.vertical.style.height = `${Math.max(0, thumbSize)}px`;
  } else {
    overlay.vertical.style.display = "none";
  }

  if (canScrollHorizontally && rect.width > 0 && rect.height > 0) {
    const trackSize = Math.max(
      0,
      rect.width -
        GIT_REVIEW_SCROLLBAR_EDGE_OFFSET_PX * 2 -
        (canScrollVertically ? cornerOffset : 0),
    );
    const thumbSize = gitReviewScrollbarThumbSize(
      element.clientWidth,
      element.scrollWidth,
      trackSize,
    );
    const thumbOffset = gitReviewScrollbarThumbOffset(
      element.scrollLeft,
      element.scrollWidth - element.clientWidth,
      trackSize - thumbSize,
    );
    overlay.horizontal.style.display = "";
    overlay.horizontal.style.left = `${Math.round(
      rect.left + GIT_REVIEW_SCROLLBAR_EDGE_OFFSET_PX + thumbOffset,
    )}px`;
    overlay.horizontal.style.top = `${Math.round(
      rect.bottom - GIT_REVIEW_SCROLLBAR_THUMB_SIZE_PX - GIT_REVIEW_SCROLLBAR_EDGE_OFFSET_PX,
    )}px`;
    overlay.horizontal.style.width = `${Math.max(0, thumbSize)}px`;
  } else {
    overlay.horizontal.style.display = "none";
  }

  setGitReviewScrollbarOverlayVisible(element, visible);
}

function startGitReviewScrollbarDrag(
  element: HTMLElement,
  overlay: GitReviewScrollbarOverlay,
  axis: GitReviewScrollbarAxis,
  event: PointerEvent,
) {
  event.preventDefault();
  event.stopPropagation();
  const thumb = axis === "vertical" ? overlay.vertical : overlay.horizontal;
  const rect = element.getBoundingClientRect();
  const hasCrossAxisScrollbar =
    axis === "vertical"
      ? element.scrollWidth > element.clientWidth + 1
      : element.scrollHeight > element.clientHeight + 1;
  const trackSize = Math.max(
    0,
    (axis === "vertical" ? rect.height : rect.width) -
      GIT_REVIEW_SCROLLBAR_EDGE_OFFSET_PX * 2 -
      (hasCrossAxisScrollbar
        ? GIT_REVIEW_SCROLLBAR_THUMB_SIZE_PX + GIT_REVIEW_SCROLLBAR_EDGE_OFFSET_PX
        : 0),
  );
  const thumbSize =
    axis === "vertical"
      ? Number.parseFloat(thumb.style.height) || 0
      : Number.parseFloat(thumb.style.width) || 0;
  const maxThumbOffset = Math.max(1, trackSize - thumbSize);
  const maxScroll =
    axis === "vertical"
      ? element.scrollHeight - element.clientHeight
      : element.scrollWidth - element.clientWidth;
  const startPointer = axis === "vertical" ? event.clientY : event.clientX;
  const startScroll = axis === "vertical" ? element.scrollTop : element.scrollLeft;
  const pointerId = event.pointerId;

  element.dataset.scrollActive = "true";
  element.dataset.scrollbarHover = "true";
  thumb.dataset.dragging = "true";
  updateGitReviewScrollbarOverlay(element);
  thumb.setPointerCapture(pointerId);

  const handleMove = (moveEvent: PointerEvent) => {
    const currentPointer = axis === "vertical" ? moveEvent.clientY : moveEvent.clientX;
    const nextScroll = startScroll + ((currentPointer - startPointer) / maxThumbOffset) * maxScroll;
    if (axis === "vertical") {
      element.scrollTop = nextScroll;
    } else {
      element.scrollLeft = nextScroll;
    }
    element.dataset.scrollActive = "true";
    updateGitReviewScrollbarOverlay(element);
  };
  const handleUp = () => {
    thumb.releasePointerCapture(pointerId);
    delete thumb.dataset.dragging;
    delete element.dataset.scrollbarHover;
    thumb.removeEventListener("pointermove", handleMove);
    thumb.removeEventListener("pointerup", handleUp);
    thumb.removeEventListener("pointercancel", handleUp);
    scheduleGitReviewScrollbarHide(element);
  };

  thumb.addEventListener("pointermove", handleMove);
  thumb.addEventListener("pointerup", handleUp);
  thumb.addEventListener("pointercancel", handleUp);
}

function ensureGitReviewScrollbarOverlay(element: HTMLElement) {
  const currentOverlay = gitReviewScrollbarOverlays.get(element);
  if (currentOverlay) return currentOverlay;
  const vertical = document.createElement("div");
  const horizontal = document.createElement("div");
  const overlay: GitReviewScrollbarOverlay = {
    vertical,
    horizontal,
    remove: () => {
      window.removeEventListener("resize", handleWindowResize);
      vertical.remove();
      horizontal.remove();
    },
  };
  const handleWindowResize = () => updateGitReviewScrollbarOverlay(element);
  const handleEnter = () => {
    element.dataset.scrollActive = "true";
    element.dataset.scrollbarHover = "true";
    updateGitReviewScrollbarOverlay(element);
  };
  const handleLeave = () => {
    delete element.dataset.scrollbarHover;
    scheduleGitReviewScrollbarHide(element, GIT_REVIEW_SCROLLBAR_HOVER_CHECK_MS);
  };
  vertical.className = "git-review-floating-scrollbar git-review-floating-scrollbar-vertical";
  horizontal.className = "git-review-floating-scrollbar git-review-floating-scrollbar-horizontal";
  vertical.dataset.visible = "false";
  horizontal.dataset.visible = "false";
  vertical.addEventListener("pointerenter", handleEnter);
  horizontal.addEventListener("pointerenter", handleEnter);
  vertical.addEventListener("pointerleave", handleLeave);
  horizontal.addEventListener("pointerleave", handleLeave);
  vertical.addEventListener("pointerdown", (event) =>
    startGitReviewScrollbarDrag(element, overlay, "vertical", event),
  );
  horizontal.addEventListener("pointerdown", (event) =>
    startGitReviewScrollbarDrag(element, overlay, "horizontal", event),
  );
  window.addEventListener("resize", handleWindowResize);
  document.body.append(vertical, horizontal);
  gitReviewScrollbarOverlays.set(element, overlay);
  return overlay;
}

function scheduleGitReviewScrollbarHide(
  element: HTMLElement,
  delay = GIT_REVIEW_SCROLLBAR_HIDE_DELAY_MS,
) {
  const currentTimer = gitReviewScrollbarTimers.get(element);
  if (currentTimer !== undefined) {
    window.clearTimeout(currentTimer);
  }
  const nextTimer = window.setTimeout(() => {
    if (!element.isConnected) {
      destroyGitReviewScrollbarOverlay(element);
      gitReviewScrollbarTimers.delete(element);
      return;
    }
    if (element.dataset.scrollbarHover === "true") {
      scheduleGitReviewScrollbarHide(element, GIT_REVIEW_SCROLLBAR_HOVER_CHECK_MS);
      return;
    }
    delete element.dataset.scrollActive;
    setGitReviewScrollbarOverlayVisible(element, false);
    gitReviewScrollbarTimers.delete(element);
  }, delay);
  gitReviewScrollbarTimers.set(element, nextTimer);
}

function handleGitReviewTransientScroll(event: ReactUIEvent<HTMLElement>) {
  const element = event.currentTarget;
  element.dataset.scrollActive = "true";
  updateGitReviewScrollbarOverlay(element);
  scheduleGitReviewScrollbarHide(element);
}

function diffSelectionAutoScrollDelta(
  pointer: number,
  start: number,
  end: number,
  canScroll: boolean,
) {
  if (!canScroll) return 0;
  if (pointer < start + DIFF_SELECTION_AUTOSCROLL_EDGE_PX) {
    const ratio = Math.min(
      1,
      (start + DIFF_SELECTION_AUTOSCROLL_EDGE_PX - pointer) /
        DIFF_SELECTION_AUTOSCROLL_EDGE_PX,
    );
    return -Math.max(2, Math.round(ratio * DIFF_SELECTION_AUTOSCROLL_MAX_STEP_PX));
  }
  if (pointer > end - DIFF_SELECTION_AUTOSCROLL_EDGE_PX) {
    const ratio = Math.min(
      1,
      (pointer - (end - DIFF_SELECTION_AUTOSCROLL_EDGE_PX)) /
        DIFF_SELECTION_AUTOSCROLL_EDGE_PX,
    );
    return Math.max(2, Math.round(ratio * DIFF_SELECTION_AUTOSCROLL_MAX_STEP_PX));
  }
  return 0;
}

type DiffSelectionScrollAxis = "vertical" | "horizontal";

function scrollDiffSelectionViewportForPointer(
  viewport: HTMLElement,
  clientX: number,
  clientY: number,
  axis: DiffSelectionScrollAxis,
) {
  const rect = viewport.getBoundingClientRect();
  const maxScrollTop = viewport.scrollHeight - viewport.clientHeight;
  const maxScrollLeft = viewport.scrollWidth - viewport.clientWidth;

  if (axis === "vertical") {
    const topDelta = diffSelectionAutoScrollDelta(clientY, rect.top, rect.bottom, maxScrollTop > 0);
    if (topDelta === 0) return false;
    const previousTop = viewport.scrollTop;
    viewport.scrollTop = Math.min(maxScrollTop, Math.max(0, previousTop + topDelta));
    return viewport.scrollTop !== previousTop;
  }

  const leftDelta = diffSelectionAutoScrollDelta(clientX, rect.left, rect.right, maxScrollLeft > 0);
  if (leftDelta === 0) return false;
  const previousLeft = viewport.scrollLeft;
  viewport.scrollLeft = Math.min(maxScrollLeft, Math.max(0, previousLeft + leftDelta));
  return viewport.scrollLeft !== previousLeft;
}

function isScrollableDiffSelectionElement(element: HTMLElement) {
  const style = window.getComputedStyle(element);
  const canScrollY =
    isScrollableOverflowValue(style.overflowY) &&
    element.scrollHeight > element.clientHeight + 1;
  const canScrollX =
    isScrollableOverflowValue(style.overflowX) &&
    element.scrollWidth > element.clientWidth + 1;
  return canScrollY || canScrollX;
}

function syncGitReviewAutoscrollScrollbar(viewport: HTMLElement) {
  if (!viewport.classList.contains(GIT_REVIEW_TRANSIENT_SCROLLBAR_CLASS)) return;
  viewport.dataset.scrollActive = "true";
  updateGitReviewScrollbarOverlay(viewport);
  scheduleGitReviewScrollbarHide(viewport);
}

function resolveDiffSelectionScrollViewports(
  target: Element | null,
  root: HTMLElement | null,
  fallback: HTMLElement | null,
) {
  const viewports: HTMLElement[] = [];
  const addViewport = (element: HTMLElement | null) => {
    if (!element || viewports.includes(element) || !isScrollableDiffSelectionElement(element)) {
      return;
    }
    viewports.push(element);
  };

  if (!target || !root) {
    addViewport(fallback);
    return viewports;
  }

  let current: HTMLElement | null =
    target instanceof HTMLElement ? target : target.parentElement;
  while (current && current !== root) {
    addViewport(current);
    current = current.parentElement;
  }
  addViewport(fallback);
  return viewports;
}

type PatchChunk = {
  key: string;
  label: string;
  chunk: string;
  lineCount: number;
  large: boolean;
};

type DiffStatFile = {
  key: string;
  path: string;
  changes: number | null;
  additions: number;
  deletions: number;
  additionPercent: number;
  deletionPercent: number;
  binary: boolean;
  raw: string;
};

type DiffStatSummary = {
  raw?: string;
};

type ParsedDiffStat = {
  files: DiffStatFile[];
  fallbackLines: string[];
  summary: DiffStatSummary;
};

type DiffViewKind = "branch" | "workingTree";
type GitReviewMode = "changes" | "history";
type GitReviewStackedPane = "list" | "detail";
type GitHistoryMarkerKind = Extract<GraphRow["kind"], "incoming-changes" | "outgoing-changes">;
type GitHistoryGraphState = Pick<
  GitLogResponse,
  "historyBaseRef" | "historyRemoteRef" | "historyAhead" | "historyBehind" | "mergeBase"
>;
type GitHistoryRow =
  | {
      type: "marker";
      kind: GitHistoryMarkerKind;
      graphIndex: number;
    }
  | {
      type: "commit";
      commit: GitCommitSummary;
      graphIndex: number;
    }
  | {
      type: "file";
      commit: GitCommitSummary;
      graphIndex: number;
      file: GitCommitFile;
    }
  | {
      type: "loadMore";
    };

type ChangeListSection = "staged" | "changes";

type ChangeContextMenuState = {
  x: number;
  y: number;
  path: string;
  section: ChangeListSection;
};

type HistoryContextMenuState =
  | {
      kind: "commit";
      x: number;
      y: number;
      commitSha: string;
    }
  | {
      kind: "file";
      x: number;
      y: number;
      commitSha: string;
      path: string;
    };

type DiffSelectionContextMenuState = {
  x: number;
  y: number;
  selectedText: string;
};

type ChangesMenuState = {
  x: number;
  y: number;
  section: ChangeListSection;
};

export type GitCommitContextPayload = GitCommitDetails & {
  githubUrl?: string;
};

export type GitFileContextPayload = {
  path: string;
  oldPath?: string;
  status: string;
  commitSha: string;
  shortSha: string;
  refName: string;
  remoteName: string;
  remoteUrl: string;
  githubUrl?: string;
};

const CHANGE_CONTEXT_MENU_WIDTH = 232;
const CHANGE_CONTEXT_MENU_HEIGHT = 210;
const CHANGES_MENU_WIDTH = 232;
const CHANGES_MENU_HEIGHT = 170;
const HISTORY_CONTEXT_MENU_WIDTH = 232;
const HISTORY_CONTEXT_MENU_HEIGHT = 270;
const HISTORY_FILE_CONTEXT_MENU_HEIGHT = 90;
const DIFF_SELECTION_CONTEXT_MENU_WIDTH = 184;
const DIFF_SELECTION_CONTEXT_MENU_HEIGHT = 52;
const DIFF_SELECTION_CONTEXT_MENU_MARGIN = 12;
const GIT_HISTORY_PAGE_SIZE = 50;
const GIT_HISTORY_LOAD_MORE_SCROLL_THRESHOLD_PX = 96;
const CHANGE_CONTEXT_MENU_ITEM_CLASS =
  "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-45";
const CONTEXT_MENU_CONTAINER_CLASS =
  "editor-context-menu select-none overflow-hidden rounded-xl border border-border/60 bg-popover/80 p-1 text-xs text-popover-foreground shadow-2xl ring-1 ring-black/[0.03] backdrop-blur-xl dark:ring-white/[0.06]";
const CONTEXT_MENU_SEPARATOR_CLASS = "mx-1 my-1 h-px bg-border/60";
const GIT_REVIEW_POLL_INTERVAL_MS = 1500;

type GitRefreshOptions = {
  append?: boolean;
  force?: boolean;
  notifyChanged?: boolean;
  silent?: boolean;
};
type GitRemoteSetupAction = "fetch" | "pull" | "push";
type GitOperationNoticeAction =
  | GitRemoteSetupAction
  | "commit"
  | "create_branch"
  | "discard"
  | "discard_all";
type GitOperationNotice = {
  id: number;
  kind: "success" | "error";
  title: string;
  message: string;
};
type GitDiscardConfirmState =
  | {
      kind: "entry";
      path: string;
      oldPath?: string | null;
    }
  | {
      kind: "all";
    };
type GitBranchFromCommitState = {
  commitSha: string;
  shortSha: string;
  subject: string;
};

function isMissingRemoteSetupError(message: string) {
  return message.includes("找不到 origin remote") || message.includes("还没有设置远端仓库");
}

function isRemoteSetupAction(action: GitOperationNoticeAction): action is GitRemoteSetupAction {
  return action === "fetch" || action === "pull" || action === "push";
}

function remoteSetupDescriptionKey(action: GitRemoteSetupAction) {
  if (action === "fetch") return "projectTools.gitReview.remoteSetupDescriptionFetch";
  if (action === "pull") return "projectTools.gitReview.remoteSetupDescriptionPull";
  return "projectTools.gitReview.remoteSetupDescriptionPush";
}

function remoteSetupSubmitKey(action: GitRemoteSetupAction) {
  if (action === "fetch") return "projectTools.gitReview.remoteSetupSubmitFetch";
  if (action === "pull") return "projectTools.gitReview.remoteSetupSubmitPull";
  return "projectTools.gitReview.remoteSetupSubmitPush";
}

function operationSuccessTitleKey(action: GitOperationNoticeAction) {
  if (action === "fetch") return "projectTools.gitReview.fetchSuccessTitle";
  if (action === "pull") return "projectTools.gitReview.pullSuccessTitle";
  if (action === "commit") return "projectTools.gitReview.commitSuccessTitle";
  if (action === "create_branch") return "projectTools.gitReview.createBranchSuccessTitle";
  if (action === "discard") return "projectTools.gitReview.discardSuccessTitle";
  if (action === "discard_all") return "projectTools.gitReview.discardAllSuccessTitle";
  return "projectTools.gitReview.pushSuccessTitle";
}

function operationSuccessMessageKey(action: GitOperationNoticeAction) {
  if (action === "fetch") return "projectTools.gitReview.fetchSuccessMessage";
  if (action === "pull") return "projectTools.gitReview.pullSuccessMessage";
  if (action === "commit") return "projectTools.gitReview.commitSuccessMessage";
  if (action === "create_branch") return "projectTools.gitReview.createBranchSuccessMessage";
  if (action === "discard") return "projectTools.gitReview.discardSuccessMessage";
  if (action === "discard_all") return "projectTools.gitReview.discardAllSuccessMessage";
  return "projectTools.gitReview.pushSuccessMessage";
}

function operationFailureTitleKey(action: GitOperationNoticeAction) {
  if (action === "fetch") return "projectTools.gitReview.fetchFailedTitle";
  if (action === "pull") return "projectTools.gitReview.pullFailedTitle";
  if (action === "commit") return "projectTools.gitReview.commitFailedTitle";
  if (action === "create_branch") return "projectTools.gitReview.createBranchFailedTitle";
  if (action === "discard") return "projectTools.gitReview.discardFailedTitle";
  if (action === "discard_all") return "projectTools.gitReview.discardAllFailedTitle";
  return "projectTools.gitReview.pushFailedTitle";
}

function compactGitOperationMessage(value: string) {
  const message = value.trim();
  if (message.length <= 260) return message;
  return `${message.slice(0, 257)}...`;
}

function dispatchGitChanged(workdir: string) {
  window.dispatchEvent(
    new CustomEvent("liveagent:git-changed", {
      detail: { workdir },
    }),
  );
}

function useIsDark() {
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains("dark"));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return isDark;
}

function GitRemoteSetupModal(props: {
  open: boolean;
  action: GitRemoteSetupAction;
  workdir: string;
  branch: string;
  remoteUrl: string;
  loading: boolean;
  error: string;
  onRemoteUrlChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const {
    open,
    action,
    workdir,
    branch,
    remoteUrl,
    loading,
    error,
    onRemoteUrlChange,
    onClose,
    onSubmit,
  } = props;
  const { t } = useLocale();
  const titleId = useId();
  const remoteUrlId = useId();

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-sm"
        onClick={loading ? undefined : onClose}
      />
      <form
        className="relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-border/70 bg-background shadow-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="border-b border-border/60 px-5 py-4">
          <div id={titleId} className="text-sm font-semibold text-foreground">
            {t("projectTools.gitReview.remoteSetupTitle")}
          </div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">
            {t(remoteSetupDescriptionKey(action))}
          </div>
        </div>
        <div className="space-y-4 px-5 py-4">
          <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
            <div
              className="truncate rounded-lg border border-border/70 bg-muted/35 px-3 py-2"
              title={branch}
            >
              {branch}
            </div>
            <div
              className="truncate rounded-lg border border-border/70 bg-muted/35 px-3 py-2"
              title={workdir}
            >
              {workdir}
            </div>
          </div>
          <div className="space-y-1.5">
            <label htmlFor={remoteUrlId} className="text-xs text-muted-foreground">
              {t("projectTools.gitReview.remoteUrl")}
            </label>
            <Input
              id={remoteUrlId}
              value={remoteUrl}
              onChange={(event) => onRemoteUrlChange(event.target.value)}
              className="h-9 text-sm"
              placeholder={t("projectTools.gitReview.remoteUrlPlaceholder")}
              autoFocus
              disabled={loading}
            />
          </div>
          {error ? (
            <div className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border/60 px-5 py-4">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={loading}>
            {t("chat.cancel")}
          </Button>
          <Button type="submit" size="sm" disabled={loading || !remoteUrl.trim()}>
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : action === "push" ? (
              <Upload className="h-3.5 w-3.5" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {t(remoteSetupSubmitKey(action))}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

function GitDiscardConfirmModal(props: {
  target: GitDiscardConfirmState | null;
  loading: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { target, loading, onClose, onConfirm } = props;
  const { t } = useLocale();
  const titleId = useId();

  if (!target) return null;

  const isAll = target.kind === "all";
  const title = isAll
    ? t("projectTools.gitReview.discardAllChanges")
    : t("projectTools.gitReview.discardChanges");
  const description = isAll
    ? t("projectTools.gitReview.discardAllConfirm")
    : t("projectTools.gitReview.discardConfirm").replace("{path}", target.path);

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-sm"
        onClick={loading ? undefined : onClose}
      />
      <div className="relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-border/70 bg-background shadow-2xl">
        <div className="flex items-start gap-3 border-b border-border/60 px-5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-destructive/10">
            <AlertTriangle className="h-4 w-4 text-destructive" />
          </div>
          <div className="min-w-0 flex-1">
            <div id={titleId} className="text-sm font-semibold text-foreground">
              {title}
            </div>
            <div className="mt-1 text-xs leading-5 text-muted-foreground">{description}</div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-4">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={loading}>
            {t("chat.cancel")}
          </Button>
          <Button type="button" variant="destructive" size="sm" onClick={onConfirm} disabled={loading}>
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : isAll ? (
              <Trash2 className="h-3.5 w-3.5" />
            ) : (
              <BrushCleaning className="h-3.5 w-3.5" />
            )}
            {title}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function GitBranchFromCommitModal(props: {
  target: GitBranchFromCommitState | null;
  branchName: string;
  loading: boolean;
  error: string;
  onBranchNameChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const { target, branchName, loading, error, onBranchNameChange, onClose, onSubmit } = props;
  const { t } = useLocale();
  const titleId = useId();
  const branchNameId = useId();

  if (!target) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-sm"
        onClick={loading ? undefined : onClose}
      />
      <form
        className="relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-border/70 bg-background shadow-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="border-b border-border/60 px-5 py-4">
          <div id={titleId} className="text-sm font-semibold text-foreground">
            {t("projectTools.gitReview.createBranchFromCommitTitle")}
          </div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">
            {t("projectTools.gitReview.createBranchFromCommitDescription")
              .replace("{sha}", target.shortSha)
              .replace("{subject}", target.subject || target.shortSha)}
          </div>
        </div>
        <div className="space-y-4 px-5 py-4">
          <div className="rounded-lg border border-border/70 bg-muted/35 px-3 py-2 text-xs">
            <div className="font-mono text-[11px] text-muted-foreground">{target.shortSha}</div>
            <div className="mt-1 truncate font-medium" title={target.subject}>
              {target.subject || target.commitSha}
            </div>
          </div>
          <div className="space-y-1.5">
            <label htmlFor={branchNameId} className="text-xs text-muted-foreground">
              {t("projectTools.gitReview.branchName")}
            </label>
            <Input
              id={branchNameId}
              value={branchName}
              onChange={(event) => onBranchNameChange(event.target.value)}
              className="h-9 text-sm"
              placeholder={t("projectTools.gitReview.branchNamePlaceholder")}
              autoFocus
              disabled={loading}
            />
          </div>
          {error ? (
            <div className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border/60 px-5 py-4">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={loading}>
            {t("chat.cancel")}
          </Button>
          <Button type="submit" size="sm" disabled={loading || !branchName.trim()}>
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <GitBranch className="h-3.5 w-3.5" />
            )}
            {t("projectTools.gitReview.createBranch")}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

function splitPatchByFile(patch: string) {
  const lines = patch.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      chunks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.some((line) => line.trim() !== "")) {
    chunks.push(current.join("\n"));
  }
  return chunks;
}

function cleanDiffPath(value: string) {
  if (!value || value === "/dev/null") return "";
  return value.replace(/^[ab]\//, "");
}

function dirname(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : "";
}

function basename(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) || normalized : normalized || "Untitled";
}

function parentPath(path: string) {
  return dirname(path) || ".";
}

function getPatchFileNames(chunk: string, fallback: string) {
  const lines = chunk.split("\n");
  const gitHeader = lines.find((line) => line.startsWith("diff --git "));
  if (gitHeader) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(gitHeader);
    if (match) {
      return {
        oldFileName: cleanDiffPath(match[1] ?? "") || fallback,
        newFileName: cleanDiffPath(match[2] ?? "") || fallback,
      };
    }
  }
  const oldHeader = lines.find((line) => line.startsWith("--- "));
  const newHeader = lines.find((line) => line.startsWith("+++ "));
  return {
    oldFileName: cleanDiffPath(oldHeader?.slice(4).trim() ?? "") || fallback,
    newFileName: cleanDiffPath(newHeader?.slice(4).trim() ?? "") || fallback,
  };
}

function countLines(value: string) {
  if (!value) return 0;
  let count = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

function parseDiffStatFile(line: string, index: number): DiffStatFile | null {
  const pipeIndex = line.lastIndexOf("|");
  if (pipeIndex < 0) return null;
  const path = line.slice(0, pipeIndex).trim();
  const details = line.slice(pipeIndex + 1).trim();
  if (!path || !details) return null;

  const binary = /^Bin\b/.test(details);
  if (binary) {
    return {
      key: `${path}:${index}`,
      path,
      changes: null,
      additions: 0,
      deletions: 0,
      additionPercent: 0,
      deletionPercent: 0,
      binary: true,
      raw: line,
    };
  }

  const match = /^(\d+)\s*([+\-]*)/.exec(details);
  if (!match?.[1]) return null;
  const changes = Number(match[1]);
  if (!Number.isFinite(changes)) return null;
  const graph = match[2] ?? "";
  const graphAdditions = graph.split("").filter((char) => char === "+").length;
  const graphDeletions = graph.split("").filter((char) => char === "-").length;
  const graphUnits = graphAdditions + graphDeletions;
  const additions = graphUnits > 0 ? Math.round(changes * (graphAdditions / graphUnits)) : 0;
  const deletions = graphUnits > 0 ? Math.max(0, changes - additions) : 0;
  const total = additions + deletions;
  const additionPercent = total > 0 ? (additions / total) * 100 : 0;
  const deletionPercent = total > 0 ? (deletions / total) * 100 : 0;

  return {
    key: `${path}:${index}`,
    path,
    changes,
    additions,
    deletions,
    additionPercent,
    deletionPercent,
    binary: false,
    raw: line,
  };
}

function parseDiffStat(stat: string): ParsedDiffStat {
  const lines = stat
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const lastLine = lines.at(-1) ?? "";
  const hasSummary =
    /\bfiles? changed\b/.test(lastLine) ||
    /\binsertions?\(\+\)/.test(lastLine) ||
    /\bdeletions?\(-\)/.test(lastLine);
  const summary: DiffStatSummary = hasSummary
    ? {
        raw: lastLine,
      }
    : {};
  const fileLines = hasSummary ? lines.slice(0, -1) : lines;
  const files: DiffStatFile[] = [];
  const fallbackLines: string[] = [];
  fileLines.forEach((line, index) => {
    const file = parseDiffStatFile(line, index);
    if (file) {
      files.push(file);
    } else {
      fallbackLines.push(line);
    }
  });
  return { files, fallbackLines, summary };
}

function buildPatchChunks(patch: string, title: string): PatchChunk[] {
  if (!patch.trim()) return [];
  return splitPatchByFile(patch).map((chunk, index) => {
    const names = getPatchFileNames(chunk, `${title}-${index + 1}`);
    const label = names.newFileName || names.oldFileName || `${title} ${index + 1}`;
    const lineCount = countLines(chunk);
    return {
      key: `${names.oldFileName}:${names.newFileName}:${index}`,
      label,
      chunk,
      lineCount,
      large:
        chunk.length > LARGE_DIFF_CHUNK_CHAR_LIMIT ||
        lineCount > LARGE_DIFF_CHUNK_LINE_LIMIT,
    };
  });
}

const DiffChunkView = memo(function DiffChunkView(props: {
  item: PatchChunk;
  isDark: boolean;
}) {
  const { item, isDark } = props;
  const { t } = useLocale();
  const diffFile = useMemo(() => {
    if (item.large) return null;
    try {
      const names = getPatchFileNames(item.chunk, item.label);
      const instance = new DiffFile(
        names.oldFileName,
        "",
        names.newFileName,
        "",
        [item.chunk],
        "diff",
        "diff",
      );
      instance.initTheme(isDark ? "dark" : "light");
      instance.init();
      instance.buildUnifiedDiffLines();
      return instance;
    } catch {
      return null;
    }
  }, [isDark, item]);

  const rawPreview = useMemo(() => {
    if (!item.large) return item.chunk;
    return item.chunk.length > RAW_DIFF_PREVIEW_CHAR_LIMIT
      ? `${item.chunk.slice(0, RAW_DIFF_PREVIEW_CHAR_LIMIT)}\n\n${t("projectTools.gitReview.diffPreviewTruncated")}`
      : item.chunk;
  }, [item, t]);

  return (
    <div className="border-b border-border/60 last:border-b-0">
      <div className="flex select-none items-center gap-2 border-b border-border/60 bg-muted/20 px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {item.large ? (
          <span className="shrink-0 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
            {t("projectTools.gitReview.largeDiff")}
          </span>
        ) : null}
      </div>
      {diffFile ? (
        <DiffView
          diffFile={diffFile}
          diffViewMode={DiffModeEnum.Unified}
          diffViewTheme={isDark ? "dark" : "light"}
          diffViewHighlight
          diffViewWrap={false}
          diffViewFontSize={12}
        />
      ) : (
        <pre
          className={cn(
            GIT_REVIEW_TRANSIENT_SCROLLBAR_CLASS,
            "git-review-diff-selectable-content max-h-[26rem] select-text overflow-auto px-3 py-3 text-[11px] leading-relaxed text-muted-foreground",
          )}
          onScroll={handleGitReviewTransientScroll}
        >
          {rawPreview}
        </pre>
      )}
    </div>
  );
});

function DiffStatView(props: { stat: string }) {
  const { stat } = props;
  const { t } = useLocale();
  const parsed = useMemo(() => parseDiffStat(stat), [stat]);
  if (!stat.trim()) return null;

  const showStructured = parsed.files.length > 0;

  if (!showStructured) {
    return (
      <pre
        className={cn(
          GIT_REVIEW_TRANSIENT_SCROLLBAR_CLASS,
          "max-h-24 overflow-auto border-b border-border/70 bg-muted/25 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground",
        )}
        onScroll={handleGitReviewTransientScroll}
      >
        {stat}
      </pre>
    );
  }

  return (
    <div className="border-b border-border/70 bg-muted/10 px-3 py-2">
      {parsed.files.length > 0 ? (
        <div
          className={cn(GIT_REVIEW_TRANSIENT_SCROLLBAR_CLASS, "max-h-40 overflow-auto space-y-1")}
          onScroll={handleGitReviewTransientScroll}
        >
          {parsed.files.map((file) => (
            <div
              key={file.key}
              className="rounded-md border border-border/60 bg-background/75 px-2.5 py-2"
              title={file.raw}
            >
              <div className="flex min-w-0 items-center gap-2">
                <div className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">
                  {basename(file.path)}
                </div>
                <div className="flex shrink-0 items-center gap-1 text-[10px] tabular-nums">
                  {file.binary ? (
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-muted-foreground">
                      {t("projectTools.gitReview.statBinary")}
                    </span>
                  ) : (
                    <>
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-muted-foreground">
                        {file.changes} {t("projectTools.gitReview.statChanges")}
                      </span>
                      {file.additions > 0 ? (
                        <span
                          className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 font-semibold text-emerald-700 dark:text-emerald-300"
                          title={t("projectTools.gitReview.statInsertions")}
                        >
                          +{file.additions}
                        </span>
                      ) : null}
                      {file.deletions > 0 ? (
                        <span
                          className="rounded-full bg-rose-500/10 px-1.5 py-0.5 font-semibold text-rose-700 dark:text-rose-300"
                          title={t("projectTools.gitReview.statDeletions")}
                        >
                          -{file.deletions}
                        </span>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
              <div className="min-w-0">
                <div className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-muted">
                  {file.additions > 0 ? (
                    <span
                      className="h-full bg-emerald-500/75"
                      style={{ width: `${file.additionPercent}%` }}
                    />
                  ) : null}
                  {file.deletions > 0 ? (
                    <span
                      className="h-full bg-rose-500/75"
                      style={{ width: `${file.deletionPercent}%` }}
                    />
                  ) : null}
                  {!file.binary && file.additions + file.deletions === 0 ? (
                    <span className="h-full w-full bg-muted-foreground/25" />
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {parsed.fallbackLines.length > 0 ? (
        <pre
          className={cn(
            GIT_REVIEW_TRANSIENT_SCROLLBAR_CLASS,
            "mt-2 max-h-20 overflow-auto rounded-md bg-muted/35 px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground",
          )}
          onScroll={handleGitReviewTransientScroll}
        >
          {parsed.fallbackLines.join("\n")}
        </pre>
      ) : null}
    </div>
  );
}

function DiffContent(props: {
  diff?: GitDiffResponse | null;
  title: string;
  error?: string;
  loading?: boolean;
  showStat?: boolean;
}) {
  const { diff, title, error, loading = false, showStat = true } = props;
  const { locale, t } = useLocale();
  const isDark = useIsDark();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollViewportRef = useRef<HTMLElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const selectionAutoscrollViewportsRef = useRef<HTMLElement[]>([]);
  const selectionAutoscrollPointerRef = useRef<{
    x: number;
    y: number;
  } | null>(null);
  const selectionAutoscrollFrameRef = useRef<number | null>(null);
  const [selectionContextMenu, setSelectionContextMenu] =
    useState<DiffSelectionContextMenuState | null>(null);
  const patchChunks = useMemo(
    () => buildPatchChunks(diff?.patch ?? "", title),
    [diff?.patch, title],
  );
  const showLoadingState = loading && !error && !diff;
  const showDiffStat = showStat && Boolean(diff?.stat);
  const closeSelectionContextMenu = useCallback(() => {
    setSelectionContextMenu(null);
  }, []);

  const runSelectionAutoscroll = useCallback(() => {
    selectionAutoscrollFrameRef.current = null;
    const viewports = selectionAutoscrollViewportsRef.current;
    const pointer = selectionAutoscrollPointerRef.current;
    if (viewports.length === 0 || !pointer) return;

    let verticalScrolled = false;
    let horizontalScrolled = false;
    for (const viewport of viewports) {
      if (!viewport.isConnected) continue;
      if (
        !verticalScrolled &&
        scrollDiffSelectionViewportForPointer(viewport, pointer.x, pointer.y, "vertical")
      ) {
        verticalScrolled = true;
        syncGitReviewAutoscrollScrollbar(viewport);
      }
      if (
        !horizontalScrolled &&
        scrollDiffSelectionViewportForPointer(viewport, pointer.x, pointer.y, "horizontal")
      ) {
        horizontalScrolled = true;
        syncGitReviewAutoscrollScrollbar(viewport);
      }
      if (verticalScrolled && horizontalScrolled) break;
    }

    selectionAutoscrollFrameRef.current = window.requestAnimationFrame(runSelectionAutoscroll);
  }, []);

  const requestSelectionAutoscroll = useCallback(() => {
    if (selectionAutoscrollFrameRef.current !== null) return;
    selectionAutoscrollFrameRef.current = window.requestAnimationFrame(runSelectionAutoscroll);
  }, [runSelectionAutoscroll]);

  const stopSelectionAutoscroll = useCallback(() => {
    if (selectionAutoscrollFrameRef.current !== null) {
      window.cancelAnimationFrame(selectionAutoscrollFrameRef.current);
      selectionAutoscrollFrameRef.current = null;
    }
    selectionAutoscrollViewportsRef.current = [];
    selectionAutoscrollPointerRef.current = null;
  }, []);

  useEffect(() => stopSelectionAutoscroll, [stopSelectionAutoscroll]);

  useEffect(() => {
    closeSelectionContextMenu();
  }, [closeSelectionContextMenu, diff?.patch, error, loading]);

  useEffect(() => {
    if (!selectionContextMenu) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        closeSelectionContextMenu();
        return;
      }
      if (contextMenuRef.current?.contains(target)) {
        return;
      }
      closeSelectionContextMenu();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeSelectionContextMenu();
      }
    };

    const handleSelectionChange = () => {
      if (!resolveContainedSelectionText(rootRef.current)) {
        closeSelectionContextMenu();
      }
    };

    const handleViewportChange = () => {
      closeSelectionContextMenu();
    };

    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("blur", handleViewportChange);
    document.addEventListener("selectionchange", handleSelectionChange);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("scroll", handleViewportChange, true);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("blur", handleViewportChange);
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, [closeSelectionContextMenu, selectionContextMenu]);

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!isDiffSelectableContentTarget(rootRef.current, event.target)) {
        closeSelectionContextMenu();
        return;
      }
      const selectedText = resolveContainedSelectionText(rootRef.current);
      if (!selectedText) {
        closeSelectionContextMenu();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setSelectionContextMenu({
        x: event.clientX,
        y: event.clientY,
        selectedText,
      });
    },
    [closeSelectionContextMenu],
  );

  const handleSelectionPointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      if (!isDiffSelectableContentTarget(rootRef.current, event.target)) return;

      const target = event.target instanceof Element ? event.target : null;
      const viewports = resolveDiffSelectionScrollViewports(
        target,
        rootRef.current,
        scrollViewportRef.current,
      );
      if (viewports.length === 0) return;

      closeSelectionContextMenu();
      selectionAutoscrollViewportsRef.current = viewports;
      selectionAutoscrollPointerRef.current = { x: event.clientX, y: event.clientY };
      requestSelectionAutoscroll();

      let cleanup = () => {};
      const handleMove = (moveEvent: PointerEvent) => {
        if ((moveEvent.buttons & 1) === 0) {
          cleanup();
          return;
        }
        selectionAutoscrollPointerRef.current = {
          x: moveEvent.clientX,
          y: moveEvent.clientY,
        };
      };
      cleanup = () => {
        stopSelectionAutoscroll();
        window.removeEventListener("pointermove", handleMove, true);
        window.removeEventListener("pointerup", cleanup, true);
        window.removeEventListener("pointercancel", cleanup, true);
        window.removeEventListener("blur", cleanup);
      };

      window.addEventListener("pointermove", handleMove, true);
      window.addEventListener("pointerup", cleanup, true);
      window.addEventListener("pointercancel", cleanup, true);
      window.addEventListener("blur", cleanup);
    },
    [closeSelectionContextMenu, requestSelectionAutoscroll, stopSelectionAutoscroll],
  );

  const selectionContextMenuPosition = selectionContextMenu
    ? clampDiffSelectionContextMenuPosition(selectionContextMenu.x, selectionContextMenu.y)
    : null;
  const copySelectedTextLabel =
    locale === "en-US" ? "Copy selected text" : "复制选中文本";

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={title}
      className="git-review-diff-selectable flex min-h-0 flex-1 select-none flex-col overflow-hidden"
      onContextMenu={handleContextMenu}
      onPointerDownCapture={handleSelectionPointerDownCapture}
    >
      {error ? <div className="shrink-0 px-3 py-3 text-xs text-destructive">{error}</div> : null}
      {!error && showDiffStat ? <DiffStatView stat={diff?.stat ?? ""} /> : null}
      {showLoadingState ? (
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 px-3 py-8 text-center text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{t("projectTools.loading")}</span>
        </div>
      ) : null}
      {!error && !showLoadingState && patchChunks.length > 0 ? (
        <div
          ref={(node) => {
            scrollViewportRef.current = node;
          }}
          className={cn(
            GIT_REVIEW_TRANSIENT_SCROLLBAR_CLASS,
            "git-review-diff-selectable-content min-h-0 flex-1 select-text overflow-x-hidden overflow-y-auto",
          )}
          onScroll={handleGitReviewTransientScroll}
        >
          {patchChunks.map((item) => (
            <DiffChunkView key={item.key} item={item} isDark={isDark} />
          ))}
        </div>
      ) : null}
      {!error && !showLoadingState && diff?.patch.trim() && patchChunks.length === 0 ? (
        <pre
          ref={(node) => {
            scrollViewportRef.current = node;
          }}
          className={cn(
            GIT_REVIEW_TRANSIENT_SCROLLBAR_CLASS,
            "git-review-diff-selectable-content min-h-0 flex-1 select-text overflow-auto px-3 py-3 text-[11px] leading-relaxed text-muted-foreground",
          )}
          onScroll={handleGitReviewTransientScroll}
        >
          {diff.patch}
        </pre>
      ) : null}
      {!error && !showLoadingState && diff && !diff.patch.trim() && patchChunks.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-3 py-8 text-center text-xs text-muted-foreground">
          {t("projectTools.gitReview.noDiff")}
        </div>
      ) : null}
      {diff?.truncated ? (
        <div className="shrink-0 border-t border-border/70 px-3 py-2 text-[11px] text-amber-600 dark:text-amber-300">
          {t("projectTools.gitReview.diffOutputTruncated")}
        </div>
      ) : null}
      {selectionContextMenu && selectionContextMenuPosition
        ? createPortal(
            <div
              ref={contextMenuRef}
              role="menu"
              className="editor-context-menu fixed z-[120] w-max min-w-[9.5rem] max-w-[calc(100vw-1.5rem)] select-none overflow-hidden rounded-xl border border-border/60 bg-popover/80 p-1 text-popover-foreground shadow-2xl ring-1 ring-black/[0.03] backdrop-blur-xl dark:ring-white/[0.06]"
              style={{
                left: selectionContextMenuPosition.left,
                top: selectionContextMenuPosition.top,
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-foreground/90 transition-colors hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  writeTextToClipboard(selectionContextMenu.selectedText);
                  closeSelectionContextMenu();
                }}
              >
                <Copy className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{copySelectedTextLabel}</span>
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function DiffReviewCard(props: {
  activeView: DiffViewKind;
  branchDiff?: GitDiffResponse | null;
  branchError?: string;
  diffLoading?: boolean;
  onActiveViewChange: (view: DiffViewKind) => void;
  showStat?: boolean;
  worktreeDiff?: GitDiffResponse | null;
}) {
  const {
    activeView,
    branchDiff,
    branchError,
    diffLoading,
    onActiveViewChange,
    showStat,
    worktreeDiff,
  } = props;
  const { t } = useLocale();
  const activeDiff = activeView === "branch" ? branchDiff : worktreeDiff;
  const branchTitle = t("projectTools.gitReview.branchDiff");
  const workingTreeTitle = t("projectTools.gitReview.workingTree");
  const activeTitle = activeView === "branch" ? branchTitle : workingTreeTitle;
  const activeError = activeView === "branch" ? branchError : "";

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/70 bg-background">
      <div className="sticky top-0 z-10 flex shrink-0 items-center justify-between gap-2 border-b border-border/70 bg-background px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold">{activeTitle}</div>
          {activeDiff ? (
            <div className="truncate text-[11px] text-muted-foreground">
              {activeDiff.baseRef} → {activeDiff.headRef}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {diffLoading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
          <Button
            type="button"
            size="sm"
            variant={activeView === "workingTree" ? "secondary" : "ghost"}
            className="h-7 w-7 px-0"
            title={workingTreeTitle}
            aria-label={t("projectTools.gitReview.showWorkingTree")}
            onClick={() => onActiveViewChange("workingTree")}
          >
            <FolderTree className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant={activeView === "branch" ? "secondary" : "ghost"}
            className="h-7 w-7 px-0"
            title={branchTitle}
            aria-label={t("projectTools.gitReview.showBranchDiff")}
            onClick={() => onActiveViewChange("branch")}
          >
            <GitBranch className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <DiffContent
        title={activeTitle}
        diff={activeDiff}
        error={activeError}
        loading={diffLoading}
        showStat={showStat}
      />
    </section>
  );
}

function statusTone(entry: GitStatusEntry) {
  if (entry.conflicted) return "text-destructive";
  if (entry.untracked) return "text-sky-600 dark:text-sky-300";
  if (entry.staged) return "text-emerald-600 dark:text-emerald-300";
  return "text-amber-600 dark:text-amber-300";
}

function statusLabel(entry: GitStatusEntry) {
  if (entry.conflicted) return "U";
  if (entry.untracked) return "U";
  const statuses = [entry.indexStatus, entry.worktreeStatus].filter((status) => status && status !== ".");
  if (entry.kind === "renamed" || statuses.includes("R")) return "R";
  if (statuses.includes("D")) return "D";
  if (statuses.includes("A")) return "A";
  if (statuses.includes("M") || statuses.includes("T")) return "M";
  return statuses[0] ?? "";
}

function commitFileStatusTone(file: GitCommitFile) {
  const status = file.status.charAt(0).toUpperCase();
  if (status === "A") return "text-emerald-600 dark:text-emerald-300";
  if (status === "D") return "text-rose-600 dark:text-rose-300";
  if (status === "R" || status === "C") return "text-sky-600 dark:text-sky-300";
  return "text-amber-600 dark:text-amber-300";
}

function commitFileStatusLabel(file: GitCommitFile) {
  const status = file.status.charAt(0).toUpperCase();
  return status === "R" || status === "C" || status === "A" || status === "D" ? status : "M";
}

const GRAPH_SWIMLANE_WIDTH = 11;
const GRAPH_SVG_HEIGHT = 22;
const GRAPH_DOT_Y = GRAPH_SWIMLANE_WIDTH;
const GRAPH_DOT_R = 4;
const GRAPH_STROKE_W = 2;
const GRAPH_LINE_W = 1;
const GRAPH_CURVE_R = 5;
const COMMIT_REF_TAG_LIMIT = 1;
const COMMIT_DETAIL_REF_TAG_LIMIT = 3;

function graphLayoutWidth(row: GraphRow) {
  return graphLaneWidth(graphColumnCount(row));
}

function graphColumnCount(row: GraphRow) {
  return Math.max(row.inputLanes.length, row.outputLanes.length, row.commitCol + 1, 1);
}

function graphLaneWidth(columnCount: number) {
  return GRAPH_SWIMLANE_WIDTH * (columnCount + 1);
}

function graphLaneX(col: number) {
  return GRAPH_SWIMLANE_WIDTH * (col + 1);
}

function graphColor(color: GraphColor) {
  if (typeof color === "string") return color;
  return GRAPH_COLORS[((color % GRAPH_COLORS.length) + GRAPH_COLORS.length) % GRAPH_COLORS.length];
}

function findLastGraphLaneIndex(lanes: GraphRow["outputLanes"], id: string) {
  for (let index = lanes.length - 1; index >= 0; index--) {
    if (lanes[index].id === id) return index;
  }
  return -1;
}

function graphVerticalPath(col: number, y1 = 0, y2 = GRAPH_SVG_HEIGHT) {
  const x = graphLaneX(col);
  return `M ${x} ${y1} V ${y2}`;
}

function graphCommitJoinPath(fromCol: number, toCol: number) {
  if (fromCol === toCol) return graphVerticalPath(fromCol, 0, GRAPH_DOT_Y);
  const x1 = graphLaneX(fromCol);
  const x2 = graphLaneX(toCol);
  const direction = toCol > fromCol ? 1 : -1;
  return [
    `M ${x1} 0`,
    `A ${GRAPH_SWIMLANE_WIDTH} ${GRAPH_SWIMLANE_WIDTH} 0 0 ${direction > 0 ? 0 : 1} ${
      x1 + direction * GRAPH_SWIMLANE_WIDTH
    } ${GRAPH_DOT_Y}`,
    `H ${x2}`,
  ].join(" ");
}

function graphParentBranchPath(fromCol: number, toCol: number) {
  if (fromCol === toCol) return "";
  const circleX = graphLaneX(fromCol);
  const branchX = GRAPH_SWIMLANE_WIDTH * toCol;
  const parentX = graphLaneX(toCol);
  return [
    `M ${branchX} ${GRAPH_DOT_Y}`,
    `A ${GRAPH_SWIMLANE_WIDTH} ${GRAPH_SWIMLANE_WIDTH} 0 0 1 ${parentX} ${GRAPH_SVG_HEIGHT}`,
    `M ${branchX} ${GRAPH_DOT_Y}`,
    `H ${circleX}`,
  ].join(" ");
}

function graphCircleColor(row: GraphRow) {
  const lane = row.outputLanes[row.commitCol] ?? row.inputLanes[row.commitCol];
  return graphColor(lane?.color ?? row.commitColor);
}

type CommitRefKind = "head" | "branch" | "remote" | "tag" | "ref";

type CommitRefTagInfo = {
  label: string;
  kind: CommitRefKind;
  title: string;
  order: number;
  index: number;
};

type CommitRefTagOptions = {
  remoteName?: string;
};

const COMMIT_REF_KIND_ORDER: Record<CommitRefKind, number> = {
  head: 0,
  branch: 1,
  remote: 2,
  tag: 3,
  ref: 4,
};

const COMMIT_REF_KIND_TITLE: Record<CommitRefKind, string> = {
  head: "HEAD",
  branch: "Branch",
  remote: "Remote branch",
  tag: "Tag",
  ref: "Ref",
};

function normalizeRefRemoteName(remoteName: string | undefined) {
  return remoteName?.trim().replace(/^refs\/remotes\//, "").replace(/\/HEAD$/, "") ?? "";
}

function isLikelyRemoteRefLabel(ref: string, remoteName: string | undefined) {
  const remote = normalizeRefRemoteName(remoteName);
  if (remote && ref.startsWith(`${remote}/`)) return true;
  return /^(origin|upstream)\//.test(ref);
}

function commitRefTagInfo(rawRef: string, index: number, options: CommitRefTagOptions) {
  const raw = rawRef.trim();
  if (!raw) return null;

  let ref = raw;
  let isHead = false;
  let isTag = false;

  if (ref.startsWith("HEAD -> ")) {
    isHead = true;
    ref = ref.slice("HEAD -> ".length).trim();
  }

  if (ref.startsWith("tag: ")) {
    isTag = true;
    ref = ref.slice("tag: ".length).trim();
  }

  if (!ref || ref === "HEAD" || ref.endsWith("/HEAD")) return null;

  let kind: CommitRefKind = "ref";
  let label = ref;
  if (ref.startsWith("refs/heads/")) {
    kind = "branch";
    label = ref.slice("refs/heads/".length);
  } else if (ref.startsWith("refs/remotes/")) {
    kind = "remote";
    label = ref.slice("refs/remotes/".length);
  } else if (ref.startsWith("refs/tags/")) {
    kind = "tag";
    label = ref.slice("refs/tags/".length);
  } else if (isTag) {
    kind = "tag";
  } else if (isLikelyRemoteRefLabel(ref, options.remoteName)) {
    kind = "remote";
  } else {
    kind = "branch";
  }

  if (!label) return null;
  const resolvedKind = isHead ? "head" : kind;
  return {
    label,
    kind: resolvedKind,
    title: `${COMMIT_REF_KIND_TITLE[resolvedKind]}: ${label}`,
    order: COMMIT_REF_KIND_ORDER[resolvedKind],
    index,
  } satisfies CommitRefTagInfo;
}

function orderedCommitRefTags(refs: readonly string[], options: CommitRefTagOptions = {}) {
  const orderedRefs: CommitRefTagInfo[] = [];
  const seenRefs = new Set<string>();
  refs.forEach((rawRef, index) => {
    const ref = commitRefTagInfo(rawRef, index, options);
    if (!ref) return;
    const key = `${ref.kind}\x00${ref.label}`;
    if (seenRefs.has(key)) return;
    seenRefs.add(key);
    orderedRefs.push(ref);
  });
  return orderedRefs.sort((left, right) => {
    if (left.order !== right.order) return left.order - right.order;
    return left.index - right.index;
  });
}

function orderedCommitRefs(refs: readonly string[], options: CommitRefTagOptions = {}) {
  return orderedCommitRefTags(refs, options).map((ref) => ref.label);
}

function commitRefChipClass(kind: CommitRefKind, selected: boolean) {
  const baseClass =
    "inline-flex h-5 min-w-0 items-center gap-1 rounded-full border px-1.5 text-[10px] font-semibold leading-[14px] shadow-sm ring-1 ring-inset";

  if (selected) {
    return cn(
      baseClass,
      "border-accent-foreground/35 bg-accent-foreground/15 text-accent-foreground ring-accent-foreground/20",
    );
  }

  switch (kind) {
    case "head":
      return cn(
        baseClass,
        "border-emerald-300/60 bg-emerald-50 text-emerald-700 ring-emerald-200/70 dark:border-emerald-300/35 dark:bg-emerald-950/45 dark:text-emerald-200 dark:ring-emerald-300/15",
      );
    case "remote":
      return cn(
        baseClass,
        "border-blue-300/60 bg-blue-50 text-blue-700 ring-blue-200/70 dark:border-blue-300/35 dark:bg-blue-950/45 dark:text-blue-200 dark:ring-blue-300/15",
      );
    case "tag":
      return cn(
        baseClass,
        "border-amber-300/60 bg-amber-50 text-amber-700 ring-amber-200/70 dark:border-amber-300/35 dark:bg-amber-950/45 dark:text-amber-200 dark:ring-amber-300/15",
      );
    case "branch":
      return cn(
        baseClass,
        "border-sky-300/60 bg-sky-50 text-sky-700 ring-sky-200/70 dark:border-sky-300/35 dark:bg-sky-950/45 dark:text-sky-200 dark:ring-sky-300/15",
      );
    case "ref":
    default:
      return cn(
        baseClass,
        "border-border/70 bg-muted/50 text-muted-foreground ring-border/60",
      );
  }
}

function CommitRefTagIcon({
  kind,
  variant,
}: {
  kind: CommitRefKind;
  variant: "list" | "detail";
}) {
  const className = cn("shrink-0 opacity-85", variant === "detail" ? "h-3 w-3" : "h-2.5 w-2.5");
  switch (kind) {
    case "head":
      return <Target className={className} aria-hidden="true" />;
    case "branch":
      return <GitBranch className={className} aria-hidden="true" />;
    case "remote":
      return <Cloud className={className} aria-hidden="true" />;
    case "tag":
      return <Tag className={className} aria-hidden="true" />;
    case "ref":
    default:
      return <GitCommitHorizontal className={className} aria-hidden="true" />;
  }
}

function commitHistoryTitle(commit: GitCommitSummary) {
  const label = commit.subject || commit.shortSha;
  const refs = orderedCommitRefs(commit.refs);
  return refs.length > 0 ? `${label} - ${refs.join(", ")}` : label;
}

function gitHistoryMarkerRef(
  kind: GitHistoryMarkerKind,
  state: Pick<GitRepositoryState, "head">,
  historyRemoteRef: string,
) {
  return kind === "outgoing-changes" ? state.head : historyRemoteRef;
}

const EMPTY_GIT_HISTORY_GRAPH_STATE: GitHistoryGraphState = {
  historyBaseRef: "",
  historyRemoteRef: "",
  historyAhead: 0,
  historyBehind: 0,
  mergeBase: "",
};

function gitHistoryGraphStateFromResponse(response: GitLogResponse): GitHistoryGraphState {
  return {
    historyBaseRef: response.historyBaseRef,
    historyRemoteRef: response.historyRemoteRef,
    historyAhead: response.historyAhead,
    historyBehind: response.historyBehind,
    mergeBase: response.mergeBase,
  };
}

function CommitRefTags({
  refs,
  selected,
  remoteName,
  variant = "list",
  limit = COMMIT_REF_TAG_LIMIT,
}: {
  refs: readonly string[];
  selected: boolean;
  remoteName?: string;
  variant?: "list" | "detail";
  limit?: number;
}) {
  const orderedRefs = orderedCommitRefTags(refs, { remoteName });
  if (orderedRefs.length === 0) return null;

  const visibleRefs = orderedRefs.slice(0, Math.max(0, limit));
  const hiddenCount = orderedRefs.length - visibleRefs.length;

  return (
    <span
      className={
        variant === "detail"
          ? "mt-1.5 flex min-w-0 flex-wrap items-center gap-1 overflow-visible"
          : "mt-0.5 flex max-w-[52%] shrink-0 items-center justify-end gap-1 overflow-x-hidden overflow-y-visible"
      }
      title={orderedRefs.map((ref) => ref.title).join(", ")}
    >
      {visibleRefs.map((ref) => (
        <span
          key={`${ref.kind}:${ref.label}`}
          title={ref.title}
          aria-label={ref.title}
          className={cn(
            commitRefChipClass(ref.kind, selected),
            variant === "detail" ? "max-w-[12rem] shrink-0" : "max-w-[8.5rem] shrink",
          )}
        >
          <CommitRefTagIcon kind={ref.kind} variant={variant} />
          <span className="truncate leading-[14px]">{ref.label}</span>
        </span>
      ))}
      {hiddenCount > 0 ? (
        <span
          className={cn(commitRefChipClass("ref", selected), "shrink-0 px-1.5 leading-[14px]")}
        >
          +{hiddenCount}
        </span>
      ) : null}
    </span>
  );
}

function GitGraphCommitMarker({
  cx,
  color,
  kind,
  isHead,
  isMerge,
}: {
  cx: number;
  color: string;
  kind: GraphRow["kind"];
  isHead: boolean;
  isMerge: boolean;
}) {
  if (kind === "incoming-changes" || kind === "outgoing-changes") {
    return (
      <g>
        <circle
          cx={cx}
          cy={GRAPH_DOT_Y}
          r={GRAPH_DOT_R + 3}
          fill={color}
          stroke="var(--git-review-graph-background)"
          strokeWidth={GRAPH_STROKE_W}
        />
        <circle
          cx={cx}
          cy={GRAPH_DOT_Y}
          r={GRAPH_DOT_R + 1}
          fill="var(--git-review-graph-background)"
          stroke="var(--git-review-graph-background)"
          strokeWidth={GRAPH_STROKE_W + 1}
        />
        <circle
          cx={cx}
          cy={GRAPH_DOT_Y}
          r={GRAPH_DOT_R + 1}
          fill="none"
          stroke={color}
          strokeDasharray="4 2"
          strokeWidth={Math.max(1, GRAPH_STROKE_W - 1)}
        />
      </g>
    );
  }

  if (isHead) {
    return (
      <g>
        <circle
          cx={cx}
          cy={GRAPH_DOT_Y}
          r={GRAPH_DOT_R + 3}
          fill={color}
          stroke="var(--git-review-graph-background)"
          strokeWidth={GRAPH_STROKE_W}
        />
        <circle
          cx={cx}
          cy={GRAPH_DOT_Y}
          r={GRAPH_DOT_R - 2}
          fill="var(--git-review-graph-background)"
          stroke="var(--git-review-graph-background)"
          strokeWidth={GRAPH_DOT_R}
        />
      </g>
    );
  }

  if (!isMerge) {
    return (
      <circle
        cx={cx}
        cy={GRAPH_DOT_Y}
        r={GRAPH_DOT_R + 1}
        fill={color}
        stroke="var(--git-review-graph-background)"
        strokeWidth={GRAPH_STROKE_W}
      />
    );
  }

  return (
    <g>
      <circle
        cx={cx}
        cy={GRAPH_DOT_Y}
        r={GRAPH_DOT_R + 2}
        fill={color}
        stroke="var(--git-review-graph-background)"
        strokeWidth={GRAPH_STROKE_W}
      />
      <circle
        cx={cx}
        cy={GRAPH_DOT_Y}
        r={GRAPH_DOT_R - 1}
        fill={color}
        stroke="var(--git-review-graph-background)"
        strokeWidth={GRAPH_STROKE_W}
      />
    </g>
  );
}

function GitGraphSvgCell({ row }: { row: GraphRow }) {
  const layoutW = graphLayoutWidth(row);
  const cx = graphLaneX(row.commitCol);
  const commitColor = graphCircleColor(row);
  const commitInputColor = graphColor(row.commitColor);
  let outputIndex = 0;

  return (
    <div
      className="shrink-0 self-center overflow-visible"
      style={{ width: layoutW, minWidth: layoutW, height: GRAPH_SVG_HEIGHT }}
    >
      <svg
        width={layoutW}
        height={GRAPH_SVG_HEIGHT}
        className="block overflow-visible"
        aria-hidden="true"
        style={{ shapeRendering: "geometricPrecision" }}
      >
        {row.inputLanes.map((lane, index) => {
          if (lane.id === row.sha) {
            if (index !== row.commitCol) {
              return (
                <path
                  key={`join-${index}-${lane.id}`}
                  d={graphCommitJoinPath(index, row.commitCol)}
                  fill="none"
                  stroke={graphColor(lane.color)}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={GRAPH_LINE_W}
                />
              );
            }

            outputIndex++;
            return null;
          }

          if (
            outputIndex < row.outputLanes.length &&
            lane.id === row.outputLanes[outputIndex].id
          ) {
            if (index === outputIndex) {
              outputIndex++;
              return (
                <path
                  key={`lane-${index}-${lane.id}`}
                  d={graphVerticalPath(index)}
                  fill="none"
                  stroke={graphColor(lane.color)}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={GRAPH_LINE_W}
                />
              );
            }

            const d: string[] = [];
            d.push(`M ${graphLaneX(index)} 0`);
            d.push(`V 6`);
            d.push(
              `A ${GRAPH_CURVE_R} ${GRAPH_CURVE_R} 0 0 1 ${graphLaneX(index) - GRAPH_CURVE_R} ${GRAPH_DOT_Y}`,
            );
            d.push(`H ${graphLaneX(outputIndex) + GRAPH_CURVE_R}`);
            d.push(
              `A ${GRAPH_CURVE_R} ${GRAPH_CURVE_R} 0 0 0 ${graphLaneX(outputIndex)} ${
                GRAPH_DOT_Y + GRAPH_CURVE_R
              }`,
            );
            d.push(`V ${GRAPH_SVG_HEIGHT}`);

            outputIndex++;
            return (
              <path
                key={`lane-${index}-${lane.id}`}
                d={d.join(" ")}
                fill="none"
                stroke={graphColor(lane.color)}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={GRAPH_LINE_W}
              />
            );
          }

          return null;
        })}

        {row.parents.slice(1).map((parentId, index) => {
          const parentIndex = findLastGraphLaneIndex(row.outputLanes, parentId);
          if (parentIndex === -1 || parentIndex === row.commitCol) {
            return null;
          }

          return (
            <path
              key={`parent-${index}-${parentId}`}
              d={graphParentBranchPath(row.commitCol, parentIndex)}
              fill="none"
              stroke={graphColor(row.outputLanes[parentIndex].color)}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={GRAPH_LINE_W}
            />
          );
        })}

        {row.inputLanes.some((lane) => lane.id === row.sha) ? (
          <path
            d={graphVerticalPath(row.commitCol, 0, GRAPH_DOT_Y)}
            fill="none"
            stroke={commitInputColor}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={GRAPH_LINE_W}
          />
        ) : null}

        {row.parents.length > 0 ? (
          <path
            d={graphVerticalPath(row.commitCol, GRAPH_DOT_Y, GRAPH_SVG_HEIGHT)}
            fill="none"
            stroke={commitColor}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={GRAPH_LINE_W}
          />
        ) : null}

        <GitGraphCommitMarker
          cx={cx}
          color={commitColor}
          kind={row.kind}
          isHead={row.isHead}
          isMerge={row.isMerge}
        />
      </svg>
    </div>
  );
}

function GitGraphContinuationCell({ row }: { row: GraphRow }) {
  const layoutW = graphLayoutWidth(row);

  return (
    <div
      className="shrink-0 self-center overflow-visible"
      style={{ width: layoutW, minWidth: layoutW, height: GRAPH_SVG_HEIGHT }}
      aria-hidden="true"
    >
      <svg
        width={layoutW}
        height={GRAPH_SVG_HEIGHT}
        className="block overflow-visible"
        style={{ shapeRendering: "geometricPrecision" }}
      >
        {row.outputLanes.map((lane, index) => (
          <path
            key={`c${index}:${lane.id}:${lane.color}`}
            d={graphVerticalPath(index)}
            fill="none"
            stroke={graphColor(lane.color)}
            strokeLinecap="round"
            strokeWidth={GRAPH_LINE_W}
          />
        ))}
      </svg>
    </div>
  );
}

function GitOperationNoticeToast({
  notice,
  onDismiss,
}: {
  notice: GitOperationNotice | null;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(onDismiss, notice.kind === "success" ? 4200 : 7000);
    return () => window.clearTimeout(timer);
  }, [notice, onDismiss]);

  if (!notice) return null;

  const isSuccess = notice.kind === "success";
  return (
    <div className="pointer-events-none absolute bottom-3 right-3 z-50 flex max-w-[calc(100%-1.5rem)] justify-end">
      <div
        role={isSuccess ? "status" : "alert"}
        aria-live={isSuccess ? "polite" : "assertive"}
        className={cn(
          "pointer-events-auto flex w-80 max-w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm shadow-lg backdrop-blur-xl",
          isSuccess
            ? "border-emerald-500/25 bg-emerald-50/95 text-emerald-900 dark:bg-emerald-950/85 dark:text-emerald-100"
            : "border-red-500/30 bg-red-50/95 text-red-900 dark:bg-red-950/85 dark:text-red-100",
        )}
      >
        {isSuccess ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-300" />
        ) : (
          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-300" />
        )}
        <div className="min-w-0 flex-1">
          <div className="font-medium leading-5">{notice.title}</div>
          {notice.message ? (
            <div
              className={cn(
                "mt-0.5 max-h-24 overflow-auto whitespace-pre-wrap break-words text-xs leading-5",
                isSuccess ? "text-emerald-800/80 dark:text-emerald-100/75" : "text-red-800/80 dark:text-red-100/75",
              )}
            >
              {notice.message}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="mt-0.5 shrink-0 rounded p-0.5 opacity-55 transition-opacity hover:opacity-100"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function formatCommitDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function normalizeGitHubRepositoryUrl(remoteUrl: string) {
  const value = remoteUrl.trim();
  if (!value) return "";
  const sshMatch = /^git@github\.com:([^/\s]+)\/(.+?)(?:\.git)?$/i.exec(value);
  if (sshMatch?.[1] && sshMatch[2]) {
    return `https://github.com/${sshMatch[1]}/${sshMatch[2].replace(/\.git$/i, "")}`;
  }
  try {
    const url = new URL(value);
    if (!["github.com", "www.github.com"].includes(url.hostname.toLowerCase())) return "";
    const parts = url.pathname
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .filter(Boolean);
    if (parts.length < 2) return "";
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, "");
    if (!owner || !repo) return "";
    return `https://github.com/${owner}/${repo}`;
  } catch {
    return "";
  }
}

function gitHubCommitUrl(remoteUrl: string, sha: string) {
  const repoUrl = normalizeGitHubRepositoryUrl(remoteUrl);
  const commitSha = sha.trim();
  return repoUrl && commitSha ? `${repoUrl}/commit/${commitSha}` : "";
}

function encodeGitHubPath(path: string) {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function gitHubFileUrl(remoteUrl: string, commitSha: string, file: GitCommitFile) {
  if (file.status.charAt(0).toUpperCase() === "D") return "";
  const repoUrl = normalizeGitHubRepositoryUrl(remoteUrl);
  const sha = commitSha.trim();
  const path = encodeGitHubPath(file.path);
  return repoUrl && sha && path ? `${repoUrl}/blob/${sha}/${path}` : "";
}

function commitContextRefName(
  commit: GitCommitSummary,
  state: Pick<GitRepositoryState, "remoteName">,
) {
  const refs = orderedCommitRefTags(commit.refs, { remoteName: state.remoteName });
  return (
    refs.find((ref) => ref.kind === "remote")?.label ||
    refs.find((ref) => ref.kind === "head")?.label ||
    refs.find((ref) => ref.kind === "branch")?.label ||
    refs[0]?.label ||
    commit.shortSha ||
    commit.sha.slice(0, 7)
  );
}

function gitFileContextPayload(
  commit: GitCommitSummary,
  file: GitCommitFile,
  state: Pick<GitRepositoryState, "remoteName" | "remoteUrl">,
): GitFileContextPayload {
  return {
    path: file.path,
    oldPath: file.oldPath ?? undefined,
    status: file.status,
    commitSha: commit.sha,
    shortSha: commit.shortSha || commit.sha.slice(0, 7),
    refName: commitContextRefName(commit, state),
    remoteName: state.remoteName,
    remoteUrl: state.remoteUrl,
    githubUrl: gitHubFileUrl(state.remoteUrl, commit.sha, file) || undefined,
  };
}

function defaultBranchNameForCommit(commit: Pick<GitCommitSummary, "sha" | "shortSha">) {
  const shortSha = commit.shortSha || commit.sha.slice(0, 7);
  return `commit/${shortSha}`;
}

function commitMessageText(commit: Pick<GitCommitDetails, "subject" | "body">) {
  return [commit.subject.trim(), commit.body.trim()].filter(Boolean).join("\n\n");
}

function canStageEntry(entry: GitStatusEntry) {
  return entry.untracked || entry.conflicted || entry.worktreeStatus !== ".";
}

function canUnstageEntry(entry: GitStatusEntry) {
  return !entry.untracked && !entry.conflicted && entry.indexStatus !== ".";
}

function revealTargetForEntry(entry: GitStatusEntry) {
  if (!entry.untracked && (entry.indexStatus === "D" || entry.worktreeStatus === "D")) {
    return dirname(entry.oldPath ?? entry.path);
  }
  return entry.path;
}

function writeTextToClipboard(text: string) {
  if (!text.trim()) return;
  const value = text;
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(value).catch(() => {
      fallbackWriteTextToClipboard(value);
    });
    return;
  }
  fallbackWriteTextToClipboard(value);
}

function fallbackWriteTextToClipboard(text: string) {
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
}

function elementForSelectionNode(node: Node) {
  return node instanceof Element ? node : node.parentElement;
}

function isDiffSelectableContentNode(root: HTMLElement | null, node: Node) {
  const element = elementForSelectionNode(node);
  const selectable = element?.closest(".git-review-diff-selectable-content");
  return Boolean(root && selectable && root.contains(selectable));
}

function isDiffSelectableContentTarget(root: HTMLElement | null, target: EventTarget | null) {
  if (!(target instanceof Node)) return false;
  return isDiffSelectableContentNode(root, target);
}

function resolveContainedSelectionText(root: HTMLElement | null) {
  if (!root) return "";

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return "";
  }

  const selectedText = selection.toString();
  if (!selectedText.trim()) return "";

  const range = selection.getRangeAt(0);
  if (
    !isDiffSelectableContentNode(root, range.startContainer) ||
    !isDiffSelectableContentNode(root, range.endContainer)
  ) {
    return "";
  }

  return selectedText;
}

function clampDiffSelectionContextMenuPosition(x: number, y: number) {
  const maxLeft = Math.max(
    DIFF_SELECTION_CONTEXT_MENU_MARGIN,
    window.innerWidth -
      DIFF_SELECTION_CONTEXT_MENU_WIDTH -
      DIFF_SELECTION_CONTEXT_MENU_MARGIN,
  );
  const maxTop = Math.max(
    DIFF_SELECTION_CONTEXT_MENU_MARGIN,
    window.innerHeight -
      DIFF_SELECTION_CONTEXT_MENU_HEIGHT -
      DIFF_SELECTION_CONTEXT_MENU_MARGIN,
  );

  return {
    left: Math.min(Math.max(DIFF_SELECTION_CONTEXT_MENU_MARGIN, x), maxLeft),
    top: Math.min(Math.max(DIFF_SELECTION_CONTEXT_MENU_MARGIN, y), maxTop),
  };
}

function gitRepositoryStateSignature(state: GitRepositoryState) {
  const dirty = state.dirtyCounts;
  const header = [
    state.status,
    state.error ?? "",
    state.repoRoot,
    state.workdir,
    state.head,
    state.upstream,
    state.remoteName,
    state.remoteUrl,
    state.ahead,
    state.behind,
    dirty.staged,
    dirty.unstaged,
    dirty.untracked,
    dirty.conflicted,
  ].join("\x1f");
  const entries = state.entries
    .map((entry) =>
      [
        entry.path,
        entry.oldPath ?? "",
        entry.indexStatus,
        entry.worktreeStatus,
        entry.kind,
        entry.staged ? "1" : "0",
        entry.conflicted ? "1" : "0",
        entry.untracked ? "1" : "0",
      ].join("\x1e"),
    )
    .join("\x1f");
  return `${header}\x1d${entries}`;
}

function gitHistorySignature(
  state: GitRepositoryState,
  commits: GitCommitSummary[],
  historyGraphState: GitHistoryGraphState,
) {
  const commitsSignature = commits
    .map((commit) =>
      [
        commit.sha,
        commit.parents.join(","),
        commit.refs.join(","),
        commit.authorDate,
        commit.subject,
        commit.fileCount,
        commit.localOnly ? "1" : "0",
        commit.files
          .map((file) => [file.path, file.oldPath ?? "", file.status, file.kind].join("\x1e"))
          .join("\x1c"),
      ].join("\x1e"),
    )
    .join("\x1f");
  return `${gitRepositoryStateSignature(state)}\x1d${historyGraphState.historyBaseRef}\x1e${historyGraphState.historyRemoteRef}\x1e${historyGraphState.historyAhead}\x1e${historyGraphState.historyBehind}\x1e${historyGraphState.mergeBase}\x1c${commitsSignature}`;
}

function gitDiffSignature(diff: GitDiffResponse) {
  return [
    diff.baseRef,
    diff.headRef,
    diff.mode,
    diff.files.join("\x1e"),
    diff.binaryFiles.join("\x1e"),
    diff.truncated ? "1" : "0",
    diff.stat,
    diff.patch,
  ].join("\x1f");
}

function assertGitOperationResult(value: unknown, fallbackMessage: string) {
  if (!value || typeof value !== "object") return;
  const result = value as { ok?: unknown; message?: unknown; stderr?: unknown };
  if (result.ok === false) {
    const message =
      typeof result.message === "string" && result.message.trim()
        ? result.message
        : typeof result.stderr === "string" && result.stderr.trim()
          ? result.stderr
          : fallbackMessage;
    throw new Error(message);
  }
}

type GitReviewPanelProps = {
  cwd: string;
  gitClient?: GitClient | null;
  canWrite?: boolean;
  disabledMessage?: string;
  onRevealInFileTree?: (path: string) => void;
  onInsertCommitMention?: (commit: GitCommitContextPayload) => void;
  onInsertGitFileMention?: (file: GitFileContextPayload) => void;
};

export const GitReviewPanel = memo(function GitReviewPanel(props: GitReviewPanelProps) {
  const {
    cwd,
    gitClient,
    canWrite = true,
    disabledMessage,
    onRevealInFileTree,
    onInsertCommitMention,
    onInsertGitFileMention,
  } = props;
  const { t } = useLocale();
  const [state, setState] = useState<GitRepositoryState>(() => emptyGitRepositoryState(cwd));
  const [branchDiff, setBranchDiff] = useState<GitDiffResponse | null>(null);
  const [worktreeDiff, setWorktreeDiff] = useState<GitDiffResponse | null>(null);
  const [branchError, setBranchError] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [remoteSetupOpen, setRemoteSetupOpen] = useState(false);
  const [remoteSetupAction, setRemoteSetupAction] = useState<GitRemoteSetupAction>("push");
  const [remoteSetupUrl, setRemoteSetupUrl] = useState("");
  const [remoteSetupError, setRemoteSetupError] = useState("");
  const [operationNotice, setOperationNotice] = useState<GitOperationNotice | null>(null);
  const [discardConfirm, setDiscardConfirm] = useState<GitDiscardConfirmState | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [selectedPath, setSelectedPath] = useState("");
  const [activeDiffView, setActiveDiffView] = useState<DiffViewKind>("workingTree");
  const [reviewMode, setReviewMode] = useState<GitReviewMode>("changes");
  const [historyCommits, setHistoryCommits] = useState<GitCommitSummary[]>([]);
  const [historyGraphState, setHistoryGraphState] = useState<GitHistoryGraphState>(
    EMPTY_GIT_HISTORY_GRAPH_STATE,
  );
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoadMoreError, setHistoryLoadMoreError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [selectedCommitSha, setSelectedCommitSha] = useState("");
  const [selectedCommitFilePath, setSelectedCommitFilePath] = useState("");
  const [expandedCommitShas, setExpandedCommitShas] = useState<Set<string>>(() => new Set());
  const [commitDiff, setCommitDiff] = useState<GitDiffResponse | null>(null);
  const [commitDiffLoading, setCommitDiffLoading] = useState(false);
  const [historyDiffTitle, setHistoryDiffTitle] = useState("");
  const [historyDiffSubtitle, setHistoryDiffSubtitle] = useState("");
  const [changeContextMenu, setChangeContextMenu] = useState<ChangeContextMenuState | null>(null);
  const [historyContextMenu, setHistoryContextMenu] = useState<HistoryContextMenuState | null>(null);
  const [changesMenu, setChangesMenu] = useState<ChangesMenuState | null>(null);
  const [branchFromCommit, setBranchFromCommit] = useState<GitBranchFromCommitState | null>(null);
  const [branchFromCommitName, setBranchFromCommitName] = useState("");
  const [branchFromCommitError, setBranchFromCommitError] = useState("");
  const [useSplitReviewLayout, setUseSplitReviewLayout] = useState(false);
  const [changesStackedPane, setChangesStackedPane] = useState<GitReviewStackedPane>("list");
  const [historyStackedPane, setHistoryStackedPane] = useState<GitReviewStackedPane>("list");
  const [changesStackedDir, setChangesStackedDir] = useState<"forward" | "back">("forward");
  const [historyStackedDir, setHistoryStackedDir] = useState<"forward" | "back">("forward");
  const [collapsedChangeSections, setCollapsedChangeSections] = useState<
    Record<ChangeListSection, boolean>
  >({
    staged: false,
    changes: false,
  });
  const selectedPathRef = useRef("");
  const selectedCommitShaRef = useRef("");
  const selectedCommitFilePathRef = useRef("");
  const historyCommitsRef = useRef<GitCommitSummary[]>([]);
  const historyHasMoreRef = useRef(false);
  const expandedCommitShasRef = useRef<Set<string>>(new Set());
  const reviewModeRef = useRef<GitReviewMode>("changes");
  const diffRequestIdRef = useRef(0);
  const diffInFlightRequestIdRef = useRef(0);
  const commitDiffRequestIdRef = useRef(0);
  const diffPathRef = useRef("");
  const commitDetailsCacheRef = useRef<Map<string, GitCommitDetails>>(new Map());
  const panelRef = useRef<HTMLDivElement | null>(null);
  const historyListRef = useRef<HTMLDivElement | null>(null);
  const changesListPaneRef = useRef<HTMLElement | null>(null);
  const changesDetailPaneRef = useRef<HTMLElement | null>(null);
  const historyListPaneRef = useRef<HTMLElement | null>(null);
  const historyDetailPaneRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef("");
  const statusSignatureRef = useRef("");
  const historySignatureRef = useRef("");
  const branchDiffSignatureRef = useRef("");
  const worktreeDiffSignatureRef = useRef("");
  const refreshInFlightRef = useRef(false);
  const historyInFlightRef = useRef(false);
  const suppressNextGitChangedRef = useRef(false);
  const operationNoticeIdRef = useRef(0);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    const updateLayout = () => {
      const nextUseSplitLayout =
        panel.getBoundingClientRect().width >= GIT_REVIEW_SPLIT_LAYOUT_MIN_WIDTH;
      setUseSplitReviewLayout((current) =>
        current === nextUseSplitLayout ? current : nextUseSplitLayout,
      );
    };

    updateLayout();
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateLayout);
    resizeObserver?.observe(panel);
    window.addEventListener("resize", updateLayout);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateLayout);
    };
  }, []);

  const beginGitOperation = useCallback((name: string) => {
    if (busyRef.current) {
      return false;
    }
    busyRef.current = name;
    setBusy(name);
    return true;
  }, []);

  const finishGitOperation = useCallback((name: string) => {
    if (busyRef.current !== name) {
      return;
    }
    busyRef.current = "";
    setBusy("");
  }, []);

  const setHistoryHasMoreValue = useCallback((value: boolean) => {
    historyHasMoreRef.current = value;
    setHistoryHasMore(value);
  }, []);

  useEffect(() => {
    selectedPathRef.current = selectedPath;
  }, [selectedPath]);

  useEffect(() => {
    reviewModeRef.current = reviewMode;
  }, [reviewMode]);

  useEffect(() => {
    selectedCommitShaRef.current = selectedCommitSha;
  }, [selectedCommitSha]);

  useEffect(() => {
    selectedCommitFilePathRef.current = selectedCommitFilePath;
  }, [selectedCommitFilePath]);

  useEffect(() => {
    historyCommitsRef.current = historyCommits;
  }, [historyCommits]);

  useEffect(() => {
    historyHasMoreRef.current = historyHasMore;
  }, [historyHasMore]);

  useEffect(() => {
    expandedCommitShasRef.current = expandedCommitShas;
  }, [expandedCommitShas]);

  useEffect(() => {
    if (useSplitReviewLayout) return;
    const el =
      changesStackedPane === "list"
        ? changesListPaneRef.current
        : changesDetailPaneRef.current;
    if (!el) return;
    const cls =
      changesStackedDir === "back"
        ? "git-review-pane-enter-back"
        : "git-review-pane-enter-forward";
    el.classList.remove("git-review-pane-enter-forward", "git-review-pane-enter-back");
    void el.offsetHeight;
    el.classList.add(cls);
  }, [changesStackedPane, useSplitReviewLayout, changesStackedDir]);

  useEffect(() => {
    if (useSplitReviewLayout) return;
    const el =
      historyStackedPane === "list"
        ? historyListPaneRef.current
        : historyDetailPaneRef.current;
    if (!el) return;
    const cls =
      historyStackedDir === "back"
        ? "git-review-pane-enter-back"
        : "git-review-pane-enter-forward";
    el.classList.remove("git-review-pane-enter-forward", "git-review-pane-enter-back");
    void el.offsetHeight;
    el.classList.add(cls);
  }, [historyStackedPane, useSplitReviewLayout, historyStackedDir]);

  const clearDiffs = useCallback(() => {
    diffRequestIdRef.current += 1;
    diffInFlightRequestIdRef.current = 0;
    diffPathRef.current = "";
    branchDiffSignatureRef.current = "";
    worktreeDiffSignatureRef.current = "";
    setBranchDiff(null);
    setWorktreeDiff(null);
    setBranchError("");
    setDiffLoading(false);
  }, []);

  const loadDiffForPath = useCallback(
    async (path: string, options: GitRefreshOptions = {}) => {
      const cleanPath = path.trim();
      if (options.silent && diffInFlightRequestIdRef.current !== 0) {
        return;
      }
      const requestId = diffRequestIdRef.current + 1;
      diffRequestIdRef.current = requestId;
      diffInFlightRequestIdRef.current = requestId;
      if (!options.silent) {
        setBranchError("");
        setError("");
      }
      if (!gitClient || !cwd.trim() || !cleanPath) {
        clearDiffs();
        return;
      }
      if (diffPathRef.current !== cleanPath) {
        branchDiffSignatureRef.current = "";
        worktreeDiffSignatureRef.current = "";
        setBranchDiff(null);
        setWorktreeDiff(null);
      }
      diffPathRef.current = cleanPath;
      if (!options.silent) {
        setDiffLoading(true);
      }
      try {
        const [branchResult, worktreeResult] = await Promise.allSettled([
          gitClient.diff(cwd, "branch", cleanPath),
          gitClient.diff(cwd, "working_tree", cleanPath),
        ]);
        if (diffRequestIdRef.current !== requestId) return;
        if (branchResult.status === "fulfilled") {
          const signature = gitDiffSignature(branchResult.value);
          if (!options.silent || branchDiffSignatureRef.current !== signature) {
            setBranchDiff(branchResult.value);
          }
          branchDiffSignatureRef.current = signature;
          setBranchError("");
        } else {
          branchDiffSignatureRef.current = "";
          setBranchDiff(null);
          setBranchError(branchResult.reason instanceof Error ? branchResult.reason.message : String(branchResult.reason));
        }
        if (worktreeResult.status === "fulfilled") {
          const signature = gitDiffSignature(worktreeResult.value);
          if (!options.silent || worktreeDiffSignatureRef.current !== signature) {
            setWorktreeDiff(worktreeResult.value);
          }
          worktreeDiffSignatureRef.current = signature;
          setError("");
        } else {
          worktreeDiffSignatureRef.current = "";
          setWorktreeDiff(null);
          setError(worktreeResult.reason instanceof Error ? worktreeResult.reason.message : String(worktreeResult.reason));
        }
      } catch (err) {
        if (diffRequestIdRef.current === requestId) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (diffRequestIdRef.current === requestId) {
          diffInFlightRequestIdRef.current = 0;
          if (!options.silent) {
            setDiffLoading(false);
          }
        }
      }
    },
    [clearDiffs, cwd, gitClient],
  );

  const refresh = useCallback(async (options: GitRefreshOptions = {}) => {
    if (refreshInFlightRef.current) {
      return;
    }
    refreshInFlightRef.current = true;
    const silent = options.silent === true;
    const force = options.force !== false;
    if (!gitClient || !cwd.trim()) {
      statusSignatureRef.current = "";
      setState(emptyGitRepositoryState(cwd));
      setSelectedPath("");
      clearDiffs();
      refreshInFlightRef.current = false;
      return;
    }
    if (!silent) {
      setLoading(true);
      setError("");
      setBranchError("");
    }
    try {
      const nextState = await gitClient.status(cwd);
      const previousSignature = statusSignatureRef.current;
      const nextSignature = gitRepositoryStateSignature(nextState);
      const stateChanged = previousSignature !== nextSignature;
      statusSignatureRef.current = nextSignature;
      if (options.notifyChanged && previousSignature && stateChanged) {
        suppressNextGitChangedRef.current = true;
        dispatchGitChanged(cwd);
      }
      if (!force && !stateChanged) {
        const currentPath = selectedPathRef.current;
        if (currentPath && reviewModeRef.current === "changes") {
          void loadDiffForPath(currentPath, { silent: true, force: false });
        }
        return;
      }
      setState(nextState);
      if (nextState.status !== "ready") {
        selectedPathRef.current = "";
        setSelectedPath("");
        clearDiffs();
        return;
      }
      const currentPath = selectedPathRef.current;
      const nextPath = nextState.entries.some((entry) => entry.path === currentPath)
        ? currentPath
        : nextState.entries[0]?.path ?? "";
      selectedPathRef.current = nextPath;
      setSelectedPath(nextPath);
      if (nextPath) {
        void loadDiffForPath(nextPath, { silent: silent && nextPath === currentPath });
      } else {
        clearDiffs();
      }
    } catch (err) {
      if (!silent || force) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      refreshInFlightRef.current = false;
      if (!silent) {
        setLoading(false);
      }
    }
  }, [clearDiffs, cwd, gitClient, loadDiffForPath]);

  const loadCommitDiff = useCallback(
    async (commitSha: string, path = "") => {
      const cleanCommit = commitSha.trim();
      const cleanPath = path.trim();
      const requestId = commitDiffRequestIdRef.current + 1;
      commitDiffRequestIdRef.current = requestId;
      setHistoryError("");
      setCommitDiff(null);
      if (!gitClient || !cwd.trim() || !cleanCommit) {
        setCommitDiffLoading(false);
        return;
      }
      setCommitDiffLoading(true);
      try {
        const diff = await gitClient.commitDiff(cwd, cleanCommit, cleanPath || undefined);
        if (commitDiffRequestIdRef.current === requestId) {
          setCommitDiff(diff);
        }
      } catch (err) {
        if (commitDiffRequestIdRef.current === requestId) {
          setHistoryError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (commitDiffRequestIdRef.current === requestId) {
          setCommitDiffLoading(false);
        }
      }
    },
    [cwd, gitClient],
  );

  const clearCommitDiff = useCallback(() => {
    commitDiffRequestIdRef.current += 1;
    setCommitDiff(null);
    setCommitDiffLoading(false);
  }, []);

  const loadCommitDetails = useCallback(
    async (commitSha: string) => {
      const cleanCommit = commitSha.trim();
      const cached = commitDetailsCacheRef.current.get(cleanCommit);
      if (cached) return cached;
      if (!gitClient || !cwd.trim() || !cleanCommit) {
        throw new Error(t("projectTools.gitReview.operationFailed"));
      }
      const response = await gitClient.commitDetails(cwd, cleanCommit);
      commitDetailsCacheRef.current.set(response.commit.sha, response.commit);
      commitDetailsCacheRef.current.set(cleanCommit, response.commit);
      return response.commit;
    },
    [cwd, gitClient, t],
  );

  const loadHistory = useCallback(
    async (options: GitRefreshOptions = {}) => {
      const append = options.append === true && historyCommitsRef.current.length > 0;
      if (append && !historyHasMoreRef.current) {
        return;
      }
      if (historyInFlightRef.current) {
        return;
      }
      historyInFlightRef.current = true;
      const silent = options.silent === true;
      const force = options.force !== false;
      const skip = append ? historyCommitsRef.current.length : 0;
      if (!gitClient || !cwd.trim()) {
        historySignatureRef.current = "";
        historyCommitsRef.current = [];
        setHistoryCommits([]);
        setHistoryGraphState(EMPTY_GIT_HISTORY_GRAPH_STATE);
        selectedCommitShaRef.current = "";
        selectedCommitFilePathRef.current = "";
        expandedCommitShasRef.current = new Set();
        setSelectedCommitSha("");
        setSelectedCommitFilePath("");
        setExpandedCommitShas(new Set());
        setHistoryHasMoreValue(false);
        setHistoryLoadMoreError("");
        setHistoryLoading(false);
        setHistoryLoadingMore(false);
        clearCommitDiff();
        setHistoryError("");
        historyInFlightRef.current = false;
        return;
      }
      if (append) {
        setHistoryLoadingMore(true);
        setHistoryLoadMoreError("");
      } else if (!silent) {
        setHistoryLoading(true);
        setHistoryError("");
        setHistoryLoadMoreError("");
      }
      try {
        const response = await gitClient.log(cwd, {
          limit: GIT_HISTORY_PAGE_SIZE,
          skip,
        });
        const nextHistoryGraphState = gitHistoryGraphStateFromResponse(response);
        const previousStatusSignature = statusSignatureRef.current;
        const nextStatusSignature = gitRepositoryStateSignature(response.state);
        const statusChanged = previousStatusSignature !== nextStatusSignature;
        statusSignatureRef.current = nextStatusSignature;
        const pageHasMore = response.commits.length >= GIT_HISTORY_PAGE_SIZE;
        if (append) {
          setState(response.state);
          if (response.state.status !== "ready") {
            historySignatureRef.current = "";
            historyCommitsRef.current = [];
            setHistoryCommits([]);
            setHistoryGraphState(EMPTY_GIT_HISTORY_GRAPH_STATE);
            selectedCommitShaRef.current = "";
            selectedCommitFilePathRef.current = "";
            expandedCommitShasRef.current = new Set();
            setSelectedCommitSha("");
            setSelectedCommitFilePath("");
            setExpandedCommitShas(new Set());
            setHistoryHasMoreValue(false);
            clearCommitDiff();
            return;
          }
          const existingCommits = historyCommitsRef.current;
          const existingShas = new Set(existingCommits.map((commit) => commit.sha));
          const nextCommits = [
            ...existingCommits,
            ...response.commits.filter((commit) => !existingShas.has(commit.sha)),
          ];
          historyCommitsRef.current = nextCommits;
          setHistoryCommits(nextCommits);
          setHistoryGraphState(nextHistoryGraphState);
          setHistoryHasMoreValue(pageHasMore);
          setHistoryLoadMoreError("");
          return;
        }

        const nextSignature = gitHistorySignature(
          response.state,
          response.commits,
          nextHistoryGraphState,
        );
        const historyChanged = historySignatureRef.current !== nextSignature;
        historySignatureRef.current = nextSignature;
        if (historyChanged) {
          commitDetailsCacheRef.current.clear();
        }
        if (options.notifyChanged && previousStatusSignature && statusChanged) {
          suppressNextGitChangedRef.current = true;
          dispatchGitChanged(cwd);
        }
        setHistoryHasMoreValue(
          !force &&
            !historyChanged &&
            historyCommitsRef.current.length > response.commits.length &&
            !historyHasMoreRef.current
            ? false
            : pageHasMore,
        );
        setHistoryLoadMoreError("");
        if (!force && !historyChanged) {
          return;
        }
        setState(response.state);
        historyCommitsRef.current = response.commits;
        setHistoryCommits(response.commits);
        setHistoryGraphState(nextHistoryGraphState);
        if (response.state.status !== "ready" || response.commits.length === 0) {
          selectedCommitShaRef.current = "";
          selectedCommitFilePathRef.current = "";
          expandedCommitShasRef.current = new Set();
          setSelectedCommitSha("");
          setSelectedCommitFilePath("");
          setExpandedCommitShas(new Set());
          setHistoryHasMoreValue(false);
          clearCommitDiff();
          return;
        }
        const currentCommit = response.commits.find(
          (commit) => commit.sha === selectedCommitShaRef.current,
        );
        const nextCommit = currentCommit ?? response.commits[0];
        const currentFile =
          currentCommit?.files.find((file) => file.path === selectedCommitFilePathRef.current) ??
          null;
        const availableCommitShas = new Set(response.commits.map((commit) => commit.sha));
        const nextExpandedCommitShas = new Set(
          [...expandedCommitShasRef.current].filter((sha) => availableCommitShas.has(sha)),
        );
        if (currentCommit && currentFile) {
          nextExpandedCommitShas.add(currentCommit.sha);
        }
        selectedCommitShaRef.current = nextCommit.sha;
        selectedCommitFilePathRef.current = currentFile?.path ?? "";
        expandedCommitShasRef.current = nextExpandedCommitShas;
        setSelectedCommitSha(nextCommit.sha);
        setSelectedCommitFilePath(currentFile?.path ?? "");
        setExpandedCommitShas(nextExpandedCommitShas);
        if (currentCommit && currentFile) {
          void loadCommitDiff(currentCommit.sha, currentFile.path);
        } else {
          clearCommitDiff();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (append) {
          setHistoryLoadMoreError(message);
          setHistoryHasMoreValue(true);
        } else if (!silent || force) {
          historyCommitsRef.current = [];
          setHistoryCommits([]);
          setHistoryGraphState(EMPTY_GIT_HISTORY_GRAPH_STATE);
          selectedCommitShaRef.current = "";
          selectedCommitFilePathRef.current = "";
          expandedCommitShasRef.current = new Set();
          setSelectedCommitSha("");
          setSelectedCommitFilePath("");
          setExpandedCommitShas(new Set());
          setHistoryHasMoreValue(false);
          setHistoryLoadMoreError("");
          clearCommitDiff();
          setHistoryError(message);
        }
      } finally {
        historyInFlightRef.current = false;
        if (append) {
          setHistoryLoadingMore(false);
        } else if (!silent) {
          setHistoryLoading(false);
        }
      }
    },
    [clearCommitDiff, cwd, gitClient, loadCommitDiff, setHistoryHasMoreValue],
  );

  const maybeLoadMoreHistory = useCallback(
    (element: HTMLElement | null) => {
      if (
        !element ||
        !(useSplitReviewLayout || historyStackedPane === "list") ||
        !historyHasMoreRef.current ||
        historyInFlightRef.current ||
        historyLoadMoreError
      ) {
        return;
      }
      const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
      if (distanceToBottom <= GIT_HISTORY_LOAD_MORE_SCROLL_THRESHOLD_PX) {
        void loadHistory({ append: true, silent: true });
      }
    },
    [historyLoadMoreError, historyStackedPane, loadHistory, useSplitReviewLayout],
  );

  const handleHistoryListScroll = useCallback(
    (event: ReactUIEvent<HTMLElement>) => {
      handleGitReviewTransientScroll(event);
      maybeLoadMoreHistory(event.currentTarget);
    },
    [maybeLoadMoreHistory],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (reviewMode === "history") {
      void loadHistory();
    }
  }, [loadHistory, reviewMode]);

  useEffect(() => {
    if (!gitClient || !cwd.trim()) {
      return;
    }
    let stopped = false;
    const refreshVisiblePanel = () => {
      if (
        stopped ||
        document.hidden ||
        busyRef.current ||
        !panelRef.current?.getClientRects().length
      ) {
        return;
      }
      if (reviewModeRef.current === "history") {
        void loadHistory({ silent: true, force: false, notifyChanged: true });
      } else {
        void refresh({ silent: true, force: false, notifyChanged: true });
      }
    };
    const interval = window.setInterval(refreshVisiblePanel, GIT_REVIEW_POLL_INTERVAL_MS);
    const handleFocus = () => refreshVisiblePanel();
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        refreshVisiblePanel();
      }
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      stopped = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [cwd, gitClient, loadHistory, refresh]);

  useEffect(() => {
    const handleGitChanged = () => {
      if (suppressNextGitChangedRef.current) {
        suppressNextGitChangedRef.current = false;
        return;
      }
      if (reviewModeRef.current === "history") {
        void loadHistory();
      } else {
        void refresh();
      }
    };
    window.addEventListener("liveagent:git-changed", handleGitChanged);
    return () => window.removeEventListener("liveagent:git-changed", handleGitChanged);
  }, [loadHistory, refresh]);

  const openRemoteSetup = useCallback((action: GitRemoteSetupAction) => {
    setRemoteSetupAction(action);
    setRemoteSetupError("");
    setRemoteSetupUrl("");
    setRemoteSetupOpen(true);
  }, []);

  const dismissOperationNotice = useCallback(() => {
    setOperationNotice(null);
  }, []);

  const showOperationNotice = useCallback(
    (kind: GitOperationNotice["kind"], action: GitOperationNoticeAction, detail?: string) => {
      const title =
        kind === "success"
          ? t(operationSuccessTitleKey(action))
          : t(operationFailureTitleKey(action));
      const message =
        kind === "success"
          ? t(operationSuccessMessageKey(action))
          : compactGitOperationMessage(detail || t("projectTools.gitReview.operationFailed"));
      setOperationNotice({
        id: ++operationNoticeIdRef.current,
        kind,
        title,
        message,
      });
    },
    [t],
  );

  const runOperation = useCallback(
    async (
      name: string,
      task: () => Promise<GitOperationResponse>,
      noticeAction?: GitOperationNoticeAction,
    ) => {
      if (!gitClient || !cwd.trim() || !canWrite || !beginGitOperation(name)) return false;
      setError("");
      if (noticeAction) {
        setOperationNotice(null);
      }
      try {
        const result = await task();
        assertGitOperationResult(result, t("projectTools.gitReview.operationFailed"));
        await refresh();
        if (reviewModeRef.current === "history") {
          await loadHistory();
        }
        suppressNextGitChangedRef.current = true;
        dispatchGitChanged(cwd);
        if (noticeAction) {
          showOperationNotice("success", noticeAction);
        }
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (
          noticeAction &&
          isRemoteSetupAction(noticeAction) &&
          isMissingRemoteSetupError(message)
        ) {
          openRemoteSetup(noticeAction);
          return false;
        }
        if (noticeAction) {
          showOperationNotice("error", noticeAction, message);
        }
        setError(message);
        return false;
      } finally {
        finishGitOperation(name);
      }
    },
    [
      beginGitOperation,
      canWrite,
      cwd,
      finishGitOperation,
      gitClient,
      loadHistory,
      openRemoteSetup,
      refresh,
      showOperationNotice,
      t,
    ],
  );

  const pushCurrentBranch = useCallback(async () => {
    const operationName = "push";
    if (!gitClient || !cwd.trim() || !canWrite || !beginGitOperation(operationName)) return false;
    setError("");
    setOperationNotice(null);
    try {
      const result = await gitClient.push(cwd);
      assertGitOperationResult(result, t("projectTools.gitReview.operationFailed"));
      await refresh();
      if (reviewModeRef.current === "history") {
        await loadHistory();
      }
      suppressNextGitChangedRef.current = true;
      dispatchGitChanged(cwd);
      showOperationNotice("success", "push");
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isMissingRemoteSetupError(message)) {
        openRemoteSetup("push");
        return false;
      }
      showOperationNotice("error", "push", message);
      setError(message);
      return false;
    } finally {
      finishGitOperation(operationName);
    }
  }, [
    beginGitOperation,
    canWrite,
    cwd,
    finishGitOperation,
    gitClient,
    loadHistory,
    openRemoteSetup,
    refresh,
    showOperationNotice,
    t,
  ]);

  const closeRemoteSetup = useCallback(() => {
    if (busyRef.current) return;
    setRemoteSetupOpen(false);
    setRemoteSetupError("");
  }, []);

  const saveRemoteAndContinue = useCallback(async () => {
    const operationName = "set_remote";
    if (!gitClient || !cwd.trim() || !canWrite || !beginGitOperation(operationName)) return false;
    const remoteUrl = remoteSetupUrl.trim();
    if (!remoteUrl) {
      finishGitOperation(operationName);
      setRemoteSetupError(t("projectTools.gitReview.remoteUrlRequired"));
      return false;
    }
    setError("");
    setRemoteSetupError("");
    setOperationNotice(null);
    try {
      const remoteResult = await gitClient.setRemote(cwd, remoteUrl);
      assertGitOperationResult(remoteResult, t("projectTools.gitReview.operationFailed"));
      const operationResult =
        remoteSetupAction === "fetch"
          ? await gitClient.fetch(cwd)
          : remoteSetupAction === "pull"
            ? await gitClient.pull(cwd)
            : await gitClient.push(cwd);
      assertGitOperationResult(operationResult, t("projectTools.gitReview.operationFailed"));
      setRemoteSetupOpen(false);
      setRemoteSetupUrl("");
      await refresh();
      if (reviewModeRef.current === "history") {
        await loadHistory();
      }
      suppressNextGitChangedRef.current = true;
      dispatchGitChanged(cwd);
      showOperationNotice("success", remoteSetupAction);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRemoteSetupError(message);
      showOperationNotice("error", remoteSetupAction, message);
      return false;
    } finally {
      finishGitOperation(operationName);
    }
  }, [
    beginGitOperation,
    canWrite,
    cwd,
    finishGitOperation,
    gitClient,
    loadHistory,
    refresh,
    remoteSetupAction,
    remoteSetupUrl,
    showOperationNotice,
    t,
  ]);

  const entries = state.entries;
  const stagedEntries = useMemo(() => entries.filter(canUnstageEntry), [entries]);
  const workingEntries = useMemo(() => entries.filter(canStageEntry), [entries]);
  const [visibleStagedEntryCount, setVisibleStagedEntryCount] = useState(
    INITIAL_CHANGE_ENTRY_RENDER_COUNT,
  );
  const [visibleWorkingEntryCount, setVisibleWorkingEntryCount] = useState(
    INITIAL_CHANGE_ENTRY_RENDER_COUNT,
  );
  useEffect(() => {
    setVisibleStagedEntryCount(INITIAL_CHANGE_ENTRY_RENDER_COUNT);
    setVisibleWorkingEntryCount(INITIAL_CHANGE_ENTRY_RENDER_COUNT);
  }, [state.repoRoot, state.head, stagedEntries.length, workingEntries.length]);
  const visibleStagedEntries = useMemo(
    () => stagedEntries.slice(0, visibleStagedEntryCount),
    [stagedEntries, visibleStagedEntryCount],
  );
  const visibleWorkingEntries = useMemo(
    () => workingEntries.slice(0, visibleWorkingEntryCount),
    [workingEntries, visibleWorkingEntryCount],
  );
  const hiddenStagedEntryCount = Math.max(0, stagedEntries.length - visibleStagedEntries.length);
  const hiddenWorkingEntryCount = Math.max(0, workingEntries.length - visibleWorkingEntries.length);
  const writeDisabled = !canWrite || Boolean(disabledMessage) || state.status !== "ready";
  const operationBusy = busy !== "";
  const hasStageableChanges = state.dirtyCounts.unstaged > 0 || state.dirtyCounts.untracked > 0;
  const hasStagedChanges = state.dirtyCounts.staged > 0;
  const hasDiscardableChanges = entries.length > 0;
  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.path === selectedPath) ?? null,
    [entries, selectedPath],
  );
  const contextEntry = useMemo(
    () => entries.find((entry) => entry.path === changeContextMenu?.path) ?? null,
    [changeContextMenu?.path, entries],
  );
  const contextEntrySection = changeContextMenu?.section ?? "changes";
  const contextEntryCanStage =
    contextEntrySection === "changes" && contextEntry ? canStageEntry(contextEntry) : false;
  const contextEntryCanUnstage =
    contextEntrySection === "staged" && contextEntry ? canUnstageEntry(contextEntry) : false;
  const contextEntryCanAddToGitignore = contextEntrySection === "changes" && Boolean(contextEntry?.untracked);
  const selectedCommit = useMemo(
    () => historyCommits.find((commit) => commit.sha === selectedCommitSha) ?? null,
    [historyCommits, selectedCommitSha],
  );
  const selectedCommitFile = useMemo(
    () => selectedCommit?.files.find((file) => file.path === selectedCommitFilePath) ?? null,
    [selectedCommit, selectedCommitFilePath],
  );
  const historyContextCommit = useMemo(() => {
    if (!historyContextMenu) return null;
    return historyCommits.find((commit) => commit.sha === historyContextMenu.commitSha) ?? null;
  }, [historyCommits, historyContextMenu]);
  const historyContextFile = useMemo(() => {
    if (!historyContextMenu || historyContextMenu.kind !== "file" || !historyContextCommit) {
      return null;
    }
    return historyContextCommit.files.find((file) => file.path === historyContextMenu.path) ?? null;
  }, [historyContextCommit, historyContextMenu]);
  const historyContextCommitGithubUrl = historyContextCommit
    ? gitHubCommitUrl(state.remoteUrl, historyContextCommit.sha)
    : "";
  const gitGraph = useMemo(
    () =>
      computeGitGraph(historyCommits, {
        currentRef: state.head,
        remoteRef: historyGraphState.historyRemoteRef,
        baseRef: historyGraphState.historyBaseRef,
        remoteName: state.remoteName,
        showRemoteChangeMarkers: true,
        ahead: historyGraphState.historyAhead,
        behind: historyGraphState.historyBehind,
        mergeBase: historyGraphState.mergeBase,
      }),
    [historyCommits, historyGraphState, state.head, state.remoteName],
  );
  const historyCommitBySha = useMemo(
    () => new Map(historyCommits.map((commit) => [commit.sha, commit])),
    [historyCommits],
  );
  const historyRows = useMemo<GitHistoryRow[]>(() => {
    const rows: GitHistoryRow[] = [];
    gitGraph.rows.forEach((graphRow, graphIndex) => {
      if (graphRow.kind === "incoming-changes" || graphRow.kind === "outgoing-changes") {
        rows.push({ type: "marker", kind: graphRow.kind, graphIndex });
        return;
      }
      const commit = historyCommitBySha.get(graphRow.sha);
      if (!commit) return;
      rows.push({ type: "commit", commit, graphIndex });
      if (expandedCommitShas.has(commit.sha)) {
        commit.files.forEach((file) => {
          rows.push({ type: "file", commit, graphIndex, file });
        });
      }
    });
    if (historyHasMore || historyLoadingMore || historyLoadMoreError) {
      rows.push({ type: "loadMore" });
    }
    return rows;
  }, [
    expandedCommitShas,
    gitGraph.rows,
    historyCommitBySha,
    historyHasMore,
    historyLoadMoreError,
    historyLoadingMore,
  ]);
  const historyVirtualizer = useVirtualizer({
    count: historyRows.length,
    getScrollElement: () => historyListRef.current,
    estimateSize: () => 22,
    overscan: 8,
    getItemKey: (index) => {
      const row = historyRows[index];
      if (!row) return index;
      if (row.type === "marker") return `marker:${row.kind}:${row.graphIndex}`;
      if (row.type === "commit") return `commit:${row.commit.sha}`;
      if (row.type === "loadMore") return "load-more";
      return `file:${row.commit.sha}:${row.file.status}:${row.file.oldPath ?? ""}:${row.file.path}`;
    },
  });
  const currentHistoryItemIndex = useMemo(() => {
    const selectedIndex = selectedCommitSha
      ? historyRows.findIndex((row) => row.type === "commit" && row.commit.sha === selectedCommitSha)
      : -1;
    if (selectedIndex >= 0) return selectedIndex;

    const headIndex = historyRows.findIndex(
      (row) => row.type === "commit" && gitGraph.rows[row.graphIndex]?.isHead,
    );
    if (headIndex >= 0) return headIndex;

    return historyRows.findIndex((row) => row.type === "commit");
  }, [gitGraph.rows, historyRows, selectedCommitSha]);
  const revealCurrentHistoryItem = useCallback(() => {
    if (currentHistoryItemIndex < 0) return;
    setHistoryContextMenu(null);
    if (!useSplitReviewLayout) {
      setHistoryStackedDir("back");
      setHistoryStackedPane("list");
    }
    window.requestAnimationFrame(() => {
      historyVirtualizer.scrollToIndex(currentHistoryItemIndex, { align: "center" });
    });
  }, [currentHistoryItemIndex, historyVirtualizer, useSplitReviewLayout]);

  useEffect(() => {
    if (reviewMode !== "history") {
      return;
    }
    maybeLoadMoreHistory(historyListRef.current);
  }, [historyRows.length, maybeLoadMoreHistory, reviewMode]);

  useEffect(() => {
    if (!changeContextMenu) return;
    const closeMenu = () => setChangeContextMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("click", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [changeContextMenu]);

  useEffect(() => {
    if (!changesMenu) return;
    const closeMenu = () => setChangesMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("click", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [changesMenu]);

  useEffect(() => {
    if (!historyContextMenu) return;
    const closeMenu = () => setHistoryContextMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("click", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [historyContextMenu]);

  const selectEntry = useCallback(
    (entry: GitStatusEntry) => {
      selectedPathRef.current = entry.path;
      setSelectedPath(entry.path);
      if (!useSplitReviewLayout) {
        setChangesStackedDir("forward");
        setChangesStackedPane("detail");
      }
      void loadDiffForPath(entry.path);
    },
    [loadDiffForPath, useSplitReviewLayout],
  );

  const selectCommit = useCallback((commit: GitCommitSummary) => {
    selectedCommitShaRef.current = commit.sha;
    selectedCommitFilePathRef.current = "";
    setSelectedCommitSha(commit.sha);
    setSelectedCommitFilePath("");
    clearCommitDiff();
    setHistoryDiffTitle("");
    setHistoryDiffSubtitle("");
    setHistoryError("");
    setExpandedCommitShas((current) => {
      const next = new Set(current);
      if (next.has(commit.sha)) {
        next.delete(commit.sha);
      } else {
        next.add(commit.sha);
      }
      expandedCommitShasRef.current = next;
      return next;
    });
  }, [clearCommitDiff]);

  const selectCommitFile = useCallback(
    (commit: GitCommitSummary, file: GitCommitFile) => {
      selectedCommitShaRef.current = commit.sha;
      selectedCommitFilePathRef.current = file.path;
      const nextExpandedCommitShas = new Set(expandedCommitShasRef.current);
      nextExpandedCommitShas.add(commit.sha);
      expandedCommitShasRef.current = nextExpandedCommitShas;
      setSelectedCommitSha(commit.sha);
      setSelectedCommitFilePath(file.path);
      if (!useSplitReviewLayout) {
        setHistoryStackedDir("forward");
        setHistoryStackedPane("detail");
      }
      setHistoryDiffTitle(t("projectTools.gitReview.commitDiff"));
      setHistoryDiffSubtitle(`${basename(file.path)} - ${commit.shortSha || commit.sha.slice(0, 7)}`);
      setExpandedCommitShas(nextExpandedCommitShas);
      void loadCommitDiff(commit.sha, file.path);
    },
    [loadCommitDiff, t, useSplitReviewLayout],
  );

  const focusHistoryCommit = useCallback((commit: GitCommitSummary) => {
    selectedCommitShaRef.current = commit.sha;
    selectedCommitFilePathRef.current = "";
    setSelectedCommitSha(commit.sha);
    setSelectedCommitFilePath("");
    if (!useSplitReviewLayout) {
      setHistoryStackedDir("forward");
      setHistoryStackedPane("detail");
    }
    clearCommitDiff();
    setHistoryDiffTitle("");
    setHistoryDiffSubtitle("");
    setHistoryError("");
    setExpandedCommitShas((current) => {
      if (current.has(commit.sha)) {
        expandedCommitShasRef.current = current;
        return current;
      }
      const next = new Set(current);
      next.add(commit.sha);
      expandedCommitShasRef.current = next;
      return next;
    });
  }, [clearCommitDiff, useSplitReviewLayout]);

  const openHistoryContextMenu = useCallback(
    (
      event: ReactMouseEvent,
      target:
        | { kind: "commit"; commitSha: string }
        | { kind: "file"; commitSha: string; path: string },
    ) => {
      event.preventDefault();
      event.stopPropagation();
      window.getSelection()?.removeAllRanges();
      setChangeContextMenu(null);
      setChangesMenu(null);
      const panelRect = panelRef.current?.getBoundingClientRect();
      const left = panelRect ? event.clientX - panelRect.left : event.clientX;
      const top = panelRect ? event.clientY - panelRect.top : event.clientY;
      const maxLeft = Math.max(
        8,
        (panelRect?.width ?? window.innerWidth) - HISTORY_CONTEXT_MENU_WIDTH - 8,
      );
      const menuHeight =
        target.kind === "file" ? HISTORY_FILE_CONTEXT_MENU_HEIGHT : HISTORY_CONTEXT_MENU_HEIGHT;
      const maxTop = Math.max(
        8,
        (panelRect?.height ?? window.innerHeight) - menuHeight - 8,
      );
      const x = Math.max(8, Math.min(left, maxLeft));
      const y = Math.max(8, Math.min(top, maxTop));
      if (target.kind === "file") {
        setHistoryContextMenu({
          kind: "file",
          x,
          y,
          commitSha: target.commitSha,
          path: target.path,
        });
      } else {
        setHistoryContextMenu({
          kind: "commit",
          x,
          y,
          commitSha: target.commitSha,
        });
      }
    },
    [],
  );

  const openHistoryCommitContextMenu = useCallback(
    (event: ReactMouseEvent, commit: GitCommitSummary) => {
      openHistoryContextMenu(event, { kind: "commit", commitSha: commit.sha });
    },
    [openHistoryContextMenu],
  );

  const openHistoryFileContextMenu = useCallback(
    (event: ReactMouseEvent, commit: GitCommitSummary, file: GitCommitFile) => {
      openHistoryContextMenu(event, {
        kind: "file",
        commitSha: commit.sha,
        path: file.path,
      });
    },
    [openHistoryContextMenu],
  );

  const openHistoryCommitDiff = useCallback(
    (commit: GitCommitSummary, file?: GitCommitFile | null) => {
      setHistoryContextMenu(null);
      if (file) {
        selectCommitFile(commit, file);
        return;
      }
      focusHistoryCommit(commit);
      setHistoryDiffTitle(t("projectTools.gitReview.commitDiff"));
      setHistoryDiffSubtitle(`${commit.shortSha || commit.sha.slice(0, 7)} - ${commit.subject}`);
      void loadCommitDiff(commit.sha);
    },
    [focusHistoryCommit, loadCommitDiff, selectCommitFile, t],
  );

  const openHistoryCommitOnGithub = useCallback((commit: GitCommitSummary) => {
    setHistoryContextMenu(null);
    const url = gitHubCommitUrl(state.remoteUrl, commit.sha);
    if (!url) return;
    void openUrl(url).catch((err) => {
      setHistoryError(err instanceof Error ? err.message : String(err));
    });
  }, [state.remoteUrl]);

  const openCreateBranchFromCommit = useCallback((commit: GitCommitSummary) => {
    setHistoryContextMenu(null);
    setBranchFromCommit({
      commitSha: commit.sha,
      shortSha: commit.shortSha || commit.sha.slice(0, 7),
      subject: commit.subject,
    });
    setBranchFromCommitName(defaultBranchNameForCommit(commit));
    setBranchFromCommitError("");
  }, []);

  const closeCreateBranchFromCommit = useCallback(() => {
    if (busyRef.current) return;
    setBranchFromCommit(null);
    setBranchFromCommitError("");
  }, []);

  const confirmCreateBranchFromCommit = useCallback(async () => {
    const target = branchFromCommit;
    if (!target) return;
    const branchName = branchFromCommitName.trim();
    if (!branchName) {
      setBranchFromCommitError(t("projectTools.gitReview.branchNameRequired"));
      return;
    }
    setBranchFromCommitError("");
    const ok = await runOperation(
      "create_branch",
      () => gitClient!.createBranch(cwd, branchName, target.commitSha),
      "create_branch",
    );
    if (ok) {
      setBranchFromCommit(null);
      setBranchFromCommitName("");
    }
  }, [branchFromCommit, branchFromCommitName, cwd, gitClient, runOperation, t]);

  const compareHistoryCommitWithRemote = useCallback(
    (commit: GitCommitSummary) => {
      setHistoryContextMenu(null);
      if (!gitClient || !cwd.trim()) return;
      focusHistoryCommit(commit);
      const requestId = commitDiffRequestIdRef.current + 1;
      commitDiffRequestIdRef.current = requestId;
      setHistoryDiffTitle(t("projectTools.gitReview.remoteCompare"));
      setHistoryDiffSubtitle(`${state.upstream || "remote"} ↔ ${commit.shortSha || commit.sha.slice(0, 7)}`);
      setHistoryError("");
      setCommitDiff(null);
      setCommitDiffLoading(true);
      void gitClient
        .compareCommitWithRemote(cwd, commit.sha)
        .then((diff) => {
          if (commitDiffRequestIdRef.current !== requestId) return;
          setCommitDiff(diff);
          setHistoryDiffSubtitle(`${diff.baseRef} ↔ ${commit.shortSha || commit.sha.slice(0, 7)}`);
        })
        .catch((err) => {
          if (commitDiffRequestIdRef.current !== requestId) return;
          setHistoryError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (commitDiffRequestIdRef.current === requestId) {
            setCommitDiffLoading(false);
          }
        });
    },
    [cwd, focusHistoryCommit, gitClient, state.upstream, t],
  );

  const copyHistoryCommitHash = useCallback((commit: GitCommitSummary) => {
    setHistoryContextMenu(null);
    writeTextToClipboard(commit.sha);
  }, []);

  const copyHistoryCommitMessage = useCallback(
    (commit: GitCommitSummary) => {
      setHistoryContextMenu(null);
      void loadCommitDetails(commit.sha)
        .then((details) => writeTextToClipboard(commitMessageText(details) || commit.subject))
        .catch(() => writeTextToClipboard(commit.subject));
    },
    [loadCommitDetails],
  );

  const addHistoryCommitToContext = useCallback(
    (commit: GitCommitSummary) => {
      setHistoryContextMenu(null);
      if (!onInsertCommitMention) return;
      void loadCommitDetails(commit.sha)
        .then((details) => {
          onInsertCommitMention({
            ...details,
            githubUrl: gitHubCommitUrl(details.remoteUrl || state.remoteUrl, details.sha),
          });
        })
        .catch((err) => {
          setHistoryError(err instanceof Error ? err.message : String(err));
        });
    },
    [loadCommitDetails, onInsertCommitMention, state.remoteUrl],
  );

  const addHistoryFileToContext = useCallback(
    (commit: GitCommitSummary, file: GitCommitFile) => {
      setHistoryContextMenu(null);
      if (!onInsertGitFileMention) return;
      onInsertGitFileMention(gitFileContextPayload(commit, file, state));
    },
    [onInsertGitFileMention, state],
  );

  const openChangeContextMenu = useCallback(
    (event: ReactMouseEvent, entry: GitStatusEntry, section: ChangeListSection) => {
      event.preventDefault();
      event.stopPropagation();
      window.getSelection()?.removeAllRanges();
      setChangesMenu(null);
      setHistoryContextMenu(null);
      const panelRect = panelRef.current?.getBoundingClientRect();
      const left = panelRect ? event.clientX - panelRect.left : event.clientX;
      const top = panelRect ? event.clientY - panelRect.top : event.clientY;
      const maxLeft = Math.max(
        8,
        (panelRect?.width ?? window.innerWidth) - CHANGE_CONTEXT_MENU_WIDTH - 8,
      );
      const maxTop = Math.max(
        8,
        (panelRect?.height ?? window.innerHeight) - CHANGE_CONTEXT_MENU_HEIGHT - 8,
      );
      setChangeContextMenu({
        x: Math.max(8, Math.min(left, maxLeft)),
        y: Math.max(8, Math.min(top, maxTop)),
        path: entry.path,
        section,
      });
    },
    [],
  );

  const toggleChangeSection = useCallback((section: ChangeListSection) => {
    setChangeContextMenu((current) => (current?.section === section ? null : current));
    setChangesMenu((current) => (current?.section === section ? null : current));
    setCollapsedChangeSections((current) => ({
      ...current,
      [section]: !current[section],
    }));
  }, []);

  const openChangesMenu = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>, section: ChangeListSection) => {
      event.preventDefault();
      event.stopPropagation();
      setChangeContextMenu(null);
      setHistoryContextMenu(null);
      const panelRect = panelRef.current?.getBoundingClientRect();
      const buttonRect = event.currentTarget.getBoundingClientRect();
      const left = panelRect
        ? buttonRect.right - panelRect.left - CHANGES_MENU_WIDTH
        : buttonRect.right - CHANGES_MENU_WIDTH;
      const top = panelRect ? buttonRect.bottom - panelRect.top + 4 : buttonRect.bottom + 4;
      const maxLeft = Math.max(8, (panelRect?.width ?? window.innerWidth) - CHANGES_MENU_WIDTH - 8);
      const maxTop = Math.max(
        8,
        (panelRect?.height ?? window.innerHeight) - CHANGES_MENU_HEIGHT - 8,
      );
      setChangesMenu({
        x: Math.max(8, Math.min(left, maxLeft)),
        y: Math.max(8, Math.min(top, maxTop)),
        section,
      });
    },
    [],
  );

  const viewEntryChanges = useCallback(
    (entry: GitStatusEntry) => {
      setChangeContextMenu(null);
      setActiveDiffView("workingTree");
      selectEntry(entry);
    },
    [selectEntry],
  );

  const stageEntry = useCallback(
    (entry: GitStatusEntry) => {
      setChangeContextMenu(null);
      void runOperation("stage", () => gitClient!.stage(cwd, entry.path));
    },
    [cwd, gitClient, runOperation],
  );

  const unstageEntry = useCallback(
    (entry: GitStatusEntry) => {
      setChangeContextMenu(null);
      void runOperation("unstage", () => gitClient!.unstage(cwd, entry.path));
    },
    [cwd, gitClient, runOperation],
  );

  const discardEntry = useCallback(
    (entry: GitStatusEntry) => {
      setChangeContextMenu(null);
      setDiscardConfirm({
        kind: "entry",
        path: entry.path,
        oldPath: entry.oldPath ?? null,
      });
    },
    [],
  );

  const addEntryToGitignore = useCallback(
    (entry: GitStatusEntry) => {
      setChangeContextMenu(null);
      void runOperation("add_to_gitignore", () => gitClient!.addToGitignore(cwd, entry.path));
    },
    [cwd, gitClient, runOperation],
  );

  const stageAllChanges = useCallback(() => {
    setChangesMenu(null);
    void runOperation("stage_all", () => gitClient!.stageAll(cwd));
  }, [cwd, gitClient, runOperation]);

  const unstageAllChanges = useCallback(() => {
    setChangesMenu(null);
    void runOperation("unstage_all", () => gitClient!.unstageAll(cwd));
  }, [cwd, gitClient, runOperation]);

  const discardAllChanges = useCallback(() => {
    setChangesMenu(null);
    setDiscardConfirm({ kind: "all" });
  }, []);

  const closeDiscardConfirm = useCallback(() => {
    if (busy === "discard" || busy === "discard_all") return;
    setDiscardConfirm(null);
  }, [busy]);

  const confirmDiscardChanges = useCallback(async () => {
    if (!discardConfirm) return;
    if (discardConfirm.kind === "all") {
      await runOperation("discard_all", () => gitClient!.discardAll(cwd), "discard_all");
    } else {
      const target = discardConfirm;
      await runOperation(
        "discard",
        () => gitClient!.discard(cwd, target.path, target.oldPath ?? undefined),
        "discard",
      );
    }
    setDiscardConfirm(null);
  }, [cwd, discardConfirm, gitClient, runOperation]);

  const revealEntryInFileTree = useCallback(
    (entry: GitStatusEntry) => {
      if (!onRevealInFileTree) return;
      setChangeContextMenu(null);
      onRevealInFileTree(revealTargetForEntry(entry));
    },
    [onRevealInFileTree],
  );

  const visibleError =
    reviewMode === "history" ? (historyCommits.length === 0 ? historyError : "") : error;

  const renderChangeEntry = (entry: GitStatusEntry, section: ChangeListSection) => {
    const selected = entry.path === selectedPath;
    const contextMenuOpen =
      entry.path === changeContextMenu?.path && section === changeContextMenu?.section;
    const TypeIcon = getFileTypeIcon(entry.path, "file");
    const fileName = basename(entry.path);
    const filePath = parentPath(entry.path);
    return (
      <div
        key={`${section}:${entry.kind}:${entry.oldPath ?? ""}:${entry.path}`}
        className={cn(
          "select-none border-b border-l-2 border-border/60 border-l-transparent px-3 py-2 transition-colors hover:bg-muted/40",
          selected && "border-l-emerald-500 bg-emerald-500/10",
          contextMenuOpen && "border-l-primary bg-primary/10 ring-1 ring-inset ring-primary/35",
        )}
        onMouseDown={(event) => {
          if (event.button === 2) {
            window.getSelection()?.removeAllRanges();
          }
        }}
        onContextMenu={(event) => openChangeContextMenu(event, entry, section)}
      >
        <button
          type="button"
          className="flex w-full select-none items-start gap-2 rounded-sm bg-transparent p-0 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => selectEntry(entry)}
          title={entry.path}
        >
          <TypeIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 select-none">
            <span className="block truncate text-xs font-medium text-foreground">{fileName}</span>
            <span className="block truncate text-[11px] leading-4 text-muted-foreground">
              {filePath}
            </span>
          </span>
          <span className={cn("mt-0.5 shrink-0 text-[10px] font-semibold", statusTone(entry))}>
            {statusLabel(entry)}
          </span>
        </button>
      </div>
    );
  };

  const renderChangeSection = (
    section: ChangeListSection,
    title: string,
    sectionEntries: GitStatusEntry[],
    visibleSectionEntries: GitStatusEntry[],
    hiddenCount: number,
    emptyLabel: string,
    onShowMore: () => void,
    collapsed: boolean,
    onToggle: () => void,
  ) => (
    <section className="relative border-b border-border/60 bg-background last:border-b-0">
      <div className="sticky top-0 z-20 grid h-7 w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 border-b border-border/60 bg-muted px-3">
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 rounded-sm bg-transparent p-0 text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          <ChevronRight
            className={cn(
              "h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-200 ease-out motion-reduce:transition-none",
              !collapsed && "rotate-90",
            )}
            aria-hidden="true"
          />
          <span className="min-w-0 truncate text-[11px] font-semibold text-muted-foreground">
            {title}
          </span>
        </button>
        <span className="inline-flex h-4 min-w-6 shrink-0 items-center justify-center justify-self-end rounded bg-background/70 px-1.5 text-center text-[10px] font-medium tabular-nums text-muted-foreground">
          {sectionEntries.length}
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="-mr-1 h-5 w-5 shrink-0 px-0 text-muted-foreground"
          title={t("projectTools.gitReview.changesActions")}
          aria-label={t("projectTools.gitReview.changesActions")}
          onClick={(event) => openChangesMenu(event, section)}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div
        aria-hidden={collapsed}
        inert={collapsed}
        className={cn(
          "grid overflow-hidden transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
          collapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100",
        )}
      >
        <div
          className={cn(
            "min-h-0 overflow-hidden transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none",
            collapsed ? "-translate-y-1 opacity-0" : "translate-y-0 opacity-100",
          )}
        >
          {sectionEntries.length === 0 ? (
            <div className="px-3 py-3 text-xs text-muted-foreground">{emptyLabel}</div>
          ) : (
            <>
              {visibleSectionEntries.map((entry) => renderChangeEntry(entry, section))}
              {hiddenCount > 0 ? (
                <div className="border-b border-border/60 px-3 py-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-full text-xs"
                    onClick={onShowMore}
                  >
                    {t("projectTools.gitReview.showMoreChanges").replace(
                      "{count}",
                      String(hiddenCount),
                    )}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </section>
  );

  return (
    <div ref={panelRef} className="relative flex h-full min-h-0 flex-col bg-background">
      <GitRemoteSetupModal
        open={remoteSetupOpen}
        action={remoteSetupAction}
        workdir={cwd}
        branch={state.head || t("projectTools.gitReview.unresolved")}
        remoteUrl={remoteSetupUrl}
        loading={busy === "set_remote"}
        error={remoteSetupError}
        onRemoteUrlChange={setRemoteSetupUrl}
        onClose={closeRemoteSetup}
        onSubmit={saveRemoteAndContinue}
      />
      <GitDiscardConfirmModal
        target={discardConfirm}
        loading={busy === "discard" || busy === "discard_all"}
        onClose={closeDiscardConfirm}
        onConfirm={confirmDiscardChanges}
      />
      <GitBranchFromCommitModal
        target={branchFromCommit}
        branchName={branchFromCommitName}
        loading={busy === "create_branch"}
        error={branchFromCommitError}
        onBranchNameChange={setBranchFromCommitName}
        onClose={closeCreateBranchFromCommit}
        onSubmit={confirmCreateBranchFromCommit}
      />
      <GitOperationNoticeToast notice={operationNotice} onDismiss={dismissOperationNotice} />
      <div className="shrink-0 border-b border-border px-3 py-3">
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-emerald-600 dark:text-emerald-300" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">
              {state.head || t("projectTools.gitReviewTitle")}
            </div>
            <div className="truncate text-[11px] text-muted-foreground">
              {state.repoRoot || disabledMessage || t("projectTools.gitReview.noRepository")}
            </div>
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={loading || historyLoading || operationBusy}
            className="h-7 w-7 px-0"
            title={t("projectTools.gitReview.refresh")}
            aria-label={t("projectTools.gitReview.refresh")}
            onClick={() => {
              if (busyRef.current) return;
              if (reviewMode === "history") {
                void loadHistory({ notifyChanged: true });
              } else {
                void refresh({ notifyChanged: true });
              }
            }}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", (loading || historyLoading) && "animate-spin")} />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={writeDisabled || operationBusy}
            title={t("projectTools.gitReview.fetch")}
            aria-label={t("projectTools.gitReview.fetch")}
            className="h-7 w-7 px-0"
            onClick={() => void runOperation("fetch", () => gitClient!.fetch(cwd), "fetch")}
          >
            {busy === "fetch" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Cloud className="h-3.5 w-3.5" />
            )}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={writeDisabled || operationBusy}
            title={t("projectTools.gitReview.pull")}
            aria-label={t("projectTools.gitReview.pull")}
            className="h-7 w-7 px-0"
            onClick={() => void runOperation("pull", () => gitClient!.pull(cwd), "pull")}
          >
            {busy === "pull" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={writeDisabled || operationBusy}
            title={t("projectTools.gitReview.push")}
            aria-label={t("projectTools.gitReview.push")}
            className="h-7 w-7 px-0"
            onClick={() => void pushCurrentBranch()}
          >
            {busy === "push" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
        {state.status === "ready" ? (
          <div className="mt-2.5 overflow-hidden rounded-xl border border-white/20 bg-white/50 shadow-sm backdrop-blur-xl dark:border-white/[0.08] dark:bg-white/[0.03]">
            <div className="flex items-center gap-2 border-b border-black/[0.04] px-3 py-2 dark:border-white/[0.06]">
              <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground/70" />
              <span className="min-w-0 truncate text-[11px] font-medium text-foreground/80">
                {branchDiff?.baseRef || state.upstream || t("projectTools.gitReview.unresolved")}
              </span>
              <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/60">
                {t("projectTools.gitReview.labelBase")}
              </span>
            </div>
            <div className="grid grid-cols-5">
              {[
                { count: state.ahead, label: t("projectTools.gitReview.labelAhead"), tone: "text-sky-600 dark:text-sky-400" },
                { count: state.behind, label: t("projectTools.gitReview.labelBehind"), tone: "text-orange-600 dark:text-orange-400" },
                { count: state.dirtyCounts.staged, label: t("projectTools.gitReview.labelStaged"), tone: "text-emerald-600 dark:text-emerald-400" },
                { count: state.dirtyCounts.unstaged, label: t("projectTools.gitReview.labelUnstaged"), tone: "text-amber-600 dark:text-amber-400" },
                { count: state.dirtyCounts.untracked, label: t("projectTools.gitReview.labelUntracked"), tone: "text-violet-600 dark:text-violet-400" },
              ].map((item, index) => (
                <div
                  key={item.label}
                  className={cn(
                    "flex flex-col items-center gap-0.5 py-2",
                    index > 0 && "border-l border-black/[0.04] dark:border-white/[0.06]",
                  )}
                >
                  <span
                    className={cn(
                      "text-sm font-semibold tabular-nums leading-none",
                      item.count > 0 ? item.tone : "text-muted-foreground/40",
                    )}
                  >
                    {item.count}
                  </span>
                  <span className="text-[9px] leading-none text-muted-foreground/60">
                    {item.label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <div className="mt-3 flex items-center gap-2">
          <div className="inline-flex shrink-0 rounded-md border border-border bg-muted/25 p-0.5 text-xs">
            <button
              type="button"
              className={cn(
                "inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 font-medium text-muted-foreground transition-colors hover:text-foreground",
                reviewMode === "changes" && "bg-background text-foreground shadow-sm",
              )}
              onClick={() => {
                setReviewMode("changes");
                setChangeContextMenu(null);
                setChangesMenu(null);
                setHistoryContextMenu(null);
              }}
            >
              <GitBranch className="h-3.5 w-3.5" />
              {t("projectTools.gitReview.localChangesView")}
            </button>
            <button
              type="button"
              className={cn(
                "inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 font-medium text-muted-foreground transition-colors hover:text-foreground",
                reviewMode === "history" && "bg-background text-foreground shadow-sm",
              )}
              onClick={() => {
                setReviewMode("history");
                setChangeContextMenu(null);
                setChangesMenu(null);
                setHistoryContextMenu(null);
              }}
            >
              <History className="h-3.5 w-3.5" />
              {t("projectTools.gitReview.commitHistoryView")}
            </button>
          </div>
          {!useSplitReviewLayout ? (
            <div className="ml-auto inline-flex shrink-0 rounded-md border border-border bg-muted/25 p-0.5">
              <button
                type="button"
                aria-label={t("projectTools.gitReview.listPane")}
                aria-pressed={
                  reviewMode === "changes"
                    ? changesStackedPane === "list"
                    : historyStackedPane === "list"
                }
                title={t("projectTools.gitReview.listPane")}
                className={cn(
                  GIT_REVIEW_STACKED_PANE_BUTTON_CLASS,
                  (reviewMode === "changes"
                    ? changesStackedPane === "list"
                    : historyStackedPane === "list") && "bg-background text-foreground shadow-sm",
                )}
                onClick={() => {
                  if (reviewMode === "changes") {
                    setChangesStackedDir("back");
                    setChangesStackedPane("list");
                  } else {
                    setHistoryStackedDir("back");
                    setHistoryStackedPane("list");
                  }
                }}
              >
                {reviewMode === "changes" ? (
                  <GitBranch className="h-3.5 w-3.5" />
                ) : (
                  <History className="h-3.5 w-3.5" />
                )}
              </button>
              <button
                type="button"
                aria-label={t("projectTools.gitReview.detailPane")}
                aria-pressed={
                  reviewMode === "changes"
                    ? changesStackedPane === "detail"
                    : historyStackedPane === "detail"
                }
                title={t("projectTools.gitReview.detailPane")}
                className={cn(
                  GIT_REVIEW_STACKED_PANE_BUTTON_CLASS,
                  (reviewMode === "changes"
                    ? changesStackedPane === "detail"
                    : historyStackedPane === "detail") &&
                    "bg-background text-foreground shadow-sm",
                )}
                onClick={() => {
                  if (reviewMode === "changes") {
                    setChangesStackedDir("forward");
                    setChangesStackedPane("detail");
                  } else {
                    setHistoryStackedDir("forward");
                    setHistoryStackedPane("detail");
                  }
                }}
              >
                <Eye className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : null}
        </div>
        {!canWrite && disabledMessage ? (
          <div className="mt-2 rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">
            {disabledMessage}
          </div>
        ) : null}
        {visibleError ? <div className="mt-2 text-xs text-destructive">{visibleError}</div> : null}
      </div>

      {reviewMode === "changes" ? (
        <div
          key="changes"
          className={cn(
            "git-review-tab-enter min-h-0 flex-1 gap-3 overflow-hidden p-3",
            useSplitReviewLayout
              ? `grid ${GIT_REVIEW_SPLIT_GRID_CLASS}`
              : "flex flex-col",
          )}
        >
          <aside
            ref={changesListPaneRef}
            className={cn(
              "min-h-0 flex-col overflow-hidden rounded-lg border border-border/70 bg-background",
              useSplitReviewLayout || changesStackedPane === "list" ? "flex" : "hidden",
              !useSplitReviewLayout && "flex-1",
            )}
          >
            <div
              className={cn(
                GIT_REVIEW_TRANSIENT_SCROLLBAR_CLASS,
                "isolate min-h-0 flex-1 overflow-auto [overscroll-behavior:contain]",
              )}
              onScroll={handleGitReviewTransientScroll}
            >
              {entries.length === 0 ? (
                <div className="px-3 py-6 text-xs text-muted-foreground">
                  {t("projectTools.gitReview.noLocalChanges")}
                </div>
              ) : (
                <>
                  {renderChangeSection(
                    "staged",
                    t("projectTools.gitReview.stagedChangesTitle"),
                    stagedEntries,
                    visibleStagedEntries,
                    hiddenStagedEntryCount,
                    t("projectTools.gitReview.noStagedChanges"),
                    () =>
                      setVisibleStagedEntryCount(
                        (current) => current + CHANGE_ENTRY_RENDER_BATCH_SIZE,
                      ),
                    collapsedChangeSections.staged,
                    () => toggleChangeSection("staged"),
                  )}
                  {renderChangeSection(
                    "changes",
                    t("projectTools.gitReview.changesTitle"),
                    workingEntries,
                    visibleWorkingEntries,
                    hiddenWorkingEntryCount,
                    t("projectTools.gitReview.noWorkingChanges"),
                    () =>
                      setVisibleWorkingEntryCount(
                        (current) => current + CHANGE_ENTRY_RENDER_BATCH_SIZE,
                      ),
                    collapsedChangeSections.changes,
                    () => toggleChangeSection("changes"),
                  )}
                </>
              )}
            </div>
          </aside>
          <main
            ref={changesDetailPaneRef}
            className={cn(
              "h-full min-h-0 flex-col overflow-hidden",
              useSplitReviewLayout || changesStackedPane === "detail" ? "flex" : "hidden",
              !useSplitReviewLayout && "flex-1",
            )}
          >
          <div className="mb-3 flex shrink-0 items-center gap-2">
            <GitCommitHorizontal className="h-4 w-4 text-muted-foreground" />
            <Input
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              placeholder={t("projectTools.gitReview.commitMessagePlaceholder")}
              disabled={writeDisabled || operationBusy}
              className="h-8 text-xs placeholder:text-[11px] focus-visible:ring-1 focus-visible:ring-border/40"
            />
            <Button
              size="sm"
              disabled={writeDisabled || operationBusy || !commitMessage.trim()}
              onClick={() => {
                void runOperation(
                  "commit",
                  () => gitClient!.commit(cwd, commitMessage),
                  "commit",
                ).then((ok) => {
                  if (ok) setCommitMessage("");
                });
              }}
            >
              {busy === "commit" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t("projectTools.gitReview.commit")}
            </Button>
          </div>
          {selectedEntry ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
              <div className="flex shrink-0 items-center gap-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-xs">
                <span className="text-muted-foreground">{t("projectTools.gitReview.selected")}</span>
                <span className="min-w-0 flex-1 truncate font-medium" title={selectedEntry.path}>
                  {selectedEntry.path}
                </span>
              </div>
              <DiffReviewCard
                activeView={activeDiffView}
                branchDiff={branchDiff}
                branchError={branchError}
                diffLoading={diffLoading}
                onActiveViewChange={setActiveDiffView}
                showStat={useSplitReviewLayout}
                worktreeDiff={worktreeDiff}
              />
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-border/70 bg-muted/10 px-4 text-center text-xs text-muted-foreground">
              {t("projectTools.gitReview.selectFileToViewDiff")}
            </div>
          )}
        </main>
        </div>
      ) : (
        <div
          key="history"
          className={cn(
            "git-review-tab-enter min-h-0 flex-1 gap-3 overflow-hidden p-3",
            useSplitReviewLayout
              ? `grid ${GIT_REVIEW_SPLIT_GRID_CLASS}`
              : "flex flex-col",
          )}
        >
          <aside
            ref={historyListPaneRef}
            className={cn(
              "min-h-0 flex-col overflow-hidden rounded-lg border border-border/70 bg-background",
              useSplitReviewLayout || historyStackedPane === "list" ? "flex" : "hidden",
              !useSplitReviewLayout && "flex-1",
            )}
          >
            <div className="relative z-10 flex shrink-0 items-center gap-2 border-b border-border bg-background px-3 py-1.5">
              <div className="flex min-w-0 items-center gap-2 truncate text-xs font-semibold">
                <History className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{t("projectTools.gitReview.commitHistoryTitle")}</span>
              </div>
              <button
                type="button"
                aria-label={t("projectTools.gitReview.revealCurrentHistoryItem")}
                title={t("projectTools.gitReview.revealCurrentHistoryItem")}
                className="ml-auto inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
                disabled={currentHistoryItemIndex < 0}
                onClick={revealCurrentHistoryItem}
              >
                <Target className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
            <div
              ref={historyListRef}
              className={cn(GIT_REVIEW_TRANSIENT_SCROLLBAR_CLASS, "min-h-0 flex-1 overflow-auto")}
              onScroll={handleHistoryListScroll}
            >
              {historyLoading && historyCommits.length === 0 ? (
                <div className="flex items-center justify-center gap-2 px-3 py-6 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>{t("projectTools.gitReview.commitHistoryTitle")}</span>
                </div>
              ) : historyCommits.length === 0 ? (
                <div className="px-3 py-6 text-xs text-muted-foreground">
                  {historyError || t("projectTools.gitReview.noCommitHistory")}
                </div>
              ) : (
                <div className="relative" style={{ height: `${historyVirtualizer.getTotalSize()}px` }}>
                  {historyVirtualizer.getVirtualItems().map((virtualRow) => {
                    const row = historyRows[virtualRow.index];
                    if (!row) return null;
                    if (row.type === "loadMore") {
                      return (
                        <div
                          key={virtualRow.key}
                          ref={historyVirtualizer.measureElement}
                          data-index={virtualRow.index}
                          className="absolute left-0 top-0 w-full"
                          style={{ transform: `translateY(${virtualRow.start}px)` }}
                        >
                          <button
                            type="button"
                            className="flex min-h-[28px] w-full items-center justify-center gap-2 px-3 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-70"
                            disabled={historyLoadingMore}
                            title={historyLoadMoreError || undefined}
                            onClick={() => void loadHistory({ append: true, silent: true })}
                          >
                            {historyLoadingMore ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : null}
                            <span>
                              {historyLoadingMore
                                ? t("projectTools.gitReview.loadingMoreCommits")
                                : historyLoadMoreError
                                  ? t("projectTools.gitReview.loadMoreCommitsFailed")
                                  : t("projectTools.gitReview.loadMoreCommits")}
                            </span>
                          </button>
                        </div>
                      );
                    }
                    if (row.type === "marker") {
                      const graphRow = gitGraph.rows[row.graphIndex];
                      if (!graphRow) return null;
                      const label =
                        row.kind === "outgoing-changes"
                          ? t("projectTools.gitReview.outgoingChanges")
                          : t("projectTools.gitReview.incomingChanges");
                      const refLabel = gitHistoryMarkerRef(
                        row.kind,
                        state,
                        historyGraphState.historyRemoteRef,
                      );
                      const title = refLabel ? `${label} ${refLabel}` : label;
                      return (
                        <div
                          key={virtualRow.key}
                          ref={historyVirtualizer.measureElement}
                          data-index={virtualRow.index}
                          className="absolute left-0 top-0 w-full"
                          style={{ transform: `translateY(${virtualRow.start}px)` }}
                        >
                          <div
                            className="git-review-history-row flex h-[22px] w-full min-w-0 select-none items-center gap-1 px-1.5 text-left text-xs text-muted-foreground transition-colors"
                            title={title}
                            aria-label={title}
                          >
                            <GitGraphSvgCell row={graphRow} />
                            <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                              {label}
                            </span>
                            {refLabel ? (
                              <span className="shrink-0 truncate text-[11px] text-muted-foreground">
                                {refLabel}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      );
                    }
                    if (row.type === "file") {
                      const TypeIcon = getFileTypeIcon(row.file.path, "file");
                      const fileSelected =
                        row.commit.sha === selectedCommitSha && row.file.path === selectedCommitFilePath;
                      const fileContextMenuOpen =
                        historyContextMenu?.kind === "file" &&
                        historyContextMenu.commitSha === row.commit.sha &&
                        historyContextMenu.path === row.file.path;
                      const fileName = basename(row.file.path);
                      const filePath = row.file.oldPath
                        ? `${parentPath(row.file.oldPath)} -> ${parentPath(row.file.path)}`
                        : parentPath(row.file.path);
                      const graphRow = gitGraph.rows[row.graphIndex];
                      return (
                        <div
                          key={virtualRow.key}
                          ref={historyVirtualizer.measureElement}
                          data-index={virtualRow.index}
                          className="absolute left-0 top-0 w-full"
                          style={{ transform: `translateY(${virtualRow.start}px)` }}
                        >
                          <button
                            type="button"
                            className="git-review-history-row flex h-[22px] w-full min-w-0 select-none items-center gap-1.5 px-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            data-selected={fileSelected || undefined}
                            data-context-open={fileContextMenuOpen || undefined}
                            title={
                              row.file.oldPath
                                ? `${row.file.oldPath} -> ${row.file.path}`
                                : row.file.path
                            }
                            onContextMenu={(event) =>
                              openHistoryFileContextMenu(event, row.commit, row.file)
                            }
                            onClick={() => selectCommitFile(row.commit, row.file)}
                          >
                            {graphRow ? (
                              <GitGraphContinuationCell row={graphRow} />
                            ) : null}
                            <TypeIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                            <span className="min-w-0 flex-1 truncate">
                              <span className="font-medium">{fileName}</span>
                              <span className="ml-1 text-[10px] text-muted-foreground">
                                {filePath}
                              </span>
                            </span>
                            <span className={cn("shrink-0 text-[10px] font-semibold", commitFileStatusTone(row.file))}>
                              {commitFileStatusLabel(row.file)}
                            </span>
                          </button>
                        </div>
                      );
                    }
                    const commit = row.commit;
                    const commitSelected = commit.sha === selectedCommitSha;
                    const commitContextMenuOpen =
                      historyContextMenu?.kind === "commit" &&
                      historyContextMenu.commitSha === commit.sha;
                    const commitExpanded = expandedCommitShas.has(commit.sha);
                    const graphRow = gitGraph.rows[row.graphIndex];
                    return (
                      <div
                        key={virtualRow.key}
                        ref={historyVirtualizer.measureElement}
                        data-index={virtualRow.index}
                        className="absolute left-0 top-0 w-full"
                        style={{ transform: `translateY(${virtualRow.start}px)` }}
                      >
                        <button
                          type="button"
                          className="git-review-history-row flex h-[22px] w-full min-w-0 select-none items-center gap-1 px-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          data-selected={commitSelected || undefined}
                          data-context-open={commitContextMenuOpen || undefined}
                          title={commitHistoryTitle(commit)}
                          aria-expanded={commitExpanded}
                          onContextMenu={(event) => openHistoryCommitContextMenu(event, commit)}
                          onClick={() => selectCommit(commit)}
                        >
                          {graphRow ? (
                            <GitGraphSvgCell row={graphRow} />
                          ) : null}
                          <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                            {commit.subject || commit.shortSha}
                          </span>
                          <CommitRefTags
                            refs={commit.refs}
                            selected={commitSelected}
                            remoteName={state.remoteName}
                          />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </aside>
          <main
            ref={historyDetailPaneRef}
            className={cn(
              "h-full min-h-0 flex-col overflow-hidden",
              useSplitReviewLayout || historyStackedPane === "detail" ? "flex" : "hidden",
              !useSplitReviewLayout && "flex-1",
            )}
          >
            {selectedCommit ? (
              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
                <div className="flex shrink-0 items-start gap-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-xs">
                  <GitCommitHorizontal className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-foreground" title={commitHistoryTitle(selectedCommit)}>
                      {selectedCommit.subject || selectedCommit.shortSha}
                    </div>
                    <CommitRefTags
                      refs={selectedCommit.refs}
                      selected={false}
                      remoteName={state.remoteName}
                      variant="detail"
                      limit={COMMIT_DETAIL_REF_TAG_LIMIT}
                    />
                    <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span className="font-mono">{selectedCommit.shortSha}</span>
                      <span>{selectedCommit.authorName}</span>
                      <span>{formatCommitDate(selectedCommit.authorDate)}</span>
                    </div>
                  </div>
                </div>
                {selectedCommitFile || commitDiff || commitDiffLoading || historyError ? (
                  <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/70 bg-background">
                    <div className="sticky top-0 z-10 flex shrink-0 items-center justify-between gap-2 border-b border-border/70 bg-background px-3 py-2">
                      <div className="min-w-0">
                        <div className="truncate text-xs font-semibold">
                          {historyDiffTitle || t("projectTools.gitReview.commitDiff")}
                        </div>
                        <div
                          className="truncate text-[11px] text-muted-foreground"
                          title={historyDiffSubtitle || selectedCommitFile?.path || selectedCommit.sha}
                        >
                          {historyDiffSubtitle ||
                            `${selectedCommit.shortSha || selectedCommit.sha.slice(0, 7)} - ${selectedCommit.subject}`}
                        </div>
                      </div>
                      {commitDiffLoading ? (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                      ) : null}
                    </div>
                    <DiffContent
                      title={historyDiffTitle || t("projectTools.gitReview.commitDiff")}
                      diff={commitDiff}
                      error={historyError}
                      loading={commitDiffLoading}
                      showStat={useSplitReviewLayout}
                    />
                  </section>
                ) : (
                  <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-border/70 bg-muted/10 px-4 text-center text-xs text-muted-foreground">
                    {t("projectTools.gitReview.selectCommitFileToViewDiff")}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-border/70 bg-muted/10 px-4 text-center text-xs text-muted-foreground">
                {historyError || t("projectTools.gitReview.selectCommitToViewFiles")}
              </div>
            )}
          </main>
        </div>
      )}
      {reviewMode === "history" &&
      historyContextMenu &&
      historyContextCommit &&
      (historyContextMenu.kind === "commit" || historyContextFile) ? (
        <div
          role="menu"
          className={cn("absolute z-[75] min-w-56", CONTEXT_MENU_CONTAINER_CLASS)}
          style={{ left: historyContextMenu.x, top: historyContextMenu.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {historyContextMenu.kind === "file" ? (
            <>
              <button
                type="button"
                role="menuitem"
                className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
                onClick={() => openHistoryCommitDiff(historyContextCommit, historyContextFile!)}
              >
                <Eye className="h-3.5 w-3.5" />
                <span>{t("projectTools.gitReview.openChange")}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
                disabled={!onInsertGitFileMention}
                onClick={() => addHistoryFileToContext(historyContextCommit, historyContextFile!)}
              >
                <MessageSquareText className="h-3.5 w-3.5" />
                <span>{t("projectTools.gitReview.addToContext")}</span>
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
                onClick={() => openHistoryCommitDiff(historyContextCommit, historyContextFile)}
              >
                <Eye className="h-3.5 w-3.5" />
                <span>{t("projectTools.gitReview.openChange")}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
                disabled={!historyContextCommitGithubUrl}
                onClick={() => openHistoryCommitOnGithub(historyContextCommit)}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                <span>{t("projectTools.gitReview.openOnGithub")}</span>
              </button>
              <div className={CONTEXT_MENU_SEPARATOR_CLASS} />
              <button
                type="button"
                role="menuitem"
                className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
                disabled={writeDisabled || operationBusy || state.status !== "ready"}
                onClick={() => openCreateBranchFromCommit(historyContextCommit)}
              >
                <GitBranch className="h-3.5 w-3.5" />
                <span>{t("projectTools.gitReview.createBranch")}</span>
              </button>
              <div className={CONTEXT_MENU_SEPARATOR_CLASS} />
              <button
                type="button"
                role="menuitem"
                className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
                disabled={!gitClient}
                onClick={() => compareHistoryCommitWithRemote(historyContextCommit)}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span>{t("projectTools.gitReview.compareWithRemote")}</span>
              </button>
              <div className={CONTEXT_MENU_SEPARATOR_CLASS} />
              <button
                type="button"
                role="menuitem"
                className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
                onClick={() => copyHistoryCommitHash(historyContextCommit)}
              >
                <Copy className="h-3.5 w-3.5" />
                <span>{t("projectTools.gitReview.copyCommitHash")}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
                onClick={() => copyHistoryCommitMessage(historyContextCommit)}
              >
                <Copy className="h-3.5 w-3.5" />
                <span>{t("projectTools.gitReview.copyCommitMessage")}</span>
              </button>
              <div className={CONTEXT_MENU_SEPARATOR_CLASS} />
              <button
                type="button"
                role="menuitem"
                className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
                disabled={!onInsertCommitMention}
                onClick={() => addHistoryCommitToContext(historyContextCommit)}
              >
                <MessageSquareText className="h-3.5 w-3.5" />
                <span>{t("projectTools.gitReview.addToContext")}</span>
              </button>
            </>
          )}
        </div>
      ) : null}
      {reviewMode === "changes" && changesMenu ? (
        <div
          role="menu"
          className={cn("absolute z-[75] min-w-56", CONTEXT_MENU_CONTAINER_CLASS)}
          style={{ left: changesMenu.x, top: changesMenu.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {changesMenu.section === "changes" ? (
            <button
              type="button"
              role="menuitem"
              className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
              disabled={writeDisabled || busy !== "" || !hasStageableChanges}
              onClick={stageAllChanges}
            >
              <FilePenLine className="h-3.5 w-3.5" />
              <span>{t("projectTools.gitReview.stageAllChanges")}</span>
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
              disabled={writeDisabled || busy !== "" || !hasStagedChanges}
              onClick={unstageAllChanges}
            >
              <GitCommitHorizontal className="h-3.5 w-3.5" />
              <span>{t("projectTools.gitReview.unstageAllChanges")}</span>
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
            disabled={writeDisabled || busy !== "" || !hasDiscardableChanges}
            onClick={discardAllChanges}
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>{t("projectTools.gitReview.discardAllChanges")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
            disabled={loading}
            onClick={() => {
              setChangesMenu(null);
              void refresh({ notifyChanged: true });
            }}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>{t("projectTools.gitReview.refreshChanges")}</span>
          </button>
        </div>
      ) : null}
      {reviewMode === "changes" && changeContextMenu && contextEntry ? (
        <div
          role="menu"
          className={cn("absolute z-[80] min-w-56", CONTEXT_MENU_CONTAINER_CLASS)}
          style={{ left: changeContextMenu.x, top: changeContextMenu.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <button
            type="button"
            role="menuitem"
            className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
            onClick={() => viewEntryChanges(contextEntry)}
          >
            <Eye className="h-3.5 w-3.5" />
            <span>{t("projectTools.gitReview.viewChanges")}</span>
          </button>
          {contextEntrySection === "staged" ? (
            <button
              type="button"
              role="menuitem"
              className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
              disabled={writeDisabled || busy !== "" || !contextEntryCanUnstage}
              onClick={() => unstageEntry(contextEntry)}
            >
              <GitCommitHorizontal className="h-3.5 w-3.5" />
              <span>{t("projectTools.gitReview.unstageChanges")}</span>
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
              disabled={writeDisabled || busy !== "" || !contextEntryCanStage}
              onClick={() => stageEntry(contextEntry)}
            >
              <FilePenLine className="h-3.5 w-3.5" />
              <span>{t("projectTools.gitReview.stageChanges")}</span>
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
            disabled={writeDisabled || busy !== ""}
            onClick={() => discardEntry(contextEntry)}
          >
            <BrushCleaning className="h-3.5 w-3.5" />
            <span>{t("projectTools.gitReview.discardChanges")}</span>
          </button>
          {contextEntryCanAddToGitignore ? (
            <button
              type="button"
              role="menuitem"
              className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
              disabled={writeDisabled || busy !== ""}
              onClick={() => addEntryToGitignore(contextEntry)}
            >
              <GitCommitHorizontal className="h-3.5 w-3.5" />
              <span>{t("projectTools.gitReview.addToGitignore")}</span>
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className={CHANGE_CONTEXT_MENU_ITEM_CLASS}
            disabled={!onRevealInFileTree}
            onClick={() => revealEntryInFileTree(contextEntry)}
          >
            <FolderTree className="h-3.5 w-3.5" />
            <span>{t("projectTools.gitReview.revealInFileTree")}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
});
