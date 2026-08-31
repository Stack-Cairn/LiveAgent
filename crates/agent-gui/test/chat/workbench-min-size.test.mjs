import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const workbench = loader.loadModule("@liveagent/ui/lib/workbench/index.ts");
const dragMachine = loader.loadModule("src/pages/chat/workbench/workbenchDragMachine.ts");

const {
  applyWorkbenchCommand,
  clampRatioToSideMinSizes,
  createEmptyWorkbenchLayout,
  MIN_CONVERSATION_PANE_HEIGHT,
  MIN_CONVERSATION_PANE_WIDTH,
  MIN_FILE_TREE_PANE_HEIGHT,
  MIN_FILE_TREE_PANE_WIDTH,
  MIN_TERMINAL_PANE_HEIGHT,
  MIN_TERMINAL_PANE_WIDTH,
  paneRendersCompact,
  subtreeMinSizeForAxis,
  surfaceMinSize,
  WORKBENCH_COMPACT_PANE_WIDTH,
} = workbench;
const { resolveWorkbenchDropTarget } = dragMachine;

let splitCounter = 0;
const reducerOptions = { createSplitId: () => `min-split-${++splitCounter}` };

function conversationPane(paneId, conversationId) {
  return {
    paneId,
    surface: {
      kind: "conversation",
      conversationId,
      project: { projectId: "project-main", projectPathKey: "/workspace/project-main" },
    },
    view: {},
  };
}

