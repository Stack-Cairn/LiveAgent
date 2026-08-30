import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const env = await createDomTestEnv();
const { React, act, createRoot } = env;
const { useWorkbenchDragSession } = env.loadModule(
  "@liveagent/ui/lib/workbench/useWorkbenchDragSession.ts",
);

const layout = {
  schemaVersion: 1,
  revision: 4,
  root: { type: "leaf", paneId: "pane-a" },
  panes: {
    "pane-a": {
      paneId: "pane-a",
      surface: {
        kind: "conversation",
        conversationId: "conv-a",
        project: { projectId: "project-a", projectPathKey: "/workspace/a" },
      },
      view: {},
    },
  },
  focusedPaneId: "pane-a",
};

const geometry = {
  canvas: { left: 0, top: 0, width: 1_000, height: 800 },
  panes: [{ paneId: "pane-a", rect: { left: 0, top: 0, width: 1_000, height: 800 } }],
  dividers: [],
};

function pointerMove(x, y) {
  const event = new env.dom.window.MouseEvent("pointermove", { clientX: x, clientY: y });
  Object.defineProperty(event, "pointerId", { value: 1 });
  window.dispatchEvent(event);
}

test("workbench pointer moves coalesce per frame and stable targets do not rerender the page", () => {
  let nextFrameId = 1;
  const frames = new Map();
  window.requestAnimationFrame = (callback) => {
    const id = nextFrameId++;
    frames.set(id, callback);
    return id;
  };
  window.cancelAnimationFrame = (id) => frames.delete(id);
  const flushFrame = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  };

  const container = document.createElement("div");
  const canvas = document.createElement("div");
  canvas.dataset.workbenchCanvas = "";
  canvas.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 1_000,
    bottom: 800,
    width: 1_000,
    height: 800,
    x: 0,
    y: 0,
    toJSON() {},
  });
  document.body.append(container, canvas);
  const root = createRoot(container);
  let controller;
  let renderCount = 0;

  function Harness() {
    renderCount += 1;
    controller = useWorkbenchDragSession({
      enabled: true,
      layoutRef: { current: layout },
      geometryRef: { current: geometry },
      onCommit() {},
    });
    return controller.dragState
      ? React.createElement("div", {
          ref: controller.dragGhostRef,
          "data-testid": "ghost",
          style: {
            transform:
              "translate3d(var(--workbench-drag-ghost-x), var(--workbench-drag-ghost-y), 0)",
          },
        })
      : null;
  }

  act(() => root.render(React.createElement(Harness)));
  const source = document.createElement("button");
  document.body.appendChild(source);
  act(() => {
    controller.beginDrag(
      {
        kind: "fileTree",
        project: { projectId: "project-a", projectPathKey: "/workspace/a" },
        title: "File Tree",
      },
      { pointerId: 1, clientX: 100, clientY: 100, currentTarget: source },
    );
  });
  assert.equal(renderCount, 1, "arming a drag does not render an overlay");

  act(() => {
    for (let x = 450; x <= 500; x += 5) pointerMove(x, 400);
  });
  assert.equal(frames.size, 1, "raw pointer events share one animation frame");
  assert.equal(renderCount, 1, "raw pointer events never rerender synchronously");

  act(flushFrame);
  assert.equal(renderCount, 2, "the first resolved target publishes one overlay render");
  const ghost = container.querySelector('[data-testid="ghost"]');
  assert.ok(ghost);
  assert.equal(ghost.style.getPropertyValue("--workbench-drag-ghost-x"), "514px");

  act(() => {
    pointerMove(510, 400);
    pointerMove(520, 400);
  });
  act(flushFrame);
  assert.equal(renderCount, 2, "moving inside the same drop target does not rerender");
  assert.equal(ghost.style.getPropertyValue("--workbench-drag-ghost-x"), "534px");

  act(() => pointerMove(2, 400));
  act(flushFrame);
  assert.equal(renderCount, 3, "crossing into a different target publishes one render");

  act(() => root.unmount());
  source.remove();
  canvas.remove();
  container.remove();
});

test.after(() => env.cleanup());
