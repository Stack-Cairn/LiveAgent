import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { commitTerminalDrop } = loader.loadModule(
  "src/pages/chat/workbench/terminalDropCommit.ts",
);
const { createTerminalPaneBindingStore } = loader.loadModule(
  "src/pages/chat/workbench/terminalPaneBindingStore.ts",
);
const { createTerminalPaneLeaseStore } = loader.loadModule(
  "src/pages/chat/workbench/terminalPaneLeaseStore.ts",
);
const { computeWorkbenchGeometry, hitTestWorkbenchDrop } = loader.loadModule(
  "@liveagent/ui/lib/workbench/index.ts",
);

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

// drop 事务实现已共享给 WebUI:源码断言指向 @liveagent/ui 中的实现。
const terminalDropCommitSource = readSource(
  "../../../agent-ui/src/lib/workbench/terminalDropCommit.ts",
);
const chatPageSource = readSource("../../src/pages/ChatPage.tsx");

const PROJECT = { projectId: "project-1", projectPathKey: "/repo" };

function session(id, overrides = {}) {
  return {
    id,
    projectPathKey: "/repo",
    cwd: "/repo",
    shell: "zsh",
    title: "Build",
    kind: "local",
    cols: 80,
    rows: 24,
    createdAt: 1,
    updatedAt: 1,
    running: true,
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  let surfaceCounter = 0;
  return {
    layout: { panes: {} },
    sessions: [],
    lease: createTerminalPaneLeaseStore(),
    bindings: createTerminalPaneBindingStore({ storage: null }),
    resolveProjectPath: () => "/repo",
    createSurfaceId: () => `surface-${(surfaceCounter += 1)}`,
    authorizeAutoLaunch: () => undefined,
    openTerminalSurface: (surface) => ({ paneId: `pane-for-${surface.surfaceId}` }),
    movePane: () => true,
    focusPane: () => undefined,
    ...overrides,
  };
}

/**
 * Every commit branch of commitTerminalDrop, each paired with the deps that
 * reach it. The drop transaction is a layout mutation only, so this is the
 * complete surface a drop can return to the caller.
 */
function everyCommitResult() {
  const leasedDeps = makeDeps({
    layout: { panes: { "pane-a": { paneId: "pane-a" } } },
    sessions: [session("session-1")],
  });
  leasedDeps.lease.acquire("session-1", "pane-a");
  const focusDeps = makeDeps({
    layout: { panes: { "pane-a": { paneId: "pane-a" } } },
    sessions: [session("session-1")],
  });
  focusDeps.lease.acquire("session-1", "pane-a");
  const dockPayload = {
    kind: "terminalSession",
    sessionId: "session-1",
    project: PROJECT,
    title: "Build",
  };
  const edge = { kind: "pane-edge", paneId: "pane-a", edge: "right" };

  return [
    ["opened (dock session)", commitTerminalDrop(dockPayload, edge, makeDeps({
      sessions: [session("session-1")],
    }))],
    ["opened (new terminal)", commitTerminalDrop(
      { kind: "newTerminal", project: PROJECT, title: "Terminal" },
      edge,
      makeDeps(),
    )],
    ["moved", commitTerminalDrop(dockPayload, { kind: "canvas-edge", edge: "left" }, leasedDeps)],
    ["focused", commitTerminalDrop(dockPayload, { kind: "canvas-empty" }, focusDeps)],
    ["ignored (stale pane-center)", commitTerminalDrop(
      dockPayload,
      { kind: "pane-center", paneId: "pane-a" },
      makeDeps({ sessions: [session("session-1")] }),
    )],
    ["ignored (unknown session)", commitTerminalDrop(
      { kind: "terminalSession", sessionId: "missing", project: PROJECT, title: "Gone" },
      edge,
      makeDeps(),
    )],
    ["ignored (unresolvable project)", commitTerminalDrop(
      { kind: "newTerminal", project: PROJECT, title: "Terminal" },
      edge,
      makeDeps({ resolveProjectPath: () => null }),
    )],
    ["ignored (failed open)", commitTerminalDrop(
      dockPayload,
      edge,
      makeDeps({ sessions: [session("session-1")], openTerminalSurface: () => null }),
    )],
  ];
}

/** TerminalDropResult, exhaustively (terminalDropCommit.ts:37-40). */
const ALLOWED_RESULT_KEYS = {
  moved: ["action", "paneId"],
  focused: ["action", "paneId"],
  opened: ["action", "paneId", "surfaceId"],
  ignored: ["action"],
};

test("no drop commit branch can carry a command-execution field", () => {
  // 7.5: a drop places a pane. It must never be a channel for "and also run
  // this", so the result is asserted positively against the frozen union.
  for (const [label, result] of everyCommitResult()) {
    const allowed = ALLOWED_RESULT_KEYS[result.action];
    assert.ok(allowed, `${label}: unexpected action '${result.action}'`);
    assert.deepEqual(
      Object.keys(result).sort(),
      [...allowed].sort(),
      `${label}: drop result must expose exactly the layout fields`,
    );
    for (const value of Object.values(result)) {
      assert.equal(typeof value, "string", `${label}: drop results carry ids only`);
    }
  }
});

test("the drop commit module names no execution or permission-grant primitive", () => {
  // Source-level assertion: the drop path must not reach for a shell, a Tauri
  // command, or a workspace-permission API even indirectly.
  for (const forbidden of [
    "grant",
    "approveWorkspace",
    "addWorkspaceRoot",
    "invoke(",
    "exec",
    "spawn",
    "child_process",
    "eval(",
  ]) {
    assert.equal(
      terminalDropCommitSource.includes(forbidden),
      false,
      `terminalDropCommit.ts must not reference '${forbidden}'`,
    );
  }
  // A terminal drop reuses a launch spec that already exists; it never widens
  // the caller's reach beyond resolving a project it was handed.
  assert.match(terminalDropCommitSource, /resolveProjectPath\(payload\.project\)/);
});

test("the chat page drop handler grants no new workspace access", () => {
  const handlerStart = chatPageSource.indexOf("const handleWorkbenchDropCommit");
  assert.notEqual(handlerStart, -1, "handleWorkbenchDropCommit must exist in ChatPage");
  const handler = chatPageSource.slice(handlerStart, chatPageSource.indexOf(
    "const { dragState: workbenchDragState",
    handlerStart,
  ));

  for (const forbidden of ["grant", "approveWorkspace", "addWorkspaceRoot", "invoke("]) {
    assert.equal(
      handler.includes(forbidden),
      false,
      `handleWorkbenchDropCommit must not reference '${forbidden}'`,
    );
  }
  // A workspace drop only opens a pane for a project the sidebar already
  // lists, and archived roots are refused rather than re-granted.
  assert.match(handler, /const project = workspaceProjects\.find\(/);
  assert.match(handler, /if \(!project\) return;/);
  assert.match(handler, /archivedWorkspaceProjectPathKeys\.has\(pathKey\)/);
});

const CANVAS = { left: 0, top: 0, width: 1200, height: 800 };

function twoPaneGeometry() {
  return computeWorkbenchGeometry(
    {
      type: "split",
      splitId: "split-root",
      axis: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: "pane-a" },
      second: { type: "leaf", paneId: "pane-b" },
    },
    CANVAS,
    { dividerSize: 8 },
  );
}

function paneRect(geometry, paneId) {
  const pane = geometry.panes.find((item) => item.paneId === paneId);
  assert.ok(pane, `geometry is missing ${paneId}`);
  return pane.rect;
}

function center(rect) {
  return {
    x: rect.left + Math.floor(rect.width / 2),
    y: rect.top + Math.floor(rect.height / 2),
  };
}

test("a file dropped inside a pane is attributed to that pane and no other", () => {
  // 7.5 #1: per-pane file routing is decided purely by geometry, so a drop
  // aimed at conversation A can never be delivered to conversation B.
  const geometry = twoPaneGeometry();
  const rectA = paneRect(geometry, "pane-a");
  const rectB = paneRect(geometry, "pane-b");
  const centerA = center(rectA);
  const centerB = center(rectB);

  assert.deepEqual(hitTestWorkbenchDrop(geometry, centerA.x, centerA.y), {
    kind: "pane-center",
    paneId: "pane-a",
  });
  assert.deepEqual(hitTestWorkbenchDrop(geometry, centerB.x, centerB.y), {
    kind: "pane-center",
    paneId: "pane-b",
  });
  // The two centers are genuinely on opposite sides of the divider.
  assert.ok(centerA.x < rectB.left, "pane-a center must lie left of pane-b");
  assert.ok(centerB.x >= rectB.left, "pane-b center must lie inside pane-b");
});

test("a pane's own rect never resolves to its neighbour, edge bands included", () => {
  const geometry = twoPaneGeometry();
  const rectA = paneRect(geometry, "pane-a");
  const rectB = paneRect(geometry, "pane-b");
  const midY = rectA.top + Math.floor(rectA.height / 2);
  let paneTargets = 0;

  // Sample across each pane's full width. Canvas-edge and divider bands take
  // priority and name no pane; every pane-scoped target that does come back
  // must name the pane the pointer is physically inside — never the sibling.
  for (const [paneId, rect] of [["pane-a", rectA], ["pane-b", rectB]]) {
    for (const fraction of [0, 0.05, 0.25, 0.5, 0.75, 0.95]) {
      const x = rect.left + Math.min(rect.width - 1, Math.floor(rect.width * fraction));
      const target = hitTestWorkbenchDrop(geometry, x, midY);
      assert.ok(target, `${paneId}@${fraction}: expected a target inside the canvas`);
      if (target.kind === "canvas-edge" || target.kind === "divider") continue;
      paneTargets += 1;
      assert.equal(
        target.paneId,
        paneId,
        `${paneId}@${fraction}: hit test attributed the point to '${target.paneId}'`,
      );
    }
  }
  assert.ok(paneTargets >= 8, "the sweep must actually produce pane-scoped targets");
});

test("the band next to a divider resolves to the divider, not the wrong pane", () => {
  // pane-b starts flush against the divider, and the divider's hit padding
  // claims that first column. The safe failure is "divider" (a split target
  // that names no conversation), never pane-a.
  const geometry = twoPaneGeometry();
  const rectB = paneRect(geometry, "pane-b");
  const midY = rectB.top + Math.floor(rectB.height / 2);

  const target = hitTestWorkbenchDrop(geometry, rectB.left, midY);
  assert.equal(target.kind, "divider");
  assert.equal(target.paneId, undefined);
  // One pixel past the padding, attribution is unambiguously pane-b.
  const clear = hitTestWorkbenchDrop(geometry, rectB.left + 5, midY);
  assert.equal(clear.paneId, "pane-b");
});

test("the divider belongs to the split, never to a pane center", () => {
  const geometry = twoPaneGeometry();
  const divider = geometry.dividers[0];
  const midY = divider.rect.top + Math.floor(divider.rect.height / 2);

  for (let offset = 0; offset < divider.rect.width; offset += 1) {
    const target = hitTestWorkbenchDrop(geometry, divider.rect.left + offset, midY);
    assert.equal(target.kind, "divider", `divider+${offset} must not fall through to a pane`);
    assert.equal(target.splitId, "split-root");
    assert.equal(target.paneId, undefined, "a divider target names no pane");
  }
});

test("a point outside the canvas is attributed to no pane at all", () => {
  const geometry = twoPaneGeometry();

  assert.equal(hitTestWorkbenchDrop(geometry, -1, 400), null);
  assert.equal(hitTestWorkbenchDrop(geometry, CANVAS.width, 400), null);
  assert.equal(hitTestWorkbenchDrop(geometry, 600, -1), null);
  assert.equal(hitTestWorkbenchDrop(geometry, 600, CANVAS.height), null);
});
