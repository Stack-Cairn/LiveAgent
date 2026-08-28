import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { installWorkbenchDragWindowListeners } = loader.loadModule(
  "@liveagent/ui/lib/workbench/dragWindowListeners.ts",
);

function pointerEvent(window, type, pointerId) {
  const event = new window.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: 420,
    clientY: 260,
  });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}

test("window capture observes dock drag move/up before nested widgets stop bubbling", () => {
  const dom = new JSDOM('<div id="menu"><button id="terminal-tab">Terminal</button></div>');
  const { window } = dom;
  const menu = window.document.querySelector("#menu");
  const terminalTab = window.document.querySelector("#terminal-tab");
  const seen = [];

  // Base UI menus and terminal widgets are allowed to consume their local
  // pointer stream. The workbench adapter must still see the gesture first.
  menu.addEventListener("pointermove", (event) => event.stopPropagation());
  menu.addEventListener("pointerup", (event) => event.stopPropagation());

  const cleanup = installWorkbenchDragWindowListeners(window, {
    onPointerMove: (event) => seen.push(`move:${event.pointerId}`),
    onPointerUp: (event) => seen.push(`up:${event.pointerId}`),
    onPointerCancel: () => seen.push("cancel"),
    onBlur: () => seen.push("blur"),
    onKeyDown: (event) => seen.push(`key:${event.key}`),
  });

  terminalTab.dispatchEvent(pointerEvent(window, "pointermove", 7));
  terminalTab.dispatchEvent(pointerEvent(window, "pointerup", 7));
  assert.deepEqual(seen, ["move:7", "up:7"]);

  cleanup();
  terminalTab.dispatchEvent(pointerEvent(window, "pointermove", 7));
  terminalTab.dispatchEvent(pointerEvent(window, "pointerup", 7));
  assert.deepEqual(seen, ["move:7", "up:7"], "cleanup must remove capture listeners");
  dom.window.close();
});
