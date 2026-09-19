import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./helpers/harness.mjs";

function resizeHarness(deferred = true) {
  const h = createHarness({ scrollAnchoring: "origin" });
  let deliver;
  h.element.ownerDocument.defaultView.ResizeObserver = class {
    constructor(callback) { deliver = callback; }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  h.virtualizer.setOptions({
    ...h.virtualizer.options,
    useAnimationFrameWithResizeObserver: deferred,
    measureElement: (_node, entry) => entry.contentRect.height,
  });
  h.emitScroll(9880, true);
  const nodes = [96, 97, 98].map((index) => ({
    isConnected: true,
    getAttribute: () => String(index),
  }));
  for (const node of nodes) h.virtualizer.measureElement(node);
  h.notifies.length = 0;
  return { h, nodes, deliver: (sizes) => deliver(sizes.map(([index, height]) => ({
    target: nodes[index], contentRect: { height },
  }))) };
}

for (const deferred of [false, true]) {
  test(`resize delivery publishes once and preserves every row anchor (deferred=${deferred})`, () => {
    const { h, deliver } = resizeHarness(deferred);
    const before = h.itemByKey("row-100").start;
    deliver([[0, 180], [1, 220], [2, 160]]);
    if (deferred) {
      assert.equal(h.notifies.length, 0);
      h.runRafs();
    }
    assert.equal(h.notifies.length, 1);
    assert.equal(h.itemByKey("row-100").start, before);
    assert.equal(h.originOffset(), -260);
    assert.equal(h.writes.length, 0);
    assert.equal(h.blankBandAtViewportTop(), 0);
    assert.equal(h.itemByKey("row-96").size, 180);
    assert.equal(h.itemByKey("row-97").size, 220);
    assert.equal(h.itemByKey("row-98").size, 160);
  });
}

test("multiple deliveries before the frame keep the latest size per node", () => {
  const { h, deliver } = resizeHarness();
  deliver([[0, 180]]);
  deliver([[0, 240], [1, 200]]);
  h.runRafs();
  assert.equal(h.notifies.length, 1);
  assert.equal(h.itemByKey("row-96").size, 240);
  assert.equal(h.originOffset(), -240);
});

test("disconnect cancels pending measurements; detached rows are ignored", () => {
  const { h, nodes, deliver } = resizeHarness();
  deliver([[0, 180], [1, 200]]);
  nodes[0].isConnected = false;
  h.runRafs();
  assert.equal(h.itemByKey("row-96").size, 100);
  assert.equal(h.itemByKey("row-97").size, 200);
  assert.equal(h.virtualizer.elementsCache.has("row-96"), false);
  h.notifies.length = 0;
  deliver([[2, 300]]);
  h.virtualizer.setOptions({ ...h.virtualizer.options, enabled: false });
  h.virtualizer._willUpdate();
  h.notifies.length = 0;
  h.runRafs();
  assert.equal(h.notifies.length, 0);
});

test("end pinning keeps the existing per-write layout publication", () => {
  const { h, deliver } = resizeHarness();
  const baseline = createHarness({ scrollAnchoring: "origin" });
  h.emitScroll(19400, false);
  baseline.emitScroll(19400, false);
  deliver([[0, 180], [1, 220], [2, 160]]);
  h.runRafs();
  for (const [index, size] of [[96, 180], [97, 220], [98, 160]]) {
    baseline.virtualizer.resizeItem(index, size);
  }
  h.runRafs();
  baseline.runRafs();
  assert.equal(h.realScrollTop, baseline.realScrollTop);
  assert.equal(h.domSizerHeight, baseline.domSizerHeight);
  assert.deepEqual(h.writes, baseline.writes);
});
