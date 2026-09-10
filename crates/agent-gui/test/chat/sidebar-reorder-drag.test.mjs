import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const env = await createDomTestEnv();
const { act, createRoot } = env;
const { useSidebarReorderDrag } = env.loadModule("@liveagent/ui/lib/sidebar/useSidebarReorderDrag.ts");
let drag;
let hit;
document.elementFromPoint = () => hit;
HTMLElement.prototype.scrollBy = () => {};

async function setup(t) {
  const container = document.createElement("div");
  document.body.append(container);
  container.getBoundingClientRect = () => ({ left: 0, right: 272, top: 0, bottom: 600 });
  const rows = ["conversation:one", "workspace:/a", "workspace:/b"].map((key) => {
    const button = document.createElement("button");
    button.dataset.sidebarReorderKey = key;
    button.getBoundingClientRect = () => ({ left: 0, right: 272, top: 100, bottom: 130, height: 30 });
    container.append(button);
    return button;
  });
  const calls = [];
  let props = {
    containerRef: { current: container }, disabled: false, scopeKey: "workspace",
    canDrop: (source, target) => source !== target,
    onDrop: (...args) => calls.push(args),
  };
  function Harness() { drag = useSidebarReorderDrag(props); return null; }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(React.createElement(Harness)));
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  return {
    rows, calls,
    async start(index = 0) {
      await act(async () => drag.onPointerDown(rows[index].dataset.sidebarReorderKey,
        { pointerId: 1, clientX: 40, clientY: 20, currentTarget: rows[index] }));
    },
    async render(changes) { props = { ...props, ...changes }; await act(async () => root.render(React.createElement(Harness))); },
  };
}

async function pointer(type, x, y) {
  const event = new window.MouseEvent(type, { clientX: x, clientY: y, cancelable: true });
  Object.defineProperty(event, "pointerId", { value: 1 });
  await act(async () => window.dispatchEvent(event));
}

test("plain clicks do not sort; dragging inserts at the final pointer target and suppresses the row click", async (t) => {
  const h = await setup(t);
  await h.start();
  await pointer("pointermove", 42, 22);
  await pointer("pointerup", 42, 22);
  assert.equal(drag.draggingKey, null);
  assert.deepEqual(h.calls, []);
  hit = h.rows[1];
  await h.start();
  await pointer("pointermove", 50, 105);
  assert.equal(drag.draggingKey, "conversation:one");
  assert.equal(drag.dropTarget.position, "before");
  // Final release chooses the final target and lower half, not the stale hover.
  hit = h.rows[2];
  await pointer("pointerup", 50, 128);
  assert.deepEqual(h.calls, [["conversation:one", "workspace:/b", "after"]]);
  assert.equal(drag.draggingKey, null);
  assert.equal(document.body.style.cursor, "");
  let blocked = false;
  drag.onClickCapture({ preventDefault() { blocked = true; }, stopPropagation() {} });
  assert.equal(blocked, true);
  blocked = false;
  drag.onPointerDownCapture();
  drag.onClickCapture({ preventDefault() { blocked = true; }, stopPropagation() {} });
  assert.equal(blocked, false);
});

test("invalid regions, Escape and scope changes cancel without persisting a sort", async (t) => {
  const h = await setup(t);
  hit = h.rows[1];
  await h.render({ canDrop: () => false });
  await h.start();
  await pointer("pointermove", 50, 105);
  assert.equal(drag.dropTarget, null);
  await pointer("pointerup", 50, 105);
  assert.deepEqual(h.calls, []);
  await h.render({ canDrop: () => true });
  await h.start();
  await pointer("pointermove", 50, 105);
  await act(async () => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" })));
  await pointer("pointerup", 50, 105);
  assert.deepEqual(h.calls, []);
  await h.start();
  await pointer("pointermove", 50, 105);
  await h.render({ scopeKey: "new-workspace" });
  await pointer("pointerup", 50, 105);
  assert.deepEqual(h.calls, []);
  assert.equal(document.body.style.userSelect, "");
});
