import {
  getWorkbenchRevisionError,
  type WorkbenchCommand,
  type WorkbenchCommandContext,
  type WorkbenchCommandError,
  type WorkbenchCommandErrorCode,
  type WorkbenchCommandResult,
  type WorkbenchMoveTarget,
  type WorkbenchOpenTarget,
} from "./commands";
import {
  canSplitRectForMinSizes,
  clampSplitRatio,
  computeWorkbenchGeometry,
  splitRegionForTarget,
  subtreeMinSizeForAxis,
  surfaceMinSizeForAxis,
  WORKBENCH_DIVIDER_SIZE,
} from "./geometry";
import { collectWorkbenchLayoutIssues, findPaneIdBySurfaceKey } from "./invariants";
import {
  type PaneNode,
  type PaneRecord,
  surfaceIdentityKey,
  type WorkbenchAxis,
  type WorkbenchEdge,
  type WorkbenchLayout,
} from "./types";

type SplitIdFactory = () => string;

export type WorkbenchReducerOptions = {
  /** Injectable id factory so tests and resume stay deterministic. */
  createSplitId?: SplitIdFactory;
};

let splitIdCounter = 0;

function defaultCreateSplitId(): string {
  splitIdCounter += 1;
  return `split-${Date.now().toString(36)}-${splitIdCounter.toString(36)}`;
}

function edgeAxis(edge: WorkbenchEdge): WorkbenchAxis {
  return edge === "left" || edge === "right" ? "horizontal" : "vertical";
}

function edgeIsBefore(edge: WorkbenchEdge): boolean {
  return edge === "left" || edge === "top";
}

function commandError(
  code: WorkbenchCommandErrorCode,
  message: string,
  currentRevision: number,
): { ok: false; error: WorkbenchCommandError } {
  return { ok: false, error: { code, message, currentRevision } };
}

function findLeaf(node: PaneNode | null, paneId: string): boolean {
  if (!node) return false;
  if (node.type === "leaf") return node.paneId === paneId;
  return findLeaf(node.first, paneId) || findLeaf(node.second, paneId);
}

function findSplit(
  node: PaneNode | null,
  splitId: string,
): Extract<PaneNode, { type: "split" }> | null {
  if (!node || node.type === "leaf") return null;
  if (node.splitId === splitId) return node;
  return findSplit(node.first, splitId) ?? findSplit(node.second, splitId);
}

/** Remove a leaf; the parent split collapses into its surviving sibling. */
function removeLeaf(node: PaneNode, paneId: string): { node: PaneNode | null; found: boolean } {
  if (node.type === "leaf") {
    return node.paneId === paneId ? { node: null, found: true } : { node, found: false };
  }
  const first = removeLeaf(node.first, paneId);
  if (first.found) {
    return { node: first.node ? { ...node, first: first.node } : node.second, found: true };
  }
  const second = removeLeaf(node.second, paneId);
  if (second.found) {
    return { node: second.node ? { ...node, second: second.node } : node.first, found: true };
  }
  return { node, found: false };
}

/** Replace the leaf `targetPaneId` with a split hosting it plus `subtree`. */
function graftAtLeaf(
  node: PaneNode,
  targetPaneId: string,
  subtree: PaneNode,
  edge: WorkbenchEdge,
  createSplitId: SplitIdFactory,
): PaneNode | null {
  if (node.type === "leaf") {
    if (node.paneId !== targetPaneId) return null;
    const before = edgeIsBefore(edge);
    return {
      type: "split",
      splitId: createSplitId(),
      axis: edgeAxis(edge),
      ratio: 0.5,
      first: before ? subtree : node,
      second: before ? node : subtree,
    };
  }
  const first = graftAtLeaf(node.first, targetPaneId, subtree, edge, createSplitId);
  if (first) return { ...node, first };
  const second = graftAtLeaf(node.second, targetPaneId, subtree, edge, createSplitId);
  if (second) return { ...node, second };
  return null;
}

