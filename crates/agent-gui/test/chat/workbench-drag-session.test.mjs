import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const machine = loader.loadModule("src/pages/chat/workbench/workbenchDragMachine.ts");

const {
  canSplitRectAtEdge,
  canvasAllowsPointerSplit,
  dragSessionReducer,
  dragStateFor,
  DRAG_THRESHOLD_PX,
  exceedsDragThreshold,
  IDLE_DRAG_SESSION,
  resolveWorkbenchDropTarget,
} = machine;

const PROJECT = { projectId: "project-main", projectPathKey: "/workspace/main" };

function rect(left, top, width, height) {
  return { left, top, width, height };
}

/** A layout whose panes hold conversation surfaces, keyed by pane id. */
function layoutWith(panes) {
  return {
    schemaVersion: 1,
    revision: 7,
    root: null,
    panes: Object.fromEntries(
      Object.entries(panes).map(([paneId, conversationId]) => [
        paneId,
        {
          paneId,
          surface: { kind: "conversation", conversationId, project: PROJECT },
          view: {},
        },
      ]),
    ),
    focusedPaneId: null,
  };
}

const EMPTY_LAYOUT = layoutWith({});

function geometry({ canvas, panes = [], dividers = [] }) {
  return { canvas, panes, dividers };
}

function conversationPayload(conversationId = "conversation-a") {
  return { kind: "conversation", conversationId, project: PROJECT, title: conversationId };
}

function panePayload(paneId = "pane-a", conversationId = "conversation-a") {
  return {
    kind: "pane",
    paneId,
    surfaceKey: `conversation:${conversationId}`,
    title: conversationId,
  };
}

// A canvas wide enough that both split axes clear the conversation minimums:
// width (1000-6)/2 = 497 >= 320, height (800-6)/2 = 397 >= 220.
const WIDE_CANVAS = rect(0, 0, 1000, 800);

test("drag threshold arms below 6px and activates at exactly 6px", () => {
  assert.equal(DRAG_THRESHOLD_PX, 6);
  const start = { x: 100, y: 100 };
  assert.equal(exceedsDragThreshold(start, { x: 105.9, y: 100 }), false);
  assert.equal(exceedsDragThreshold(start, { x: 100, y: 105.9 }), false);
  assert.equal(exceedsDragThreshold(start, { x: 106, y: 100 }), true);
  assert.equal(exceedsDragThreshold(start, { x: 100, y: 94 }), true);
  // Radial, not per-axis: 4/4 is only 5.66px away and must not activate.
  assert.equal(exceedsDragThreshold(start, { x: 104, y: 104 }), false);
  assert.equal(exceedsDragThreshold(start, { x: 100, y: 100 }), false);
});

test("canSplitRectAtEdge enforces the conversation hard minimums per axis", () => {
  // Horizontal split needs (width - 6) / 2 >= 320 -> width >= 646.
  assert.equal(canSplitRectAtEdge(rect(0, 0, 646, 800), "right"), true);
  assert.equal(canSplitRectAtEdge(rect(0, 0, 645, 800), "right"), false);
  assert.equal(canSplitRectAtEdge(rect(0, 0, 645, 800), "left"), false);
  // Vertical split needs (height - 6) / 2 >= 220 -> height >= 446.
  assert.equal(canSplitRectAtEdge(rect(0, 0, 1000, 446), "bottom"), true);
  assert.equal(canSplitRectAtEdge(rect(0, 0, 1000, 445), "bottom"), false);
  assert.equal(canSplitRectAtEdge(rect(0, 0, 1000, 445), "top"), false);
});

test("pointer splitting is disabled below the narrow-canvas cutoff", () => {
  assert.equal(canvasAllowsPointerSplit(geometry({ canvas: rect(0, 0, 440, 800) })), true);
  assert.equal(canvasAllowsPointerSplit(geometry({ canvas: rect(0, 0, 439, 800) })), false);
});

test("resolveTarget passes a null hit straight through", () => {
  const geo = geometry({ canvas: WIDE_CANVAS, panes: [{ paneId: "pane-a", rect: WIDE_CANVAS }] });
  assert.equal(
    resolveWorkbenchDropTarget(null, conversationPayload(), geo, EMPTY_LAYOUT),
    null,
  );
});

