import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// 核心验收「Pane 移动/缩放不重挂 DOM」的 DOM 级验证
// (docs/design/session-workbench-pane-architecture.md §30.2)。
// 此前仅有源码正则保护(PaneSurfaceLayer 按 paneId 排序 + key);本测试用
// jsdom + 真实 react-dom 渲染 PaneSurfaceLayer,以 Object.is 比对节点实例:
// MOVE/RESIZE 后存活 Pane 的内容 DOM 不得重挂(草稿/滚动/流才能存活),
// CLOSE 只移除被关 Pane。

const env = await createDomTestEnv();
const { React, act, createRoot } = env;

const { PaneSurfaceLayer } = env.loadModule(
  "@liveagent/ui/components/workbench/PaneSurfaceLayer.tsx",
);
const { applyWorkbenchCommand } = env.loadModule("@liveagent/ui/lib/workbench/reducer.ts");
const { computeWorkbenchGeometry } = env.loadModule("@liveagent/ui/lib/workbench/geometry.ts");

const CANVAS = { left: 0, top: 0, width: 1200, height: 800 };

function conversationPane(paneId, conversationId) {
  return {
    paneId,
    surface: {
      kind: "conversation",
      conversationId,
      project: { projectId: `p-${conversationId}`, projectPathKey: `/ws/${conversationId}` },
    },
    view: {},
  };
}

/** 两 Pane 左右分屏的起始布局。 */
function twoPaneLayout() {
  return {
    schemaVersion: 1,
    revision: 0,
    root: {
      type: "split",
      splitId: "split-root",
      axis: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: "pane-a" },
      second: { type: "leaf", paneId: "pane-b" },
    },
    panes: {
      "pane-a": conversationPane("pane-a", "conv-a"),
      "pane-b": conversationPane("pane-b", "conv-b"),
    },
    focusedPaneId: "pane-a",
  };
}

function renderLayer(root, layout) {
  const geometry = computeWorkbenchGeometry(layout.root, CANVAS);
  act(() => {
    root.render(
      React.createElement(PaneSurfaceLayer, {
        panes: layout.panes,
        paneGeometries: geometry.panes,
        focusedPaneId: layout.focusedPaneId,
        renderPaneContent: (pane) =>
          React.createElement("div", {
            "data-testid": `content-${pane.paneId}`,
            children: pane.surface.kind === "conversation" ? pane.surface.conversationId : "",
          }),
        getPaneRegionLabel: (pane) => pane.paneId,
      }),
    );
  });
}

function dispatch(layout, command) {
  const result = applyWorkbenchCommand(layout, {
    ...command,
    expectedRevision: layout.revision,
  });
  assert.ok(result.ok, `command ${command.type} must apply: ${JSON.stringify(result)}`);
  return result.layout;
}

function contentNode(container, paneId) {
  return container.querySelector(`[data-testid="content-${paneId}"]`);
}

function frameNode(container, paneId) {
  return container.querySelector(`[data-workbench-pane="${paneId}"]`);
}

test("MOVE_PANE updates rects in place without remounting surviving pane DOM", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  let layout = twoPaneLayout();
  renderLayer(root, layout);

  const contentA = contentNode(container, "pane-a");
  const contentB = contentNode(container, "pane-b");
  const frameA = frameNode(container, "pane-a");
  const frameB = frameNode(container, "pane-b");
  assert.ok(contentA && contentB, "both panes render content");
  const widthBeforeA = frameA.style.width;

  // A 移到 B 的下边缘:水平分屏变为 B 上 / A 下的垂直分屏。
  layout = dispatch(layout, {
    type: "MOVE_PANE",
    paneId: "pane-a",
    target: { kind: "pane-edge", paneId: "pane-b", edge: "bottom" },
  });
  renderLayer(root, layout);

  assert.ok(
    Object.is(contentNode(container, "pane-a"), contentA),
    "pane-a content DOM node must be the same instance after MOVE",
  );
  assert.ok(
    Object.is(contentNode(container, "pane-b"), contentB),
    "pane-b content DOM node must be the same instance after MOVE",
  );
  assert.ok(Object.is(frameNode(container, "pane-a"), frameA), "pane-a frame not remounted");
  assert.ok(Object.is(frameNode(container, "pane-b"), frameB), "pane-b frame not remounted");
  // 几何确实变了(横向半宽 → 纵向全宽),说明比对不是"什么都没发生"。
  assert.notEqual(frameA.style.width, widthBeforeA, "pane-a rect updated in place");

  act(() => root.unmount());
  container.remove();
});

test("RESIZE_SPLIT keeps every pane's DOM instance", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  let layout = twoPaneLayout();
  renderLayer(root, layout);
  const contentA = contentNode(container, "pane-a");
  const contentB = contentNode(container, "pane-b");
  const widthBeforeA = frameNode(container, "pane-a").style.width;

  layout = dispatch(layout, { type: "RESIZE_SPLIT", splitId: "split-root", ratio: 0.7 });
  renderLayer(root, layout);

  assert.ok(Object.is(contentNode(container, "pane-a"), contentA));
  assert.ok(Object.is(contentNode(container, "pane-b"), contentB));
  assert.notEqual(frameNode(container, "pane-a").style.width, widthBeforeA);

  act(() => root.unmount());
  container.remove();
});

test("CLOSE_PANE removes only the closed pane; the survivor keeps its DOM", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  let layout = twoPaneLayout();
  renderLayer(root, layout);
  const contentB = contentNode(container, "pane-b");

  layout = dispatch(layout, { type: "CLOSE_PANE", paneId: "pane-a" });
  renderLayer(root, layout);

  assert.equal(contentNode(container, "pane-a"), null, "closed pane DOM removed");
  assert.ok(
    Object.is(contentNode(container, "pane-b"), contentB),
    "surviving pane keeps its DOM instance",
  );

  act(() => root.unmount());
  container.remove();
});

test.after(() => {
  env.cleanup();
});