/** Insert `subtree` at an existing divider, between the split's children. */
function graftAtDivider(
  node: PaneNode,
  splitId: string,
  subtree: PaneNode,
  edge: WorkbenchEdge,
  createSplitId: SplitIdFactory,
): PaneNode | null {
  if (node.type === "leaf") return null;
  if (node.splitId === splitId) {
    const before = edgeIsBefore(edge);
    // "before" groups the inserted pane with the first child, "after" with
    // the second child; either way the pane lands visually at the divider.
    if (before) {
      return {
        ...node,
        first: {
          type: "split",
          splitId: createSplitId(),
          axis: node.axis,
          ratio: 0.5,
          first: node.first,
          second: subtree,
        },
      };
    }
    return {
      ...node,
      second: {
        type: "split",
        splitId: createSplitId(),
        axis: node.axis,
        ratio: 0.5,
        first: subtree,
        second: node.second,
      },
    };
  }
  const first = graftAtDivider(node.first, splitId, subtree, edge, createSplitId);
  if (first) return { ...node, first };
  const second = graftAtDivider(node.second, splitId, subtree, edge, createSplitId);
  if (second) return { ...node, second };
  return null;
}

/** Wrap the whole tree in a root-level split with `subtree` on `edge`. */
function graftAtRoot(
  root: PaneNode | null,
  subtree: PaneNode,
  edge: WorkbenchEdge,
  createSplitId: SplitIdFactory,
): PaneNode {
  if (!root) return subtree;
  const before = edgeIsBefore(edge);
  return {
    type: "split",
    splitId: createSplitId(),
    axis: edgeAxis(edge),
    ratio: 0.5,
    first: before ? subtree : root,
    second: before ? root : subtree,
  };
}

function graftAtTarget(
  root: PaneNode | null,
  subtree: PaneNode,
  target: WorkbenchOpenTarget | Exclude<WorkbenchMoveTarget, { kind: "pane-center" }>,
  createSplitId: SplitIdFactory,
): PaneNode | null {
  switch (target.kind) {
    case "canvas-empty":
      return root === null ? subtree : null;
    case "canvas-edge":
      return graftAtRoot(root, subtree, target.edge, createSplitId);
    case "pane-edge":
      return root ? graftAtLeaf(root, target.paneId, subtree, target.edge, createSplitId) : null;
    case "divider":
      return root
        ? graftAtDivider(root, target.splitId, subtree, target.edge, createSplitId)
        : null;
  }
}

/**
 * Reject a split whose two halves cannot both hold their hard minimum pane
 * sizes: the incoming surface's own minimum on one side, and the minimum of
 * the subtree already occupying the halved region on the other (per-kind, so
 * a terminal pane may fit where a conversation would not).
 *
 * Only runs when the caller supplied pixel `context`; without it the reducer
 * has no geometry to judge against and stays permissive. The target rect is
 * measured against `tree` — for moves that is the tree with the pane already
 * detached, so the rejection matches what the user would actually get.
 */
function insufficientSpaceError(
  tree: PaneNode | null,
  panes: Record<string, PaneRecord>,
  incoming: PaneRecord,
  target: WorkbenchOpenTarget | WorkbenchMoveTarget,
  context: WorkbenchCommandContext | undefined,
  currentRevision: number,
): { ok: false; error: WorkbenchCommandError } | null {
  if (!context) return null;
  if (target.kind === "canvas-empty" || target.kind === "pane-center") return null;
  // An edge drop onto an empty canvas becomes the root pane, never a split.
  if (tree === null) return null;
  const dividerSize = context.dividerSize ?? WORKBENCH_DIVIDER_SIZE;
  const geometry = computeWorkbenchGeometry(
    tree,
    { left: 0, top: 0, width: context.canvasSize.width, height: context.canvasSize.height },
    { dividerSize },
  );
  const region = splitRegionForTarget(geometry, target);
  // A target absent from the geometry is a missing target, not a space
  // failure; the graft below reports it as `target-not-found`.
  if (!region) return null;
  const incomingMin = surfaceMinSizeForAxis(incoming.surface, region.axis);
  const existingMin = existingRegionMinSize(tree, panes, target, region.axis, dividerSize);
  if (
    canSplitRectForMinSizes({
      rect: region.rect,
      axis: region.axis,
      incomingMin,
      existingMin,
      dividerSize,
    })
  ) {
    return null;
  }
  const available = region.axis === "horizontal" ? region.rect.width : region.rect.height;
  return commandError(
    "insufficient-space",
    `Splitting this region ${region.axis === "horizontal" ? "horizontally" : "vertically"} would leave panes under the ${Math.max(incomingMin, existingMin)}px minimum (region is ${available}px).`,
    currentRevision,
  );
}