test("dropping a conversation on its own pane resolves to focus, not a split", () => {
  const geo = geometry({ canvas: WIDE_CANVAS, panes: [{ paneId: "pane-a", rect: WIDE_CANVAS }] });
  const layout = layoutWith({ "pane-a": "conversation-a" });
  assert.deepEqual(
    resolveWorkbenchDropTarget(
      { kind: "pane-center", paneId: "pane-a" },
      conversationPayload("conversation-a"),
      geo,
      layout,
    ),
    { kind: "pane-center", paneId: "pane-a" },
  );
  // An own-pane *edge* hit also collapses to focus rather than self-splitting.
  assert.deepEqual(
    resolveWorkbenchDropTarget(
      { kind: "pane-edge", paneId: "pane-a", edge: "right" },
      panePayload("pane-a", "conversation-a"),
      geo,
      layout,
    ),
    { kind: "pane-center", paneId: "pane-a" },
  );
});

test("sidebar payloads auto-dock on a pane center: right first on wide canvases", () => {
  const geo = geometry({ canvas: WIDE_CANVAS, panes: [{ paneId: "pane-a", rect: WIDE_CANVAS }] });
  assert.deepEqual(
    resolveWorkbenchDropTarget(
      { kind: "pane-center", paneId: "pane-a" },
      conversationPayload("conversation-new"),
      geo,
      EMPTY_LAYOUT,
    ),
    { kind: "pane-edge", paneId: "pane-a", edge: "right" },
  );
});

test("sidebar auto-dock prefers bottom when the canvas is narrower than 680", () => {
  // 679 wide still allows a horizontal split (>= 646), so the bottom-first
  // preference — not a fallback — is what selects the vertical axis.
  const canvas = rect(0, 0, 679, 800);
  const geo = geometry({ canvas, panes: [{ paneId: "pane-a", rect: canvas }] });
  assert.deepEqual(
    resolveWorkbenchDropTarget(
      { kind: "pane-center", paneId: "pane-a" },
      conversationPayload("conversation-new"),
      geo,
      EMPTY_LAYOUT,
    ),
    { kind: "pane-edge", paneId: "pane-a", edge: "bottom" },
  );
  // At 680 the wide preference kicks back in.
  const wide = rect(0, 0, 680, 800);
  assert.deepEqual(
    resolveWorkbenchDropTarget(
      { kind: "pane-center", paneId: "pane-a" },
      conversationPayload("conversation-new"),
      geometry({ canvas: wide, panes: [{ paneId: "pane-a", rect: wide }] }),
      EMPTY_LAYOUT,
    ),
    { kind: "pane-edge", paneId: "pane-a", edge: "right" },
  );
});

test("auto-dock falls back to the other axis, then to no target at all", () => {
  // Too narrow to split horizontally (600 < 646) but tall enough for bottom.
  const narrowPane = rect(0, 0, 600, 800);
  const geo = geometry({
    canvas: rect(0, 0, 900, 800),
    panes: [{ paneId: "pane-a", rect: narrowPane }],
  });
  assert.deepEqual(
    resolveWorkbenchDropTarget(
      { kind: "pane-center", paneId: "pane-a" },
      conversationPayload("conversation-new"),
      geo,
      EMPTY_LAYOUT,
    ),
    { kind: "pane-edge", paneId: "pane-a", edge: "bottom" },
  );
  // Neither axis fits: no preview, nothing to commit.
  const tinyPane = rect(0, 0, 600, 400);
  assert.equal(
    resolveWorkbenchDropTarget(
      { kind: "pane-center", paneId: "pane-a" },
      conversationPayload("conversation-new"),
      geometry({ canvas: rect(0, 0, 900, 800), panes: [{ paneId: "pane-a", rect: tinyPane }] }),
      EMPTY_LAYOUT,
    ),
    null,
  );
});

test("pane payloads keep a foreign pane center as a swap target", () => {
  const geo = geometry({ canvas: WIDE_CANVAS, panes: [{ paneId: "pane-a", rect: WIDE_CANVAS }] });
  assert.deepEqual(
    resolveWorkbenchDropTarget(
      { kind: "pane-center", paneId: "pane-a" },
      panePayload("pane-b", "conversation-b"),
      geo,
      layoutWith({ "pane-a": "conversation-a", "pane-b": "conversation-b" }),
    ),
    { kind: "pane-center", paneId: "pane-a" },
  );
  // An unknown pane id has no rect to auto-dock into.
  assert.equal(
    resolveWorkbenchDropTarget(
      { kind: "pane-center", paneId: "pane-missing" },
      conversationPayload("conversation-new"),
      geo,
      EMPTY_LAYOUT,
    ),
    null,
  );
});

