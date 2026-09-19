import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const env = await createDomTestEnv();
const { React, act, createRoot } = env;
const { ContextMenuPopup, ContextMenuItem } = env.loadModule("@liveagent/ui/components/ui/context-menu.tsx");

test("panel-relative menus escape clipping and leave positioning outside the animated surface", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function Harness() {
    const panelRef = React.useRef(null);
    const [open, setOpen] = React.useState(false);
    React.useEffect(() => setOpen(true), []);
    return React.createElement("section", { ref: panelRef, style: { overflow: "hidden", transform: "translateX(20px)" } },
      open ? React.createElement(ContextMenuPopup, {
        coordinateRoot: panelRef, point: { x: 80, y: 40 }, onClose: () => setOpen(false),
      }, React.createElement(ContextMenuItem, null, "Stage changes")) : null);
  }
  try {
    await act(async () => root.render(React.createElement(Harness)));
    const menu = document.querySelector('[role="menu"]');
    assert.ok(menu);
    assert.equal(host.contains(menu), false, "the menu must not be clipped by the Git panel");
    assert.equal(menu.parentElement.style.position, "fixed");
    assert.equal(menu.style.left, "", "the popup animation surface must not own positioning");
    await act(async () => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(document.querySelector('[role="menu"]'), null);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