/**
 * The minimum extent the content already occupying a split target's region
 * needs along `axis`. Canvas-edge splits push the whole tree aside; pane-edge
 * splits push one leaf; divider inserts push the subtree on the chosen side.
 */
function existingRegionMinSize(
  tree: PaneNode,
  panes: Record<string, PaneRecord>,
  target: Exclude<
    WorkbenchOpenTarget | WorkbenchMoveTarget,
    { kind: "canvas-empty" | "pane-center" }
  >,
  axis: WorkbenchAxis,
  dividerSize: number,
): number {
  switch (target.kind) {
    case "canvas-edge":
      return subtreeMinSizeForAxis(tree, panes, axis, dividerSize);
    case "pane-edge": {
      const pane = panes[target.paneId];
      return pane
        ? surfaceMinSizeForAxis(pane.surface, axis)
        : subtreeMinSizeForAxis(tree, panes, axis, dividerSize);
    }
    case "divider": {
      const split = findSplit(tree, target.splitId);
      if (!split) return 0;
      const side = edgeIsBefore(target.edge) ? split.first : split.second;
      return subtreeMinSizeForAxis(side, panes, axis, dividerSize);
    }
  }
}

function swapLeaves(node: PaneNode, firstPaneId: string, secondPaneId: string): PaneNode {
  if (node.type === "leaf") {
    if (node.paneId === firstPaneId) return { ...node, paneId: secondPaneId };
    if (node.paneId === secondPaneId) return { ...node, paneId: firstPaneId };
    return node;
  }
  return {
    ...node,
    first: swapLeaves(node.first, firstPaneId, secondPaneId),
    second: swapLeaves(node.second, firstPaneId, secondPaneId),
  };
}

function firstLeafId(node: PaneNode | null): string | null {
  if (!node) return null;
  if (node.type === "leaf") return node.paneId;
  return firstLeafId(node.first) ?? firstLeafId(node.second);
}

/**
 * The leaf that receives focus after `paneId` closes: the nearest leaf of the
 * collapsed split's sibling subtree, falling back to the first leaf overall.
 */
function focusSuccessor(root: PaneNode, paneId: string): string | null {
  if (root.type === "leaf") return null;
  const locate = (node: PaneNode): string | null => {
    if (node.type === "leaf") return null;
    if (node.first.type === "leaf" && node.first.paneId === paneId) {
      return firstLeafId(node.second);
    }
    if (node.second.type === "leaf" && node.second.paneId === paneId) {
      return firstLeafId(node.first);
    }
    return locate(node.first) ?? locate(node.second);
  };
  return locate(root);
}

function setSplitRatio(node: PaneNode, splitId: string, ratio: number): PaneNode | null {
  if (node.type === "leaf") return null;
  if (node.splitId === splitId) return { ...node, ratio };
  const first = setSplitRatio(node.first, splitId, ratio);
  if (first) return { ...node, first };
  const second = setSplitRatio(node.second, splitId, ratio);
  if (second) return { ...node, second };
  return null;
}

/**
 * Clamp a resize so neither side of the split drops below its subtree's
 * per-kind minimum. Needs pixel `context` to know the split's actual extent;
 * without it (or when the region is too small to honour both minimums, e.g.
 * a tiny window) this falls back to the plain 0.05–0.95 ratio clamp.
 */
