import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
const core = createTsModuleLoader().loadModule(new URL("../../../virtual-core/src/index.ts", import.meta.url).pathname);
let realVirtualizer;

import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const env = await createDomTestEnv({
  mocks: { "@tanstack/virtual-core": core, "@tanstack/react-virtual": { useVirtualizer: (...args) => realVirtualizer(...args) }, "@liveagent/ui/components/IconSet": { Pin: () => null, ChevronUp: () => null, ChevronDown: () => null }, "@liveagent/ui/i18n/index": { useLocale: () => ({ locale: "en-US" }) } },
});
realVirtualizer = env.loadModule(createRequire(new URL("../../package.json", import.meta.url)).resolve("@tanstack/react-virtual")).useVirtualizer;
const { React, act, createRoot } = env;
Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
const { FloorNavRail } = env.loadModule("@liveagent/ui/pages/chat/transcript/FloorNavRail.tsx");

Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 396 });
Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 40 });
HTMLElement.prototype.scrollTo = function({top = 0}) { this.scrollTop = top; };
const floors = Array.from({ length: 105 }, (_, i) => ({
  rowKey: String(i), messageId: String(i), preview: `Message ${i}`, responsePreview: null,
}));

test("rail scrolls continuously without paging controls and keeps rendering bounded", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const jumps = [];
  try {
    act(() => root.render(React.createElement(FloorNavRail, {
      floors, activeRowKey: "0", conversationId: "scroll",
      onJump: key => jumps.push(key),
    })));
    assert.equal(container.querySelector('[aria-label="Previous page"]'), null);
    assert.equal(container.querySelector('[aria-label="Next page"]'), null);
    const rail = container.querySelector("[data-floor-scroll]");
    assert.ok(rail);
    const markers = rail.querySelectorAll("button");
    assert.ok(markers.length > 0 && markers.length < floors.length);
    act(() => markers[0].click());
    assert.deepEqual(jumps, ["0"]);
    await act(async () => {
      rail.scrollTop = 500;
      rail.dispatchEvent(new Event("scroll"));
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    const later = [...rail.querySelectorAll("button")];
    assert.ok(later.some(button => button.getAttribute("aria-label") === "Message 60"));
    assert.ok(!later.some(button => button.getAttribute("aria-label") === "Message 0"));
    act(() => later.find(button => button.getAttribute("aria-label") === "Message 60").click());
    assert.deepEqual(jumps, ["0", "60"]);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
test.after(() => env.cleanup());
