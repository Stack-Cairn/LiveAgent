import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = fileURLToPath(new URL("../..", import.meta.url));
const requireFromRoot = createRequire(path.join(rootDir, "package.json"));
const jsxRuntime = requireFromRoot("react/jsx-runtime");
const { renderToStaticMarkup } = requireFromRoot("react-dom/server");

const loader = createTsModuleLoader({ rootDir, mocks: { "react/jsx-runtime": jsxRuntime } });
const { useWindowWorkbench } = loader.loadModule("src/pages/chat/workbench/useWindowWorkbench.ts");
const { WORKBENCH_DIVIDER_SIZE, MIN_CONVERSATION_PANE_WIDTH } = loader.loadModule(
  "@liveagent/ui/lib/workbench/index.ts",
);
const { WORKBENCH_CANVAS_DIVIDER_SIZE } = loader.loadModule(
  "@liveagent/ui/components/workbench/WorkbenchCanvas.tsx",
);

const chatPageSource = readFileSync(
  new URL("../../src/pages/ChatPage.tsx", import.meta.url),
  "utf8",
);

const PROJECT = { projectId: "project-root", projectPathKey: "/workspace/root" };

/**
 * Render the hook once and hand back the workbench object it produced. The
 * commands under test are dispatched after the render returns: `dispatch`
 * updates `layoutRef` synchronously and returns the result, so the assertions
 * never depend on a React re-render.
 */
function mountWorkbench({ canvas, dividerSize }) {
  const geometryRef = {
    current: canvas ? { canvas: { left: 0, top: 0, ...canvas }, panes: [], dividers: [] } : null,
  };
  const errors = [];
  let workbench = null;
  function Harness() {
    workbench = useWindowWorkbench({
      enabled: true,
      initialConversationId: "conversation-root",
      initialProject: PROJECT,
      geometryRef,
      dividerSize,
      onCommandError: (error) => errors.push(error),
    });
    return null;
  }
  renderToStaticMarkup(jsxRuntime.jsx(Harness, {}));
  return { workbench, errors, geometryRef };
}

function splitRight(workbench, conversationId = "conversation-b") {
  return workbench.openConversation(
    { conversationId, project: PROJECT },
    { kind: "canvas-edge", edge: "right" },
  );
}

test("a canvas too narrow to halve rejects the split and leaves the layout untouched", () => {
  const { workbench, errors } = mountWorkbench({
    canvas: { width: 600, height: 800 },
    dividerSize: WORKBENCH_CANVAS_DIVIDER_SIZE,
  });
  const before = workbench.layoutRef.current;

  assert.equal(splitRight(workbench), null);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "insufficient-space");

  const after = workbench.layoutRef.current;
  assert.equal(after, before, "a rejected command must not replace the layout object");
  assert.equal(Object.keys(after.panes).length, 1);
  assert.equal(after.revision, before.revision);
});

test("a canvas with room for both halves opens the pane", () => {
  const { workbench, errors } = mountWorkbench({
    canvas: { width: 1200, height: 800 },
    dividerSize: WORKBENCH_CANVAS_DIVIDER_SIZE,
  });

  const opened = splitRight(workbench);
  assert.ok(opened, "a 1200px canvas holds two conversation panes");
  assert.deepEqual(errors, []);
  assert.equal(Object.keys(workbench.layoutRef.current.panes).length, 2);
});

// The canvas draws 6px dividers while the geometry library defaults to 8. At
// exactly 2 * minWidth + 6 the split is feasible only when the caller passes
// the canvas' real divider size, so this pins that ChatPage must not fall
// through to the library default.
test("the canvas divider size is threaded into the feasibility check", () => {
  assert.equal(WORKBENCH_CANVAS_DIVIDER_SIZE, 6);
  assert.equal(WORKBENCH_DIVIDER_SIZE, 8);
  const width = MIN_CONVERSATION_PANE_WIDTH * 2 + WORKBENCH_CANVAS_DIVIDER_SIZE;

  const canvasDivider = mountWorkbench({
    canvas: { width, height: 800 },
    dividerSize: WORKBENCH_CANVAS_DIVIDER_SIZE,
  });
  assert.ok(splitRight(canvasDivider.workbench), "6px dividers leave exactly enough room");

  const libraryDivider = mountWorkbench({ canvas: { width, height: 800 } });
  assert.equal(splitRight(libraryDivider.workbench), null);
  assert.equal(libraryDivider.errors[0].code, "insufficient-space");
});

test("an unmeasured canvas keeps the reducer permissive", () => {
  const { workbench, errors } = mountWorkbench({
    canvas: null,
    dividerSize: WORKBENCH_CANVAS_DIVIDER_SIZE,
  });

  assert.ok(splitRight(workbench), "without geometry there is nothing to judge against");
  assert.deepEqual(errors, []);
});

test("a zero-sized canvas is treated as unmeasured rather than as no room", () => {
  const { workbench, errors } = mountWorkbench({
    canvas: { width: 0, height: 0 },
    dividerSize: WORKBENCH_CANVAS_DIVIDER_SIZE,
  });

  assert.ok(splitRight(workbench), "a canvas that has not laid out yet must not block drops");
  assert.deepEqual(errors, []);
});

test("resizing clamps to the canvas so neither side drops below its minimum", () => {
  const { workbench } = mountWorkbench({
    canvas: { width: 1200, height: 800 },
    dividerSize: WORKBENCH_CANVAS_DIVIDER_SIZE,
  });
  assert.ok(splitRight(workbench));

  const root = workbench.layoutRef.current.root;
  assert.equal(root.type, "split");
  workbench.resizeSplit(root.splitId, 0.95);

  const usable = 1200 - WORKBENCH_CANVAS_DIVIDER_SIZE;
  const upperBound = 1 - MIN_CONVERSATION_PANE_WIDTH / usable;
  assert.equal(workbench.layoutRef.current.root.ratio, upperBound);
  assert.ok(usable * (1 - upperBound) >= MIN_CONVERSATION_PANE_WIDTH);
});

test("ChatPage feeds the workbench its live geometry and the canvas divider size", () => {
  const call = chatPageSource.slice(
    chatPageSource.indexOf("useWindowWorkbench({"),
    chatPageSource.indexOf("useWindowWorkbench({") + 600,
  );
  assert.match(call, /geometryRef: workbenchGeometryRef/);
  assert.match(call, /dividerSize: WORKBENCH_CANVAS_DIVIDER_SIZE/);
  assert.match(call, /onCommandError: handleWorkbenchCommandError/);
  // The rejection has to reach the user, not just the console.
  assert.match(chatPageSource, /error\.code === "insufficient-space"/);
  assert.match(chatPageSource, /addNotify\("error", t\("workbench\.noSpaceForSplit"\)\)/);
});