function clampResizeRatio(
  layout: WorkbenchLayout,
  split: Extract<PaneNode, { type: "split" }>,
  ratio: number,
  context: WorkbenchCommandContext | undefined,
): number {
  const base = clampSplitRatio(ratio);
  if (!context || !layout.root) return base;
  const dividerSize = context.dividerSize ?? WORKBENCH_DIVIDER_SIZE;
  const geometry = computeWorkbenchGeometry(
    layout.root,
    { left: 0, top: 0, width: context.canvasSize.width, height: context.canvasSize.height },
    { dividerSize },
  );
  const divider = geometry.dividers.find((entry) => entry.splitId === split.splitId);
  if (!divider) return base;
  const usable =
    (split.axis === "horizontal" ? divider.splitArea.width : divider.splitArea.height) -
    dividerSize;
  if (usable <= 0) return base;
  const firstMin = subtreeMinSizeForAxis(split.first, layout.panes, split.axis, dividerSize);
  const secondMin = subtreeMinSizeForAxis(split.second, layout.panes, split.axis, dividerSize);
  if (firstMin + secondMin > usable) return base;
  const lower = firstMin / usable;
  const upper = 1 - secondMin / usable;
  return Math.min(upper, Math.max(lower, base));
}

type PaneRecordIssue = {
  code: WorkbenchCommandErrorCode;
  message: string;
};

function validatePaneRecord(pane: PaneRecord): PaneRecordIssue | null {
  if (!pane.paneId.trim()) {
    return { code: "invalid-layout", message: "Pane records require a stable pane id." };
  }
  const surface = pane.surface;
  switch (surface.kind) {
    case "conversation": {
      if (!surface.conversationId.trim()) {
        return { code: "invalid-layout", message: "Conversation surfaces require an id." };
      }
      if (!surface.project.projectId.trim() || !surface.project.projectPathKey.trim()) {
        return {
          code: "invalid-layout",
          message: "Conversation surfaces require a complete project reference.",
        };
      }
      return null;
    }
    case "fileTree": {
      if (!surface.project.projectId.trim() || !surface.project.projectPathKey.trim()) {
        return {
          code: "invalid-layout",
          message: "File tree surfaces require a complete project reference.",
        };
      }
      return null;
    }
    case "localTerminal":
    case "sshTerminal": {
      if (!surface.surfaceId.trim()) {
        return { code: "invalid-layout", message: "Terminal surfaces require a surface id." };
      }
      if (!surface.launchSpec.cwd.trim()) {
        return {
          code: "invalid-layout",
          message: "Terminal surfaces require a launch working directory.",
        };
      }
      if (!surface.project.projectId.trim() || !surface.project.projectPathKey.trim()) {
        return {
          code: "invalid-layout",
          message: "Terminal surfaces require a complete project reference.",
        };
      }
      return null;
    }
    case "unsupported":
      return { code: "unsupported-surface", message: "Unsupported surface kind." };
  }
}

function commit(layout: WorkbenchLayout, next: WorkbenchLayout): WorkbenchCommandResult {
  const issues = collectWorkbenchLayoutIssues(next);
  if (issues.length > 0) {
    return commandError(
      "invalid-layout",
      issues.map((item) => `${item.path}: ${item.message}`).join("; "),
      layout.revision,
    );
  }
  return { ok: true, layout: next };
}

/**
 * Pure workbench layout reducer. Never mutates the input layout; failures
 * return the current revision and leave the layout untouched.
 */