test("pane-edge drops are rejected when either half loses the minimum size", () => {
  const geo = geometry({
    canvas: rect(0, 0, 900, 800),
    panes: [{ paneId: "pane-a", rect: rect(0, 0, 600, 400) }],
  });
  const payload = conversationPayload("conversation-new");
  assert.equal(
    resolveWorkbenchDropTarget({ kind: "pane-edge", paneId: "pane-a", edge: "right" }, payload, geo, EMPTY_LAYOUT),
    null,
  );
  assert.equal(
    resolveWorkbenchDropTarget({ kind: "pane-edge", paneId: "pane-a", edge: "bottom" }, payload, geo, EMPTY_LAYOUT),
    null,
  );
  assert.equal(
    resolveWorkbenchDropTarget({ kind: "pane-edge", paneId: "pane-missing", edge: "right" }, payload, geo, EMPTY_LAYOUT),
    null,
  );
  // Same edge on a pane with room passes through untouched.
  const roomy = geometry({ canvas: WIDE_CANVAS, panes: [{ paneId: "pane-a", rect: WIDE_CANVAS }] });
  assert.deepEqual(
    resolveWorkbenchDropTarget({ kind: "pane-edge", paneId: "pane-a", edge: "right" }, payload, roomy, EMPTY_LAYOUT),
    { kind: "pane-edge", paneId: "pane-a", edge: "right" },
  );
});

test("canvas-edge drops are measured against the canvas rect", () => {
  const payload = conversationPayload("conversation-new");
  const roomy = geometry({ canvas: WIDE_CANVAS });
  assert.deepEqual(
    resolveWorkbenchDropTarget({ kind: "canvas-edge", edge: "left" }, payload, roomy, EMPTY_LAYOUT),
    { kind: "canvas-edge", edge: "left" },
  );
  // 445 tall: (445 - 6) / 2 = 219.5 < 220.
  const shortCanvas = geometry({ canvas: rect(0, 0, 1000, 445) });
  assert.equal(
    resolveWorkbenchDropTarget({ kind: "canvas-edge", edge: "top" }, payload, shortCanvas, EMPTY_LAYOUT),
    null,
  );
  const narrowCanvas = geometry({ canvas: rect(0, 0, 645, 800) });
  assert.equal(
    resolveWorkbenchDropTarget({ kind: "canvas-edge", edge: "right" }, payload, narrowCanvas, EMPTY_LAYOUT),
    null,
  );
});

test("divider drops halve the region on the pointed-at side of a horizontal bar", () => {
  // splitArea 1400 wide, bar at x=700..706: both regions are 700 / 694 wide,
  // so (700 - 6) / 2 = 347 and (694 - 6) / 2 = 344 both clear 320.
  const geo = geometry({
    canvas: rect(0, 0, 1400, 800),
    dividers: [
      {
        splitId: "split-1",
        axis: "horizontal",
        rect: rect(700, 0, 6, 800),
        splitArea: rect(0, 0, 1400, 800),
      },
    ],
  });
  const payload = conversationPayload("conversation-new");
  for (const edge of ["left", "right"]) {
    assert.deepEqual(
      resolveWorkbenchDropTarget({ kind: "divider", splitId: "split-1", edge }, payload, geo, EMPTY_LAYOUT),
      { kind: "divider", splitId: "split-1", edge },
    );
  }
  // An off-centre bar starves the left region: 500 -> (500 - 6) / 2 = 247.
  const lopsided = geometry({
    canvas: rect(0, 0, 1400, 800),
    dividers: [
      {
        splitId: "split-1",
        axis: "horizontal",
        rect: rect(500, 0, 6, 800),
        splitArea: rect(0, 0, 1400, 800),
      },
    ],
  });
  assert.equal(
    resolveWorkbenchDropTarget({ kind: "divider", splitId: "split-1", edge: "left" }, payload, lopsided, EMPTY_LAYOUT),
    null,
  );
  assert.deepEqual(
    resolveWorkbenchDropTarget({ kind: "divider", splitId: "split-1", edge: "right" }, payload, lopsided, EMPTY_LAYOUT),
    { kind: "divider", splitId: "split-1", edge: "right" },
  );
});

