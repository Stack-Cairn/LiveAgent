import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const workbench = loader.loadModule("@liveagent/ui/lib/workbench/index.ts");

const {
  applyWorkbenchCommand,
  clampRatioToMinSize,
  computeWorkbenchGeometry,
  createEmptyWorkbenchLayout,
  decodeWorkbenchLayout,
  encodeWorkbenchLayout,
  findAdjacentPaneId,
  hitTestWorkbenchDrop,
  previewRectForDropTarget,
  WORKBENCH_LAYOUT_SCHEMA_VERSION,
} = workbench;

let splitCounter = 0;
const reducerOptions = { createSplitId: () => `split-${++splitCounter}` };

function pane(paneId, conversationId, projectId = "project-main") {
  return {
    paneId,
    surface: {
      kind: "conversation",
      conversationId,
      project: { projectId, projectPathKey: `/workspace/${projectId}` },
    },
    view: {},
  };
}

function apply(layout, command) {
  return applyWorkbenchCommand(
    layout,
    { expectedRevision: layout.revision, ...command },
    reducerOptions,
  );
}

function mustApply(layout, command) {
  const result = apply(layout, command);
  assert.equal(result.ok, true, `command ${command.type} failed: ${JSON.stringify(result)}`);
  return result.layout;
}

function openRoot(conversationId = "conversation-a", paneId = "pane-a") {
  return mustApply(createEmptyWorkbenchLayout(), {
    type: "OPEN_PANE",
    pane: pane(paneId, conversationId),
    target: { kind: "canvas-empty" },
  });
}

function leafIds(node) {
  if (!node) return [];
  if (node.type === "leaf") return [node.paneId];
  return [...leafIds(node.first), ...leafIds(node.second)];
}

const CANVAS = { left: 0, top: 0, width: 1200, height: 800 };

test("root open creates a focused single-pane layout", () => {
  const layout = openRoot();
  assert.equal(layout.revision, 1);
  assert.deepEqual(layout.root, { type: "leaf", paneId: "pane-a" });
  assert.equal(layout.focusedPaneId, "pane-a");
  assert.ok(layout.panes["pane-a"]);
});

test("open pane splits target pane on all four edges", () => {
  for (const [edge, axis, newFirst] of [
    ["left", "horizontal", true],
    ["right", "horizontal", false],
    ["top", "vertical", true],
    ["bottom", "vertical", false],
  ]) {
    const layout = mustApply(openRoot(), {
      type: "OPEN_PANE",
      pane: pane("pane-b", "conversation-b"),
      target: { kind: "pane-edge", paneId: "pane-a", edge },
    });
    assert.equal(layout.root.type, "split");
    assert.equal(layout.root.axis, axis);
    assert.equal(layout.root.ratio, 0.5);
    const expectedOrder = newFirst ? ["pane-b", "pane-a"] : ["pane-a", "pane-b"];
    assert.deepEqual(leafIds(layout.root), expectedOrder);
    assert.equal(layout.focusedPaneId, "pane-b");
  }
});

test("canvas-edge open performs a root-level split around the whole tree", () => {
  let layout = openRoot();
  layout = mustApply(layout, {
    type: "OPEN_PANE",
    pane: pane("pane-b", "conversation-b"),
    target: { kind: "pane-edge", paneId: "pane-a", edge: "right" },
  });
  const withRootSplit = mustApply(layout, {
    type: "OPEN_PANE",
    pane: pane("pane-c", "conversation-c"),
    target: { kind: "canvas-edge", edge: "bottom" },
  });
  assert.equal(withRootSplit.root.type, "split");
  assert.equal(withRootSplit.root.axis, "vertical");
  assert.deepEqual(leafIds(withRootSplit.root), ["pane-a", "pane-b", "pane-c"]);
  assert.equal(withRootSplit.root.second.type, "leaf");
});

test("canvas-edge open on an empty canvas degrades to a root open", () => {
  const layout = mustApply(createEmptyWorkbenchLayout(), {
    type: "OPEN_PANE",
    pane: pane("pane-a", "conversation-a"),
    target: { kind: "canvas-edge", edge: "left" },
  });
  assert.deepEqual(layout.root, { type: "leaf", paneId: "pane-a" });
});

