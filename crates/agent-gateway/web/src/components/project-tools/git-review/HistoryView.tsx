// GitReview history view: commit graph list (virtualized), commit detail pane
// and the history context menus.
//
// MIRROR NOTICE: every file under components/project-tools/git-review exists
// byte-for-byte in both frontends (crates/agent-gui/src and
// crates/agent-gateway/web/src). Keep changes in sync on both ends; only
// relative or @tauri-apps/* imports are allowed here.

import { useVirtualizer } from "@tanstack/react-virtual";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type MouseEvent as ReactMouseEvent,
  type UIEvent as ReactUIEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocale } from "../../../i18n";
import {
  computeGitGraph,
  GRAPH_COLORS,
  type GraphColor,
  type GraphRow,
} from "../../../lib/git/gitGraph";
import type { GitCommitFile, GitCommitSummary } from "../../../lib/git/types";
import { cn } from "../../../lib/shared/utils";
import { getFileTypeIcon } from "../../chat/fileTypeIcons";
import {
  Cloud,
  Copy,
  ExternalLink,
  Eye,
  GitBranch,
  GitCommitHorizontal,
  History,
  Loader2,
  MessageSquareText,
  RefreshCw,
  Tag,
  Target,
} from "../../icons";
import { useRightDockToolContext } from "../RightDockContext";
import { DiffContent } from "./DiffView";
import {
  basename,
  CHANGE_CONTEXT_MENU_ITEM_CLASS,
  CONTEXT_MENU_CONTAINER_CLASS,
  CONTEXT_MENU_SEPARATOR_CLASS,
  type CommitRefKind,
  clampMenuRectWithinRect,
  commitFileStatusLabel,
  commitFileStatusTone,
  commitHistoryTitle,
  commitMessageText,
  defaultBranchNameForCommit,
  formatCommitDate,
  GIT_REVIEW_SPLIT_GRID_CLASS,
  type GitBranchFromCommitState,
  type GitHistoryRow,
  type GitReviewStackedPane,
  gitFileContextPayload,
  gitHistoryMarkerRef,
  gitHubCommitUrl,
  type HistoryContextMenuState,
  orderedCommitRefTags,
  parentPath,
  writeTextToClipboard,
} from "./model";
import { GitBranchFromCommitModal } from "./Toolbar";
import type { GitReviewData } from "./useGitReviewData";
import { GIT_REVIEW_TRANSIENT_SCROLLBAR_CLASS, useOverlayScrollbar } from "./useOverlayScrollbar";

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

function commitRefChipClass(kind: CommitRefKind, selected: boolean) {
  const baseClass =
    "inline-flex h-5 min-w-0 items-center gap-1 rounded-full border px-1.5 text-[calc(10px*var(--zone-font-scale,1))] font-semibold leading-[14px] shadow-sm ring-1 ring-inset";

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
      return cn(baseClass, "border-border/70 bg-muted/50 text-muted-foreground ring-border/60");
  }
}

