import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Moving the active floor while scrolling must re-render the rail and the two
// markers whose state changed, not every marker, and not the host.

const core = createTsModuleLoader().loadModule(
  fileURLToPath(new URL("../../../virtual-core/src/index.ts", import.meta.url)),
);
let realVirtualizer;
let React;
const markerRenders = new Map();
// Preview card stand-in: counts one render per marker (keyed by its label).
function PreviewCard(props) {
  return props.children;
}
function PreviewCardTrigger(props) {
  const label = props.render.props["aria-label"];
  markerRenders.set(label, (markerRenders.get(label) ?? 0) + 1);
  return props.render;
}
const PreviewCardContent = () => null;

const env = await createDomTestEnv({
  mocks: {
    "@tanstack/virtual-core": core,
    "@tanstack/react-virtual": { useVirtualizer: (...args) => realVirtualizer(...args) },
    "@liveagent/ui/components/IconSet": { Pin: () => null },
    "@liveagent/ui/i18n/index": { useLocale: () => ({ locale: "en-US" }) },
    "../../../components/ui/preview-card": {
      PreviewCard,
      PreviewCardTrigger,
      PreviewCardContent,
    },
  },
});
realVirtualizer = env.loadModule(
  createRequire(new URL("../../package.json", import.meta.url)).resolve("@tanstack/react-virtual"),
).useVirtualizer;
React = env.React;
const { act, createRoot } = env;
Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 600 });
Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 40 });
const { FloorNavRail } = env.loadModule("@liveagent/ui/pages/chat/transcript/FloorNavRail.tsx");
const { createActiveFloorStore } = env.loadModule(
  "@liveagent/ui/lib/chat-floor-nav/activeFloorStore.ts",
);

const floors = Array.from({ length: 40 }, (_, i) => ({
  rowKey: `row-${i}`,
  messageId: `m-${i}`,
  preview: `Message ${i}`,
  responsePreview: null,
}));

test("an active floor change re-renders only the markers it touches", () => {
  const store = createActiveFloorStore();
  let hostRenders = 0;
  const onJump = () => {};
  function Host() {
    hostRenders += 1;
    return React.createElement(FloorNavRail, {
      floors,
      conversationId: "c1",
      activeRowKeyStore: store,
      onJump,
    });
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    act(() => store.set("row-3"));
    act(() => root.render(React.createElement(Host)));
    const current = () => container.querySelector('[aria-current="location"]');
    assert.equal(current()?.getAttribute("aria-label"), "Message 3");
    const mounted = markerRenders.size;
    assert.ok(mounted >= 10, "markers rendered");
    markerRenders.clear();
    const hostBefore = hostRenders;

    act(() => store.set("row-4"));
    assert.equal(current()?.getAttribute("aria-label"), "Message 4");
    assert.deepEqual(
      [...markerRenders.keys()].sort(),
      ["Message 3", "Message 4"],
      "only the old and the new active marker re-render",
    );
    assert.equal(hostRenders, hostBefore, "the host does not re-render");

    // Same key again: nothing re-renders.
    markerRenders.clear();
    act(() => store.set("row-4"));
    assert.equal(markerRenders.size, 0);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

test("a host that passes activeRowKey still marks the active floor", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        React.createElement(FloorNavRail, {
          floors,
          conversationId: "c2",
          activeRowKey: "row-1",
          onJump: () => {},
        }),
      ),
    );
    assert.equal(
      container.querySelector('[aria-current="location"]')?.getAttribute("aria-label"),
      "Message 1",
    );
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

test.after(() => env.cleanup());