test("divider drops on a vertical bar measure the height axis, offset by splitArea", () => {
  // splitArea starts at y=100 so a naive `rect.top` region height would be
  // wrong by 100px; top region is 400 tall -> (400 - 6) / 2 = 197 < 220.
  const geo = geometry({
    canvas: rect(0, 0, 1000, 1100),
    dividers: [
      {
        splitId: "split-v",
        axis: "vertical",
        rect: rect(0, 500, 1000, 6),
        splitArea: rect(0, 100, 1000, 1000),
      },
    ],
  });
  const payload = conversationPayload("conversation-new");
  assert.equal(
    resolveWorkbenchDropTarget({ kind: "divider", splitId: "split-v", edge: "top" }, payload, geo, EMPTY_LAYOUT),
    null,
  );
  // Bottom region: 1100 - 506 = 594 tall -> (594 - 6) / 2 = 294 >= 220.
  assert.deepEqual(
    resolveWorkbenchDropTarget({ kind: "divider", splitId: "split-v", edge: "bottom" }, payload, geo, EMPTY_LAYOUT),
    { kind: "divider", splitId: "split-v", edge: "bottom" },
  );
  // Unknown split id has no region to measure.
  assert.equal(
    resolveWorkbenchDropTarget({ kind: "divider", splitId: "split-gone", edge: "top" }, payload, geo, EMPTY_LAYOUT),
    null,
  );
});

test("canvas-empty accepts new surfaces but never a pane move", () => {
  const geo = geometry({ canvas: WIDE_CANVAS });
  assert.equal(
    resolveWorkbenchDropTarget({ kind: "canvas-empty" }, panePayload("pane-a"), geo, layoutWith({ "pane-a": "conversation-a" })),
    null,
  );
  for (const payload of [
    conversationPayload("conversation-new"),
    { kind: "workspace", projectId: "project-main", projectPath: "/workspace/main", title: "main" },
    { kind: "newTerminal", project: PROJECT, title: "Terminal" },
  ]) {
    assert.deepEqual(
      resolveWorkbenchDropTarget({ kind: "canvas-empty" }, payload, geo, EMPTY_LAYOUT),
      { kind: "canvas-empty" },
      `payload ${payload.kind} should fill an empty canvas`,
    );
  }
});

test("terminal payloads have no own pane and auto-dock like sidebar drags", () => {
  const geo = geometry({ canvas: WIDE_CANVAS, panes: [{ paneId: "pane-a", rect: WIDE_CANVAS }] });
  const layout = layoutWith({ "pane-a": "conversation-a" });
  for (const payload of [
    { kind: "terminalSession", sessionId: "session-1", project: PROJECT, title: "zsh" },
    { kind: "newTerminal", project: PROJECT, title: "Terminal" },
  ]) {
    assert.deepEqual(
      resolveWorkbenchDropTarget({ kind: "pane-center", paneId: "pane-a" }, payload, geo, layout),
      { kind: "pane-edge", paneId: "pane-a", edge: "right" },
      `payload ${payload.kind} should auto-dock instead of overwriting`,
    );
    // Edge hits keep their edge: a terminal never owns the pane it lands on.
    assert.deepEqual(
      resolveWorkbenchDropTarget(
        { kind: "pane-edge", paneId: "pane-a", edge: "left" },
        payload,
        geo,
        layout,
      ),
      { kind: "pane-edge", paneId: "pane-a", edge: "left" },
    );
  }
});

// --- state machine -------------------------------------------------------

const SESSION_GEOMETRY = geometry({
  canvas: WIDE_CANVAS,
  panes: [{ paneId: "pane-a", rect: WIDE_CANVAS }],
});

const ACTIVATION = {
  canvasOrigin: { left: 50, top: 20 },
  geometry: SESSION_GEOMETRY,
  revision: 7,
};

/** Feed a sequence of events, collecting every commit the machine emits. */
function run(events, initial = IDLE_DRAG_SESSION) {
  let state = initial;
  const commits = [];
  for (const event of events) {
    const result = dragSessionReducer(state, event);
    state = result.state;
    if (result.commit) commits.push(result.commit);
  }
  return { state, commits };
}

const ARM = { type: "arm", payload: conversationPayload("conversation-new"), pointerId: 1, clientX: 100, clientY: 100 };
const ACTIVATE = { type: "activate", pointerId: 1, ...ACTIVATION };
// Canvas origin (50, 20) puts this pointer at the pane centre (450, 380).
const MOVE_CENTER = { type: "pointer-move", pointerId: 1, clientX: 500, clientY: 400, layout: EMPTY_LAYOUT };