function terminalPane(paneId, surfaceId) {
  return {
    paneId,
    surface: {
      kind: "localTerminal",
      surfaceId,
      project: { projectId: "project-main", projectPathKey: "/workspace/project-main" },
      launchSpec: { cwd: "/workspace/project-main" },
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

function openRoot(pane) {
  return mustApply(createEmptyWorkbenchLayout(), {
    type: "OPEN_PANE",
    pane,
    target: { kind: "canvas-empty" },
  });
}

test("surfaceMinSize resolves per kind", () => {
  assert.deepEqual(surfaceMinSize(conversationPane("p", "c").surface), {
    minWidth: MIN_CONVERSATION_PANE_WIDTH,
    minHeight: MIN_CONVERSATION_PANE_HEIGHT,
  });
  assert.deepEqual(surfaceMinSize(terminalPane("p", "t").surface), {
    minWidth: MIN_TERMINAL_PANE_WIDTH,
    minHeight: MIN_TERMINAL_PANE_HEIGHT,
  });
  assert.deepEqual(
    surfaceMinSize({
      kind: "fileTree",
      project: { projectId: "project-main", projectPathKey: "/workspace/project-main" },
    }),
    { minWidth: MIN_FILE_TREE_PANE_WIDTH, minHeight: MIN_FILE_TREE_PANE_HEIGHT },
  );
  const unsupported = surfaceMinSize({ kind: "unsupported", originalKind: "future", raw: {} });
  assert.ok(unsupported.minWidth < MIN_TERMINAL_PANE_WIDTH);
  assert.ok(unsupported.minHeight < MIN_TERMINAL_PANE_HEIGHT);
});

test("terminal pane splits succeed where a conversation split is rejected", () => {
  // 700px canvas: halving a 346px half again leaves ~169px per side — under
  // the conversation minimum (320) but not the terminal minimum (220)? No:
  // 169 < 220 too. Use a 940px canvas: halves are 466px; halving one leaves
  // 229px per side — legal for a terminal (220), illegal for a conversation.
  const canvas = { canvasSize: { width: 940, height: 500 } };
  let layout = openRoot(conversationPane("pane-a", "conversation-a"));
  layout = mustApply(layout, {
    type: "OPEN_PANE",
    pane: conversationPane("pane-b", "conversation-b"),
    target: { kind: "pane-edge", paneId: "pane-a", edge: "right" },
    context: canvas,
  });

  const conversationRejected = apply(layout, {
    type: "OPEN_PANE",
    pane: conversationPane("pane-c", "conversation-c"),
    target: { kind: "pane-edge", paneId: "pane-b", edge: "right" },
    context: canvas,
  });
  assert.equal(conversationRejected.ok, false);
  assert.equal(conversationRejected.error.code, "insufficient-space");

  const terminalAccepted = apply(layout, {
    type: "OPEN_PANE",
    pane: terminalPane("pane-t", "terminal-1"),
    target: { kind: "pane-edge", paneId: "pane-b", edge: "right" },
    context: canvas,
  });
  assert.equal(terminalAccepted.ok, false, "the displaced conversation still needs 320px");

  // Terminal beside a terminal: both sides only need 220px.
  let termLayout = openRoot(terminalPane("pane-t1", "terminal-1"));
  termLayout = mustApply(termLayout, {
    type: "OPEN_PANE",
    pane: conversationPane("pane-conv", "conversation-a"),
    target: { kind: "pane-edge", paneId: "pane-t1", edge: "left" },
    context: canvas,
  });
  const termBesideTerm = apply(termLayout, {
    type: "OPEN_PANE",
    pane: terminalPane("pane-t2", "terminal-2"),
    target: { kind: "pane-edge", paneId: "pane-t1", edge: "right" },
    context: canvas,
  });
  assert.equal(termBesideTerm.ok, true, JSON.stringify(termBesideTerm));
});

test("subtreeMinSizeForAxis sums same-axis splits and maxes cross-axis splits", () => {
  const panes = {
    "pane-a": conversationPane("pane-a", "conversation-a"),
    "pane-t": terminalPane("pane-t", "terminal-1"),
  };
  const split = (axis, first, second) => ({
    type: "split",
    splitId: "s",
    axis,
    ratio: 0.5,
    first,
    second,
  });
  const leafA = { type: "leaf", paneId: "pane-a" };
  const leafT = { type: "leaf", paneId: "pane-t" };
  const divider = 8;

  assert.equal(subtreeMinSizeForAxis(leafT, panes, "horizontal", divider), MIN_TERMINAL_PANE_WIDTH);
  assert.equal(
    subtreeMinSizeForAxis(split("horizontal", leafA, leafT), panes, "horizontal", divider),
    MIN_CONVERSATION_PANE_WIDTH + divider + MIN_TERMINAL_PANE_WIDTH,
  );
  assert.equal(
    subtreeMinSizeForAxis(split("vertical", leafA, leafT), panes, "horizontal", divider),
    MIN_CONVERSATION_PANE_WIDTH,
  );
  // Unknown pane ids fall back to the strictest (conversation) minimum.
  assert.equal(
    subtreeMinSizeForAxis({ type: "leaf", paneId: "missing" }, panes, "vertical", divider),
    MIN_CONVERSATION_PANE_HEIGHT,
  );
  assert.equal(subtreeMinSizeForAxis(null, panes, "horizontal", divider), 0);
});

test("RESIZE_SPLIT with context clamps to per-side subtree minimums", () => {
  const canvas = { canvasSize: { width: 1000, height: 600 } };
  let layout = openRoot(conversationPane("pane-a", "conversation-a"));
  layout = mustApply(layout, {
    type: "OPEN_PANE",
    pane: terminalPane("pane-t", "terminal-1"),
    target: { kind: "pane-edge", paneId: "pane-a", edge: "right" },
    context: canvas,
  });
  const splitId = layout.root.splitId;
  // usable = 1000 - 8 = 992; conversation side floor = 320/992 ≈ 0.3226,
  // terminal side ceiling = 1 - 220/992 ≈ 0.7782.
  const low = mustApply(layout, { type: "RESIZE_SPLIT", splitId, ratio: 0.1, context: canvas });
  assert.ok(Math.abs(low.root.ratio - 320 / 992) < 1e-9, `ratio ${low.root.ratio}`);
  const high = mustApply(layout, { type: "RESIZE_SPLIT", splitId, ratio: 0.97, context: canvas });
  assert.ok(Math.abs(high.root.ratio - (1 - 220 / 992)) < 1e-9, `ratio ${high.root.ratio}`);
  // Without context the historical permissive clamp applies.
  const permissive = mustApply(layout, { type: "RESIZE_SPLIT", splitId, ratio: 0.1 });
  assert.equal(permissive.root.ratio, 0.1);
  // A window too small for both minimums falls back instead of pinning.
  const tiny = { canvasSize: { width: 300, height: 200 } };
  const fallback = mustApply(layout, { type: "RESIZE_SPLIT", splitId, ratio: 0.2, context: tiny });
  assert.ok(fallback.root.ratio >= 0.05 && fallback.root.ratio <= 0.95);
});

test("clampRatioToSideMinSizes honours asymmetric side minimums", () => {
  const splitArea = { left: 0, top: 0, width: 1008, height: 400 };
  const clamp = (ratio) =>
    clampRatioToSideMinSizes({
      ratio,
      axis: "horizontal",
      splitArea,
      firstMin: 320,
      secondMin: 220,
      dividerSize: 8,
    });
  assert.equal(clamp(0.05), 320 / 1000);
  assert.equal(clamp(0.95), 1 - 220 / 1000);
  assert.equal(clamp(0.5), 0.5);
  // Region too small for both minimums: symmetric fallback keeps resizing.
  const cramped = clampRatioToSideMinSizes({
    ratio: 0.1,
    axis: "horizontal",
    splitArea: { left: 0, top: 0, width: 400, height: 300 },
    firstMin: 320,
    secondMin: 220,
    dividerSize: 8,
  });
  assert.ok(cramped >= 0.05 && cramped <= 0.95);
});

test("paneRendersCompact derives from rect width alone", () => {
  assert.equal(paneRendersCompact(WORKBENCH_COMPACT_PANE_WIDTH - 1), true);
  assert.equal(paneRendersCompact(WORKBENCH_COMPACT_PANE_WIDTH), false);
  assert.equal(paneRendersCompact(WORKBENCH_COMPACT_PANE_WIDTH + 1), false);
  assert.equal(paneRendersCompact(1200), false);
});

test("drop resolution accepts terminal payloads in terminal-tight spots only", () => {
  // Two-pane layout: conversation (left) + terminal (right) on a 940px canvas.
  const canvas = { canvasSize: { width: 940, height: 500 } };
  let layout = openRoot(conversationPane("pane-a", "conversation-a"));
  layout = mustApply(layout, {
    type: "OPEN_PANE",
    pane: terminalPane("pane-t", "terminal-1"),
    target: { kind: "pane-edge", paneId: "pane-a", edge: "right" },
    context: canvas,
  });
  const divider = 6; // WORKBENCH_CANVAS_DIVIDER_SIZE
  const paneWidth = (940 - divider) / 2;
  const geometry = {
    canvas: { left: 0, top: 0, width: 940, height: 500 },
    panes: [
      { paneId: "pane-a", rect: { left: 0, top: 0, width: paneWidth, height: 500 } },
      {
        paneId: "pane-t",
        rect: { left: paneWidth + divider, top: 0, width: paneWidth, height: 500 },
      },
    ],
    dividers: [],
  };
  const targetOnTerminal = { kind: "pane-edge", paneId: "pane-t", edge: "right" };
  const terminalPayload = {
    kind: "newTerminal",
    project: { projectId: "project-main", projectPathKey: "/workspace/project-main" },
    title: "Terminal",
  };
  const conversationPayload = {
    kind: "conversation",
    conversationId: "conversation-x",
    project: { projectId: "project-main", projectPathKey: "/workspace/project-main" },
    title: "Chat",
  };
  // Halving the 467px terminal pane leaves ~230px halves: enough for two
  // terminals (220), not for a conversation (320).
  assert.deepEqual(
    resolveWorkbenchDropTarget(targetOnTerminal, terminalPayload, geometry, layout),
    targetOnTerminal,
  );
  assert.equal(
    resolveWorkbenchDropTarget(targetOnTerminal, conversationPayload, geometry, layout),
    null,
  );
  // Dropping a conversation beside the conversation pane fails too (the
  // displaced conversation also needs 320px), while a terminal drop is
  // rejected because the displaced side is a conversation.
  const targetOnConversation = { kind: "pane-edge", paneId: "pane-a", edge: "left" };
  assert.equal(
    resolveWorkbenchDropTarget(targetOnConversation, terminalPayload, geometry, layout),
    null,
  );
});