export function applyWorkbenchCommand(
  layout: WorkbenchLayout,
  command: WorkbenchCommand,
  options?: WorkbenchReducerOptions,
): WorkbenchCommandResult {
  const revisionError = getWorkbenchRevisionError(layout, command.expectedRevision);
  if (revisionError) return { ok: false, error: revisionError };
  const createSplitId = options?.createSplitId ?? defaultCreateSplitId;

  switch (command.type) {
    case "OPEN_PANE": {
      const pane = command.pane;
      const recordIssue = validatePaneRecord(pane);
      if (recordIssue) {
        return commandError(recordIssue.code, recordIssue.message, layout.revision);
      }
      if (layout.panes[pane.paneId]) {
        return commandError(
          "invalid-layout",
          `Pane '${pane.paneId}' already exists.`,
          layout.revision,
        );
      }
      // validatePaneRecord already rejected unsupported surfaces, so every
      // openable surface participates in identity uniqueness.
      const existingPaneId = findPaneIdBySurfaceKey(layout, surfaceIdentityKey(pane.surface));
      if (existingPaneId) {
        if (pane.surface.kind === "conversation") {
          return commandError(
            "duplicate-conversation",
            `Conversation '${pane.surface.conversationId}' is already open in pane '${existingPaneId}'.`,
            layout.revision,
          );
        }
        const surfaceId = surfaceIdentityKey(pane.surface);
        return commandError(
          "duplicate-surface",
          `Surface '${surfaceId}' is already open in pane '${existingPaneId}'.`,
          layout.revision,
        );
      }
      const target: WorkbenchOpenTarget =
        command.target.kind === "canvas-edge" && layout.root === null
          ? { kind: "canvas-empty" }
          : command.target;
      const spaceError = insufficientSpaceError(
        layout.root,
        layout.panes,
        pane,
        target,
        command.context,
        layout.revision,
      );
      if (spaceError) return spaceError;
      const nextRoot = graftAtTarget(
        layout.root,
        { type: "leaf", paneId: pane.paneId },
        target,
        createSplitId,
      );
      if (!nextRoot) {
        return commandError(
          "target-not-found",
          "Open target does not exist in the current layout.",
          layout.revision,
        );
      }
      return commit(layout, {
        ...layout,
        revision: layout.revision + 1,
        root: nextRoot,
        panes: { ...layout.panes, [pane.paneId]: pane },
        focusedPaneId: pane.paneId,
      });
    }

    case "MOVE_PANE": {
      if (!layout.root || !layout.panes[command.paneId]) {
        return commandError(
          "pane-not-found",
          `Pane '${command.paneId}' does not exist.`,
          layout.revision,
        );
      }
      if (command.target.kind === "pane-center") {
        const targetPaneId = command.target.paneId;
        if (targetPaneId === command.paneId) {
          return commandError(
            "target-not-found",
            "A pane cannot swap with itself.",
            layout.revision,
          );
        }
        if (!layout.panes[targetPaneId]) {
          return commandError(
            "target-not-found",
            `Swap target '${targetPaneId}' does not exist.`,
            layout.revision,
          );
        }
        return commit(layout, {
          ...layout,
          revision: layout.revision + 1,
          root: swapLeaves(layout.root, command.paneId, targetPaneId),
          focusedPaneId: command.paneId,
        });
      }
      if (command.target.kind === "pane-edge" && command.target.paneId === command.paneId) {
        return commandError("target-not-found", "A pane cannot dock onto itself.", layout.revision);
      }
      // Edge/divider moves detach the pane first, then graft it back. The
      // target is re-resolved against the detached tree so a divider that
      // collapsed with the removal is a clean rejection, not a stale replay.
      const removal = removeLeaf(layout.root, command.paneId);
      if (!removal.found) {
        return commandError(
          "pane-not-found",
          `Pane '${command.paneId}' is not mounted in the tree.`,
          layout.revision,
        );
      }
      // The space check also measures the detached tree, so freeing the pane's
      // own room is reflected before the split is judged.
      const spaceError = insufficientSpaceError(
        removal.node,
        layout.panes,
        layout.panes[command.paneId],
        command.target,
        command.context,
        layout.revision,
      );
      if (spaceError) return spaceError;
      const nextRoot = graftAtTarget(
        removal.node,
        { type: "leaf", paneId: command.paneId },
        removal.node === null ? { kind: "canvas-empty" } : command.target,
        createSplitId,
      );
      if (!nextRoot) {
        return commandError(
          "target-not-found",
          "Move target no longer exists after detaching the pane.",
          layout.revision,
        );
      }
      return commit(layout, {
        ...layout,
        revision: layout.revision + 1,
        root: nextRoot,
        focusedPaneId: command.paneId,
      });
    }

    case "SWAP_PANES": {
      if (command.firstPaneId === command.secondPaneId) {
        return commandError("target-not-found", "Cannot swap a pane with itself.", layout.revision);
      }
      if (!layout.root || !layout.panes[command.firstPaneId]) {
        return commandError(
          "pane-not-found",
          `Pane '${command.firstPaneId}' does not exist.`,
          layout.revision,
        );
      }
      if (!layout.panes[command.secondPaneId]) {
        return commandError(
          "pane-not-found",
          `Pane '${command.secondPaneId}' does not exist.`,
          layout.revision,
        );
      }
      return commit(layout, {
        ...layout,
        revision: layout.revision + 1,
        root: swapLeaves(layout.root, command.firstPaneId, command.secondPaneId),
      });
    }

    case "CLOSE_PANE": {
      if (!layout.root || !layout.panes[command.paneId]) {
        return commandError(
          "pane-not-found",
          `Pane '${command.paneId}' does not exist.`,
          layout.revision,
        );
      }
      const successor =
        layout.focusedPaneId === command.paneId
          ? focusSuccessor(layout.root, command.paneId)
          : layout.focusedPaneId;
      const removal = removeLeaf(layout.root, command.paneId);
      if (!removal.found) {
        return commandError(
          "pane-not-found",
          `Pane '${command.paneId}' is not mounted in the tree.`,
          layout.revision,
        );
      }
      const nextPanes = { ...layout.panes };
      delete nextPanes[command.paneId];
      const nextRoot = removal.node;
      const nextFocus = nextRoot === null ? null : (successor ?? firstLeafId(nextRoot));
      return commit(layout, {
        ...layout,
        revision: layout.revision + 1,
        root: nextRoot,
        panes: nextRoot === null ? {} : nextPanes,
        focusedPaneId: nextFocus,
      });
    }

    case "RESIZE_SPLIT": {
      if (!Number.isFinite(command.ratio)) {
        return commandError("invalid-layout", "Split ratio must be finite.", layout.revision);
      }
      const split = layout.root ? findSplit(layout.root, command.splitId) : null;
      if (!layout.root || !split) {
        return commandError(
          "target-not-found",
          `Split '${command.splitId}' does not exist.`,
          layout.revision,
        );
      }
      const nextRoot = setSplitRatio(
        layout.root,
        command.splitId,
        clampResizeRatio(layout, split, command.ratio, command.context),
      );
      if (!nextRoot) {
        return commandError(
          "target-not-found",
          `Split '${command.splitId}' does not exist.`,
          layout.revision,
        );
      }
      return commit(layout, { ...layout, revision: layout.revision + 1, root: nextRoot });
    }

    case "EQUALIZE_SPLIT": {
      if (!layout.root || !findSplit(layout.root, command.splitId)) {
        return commandError(
          "target-not-found",
          `Split '${command.splitId}' does not exist.`,
          layout.revision,
        );
      }
      const nextRoot = setSplitRatio(layout.root, command.splitId, 0.5);
      if (!nextRoot) {
        return commandError(
          "target-not-found",
          `Split '${command.splitId}' does not exist.`,
          layout.revision,
        );
      }
      return commit(layout, { ...layout, revision: layout.revision + 1, root: nextRoot });
    }

    case "FOCUS_PANE": {
      if (!layout.root || !layout.panes[command.paneId] || !findLeaf(layout.root, command.paneId)) {
        return commandError(
          "pane-not-found",
          `Pane '${command.paneId}' does not exist.`,
          layout.revision,
        );
      }
      if (layout.focusedPaneId === command.paneId) {
        return { ok: true, layout };
      }
      return commit(layout, {
        ...layout,
        revision: layout.revision + 1,
        focusedPaneId: command.paneId,
      });
    }
  }
}