test("duplicate conversation open is rejected without mutation", () => {
  const layout = openRoot();
  const result = apply(layout, {
    type: "OPEN_PANE",
    pane: pane("pane-dup", "conversation-a"),
    target: { kind: "pane-edge", paneId: "pane-a", edge: "right" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "duplicate-conversation");
  assert.equal(result.error.currentRevision, layout.revision);
});

test("stale revision commands are rejected", () => {
  const layout = openRoot();
  const result = applyWorkbenchCommand(
    layout,
    {
      expectedRevision: layout.revision - 1,
      type: "FOCUS_PANE",
      paneId: "pane-a",
    },
    reducerOptions,
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "stale-revision");
});

test("close collapses the parent split and transfers focus to the sibling", () => {
  let layout = openRoot();
  layout = mustApply(layout, {
    type: "OPEN_PANE",
    pane: pane("pane-b", "conversation-b"),
    target: { kind: "pane-edge", paneId: "pane-a", edge: "right" },
  });
  assert.equal(layout.focusedPaneId, "pane-b");
  const closed = mustApply(layout, { type: "CLOSE_PANE", paneId: "pane-b" });
  assert.deepEqual(closed.root, { type: "leaf", paneId: "pane-a" });
  assert.equal(closed.focusedPaneId, "pane-a");
  assert.equal(closed.panes["pane-b"], undefined);
});

test("closing the last pane empties the layout", () => {
  const closed = mustApply(openRoot(), { type: "CLOSE_PANE", paneId: "pane-a" });
  assert.equal(closed.root, null);
  assert.equal(closed.focusedPaneId, null);
  assert.deepEqual(closed.panes, {});
});

test("edge move detaches the pane, then grafts it at the target edge", () => {
  let layout = openRoot();
  layout = mustApply(layout, {
    type: "OPEN_PANE",
    pane: pane("pane-b", "conversation-b"),
    target: { kind: "pane-edge", paneId: "pane-a", edge: "right" },
  });
  const recordBefore = layout.panes["pane-b"];
  const moved = mustApply(layout, {
    type: "MOVE_PANE",
    paneId: "pane-b",
    target: { kind: "pane-edge", paneId: "pane-a", edge: "top" },
  });
  assert.equal(moved.root.axis, "vertical");
  assert.deepEqual(leafIds(moved.root), ["pane-b", "pane-a"]);
  assert.equal(moved.panes["pane-b"], recordBefore, "move must not recreate the pane record");
  assert.equal(moved.focusedPaneId, "pane-b");
});

test("moving a pane onto its own edge or center is rejected", () => {
  const layout = openRoot();
  for (const target of [
    { kind: "pane-edge", paneId: "pane-a", edge: "left" },
    { kind: "pane-center", paneId: "pane-a" },
  ]) {
    const result = apply(layout, { type: "MOVE_PANE", paneId: "pane-a", target });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "target-not-found");
  }
});

test("move to a divider that collapsed with the detach is safely rejected", () => {
  let layout = openRoot();
  layout = mustApply(layout, {
    type: "OPEN_PANE",
    pane: pane("pane-b", "conversation-b"),
    target: { kind: "pane-edge", paneId: "pane-a", edge: "right" },
  });
  const rootSplitId = layout.root.splitId;
  const result = apply(layout, {
    type: "MOVE_PANE",
    paneId: "pane-b",
    target: { kind: "divider", splitId: rootSplitId, edge: "left" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "target-not-found");
});

test("pane-center move swaps the two panes in place", () => {
  let layout = openRoot();
  layout = mustApply(layout, {
    type: "OPEN_PANE",
    pane: pane("pane-b", "conversation-b"),
    target: { kind: "pane-edge", paneId: "pane-a", edge: "right" },
  });
  const swapped = mustApply(layout, {
    type: "MOVE_PANE",
    paneId: "pane-a",
    target: { kind: "pane-center", paneId: "pane-b" },
  });
  assert.deepEqual(leafIds(swapped.root), ["pane-b", "pane-a"]);
  assert.equal(swapped.root.splitId, layout.root.splitId, "swap keeps the split node");
});

test("SWAP_PANES exchanges leaf positions and keeps focus valid", () => {
  let layout = openRoot();
  layout = mustApply(layout, {
    type: "OPEN_PANE",
    pane: pane("pane-b", "conversation-b"),
    target: { kind: "pane-edge", paneId: "pane-a", edge: "bottom" },
  });
  const swapped = mustApply(layout, {
    type: "SWAP_PANES",
    firstPaneId: "pane-a",
    secondPaneId: "pane-b",
  });
  assert.deepEqual(leafIds(swapped.root), ["pane-b", "pane-a"]);
  assert.equal(swapped.focusedPaneId, "pane-b");
});

test("divider insert places the new pane between the split children", () => {
  let layout = openRoot();
  layout = mustApply(layout, {
    type: "OPEN_PANE",
    pane: pane("pane-b", "conversation-b"),
    target: { kind: "pane-edge", paneId: "pane-a", edge: "right" },
  });
  const splitId = layout.root.splitId;

  const beforeSide = mustApply(layout, {
    type: "OPEN_PANE",
    pane: pane("pane-c", "conversation-c"),
    target: { kind: "divider", splitId, edge: "left" },
  });
  assert.deepEqual(leafIds(beforeSide.root), ["pane-a", "pane-c", "pane-b"]);

  const afterSide = mustApply(layout, {
    type: "OPEN_PANE",
    pane: pane("pane-c", "conversation-c"),
    target: { kind: "divider", splitId, edge: "right" },
  });
  assert.deepEqual(leafIds(afterSide.root), ["pane-a", "pane-c", "pane-b"]);
});

test("resize clamps the ratio and equalize restores 0.5", () => {
  let layout = openRoot();
  layout = mustApply(layout, {
    type: "OPEN_PANE",
    pane: pane("pane-b", "conversation-b"),
    target: { kind: "pane-edge", paneId: "pane-a", edge: "right" },
  });
  const splitId = layout.root.splitId;
  const resized = mustApply(layout, { type: "RESIZE_SPLIT", splitId, ratio: 0.001 });
  assert.equal(resized.root.ratio, 0.05);
  const oversized = mustApply(resized, { type: "RESIZE_SPLIT", splitId, ratio: 4 });
  assert.equal(oversized.root.ratio, 0.95);
  const equalized = mustApply(oversized, { type: "EQUALIZE_SPLIT", splitId });
  assert.equal(equalized.root.ratio, 0.5);
});

test("focus command validates the pane and no-ops when already focused", () => {
  let layout = openRoot();
  layout = mustApply(layout, {
    type: "OPEN_PANE",
    pane: pane("pane-b", "conversation-b"),
    target: { kind: "pane-edge", paneId: "pane-a", edge: "right" },
  });
  const focused = mustApply(layout, { type: "FOCUS_PANE", paneId: "pane-a" });
  assert.equal(focused.focusedPaneId, "pane-a");
  const noop = mustApply(focused, { type: "FOCUS_PANE", paneId: "pane-a" });
  assert.equal(noop.revision, focused.revision);
  const missing = apply(focused, { type: "FOCUS_PANE", paneId: "pane-zzz" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "pane-not-found");
});

test("geometry tiles the canvas with integers, no gaps and no overlaps", () => {
  let layout = openRoot();
  layout = mustApply(layout, {
    type: "OPEN_PANE",
    pane: pane("pane-b", "conversation-b"),
    target: { kind: "pane-edge", paneId: "pane-a", edge: "right" },
  });
  layout = mustApply(layout, {
    type: "OPEN_PANE",
    pane: pane("pane-c", "conversation-c"),
    target: { kind: "pane-edge", paneId: "pane-b", edge: "bottom" },
  });
  layout = mustApply(layout, {
    type: "RESIZE_SPLIT",
    splitId: layout.root.splitId,
    ratio: 0.3337,
  });

  const geometry = computeWorkbenchGeometry(layout.root, CANVAS, { dividerSize: 8 });
  assert.equal(geometry.panes.length, 3);
  assert.equal(geometry.dividers.length, 2);

  let area = 0;
  for (const item of [...geometry.panes, ...geometry.dividers]) {
    for (const value of [item.rect.left, item.rect.top, item.rect.width, item.rect.height]) {
      assert.equal(Number.isInteger(value), true, "geometry must be integer pixels");
    }
    area += item.rect.width * item.rect.height;
  }
  assert.equal(area, CANVAS.width * CANVAS.height, "panes + dividers must tile the canvas");

  for (let i = 0; i < geometry.panes.length; i += 1) {
    for (let j = i + 1; j < geometry.panes.length; j += 1) {
      const a = geometry.panes[i].rect;
      const b = geometry.panes[j].rect;
      const overlaps =
        a.left < b.left + b.width &&
        b.left < a.left + a.width &&
        a.top < b.top + b.height &&
        b.top < a.top + a.height;
      assert.equal(overlaps, false, "pane rects must not overlap");
    }
  }
});

test("hit testing priority is canvas-edge > divider > pane-edge > pane-center", () => {
  let layout = openRoot();
  layout = mustApply(layout, {
    type: "OPEN_PANE",
    pane: pane("pane-b", "conversation-b"),
    target: { kind: "pane-edge", paneId: "pane-a", edge: "right" },
  });
  const geometry = computeWorkbenchGeometry(layout.root, CANVAS, { dividerSize: 8 });
  const dividerX = geometry.dividers[0].rect.left + 4;

  assert.deepEqual(hitTestWorkbenchDrop(geometry, 4, 400), { kind: "canvas-edge", edge: "left" });
  assert.deepEqual(hitTestWorkbenchDrop(geometry, dividerX, 8), { kind: "canvas-edge", edge: "top" });
  assert.equal(hitTestWorkbenchDrop(geometry, dividerX, 400).kind, "divider");
  assert.deepEqual(hitTestWorkbenchDrop(geometry, 80, 400), {
    kind: "pane-edge",
    paneId: "pane-a",
    edge: "left",
  });
  assert.deepEqual(hitTestWorkbenchDrop(geometry, geometry.panes[0].rect.width / 2, 400), {
    kind: "pane-center",
    paneId: "pane-a",
  });
  assert.equal(hitTestWorkbenchDrop(geometry, -10, 400), null);
});

test("hit testing an empty canvas returns canvas-empty", () => {
  const geometry = computeWorkbenchGeometry(null, CANVAS);
  assert.deepEqual(hitTestWorkbenchDrop(geometry, 600, 400), { kind: "canvas-empty" });
});

test("drop preview rects mirror the 0.5-ratio insertion result", () => {
  let layout = openRoot();
  layout = mustApply(layout, {
    type: "OPEN_PANE",
    pane: pane("pane-b", "conversation-b"),
    target: { kind: "pane-edge", paneId: "pane-a", edge: "right" },
  });
  const geometry = computeWorkbenchGeometry(layout.root, CANVAS, { dividerSize: 8 });

  const canvasPreview = previewRectForDropTarget(geometry, { kind: "canvas-edge", edge: "right" });
  assert.equal(canvasPreview.left, CANVAS.width - Math.floor(CANVAS.width / 2));
  assert.equal(canvasPreview.width, Math.floor(CANVAS.width / 2));

  const paneA = geometry.panes.find((item) => item.paneId === "pane-a");
  const panePreview = previewRectForDropTarget(geometry, {
    kind: "pane-edge",
    paneId: "pane-a",
    edge: "bottom",
  });
  assert.equal(panePreview.height, Math.floor(paneA.rect.height / 2));
  assert.equal(panePreview.top + panePreview.height, paneA.rect.top + paneA.rect.height);

  const divider = geometry.dividers[0];
  const dividerPreview = previewRectForDropTarget(geometry, {
    kind: "divider",
    splitId: divider.splitId,
    edge: "left",
  });
  assert.equal(dividerPreview.left + dividerPreview.width, divider.rect.left);
});

test("keyboard adjacency picks the nearest pane with perpendicular overlap", () => {
  let layout = openRoot();
  layout = mustApply(layout, {
    type: "OPEN_PANE",
    pane: pane("pane-b", "conversation-b"),
    target: { kind: "pane-edge", paneId: "pane-a", edge: "right" },
  });
  layout = mustApply(layout, {
    type: "OPEN_PANE",
    pane: pane("pane-c", "conversation-c"),
    target: { kind: "pane-edge", paneId: "pane-b", edge: "bottom" },
  });
  const geometry = computeWorkbenchGeometry(layout.root, CANVAS, { dividerSize: 8 });

  assert.equal(findAdjacentPaneId(geometry, "pane-a", "right"), "pane-b");
  assert.equal(findAdjacentPaneId(geometry, "pane-b", "bottom"), "pane-c");
  assert.equal(findAdjacentPaneId(geometry, "pane-c", "left"), "pane-a");
  assert.equal(findAdjacentPaneId(geometry, "pane-a", "left"), null);
});

test("ratio min-size clamping keeps both sides above the pane minimum", () => {
  const splitArea = { left: 0, top: 0, width: 1008, height: 600 };
  const clamped = clampRatioToMinSize({
    ratio: 0.05,
    axis: "horizontal",
    splitArea,
    minSize: 320,
    dividerSize: 8,
  });
  assert.equal(clamped, 0.32);
  const tiny = clampRatioToMinSize({
    ratio: 0.9,
    axis: "horizontal",
    splitArea: { left: 0, top: 0, width: 400, height: 600 },
    minSize: 320,
    dividerSize: 8,
  });
  assert.equal(tiny, 0.5, "regions too small for both minimums equalize instead");
});

test("codec round-trips a valid layout without repairs", () => {
  let layout = openRoot();
  layout = mustApply(layout, {
    type: "OPEN_PANE",
    pane: pane("pane-b", "conversation-b", "project-second"),
    target: { kind: "pane-edge", paneId: "pane-a", edge: "right" },
  });
  const decoded = decodeWorkbenchLayout(encodeWorkbenchLayout(layout));
  assert.equal(decoded.ok, true);
  assert.equal(decoded.repaired, false);
  assert.deepEqual(decoded.layout, layout);
});

test("codec rejects corrupted JSON and unsupported schema versions", () => {
  assert.deepEqual(decodeWorkbenchLayout("{not json"), { ok: false, reason: "corrupted-json" });
  assert.deepEqual(decodeWorkbenchLayout('"a string"'), { ok: false, reason: "corrupted-json" });
  const future = JSON.stringify({
    schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION + 1,
    revision: 0,
    root: null,
    panes: {},
    focusedPaneId: null,
  });
  assert.deepEqual(decodeWorkbenchLayout(future), { ok: false, reason: "unsupported-schema" });
});

test("codec repairs leaves without records and collapses their splits", () => {
  let layout = openRoot();
  layout = mustApply(layout, {
    type: "OPEN_PANE",
    pane: pane("pane-b", "conversation-b"),
    target: { kind: "pane-edge", paneId: "pane-a", edge: "right" },
  });
  const damaged = JSON.parse(encodeWorkbenchLayout(layout));
  delete damaged.panes["pane-b"];
  const decoded = decodeWorkbenchLayout(JSON.stringify(damaged));
  assert.equal(decoded.ok, true);
  assert.equal(decoded.repaired, true);
  assert.deepEqual(decoded.layout.root, { type: "leaf", paneId: "pane-a" });
  assert.equal(decoded.layout.focusedPaneId, "pane-a");
});

test("codec repairs duplicate pane references and invalid focus", () => {
  const payload = JSON.stringify({
    schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION,
    revision: 5,
    root: {
      type: "split",
      splitId: "split-x",
      axis: "horizontal",
      ratio: 7,
      first: { type: "leaf", paneId: "pane-a" },
      second: { type: "leaf", paneId: "pane-a" },
    },
    panes: { "pane-a": pane("pane-a", "conversation-a") },
    focusedPaneId: "pane-missing",
  });
  const decoded = decodeWorkbenchLayout(payload);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.repaired, true);
  assert.deepEqual(decoded.layout.root, { type: "leaf", paneId: "pane-a" });
  assert.equal(decoded.layout.focusedPaneId, "pane-a");
  assert.equal(decoded.layout.revision, 5);
});

test("codec repairs a fully invalid tree into an empty layout", () => {
  const payload = JSON.stringify({
    schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION,
    revision: 2,
    root: { type: "leaf", paneId: "pane-ghost" },
    panes: {},
    focusedPaneId: "pane-ghost",
  });
  const decoded = decodeWorkbenchLayout(payload);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.repaired, true);
  assert.equal(decoded.layout.root, null);
  assert.equal(decoded.layout.focusedPaneId, null);
});
