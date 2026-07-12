// GitReview diff rendering: DiffContent (patch chunks, diff stat, selection
// context menu, selection autoscroll, horizontal scrollbar) and the
// DiffReviewCard wrapper used by the changes view.
//
// MIRROR NOTICE: every file under components/project-tools/git-review exists
// byte-for-byte in both frontends (crates/agent-gui/src and
// crates/agent-gateway/web/src). Keep changes in sync on both ends; only
// relative or @tauri-apps/* imports are allowed here.

import { DiffFile } from "@git-diff-view/file";
import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import {
  memo,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useLocale } from "../../../i18n";
import type { GitDiffResponse } from "../../../lib/git/types";
import { cn } from "../../../lib/shared/utils";
import { Copy, FolderTree, GitBranch, Loader2 } from "../../icons";
import { Button } from "../../ui/button";
import {
  basename,
  buildPatchChunks,
  type DiffViewKind,
  getPatchFileNames,
  type PatchChunk,
  parseDiffStat,
  writeTextToClipboard,
} from "./model";
import {
  GIT_REVIEW_TRANSIENT_SCROLLBAR_CLASS,
  isScrollableOverflowValue,
  syncGitReviewAutoscrollScrollbar,
  useOverlayScrollbar,
} from "./useOverlayScrollbar";

const RAW_DIFF_PREVIEW_CHAR_LIMIT = 60 * 1024;