test("the machine walks idle -> armed -> dragging and previews on move", () => {
  const armed = dragSessionReducer(IDLE_DRAG_SESSION, ARM);
  assert.equal(armed.state.phase, "armed");
  assert.equal(armed.commit, null);
  // No overlay until the threshold is cleared.
  assert.equal(dragStateFor(armed.state), null);

  const dragging = dragSessionReducer(armed.state, ACTIVATE);
  assert.equal(dragging.state.phase, "dragging");
  assert.equal(dragging.state.revision, 7);
  assert.equal(dragStateFor(dragging.state), null);

  const moved = dragSessionReducer(dragging.state, MOVE_CENTER);
  const drag = dragStateFor(moved.state);
  assert.deepEqual(drag.pointer, { x: 500, y: 400 });
  assert.deepEqual(drag.target, { kind: "pane-edge", paneId: "pane-a", edge: "right" });
  assert.ok(drag.previewRect, "an accepted target must render a preview rect");
  assert.equal(moved.commit, null);
});

test("Escape and pointer-cancel return to idle without committing", () => {
  for (const label of ["escape", "pointercancel", "blur"]) {
    const { state, commits } = run([ARM, ACTIVATE, MOVE_CENTER, { type: "cancel" }]);
    assert.equal(state.phase, "idle", `${label} must land in idle`);
    assert.equal(dragStateFor(state), null);
    assert.deepEqual(commits, []);
  }
  // A cancel mid-gesture also blocks the pointer-up that follows it.
  const { state, commits } = run([
    ARM,
    ACTIVATE,
    MOVE_CENTER,
    { type: "cancel" },
    { type: "pointer-up", pointerId: 1, clientX: 500, clientY: 400, layout: EMPTY_LAYOUT },
  ]);
  assert.equal(state.phase, "idle");
  assert.deepEqual(commits, []);
});

test("pointer-up over a target commits exactly once with the frozen revision", () => {
  const upEvent = { type: "pointer-up", pointerId: 1, clientX: 500, clientY: 400, layout: EMPTY_LAYOUT };
  const { state, commits } = run([ARM, ACTIVATE, MOVE_CENTER, upEvent, upEvent]);
  assert.equal(state.phase, "idle");
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0], {
    payload: ARM.payload,
    target: { kind: "pane-edge", paneId: "pane-a", edge: "right" },
    // Frozen at activation, not read at drop time: the CAS input.
    revision: 7,
  });
});

test("pointer-up without a resolvable target commits nothing", () => {
  // Outside the canvas: the hit test returns null.
  const outside = { type: "pointer-up", pointerId: 1, clientX: 5000, clientY: 5000, layout: EMPTY_LAYOUT };
  const { state, commits } = run([ARM, ACTIVATE, MOVE_CENTER, outside]);
  assert.equal(state.phase, "idle");
  assert.deepEqual(commits, []);

  // Armed but never activated: a plain click, not a drop.
  const armedUp = run([ARM, { type: "pointer-up", pointerId: 1, clientX: 500, clientY: 400, layout: EMPTY_LAYOUT }]);
  assert.equal(armedUp.state.phase, "idle");
  assert.deepEqual(armedUp.commits, []);
});

test("events from a second pointer never disturb a live gesture", () => {
  const armed = dragSessionReducer(IDLE_DRAG_SESSION, ARM).state;
  // A second arm cannot preempt the first.
  const reArmed = dragSessionReducer(armed, { ...ARM, pointerId: 2, clientX: 700 });
  assert.deepEqual(reArmed.state, armed);

  const dragging = dragSessionReducer(armed, ACTIVATE).state;
  const foreignMove = dragSessionReducer(dragging, { ...MOVE_CENTER, pointerId: 2 });
  assert.deepEqual(foreignMove.state, dragging);
  const foreignUp = dragSessionReducer(dragging, {
    type: "pointer-up",
    pointerId: 2,
    clientX: 500,
    clientY: 400,
    layout: EMPTY_LAYOUT,
  });
  assert.deepEqual(foreignUp.state, dragging);
  assert.equal(foreignUp.commit, null);
});

test("moves use the frozen geometry snapshot, not a later layout", () => {
  const dragging = run([ARM, ACTIVATE]).state;
  // Rebasing the layout mid-drag (revision bump, pane now owned) changes the
  // resolution rules but must not change the frozen revision on the commit.
  const ownedLayout = { ...layoutWith({ "pane-a": "conversation-new" }), revision: 99 };
  const moved = dragSessionReducer(dragging, { ...MOVE_CENTER, layout: ownedLayout });
  assert.deepEqual(dragStateFor(moved.state).target, { kind: "pane-center", paneId: "pane-a" });
  const up = dragSessionReducer(moved.state, {
    type: "pointer-up",
    pointerId: 1,
    clientX: 500,
    clientY: 400,
    layout: ownedLayout,
  });
  assert.equal(up.commit.revision, 7);
  assert.deepEqual(up.commit.target, { kind: "pane-center", paneId: "pane-a" });
});
