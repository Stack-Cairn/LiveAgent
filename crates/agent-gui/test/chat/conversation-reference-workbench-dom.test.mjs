import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const env = await createDomTestEnv();
const { React, act, createRoot } = env;

const { registerConversationReferenceDropZone } = env.loadModule(
  "@liveagent/ui/lib/chat/conversationReferenceDrag.ts",
);
const { useWorkbenchDragSession } = env.loadModule(
  "src/pages/chat/workbench/useWorkbenchDragSession.ts",
);

const PROJECT = { projectId: "project-main", projectPathKey: "/workspace/main" };
const CANVAS_RECT = {
  left: 0,
  top: 0,
  width: 1000,
  height: 800,
  right: 1000,
  bottom: 800,
};
const COMPOSER_RECT = {
  left: 200,
  top: 600,
  width: 500,
  height: 140,
  right: 700,
  bottom: 740,
};

function layout() {
  return {
    schemaVersion: 1,
    revision: 7,
    root: { type: "leaf", paneId: "pane-a" },
    panes: {
      "pane-a": {
        paneId: "pane-a",
        surface: { kind: "conversation", conversationId: "conversation-current", project: PROJECT },
        view: {},
      },
    },
    focusedPaneId: "pane-a",
  };
}

const GEOMETRY = {
  canvas: { left: 0, top: 0, width: 1000, height: 800 },
  panes: [{ paneId: "pane-a", rect: { left: 0, top: 0, width: 1000, height: 800 } }],
  dividers: [],
};

function conversationPayload(id = "conversation-source") {
  return {
    kind: "conversation",
    conversationId: id,
    project: { projectId: "project-other", projectPathKey: "/workspace/other" },
    title: "Cross-project source",
    cwd: "/workspace/other",
    updatedAt: 42,
  };
}

function pointerEvent(type, { x, y, pointerId = 1 }) {
  const event = new window.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}

test("Workbench pointer drag prioritizes the Composer and never leaks into a split", () => {
  const container = document.createElement("div");
  const canvas = document.createElement("div");
  const composer = document.createElement("div");
  canvas.dataset.workbenchCanvas = "";
  composer.dataset.conversationReferenceDropZone = "enabled";
  composer.dataset.conversationReferenceDropConversationId = "conversation-current";
  canvas.getBoundingClientRect = () => CANVAS_RECT;
  composer.getBoundingClientRect = () => COMPOSER_RECT;
  canvas.appendChild(container);
  canvas.appendChild(composer);
  document.body.appendChild(canvas);

  const commits = [];
  let beginDrag = null;
  function Harness() {
    const layoutRef = React.useRef(layout());
    const geometryRef = React.useRef(GEOMETRY);
    const drag = useWorkbenchDragSession({
      enabled: true,
      layoutRef,
      geometryRef,
      onCommit: (commit) => commits.push(commit),
    });
    beginDrag = drag.beginDrag;
    return null;
  }

  const root = createRoot(container);
  act(() => root.render(React.createElement(Harness)));
  assert.equal(typeof beginDrag, "function");

  const inserted = [];
  const hoverStates = [];
  let unregister = registerConversationReferenceDropZone(composer, {
    conversationId: "conversation-current",
    enabled: true,
    onHover: (_reference, active) => hoverStates.push(active),
    onDrop: (reference) => {
      inserted.push(reference);
      return "inserted";
    },
  });

  // Editors and pane overlays may stop bubbling. The Workbench session owns
  // capture-phase listeners so the semantic drop still completes.
  composer.addEventListener("pointermove", (event) => event.stopPropagation());
  composer.addEventListener("pointerup", (event) => event.stopPropagation());

  act(() => beginDrag(conversationPayload(), { pointerId: 1, clientX: 10, clientY: 10 }));
  act(() => composer.dispatchEvent(pointerEvent("pointermove", { x: 300, y: 650 })));
  act(() => composer.dispatchEvent(pointerEvent("pointerup", { x: 300, y: 650 })));

  assert.equal(inserted.length, 1, "the Composer receives the conversation reference");
  assert.deepEqual(inserted[0], {
    id: "conversation-source",
    title: "Cross-project source",
    cwd: "/workspace/other",
    updatedAt: 42,
  });
  assert.deepEqual(hoverStates, [true, false]);
  assert.deepEqual(commits, [], "a reference drop must not commit a Workbench split");

  unregister();
  let disabledDropCount = 0;
  unregister = registerConversationReferenceDropZone(composer, {
    conversationId: "conversation-current",
    enabled: false,
    onDrop: () => {
      disabledDropCount += 1;
      return "disabled";
    },
  });
  composer.dataset.conversationReferenceDropZone = "disabled";

  act(() =>
    beginDrag(conversationPayload("conversation-disabled"), {
      pointerId: 2,
      clientX: 10,
      clientY: 10,
    }),
  );
  act(() =>
    composer.dispatchEvent(pointerEvent("pointermove", { x: 300, y: 650, pointerId: 2 })),
  );
  act(() =>
    composer.dispatchEvent(pointerEvent("pointerup", { x: 300, y: 650, pointerId: 2 })),
  );

  assert.equal(disabledDropCount, 1, "disabled Composer owns the rejection result");
  assert.deepEqual(commits, [], "a rejected reference must not fall through to a split");

  // Outside the Composer, the broad pane centre keeps the original responsive
  // auto-dock behavior. An explicit pane edge remains directional.
  act(() =>
    beginDrag(conversationPayload("conversation-center"), {
      pointerId: 3,
      clientX: 10,
      clientY: 10,
    }),
  );
  act(() => canvas.dispatchEvent(pointerEvent("pointermove", { x: 500, y: 400, pointerId: 3 })));
  act(() => canvas.dispatchEvent(pointerEvent("pointerup", { x: 500, y: 400, pointerId: 3 })));
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].target, {
    kind: "pane-edge",
    paneId: "pane-a",
    edge: "right",
  });

  act(() =>
    beginDrag(conversationPayload("conversation-split"), {
      pointerId: 4,
      clientX: 10,
      clientY: 10,
    }),
  );
  act(() => canvas.dispatchEvent(pointerEvent("pointermove", { x: 800, y: 400, pointerId: 4 })));
  act(() => canvas.dispatchEvent(pointerEvent("pointerup", { x: 800, y: 400, pointerId: 4 })));
  assert.equal(commits.length, 2);
  assert.deepEqual(commits[1].target, { kind: "pane-edge", paneId: "pane-a", edge: "right" });

  unregister();
  act(() => root.unmount());
  canvas.remove();
});

test.after(() => {
  env.cleanup();
});