const DIFF_SELECTION_AUTOSCROLL_EDGE_PX = 40;
const DIFF_SELECTION_AUTOSCROLL_MAX_STEP_PX = 22;
const DIFF_HORIZONTAL_SCROLLBAR_MIN_THUMB_PX = 32;
const PROJECT_TOOLS_RESIZE_END_EVENT = "liveagent:project-tools-resize-end";

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
      (start + DIFF_SELECTION_AUTOSCROLL_EDGE_PX - pointer) / DIFF_SELECTION_AUTOSCROLL_EDGE_PX,
    );
    return -Math.max(2, Math.round(ratio * DIFF_SELECTION_AUTOSCROLL_MAX_STEP_PX));
  }
  if (pointer > end - DIFF_SELECTION_AUTOSCROLL_EDGE_PX) {
    const ratio = Math.min(
      1,
      (pointer - (end - DIFF_SELECTION_AUTOSCROLL_EDGE_PX)) / DIFF_SELECTION_AUTOSCROLL_EDGE_PX,
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
    isScrollableOverflowValue(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
  const canScrollX =
    isScrollableOverflowValue(style.overflowX) && element.scrollWidth > element.clientWidth + 1;
  return canScrollY || canScrollX;
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

  let current: HTMLElement | null = target instanceof HTMLElement ? target : target.parentElement;
  while (current && current !== root) {
    addViewport(current);
    current = current.parentElement;
  }
  addViewport(fallback);
  return viewports;
}

function getDiffHorizontalScrollOverflow(element: HTMLElement) {
  return Math.max(0, element.scrollWidth - element.clientWidth);
}

function isDiffHorizontalScrollableElement(element: HTMLElement) {
  return getDiffHorizontalScrollOverflow(element) > 0;
}

function resolveDiffHorizontalScrollTargets(
  root: HTMLElement | null,
  fallback: HTMLElement | null,
) {
  const targets: HTMLElement[] = [];
  const addTarget = (element: HTMLElement | null) => {
    if (!element || targets.includes(element) || !isDiffHorizontalScrollableElement(element)) {
      return;
    }
    targets.push(element);
  };

  if (fallback) {
    addTarget(fallback);
  }
  if (!root) return targets;

  root.querySelectorAll<HTMLElement>(".diff-table-scroll-container").forEach(addTarget);
  return targets;
}

function chooseDiffHorizontalScrollTarget(targets: HTMLElement[], preferred: HTMLElement | null) {
  if (preferred && targets.includes(preferred) && isDiffHorizontalScrollableElement(preferred)) {
    return preferred;
  }

  let bestTarget: HTMLElement | null = null;
  let bestOverflow = 0;
  for (const target of targets) {
    const overflow = getDiffHorizontalScrollOverflow(target);
    if (overflow > bestOverflow) {
      bestOverflow = overflow;
      bestTarget = target;
    }
  }
  return bestTarget;
}

function isRightDockPanelResizing(root: HTMLElement | null) {
  return Boolean(root?.closest('[data-project-tools-resizing="true"]'));
}

type DiffSelectionContextMenuState = {
  x: number;
  y: number;
  selectedText: string;
};

type DiffHorizontalScrollbarState = {
  visible: boolean;
  thumbWidth: number;
  thumbLeft: number;
  maxScrollLeft: number;
  scrollLeft: number;
};

const DIFF_SELECTION_CONTEXT_MENU_MARGIN = 12;

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

const DiffChunkView = memo(function DiffChunkView(props: { item: PatchChunk; isDark: boolean }) {
  const { item, isDark } = props;
  const { t } = useLocale();
  const handleOverlayScroll = useOverlayScrollbar();
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Lazy parse/highlight: a chunk only builds its DiffFile once it scrolls
  // near the viewport, so a multi-file commit diff no longer freezes the main
  // thread synchronously on selection.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (visible) return undefined;
    const element = containerRef.current;
    if (!element) return undefined;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
        }
      },
      { rootMargin: "320px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);

  const diffFile = useMemo(() => {
    if (!visible || item.large) return null;
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
  }, [isDark, item, visible]);

  const rawPreview = useMemo(() => {
    if (!item.large) return item.chunk;
    return item.chunk.length > RAW_DIFF_PREVIEW_CHAR_LIMIT
      ? `${item.chunk.slice(0, RAW_DIFF_PREVIEW_CHAR_LIMIT)}\n\n${t("projectTools.gitReview.diffPreviewTruncated")}`
      : item.chunk;
  }, [item, t]);

  // Rough height estimate so the scroll range stays stable while the chunk is
  // still a placeholder (large chunks render a capped raw preview instead).
  const placeholderHeight = item.large ? 416 : Math.max(48, item.lineCount * 20);

  return (
    <div ref={containerRef} className="border-b border-border/60 last:border-b-0">
      <div className="flex select-none items-center gap-2 border-b border-border/60 bg-muted/20 px-3 py-1.5 text-[calc(11px*var(--zone-font-scale,1))] font-medium text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {item.large ? (
          <span className="shrink-0 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[calc(10px*var(--zone-font-scale,1))] text-amber-700 dark:text-amber-300">
            {t("projectTools.gitReview.largeDiff")}
          </span>
        ) : null}
      </div>
      {!visible ? (
        <div aria-hidden="true" style={{ height: placeholderHeight }} />
      ) : diffFile ? (
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
            "git-review-diff-selectable-content max-h-[26rem] select-text overflow-auto px-3 py-3 text-[calc(11px*var(--zone-font-scale,1))] leading-relaxed text-muted-foreground",
          )}
          onScroll={handleOverlayScroll}
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
  const handleOverlayScroll = useOverlayScrollbar();
  const parsed = useMemo(() => parseDiffStat(stat), [stat]);
  if (!stat.trim()) return null;

  const showStructured = parsed.files.length > 0;

  if (!showStructured) {
    return (
      <pre
        className={cn(
          GIT_REVIEW_TRANSIENT_SCROLLBAR_CLASS,
          "max-h-24 overflow-auto border-b border-border/70 bg-muted/25 px-3 py-2 text-[calc(11px*var(--zone-font-scale,1))] leading-relaxed text-muted-foreground",
        )}
        onScroll={handleOverlayScroll}
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
          onScroll={handleOverlayScroll}
        >
          {parsed.files.map((file) => (
            <div
              key={file.key}
              className="rounded-md border border-border/60 bg-background/75 px-2.5 py-2"
              title={file.raw}
            >
              <div className="flex min-w-0 items-center gap-2">
                <div className="min-w-0 flex-1 truncate text-[calc(11px*var(--zone-font-scale,1))] font-medium text-foreground">
                  {basename(file.path)}
                </div>
                <div className="flex shrink-0 items-center gap-1 text-[calc(10px*var(--zone-font-scale,1))] tabular-nums">
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
            "mt-2 max-h-20 overflow-auto rounded-md bg-muted/35 px-2 py-1.5 text-[calc(10px*var(--zone-font-scale,1))] leading-relaxed text-muted-foreground",
          )}
          onScroll={handleOverlayScroll}
        >
          {parsed.fallbackLines.join("\n")}
        </pre>
      ) : null}
    </div>
  );
}

export function DiffContent(props: {
  diff?: GitDiffResponse | null;
  title: string;
  error?: string;
  loading?: boolean;
  showStat?: boolean;
}) {
  const { diff, title, error, loading = false, showStat = true } = props;
  const { locale, t } = useLocale();
  const isDark = useIsDark();
  const handleOverlayScroll = useOverlayScrollbar();
  const rootRef = useRef<HTMLElement | null>(null);
  const scrollViewportRef = useRef<HTMLElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const selectionAutoscrollViewportsRef = useRef<HTMLElement[]>([]);
  const selectionAutoscrollPointerRef = useRef<{
    x: number;
    y: number;
  } | null>(null);
  const selectionAutoscrollFrameRef = useRef<number | null>(null);
  const diffHorizontalScrollbarTrackRef = useRef<HTMLDivElement | null>(null);
  const diffHorizontalScrollTargetsRef = useRef<HTMLElement[]>([]);
  const diffHorizontalActiveTargetRef = useRef<HTMLElement | null>(null);
  const diffScrollViewportId = useId();
  const [selectionContextMenu, setSelectionContextMenu] =
    useState<DiffSelectionContextMenuState | null>(null);
  const [diffHorizontalScrollbar, setDiffHorizontalScrollbar] =
    useState<DiffHorizontalScrollbarState>({
      visible: false,
      thumbWidth: 0,
      thumbLeft: 0,
      maxScrollLeft: 0,
      scrollLeft: 0,
    });
  const patchChunks = useMemo(
    () => buildPatchChunks(diff?.patch ?? "", title),
    [diff?.patch, title],
  );
  const showLoadingState = loading && !error && !diff;
  const showDiffStat = showStat && Boolean(diff?.stat);
  const closeSelectionContextMenu = useCallback(() => {
    setSelectionContextMenu(null);
  }, []);

  const updateDiffHorizontalScrollbar = useCallback(() => {
    const root = rootRef.current;
    if (isRightDockPanelResizing(root)) return;

    const trackWidth =
      diffHorizontalScrollbarTrackRef.current?.clientWidth ??
      scrollViewportRef.current?.clientWidth ??
      root?.clientWidth ??
      0;
    const target = chooseDiffHorizontalScrollTarget(
      diffHorizontalScrollTargetsRef.current,
      diffHorizontalActiveTargetRef.current,
    );

    if (!target || trackWidth <= 0) {
      diffHorizontalActiveTargetRef.current = null;
      setDiffHorizontalScrollbar((current) =>
        current.visible
          ? { visible: false, thumbWidth: 0, thumbLeft: 0, maxScrollLeft: 0, scrollLeft: 0 }
          : current,
      );
      return;
    }

    diffHorizontalActiveTargetRef.current = target;
    const maxScrollLeft = getDiffHorizontalScrollOverflow(target);
    if (maxScrollLeft <= 0 || target.scrollWidth <= 0) {
      setDiffHorizontalScrollbar((current) =>
        current.visible
          ? { visible: false, thumbWidth: 0, thumbLeft: 0, maxScrollLeft: 0, scrollLeft: 0 }
          : current,
      );
      return;
    }

    const thumbWidth = Math.max(
      DIFF_HORIZONTAL_SCROLLBAR_MIN_THUMB_PX,
      Math.min(trackWidth, (target.clientWidth / target.scrollWidth) * trackWidth),
    );
    const travelWidth = Math.max(1, trackWidth - thumbWidth);
    const thumbLeft = (target.scrollLeft / maxScrollLeft) * travelWidth;
    setDiffHorizontalScrollbar((current) => {
      if (
        current.visible &&
        Math.abs(current.thumbWidth - thumbWidth) < 0.5 &&
        Math.abs(current.thumbLeft - thumbLeft) < 0.5 &&
        Math.abs(current.maxScrollLeft - maxScrollLeft) < 0.5 &&
        Math.abs(current.scrollLeft - target.scrollLeft) < 0.5
      ) {
        return current;
      }
      return {
        visible: true,
        thumbWidth,
        thumbLeft,
        maxScrollLeft,
        scrollLeft: target.scrollLeft,
      };
    });
  }, []);

  const setDiffHorizontalScrollRatio = useCallback(
    (ratio: number) => {
      const nextRatio = Math.min(1, Math.max(0, ratio));
      for (const target of diffHorizontalScrollTargetsRef.current) {
        const maxScrollLeft = getDiffHorizontalScrollOverflow(target);
        if (maxScrollLeft <= 0) continue;
        target.scrollLeft = Math.min(maxScrollLeft, Math.max(0, nextRatio * maxScrollLeft));
      }
      updateDiffHorizontalScrollbar();
    },
    [updateDiffHorizontalScrollbar],
  );

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let animationFrame: number | null = null;
    let targets: HTMLElement[] = [];
    const scheduleUpdate = () => {
      if (animationFrame !== null) return;
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = null;
        updateDiffHorizontalScrollbar();
      });
    };
    const handleTargetScroll = (event: Event) => {
      if (event.currentTarget instanceof HTMLElement) {
        diffHorizontalActiveTargetRef.current = event.currentTarget;
      }
      scheduleUpdate();
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            scheduleUpdate();
          });

    const detachTargets = () => {
      for (const target of targets) {
        target.removeEventListener("scroll", handleTargetScroll);
        resizeObserver?.unobserve(target);
      }
    };
    const attachTargets = (nextTargets: HTMLElement[]) => {
      for (const target of nextTargets) {
        target.addEventListener("scroll", handleTargetScroll, { passive: true });
        resizeObserver?.observe(target);
      }
    };
    const refreshTargets = () => {
      detachTargets();
      targets = resolveDiffHorizontalScrollTargets(root, scrollViewportRef.current);
      diffHorizontalScrollTargetsRef.current = targets;
      diffHorizontalActiveTargetRef.current = chooseDiffHorizontalScrollTarget(
        targets,
        diffHorizontalActiveTargetRef.current,
      );
      attachTargets(targets);
      scheduleUpdate();
    };

    resizeObserver?.observe(root);
    if (scrollViewportRef.current) {
      resizeObserver?.observe(scrollViewportRef.current);
    }
    // Mutations arrive in bursts (lazy chunks materializing, syntax highlight
    // batches): throttle the full target re-scan instead of running it on
    // every single mutation record.
    let refreshTimer: number | null = null;
    const scheduleRefreshTargets = () => {
      if (refreshTimer !== null) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        refreshTargets();
      }, 200);
    };
    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            scheduleRefreshTargets();
          });
    mutationObserver?.observe(root, { childList: true, subtree: true });
    window.addEventListener("resize", refreshTargets);
    window.addEventListener(PROJECT_TOOLS_RESIZE_END_EVENT, refreshTargets);
    refreshTargets();

    return () => {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      window.removeEventListener("resize", refreshTargets);
      window.removeEventListener(PROJECT_TOOLS_RESIZE_END_EVENT, refreshTargets);
      mutationObserver?.disconnect();
      detachTargets();
      resizeObserver?.disconnect();
      diffHorizontalScrollTargetsRef.current = [];
      diffHorizontalActiveTargetRef.current = null;
    };
  }, [diff?.patch, error, loading, patchChunks.length, updateDiffHorizontalScrollbar]);

  const handleDiffHorizontalScrollbarPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !diffHorizontalScrollbar.visible) return;
      const track = diffHorizontalScrollbarTrackRef.current;
      if (!track) return;
      const target = chooseDiffHorizontalScrollTarget(
        diffHorizontalScrollTargetsRef.current,
        diffHorizontalActiveTargetRef.current,
      );
      if (!target) return;

      const maxScrollLeft = getDiffHorizontalScrollOverflow(target);
      if (maxScrollLeft <= 0) return;

      event.preventDefault();
      event.stopPropagation();
      diffHorizontalActiveTargetRef.current = target;

      const rect = track.getBoundingClientRect();
      const thumbWidth = Math.max(
        DIFF_HORIZONTAL_SCROLLBAR_MIN_THUMB_PX,
        Math.min(rect.width, (target.clientWidth / target.scrollWidth) * rect.width),
      );
      const travelWidth = Math.max(1, rect.width - thumbWidth);
      const clickedThumb =
        event.target instanceof HTMLElement &&
        event.target.closest(".git-review-diff-horizontal-scrollbar-thumb") !== null;
      const pointerStartX = event.clientX;
      const scrollStart = clickedThumb
        ? target.scrollLeft
        : Math.min(
            maxScrollLeft,
            Math.max(
              0,
              ((event.clientX - rect.left - thumbWidth / 2) / travelWidth) * maxScrollLeft,
            ),
          );
      setDiffHorizontalScrollRatio(scrollStart / maxScrollLeft);

      let cleanup = () => {};
      const handleMove = (moveEvent: PointerEvent) => {
        if ((moveEvent.buttons & 1) === 0) {
          cleanup();
          return;
        }
        const nextScrollLeft = Math.min(
          maxScrollLeft,
          Math.max(
            0,
            scrollStart + ((moveEvent.clientX - pointerStartX) / travelWidth) * maxScrollLeft,
          ),
        );
        setDiffHorizontalScrollRatio(nextScrollLeft / maxScrollLeft);
      };
      cleanup = () => {
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
    [diffHorizontalScrollbar.visible, setDiffHorizontalScrollRatio],
  );

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
    (event: ReactMouseEvent<HTMLFieldSetElement>) => {
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
    (event: ReactPointerEvent<HTMLFieldSetElement>) => {
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

  // Clamp the selection menu against its measured size after it renders (no
  // hard-coded width/height): useLayoutEffect runs before paint, so an
  // out-of-bounds menu never flashes at the raw pointer position.
  useLayoutEffect(() => {
    if (!selectionContextMenu) return;
    const menu = contextMenuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const next = clampDiffSelectionContextMenuPosition(
      selectionContextMenu.x,
      selectionContextMenu.y,
      rect.width,
      rect.height,
    );
    if (next.left !== selectionContextMenu.x || next.top !== selectionContextMenu.y) {
      setSelectionContextMenu({ ...selectionContextMenu, x: next.left, y: next.top });
    }
  }, [selectionContextMenu]);

  const copySelectedTextLabel = locale === "en-US" ? "Copy selected text" : "复制选中文本";

  return (
    <fieldset
      ref={(node) => {
        rootRef.current = node;
      }}
      aria-label={title}
      className="git-review-diff-selectable m-0 flex min-h-0 min-w-0 flex-1 select-none flex-col overflow-hidden border-0 p-0"
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
          id={diffScrollViewportId}
          ref={(node) => {
            scrollViewportRef.current = node;
          }}
          className={cn(
            GIT_REVIEW_TRANSIENT_SCROLLBAR_CLASS,
            "git-review-diff-selectable-content min-h-0 flex-1 select-text overflow-auto",
          )}
          onScroll={handleOverlayScroll}
        >
          {patchChunks.map((item) => (
            <DiffChunkView key={item.key} item={item} isDark={isDark} />
          ))}
        </div>
      ) : null}
      {!error && !showLoadingState && diff?.patch.trim() && patchChunks.length === 0 ? (
        <pre
          id={diffScrollViewportId}
          ref={(node) => {
            scrollViewportRef.current = node;
          }}
          className={cn(
            GIT_REVIEW_TRANSIENT_SCROLLBAR_CLASS,
            "git-review-diff-selectable-content min-h-0 flex-1 select-text overflow-auto px-3 py-3 text-[calc(11px*var(--zone-font-scale,1))] leading-relaxed text-muted-foreground",
          )}
          onScroll={handleOverlayScroll}
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
        <div className="shrink-0 border-t border-border/70 px-3 py-2 text-[calc(11px*var(--zone-font-scale,1))] text-amber-600 dark:text-amber-300">
          {t("projectTools.gitReview.diffOutputTruncated")}
        </div>
      ) : null}
      {diffHorizontalScrollbar.visible ? (
        <div className="shrink-0 border-t border-border/70 bg-background/80 px-2 py-0.5">
          <div
            ref={diffHorizontalScrollbarTrackRef}
            role="scrollbar"
            aria-label={locale === "en-US" ? "Horizontal diff scrollbar" : "diff 横向滚动条"}
            aria-controls={diffScrollViewportId}
            aria-orientation="horizontal"
            aria-valuemin={0}
            aria-valuemax={Math.round(diffHorizontalScrollbar.maxScrollLeft)}
            aria-valuenow={Math.round(diffHorizontalScrollbar.scrollLeft)}
            tabIndex={0}
            className="relative h-1.5 overflow-hidden rounded-full bg-muted/35"
            onPointerDown={handleDiffHorizontalScrollbarPointerDown}
          >
            <div
              className="git-review-diff-horizontal-scrollbar-thumb absolute left-0 top-0 h-full rounded-full bg-muted-foreground/35 shadow-sm transition-colors hover:bg-muted-foreground/55"
              style={{
                width: `${diffHorizontalScrollbar.thumbWidth}px`,
                transform: `translateX(${diffHorizontalScrollbar.thumbLeft}px)`,
              }}
            />
          </div>
        </div>
      ) : null}
      {selectionContextMenu
        ? createPortal(
            <div
              ref={contextMenuRef}
              role="menu"
              className="editor-context-menu fixed z-[120] w-max min-w-[9.5rem] max-w-[calc(100vw-1.5rem)] select-none overflow-hidden rounded-xl border border-border/60 bg-popover/80 p-1 text-popover-foreground shadow-2xl ring-1 ring-black/[0.03] backdrop-blur-xl dark:ring-white/[0.06]"
              style={{
                left: selectionContextMenu.x,
                top: selectionContextMenu.y,
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[calc(13px*var(--zone-font-scale,1))] text-foreground/90 transition-colors hover:bg-accent hover:text-accent-foreground"
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
    </fieldset>
  );
}

export function DiffReviewCard(props: {
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
            <div className="truncate text-[calc(11px*var(--zone-font-scale,1))] text-muted-foreground">
              {activeDiff.baseRef} → {activeDiff.headRef}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {diffLoading ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin text-muted-foreground" />
          ) : null}
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

function clampDiffSelectionContextMenuPosition(
  x: number,
  y: number,
  menuWidth: number,
  menuHeight: number,
) {
  const maxLeft = Math.max(
    DIFF_SELECTION_CONTEXT_MENU_MARGIN,
    window.innerWidth - menuWidth - DIFF_SELECTION_CONTEXT_MENU_MARGIN,
  );
  const maxTop = Math.max(
    DIFF_SELECTION_CONTEXT_MENU_MARGIN,
    window.innerHeight - menuHeight - DIFF_SELECTION_CONTEXT_MENU_MARGIN,
  );

  return {
    left: Math.min(Math.max(DIFF_SELECTION_CONTEXT_MENU_MARGIN, x), maxLeft),
    top: Math.min(Math.max(DIFF_SELECTION_CONTEXT_MENU_MARGIN, y), maxTop),
  };
}