function CommitRefTagIcon({ kind, variant }: { kind: CommitRefKind; variant: "list" | "detail" }) {
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
        <span className={cn(commitRefChipClass("ref", selected), "shrink-0 px-1.5 leading-[14px]")}>
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

          if (outputIndex < row.outputLanes.length && lane.id === row.outputLanes[outputIndex].id) {
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
        aria-hidden="true"
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

export function GitReviewHistoryView(props: {
  data: GitReviewData;
  onStackedPaneChange: (pane: GitReviewStackedPane, dir: "forward" | "back") => void;
  panelRef: RefObject<HTMLDivElement | null>;
  stackedDir: "forward" | "back";
  stackedPane: GitReviewStackedPane;
  useSplitReviewLayout: boolean;
  writeDisabled: boolean;
}) {
  const {
    data,
    onStackedPaneChange,
    panelRef,
    stackedDir,
    stackedPane,
    useSplitReviewLayout,
    writeDisabled,
  } = props;
  const {
    busy,
    commitDiff,
    commitDiffLoading,
    compareCommitWithRemote,
    cwd,
    expandedCommitShas,
    gitClient,
    historyCommits,
    historyDiffSubtitle,
    historyDiffTitle,
    historyError,
    historyGraphState,
    historyHasMore,
    historyLoadMoreError,
    historyLoading,
    historyLoadingMore,
    loadCommitDetails,
    loadHistory,
    maybeLoadMoreHistory,
    openCommitDiffData,
    runOperation,
    selectCommitFileData,
    selectCommitRow,
    selectedCommitFilePath,
    selectedCommitSha,
    setHistoryError,
    state,
  } = data;
  const context = useRightDockToolContext();
  const onInsertCommitMention = context.git.onInsertCommitMention;
  const onInsertGitFileMention = context.git.onInsertGitFileMention;
  const { t } = useLocale();
  const operationBusy = busy !== "";

  const [historyContextMenu, setHistoryContextMenu] = useState<HistoryContextMenuState | null>(
    null,
  );
  const [branchFromCommit, setBranchFromCommit] = useState<GitBranchFromCommitState | null>(null);
  const [branchFromCommitName, setBranchFromCommitName] = useState("");
  const [branchFromCommitError, setBranchFromCommitError] = useState("");
  const handleOverlayScroll = useOverlayScrollbar();
  const historyListRef = useRef<HTMLDivElement | null>(null);
  const listPaneRef = useRef<HTMLElement | null>(null);
  const detailPaneRef = useRef<HTMLElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const listPaneVisible = useSplitReviewLayout || stackedPane === "list";

  // Clamp the menu against its measured size after it renders (no hard-coded
  // menu dimensions); useLayoutEffect corrects the position before paint, so
  // an out-of-bounds menu never flashes at the raw pointer spot.
  useLayoutEffect(() => {
    if (!historyContextMenu) return;
    const menu = contextMenuRef.current;
    const panel = panelRef.current;
    if (!menu || !panel) return;
    const { dx, dy } = clampMenuRectWithinRect(
      menu.getBoundingClientRect(),
      panel.getBoundingClientRect(),
      8,
    );
    if (dx !== 0 || dy !== 0) {
      setHistoryContextMenu({
        ...historyContextMenu,
        x: historyContextMenu.x + dx,
        y: historyContextMenu.y + dy,
      });
    }
  }, [historyContextMenu, panelRef]);

  useEffect(() => {
    if (useSplitReviewLayout) return;
    const el = stackedPane === "list" ? listPaneRef.current : detailPaneRef.current;
    if (!el) return;
    const cls =
      stackedDir === "back" ? "git-review-pane-enter-back" : "git-review-pane-enter-forward";
    el.classList.remove("git-review-pane-enter-forward", "git-review-pane-enter-back");
    void el.offsetHeight;
    el.classList.add(cls);
  }, [stackedPane, useSplitReviewLayout, stackedDir]);

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
      ? historyRows.findIndex(
          (row) => row.type === "commit" && row.commit.sha === selectedCommitSha,
        )
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
      onStackedPaneChange("list", "back");
    }
    window.requestAnimationFrame(() => {
      historyVirtualizer.scrollToIndex(currentHistoryItemIndex, { align: "center" });
    });
  }, [currentHistoryItemIndex, historyVirtualizer, onStackedPaneChange, useSplitReviewLayout]);

  useEffect(() => {
    maybeLoadMoreHistory(historyListRef.current, listPaneVisible);
  }, [historyRows.length, listPaneVisible, maybeLoadMoreHistory]);

  const handleHistoryListScroll = useCallback(
    (event: ReactUIEvent<HTMLElement>) => {
      handleOverlayScroll(event);
      maybeLoadMoreHistory(event.currentTarget, listPaneVisible);
    },
    [handleOverlayScroll, listPaneVisible, maybeLoadMoreHistory],
  );

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

  const goDetailPane = useCallback(() => {
    if (!useSplitReviewLayout) {
      onStackedPaneChange("detail", "forward");
    }
  }, [onStackedPaneChange, useSplitReviewLayout]);

  const selectCommitFile = useCallback(
    (commit: GitCommitSummary, file: GitCommitFile) => {
      selectCommitFileData(commit, file);
      goDetailPane();
    },
    [goDetailPane, selectCommitFileData],
  );

  const openHistoryContextMenu = useCallback(
    (
      event: ReactMouseEvent,
      target:
        | { kind: "commit"; commitSha: string }
        | { kind: "file"; commitSha: string; path: string },
    ) => {
      event.preventDefault();
      event.stopPropagation();
      const panelRect = panelRef.current?.getBoundingClientRect();
      // Raw pointer position; the measured-clamp layout effect corrects it.
      const x = panelRect ? event.clientX - panelRect.left : event.clientX;
      const y = panelRect ? event.clientY - panelRect.top : event.clientY;
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
    [panelRef],
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
      openCommitDiffData(commit);
      goDetailPane();
    },
    [goDetailPane, openCommitDiffData, selectCommitFile],
  );

  const openHistoryCommitOnGithub = useCallback(
    (commit: GitCommitSummary) => {
      setHistoryContextMenu(null);
      const url = gitHubCommitUrl(state.remoteUrl, commit.sha);
      if (!url) return;
      void openUrl(url).catch((err) => {
        setHistoryError(err instanceof Error ? err.message : String(err));
      });
    },
    [setHistoryError, state.remoteUrl],
  );

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
    if (data.isBusy()) return;
    setBranchFromCommit(null);
    setBranchFromCommitError("");
  }, [data]);

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
      compareCommitWithRemote(commit);
      goDetailPane();
    },
    [compareCommitWithRemote, cwd, gitClient, goDetailPane],
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
    [loadCommitDetails, onInsertCommitMention, setHistoryError, state.remoteUrl],
  );

  const addHistoryFileToContext = useCallback(
    (commit: GitCommitSummary, file: GitCommitFile) => {
      setHistoryContextMenu(null);
      if (!onInsertGitFileMention) return;
      onInsertGitFileMention(gitFileContextPayload(commit, file, state));
    },
    [onInsertGitFileMention, state],
  );

  return (
    <>
      <GitBranchFromCommitModal
        target={branchFromCommit}
        branchName={branchFromCommitName}
        loading={busy === "create_branch"}
        error={branchFromCommitError}
        onBranchNameChange={setBranchFromCommitName}
        onClose={closeCreateBranchFromCommit}
        onSubmit={confirmCreateBranchFromCommit}
      />
      <div
        key="history"
        className={cn(
          "git-review-tab-enter min-h-0 flex-1 gap-3 overflow-hidden p-3",
          useSplitReviewLayout ? `grid ${GIT_REVIEW_SPLIT_GRID_CLASS}` : "flex flex-col",
        )}
      >
        <aside
          ref={listPaneRef}
          className={cn(
            "min-h-0 flex-col overflow-hidden rounded-lg border border-border/70 bg-background",
            useSplitReviewLayout || stackedPane === "list" ? "flex" : "hidden",
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
              <div
                className="relative"
                style={{ height: `${historyVirtualizer.getTotalSize()}px` }}
              >
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
                          <span className="min-w-0 flex-1 truncate text-[calc(12px*var(--zone-font-scale,1))] font-medium">
                            {label}
                          </span>
                          {refLabel ? (
                            <span className="shrink-0 truncate text-[calc(11px*var(--zone-font-scale,1))] text-muted-foreground">
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
                      row.commit.sha === selectedCommitSha &&
                      row.file.path === selectedCommitFilePath;
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
                          {graphRow ? <GitGraphContinuationCell row={graphRow} /> : null}
                          <TypeIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                          <span className="min-w-0 flex-1 truncate">
                            <span className="font-medium">{fileName}</span>
                            <span className="ml-1 text-[calc(10px*var(--zone-font-scale,1))] text-muted-foreground">
                              {filePath}
                            </span>
                          </span>
                          <span
                            className={cn(
                              "shrink-0 text-[calc(10px*var(--zone-font-scale,1))] font-semibold",
                              commitFileStatusTone(row.file),
                            )}
                          >
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
                        onClick={() => selectCommitRow(commit)}
                      >
                        {graphRow ? <GitGraphSvgCell row={graphRow} /> : null}
                        <span className="min-w-0 flex-1 truncate text-[calc(12px*var(--zone-font-scale,1))] font-medium">
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
          ref={detailPaneRef}
          className={cn(
            "h-full min-h-0 flex-col overflow-hidden",
            useSplitReviewLayout || stackedPane === "detail" ? "flex" : "hidden",
            !useSplitReviewLayout && "flex-1",
          )}
        >
          {selectedCommit ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
              <div className="flex shrink-0 items-start gap-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-xs">
                <GitCommitHorizontal className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div
                    className="truncate font-medium text-foreground"
                    title={commitHistoryTitle(selectedCommit)}
                  >
                    {selectedCommit.subject || selectedCommit.shortSha}
                  </div>
                  <CommitRefTags
                    refs={selectedCommit.refs}
                    selected={false}
                    remoteName={state.remoteName}
                    variant="detail"
                    limit={COMMIT_DETAIL_REF_TAG_LIMIT}
                  />
                  <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-[calc(11px*var(--zone-font-scale,1))] text-muted-foreground">
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
                        className="truncate text-[calc(11px*var(--zone-font-scale,1))] text-muted-foreground"
                        title={
                          historyDiffSubtitle || selectedCommitFile?.path || selectedCommit.sha
                        }
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
      {historyContextMenu &&
      historyContextCommit &&
      (historyContextMenu.kind === "commit" || historyContextFile) ? (
        <div
          ref={contextMenuRef}
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
    </>
  );
}
