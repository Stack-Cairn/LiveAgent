import assert from "node:assert/strict";
import test from "node:test";
import { createHarness } from "../../../virtual-core/test/helpers/harness.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// The transcript defers ResizeObserver flushes to the next animation frame.
// A collapse animation writes a newer row height before that flush runs, so
// sizing rows from the delivered box painted the rows below one frame behind
// the collapsing row: a gap flashed open under the tool-group header.

const core = createHarness().core;
const { measureRowLive } = createTsModuleLoader({
  mocks: { "@tanstack/react-virtual": { measureElement: core.measureElement } },
}).loadModule("src/pages/chat/transcript/measureRowLive.ts");

// Fake rows: live layout height (offsetHeight) plus a count of layout reads.
function createRows(indexes, height = 120) {
  const rows = new Map();
  for (const index of indexes) {
    const row = { index, live: height, reads: 0, node: null };
    row.node = {
      isConnected: true,
      getAttribute: () => String(index),
      get offsetHeight() {
        row.reads += 1;
        return row.live;
      },
    };
    rows.set(index, row);
  }
  return rows;
}

function deferredHarness({ measurer, scrollTop, indexes, harnessOptions = {} }) {
  const h = createHarness({ scrollAnchoring: "origin", ...harnessOptions });
  let deliver;
  h.element.ownerDocument.defaultView.ResizeObserver = class {
    constructor(callback) {
      deliver = callback;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  h.virtualizer.setOptions({
    ...h.virtualizer.options,
    useAnimationFrameWithResizeObserver: true,
    measureElement: measurer,
  });
  h.emitScroll(scrollTop, false);
  const rows = createRows(indexes);
  for (const row of rows.values()) h.virtualizer.measureElement(row.node);
  h.runRafs();
  h.notifies.length = 0;
  return {
    h,
    rows,
    // RO delivery carrying the border box observed at delivery time.
    deliver: (sizes) =>
      deliver(
        sizes.map(([index, blockSize]) => ({
          target: rows.get(index).node,
          borderBoxSize: [{ blockSize, inlineSize: 800 }],
          contentRect: { height: blockSize },
        })),
      ),
  };
}

function collapseFrameGap(measurer) {
  // Rows 100/101 sit inside the viewport (9880..10480): no anchoring correction.
  const { h, rows, deliver } = deferredHarness({ measurer, scrollTop: 9880, indexes: [100, 101] });
  // Frame N: the observer delivers the collapsing row at 80px.
  rows.get(100).live = 80;
  deliver([[100, 80]]);
  // Frame N+1: the animation's rAF (registered earlier) writes 60px first.
  rows.get(100).live = 60;
  h.runRafs();
  const row100 = h.itemByKey("row-100");
  const row101 = h.itemByKey("row-101");
  return { size: row100.size, gap: row101.start - (row100.start + rows.get(100).live) };
}

test("a deferred flush sizes the collapsing row from its live height, so no gap opens", () => {
  assert.deepEqual(collapseFrameGap(measureRowLive), { size: 60, gap: 0 });
  // The default measurer reproduces the flicker: the frame-old box leaves 20px.
  assert.deepEqual(collapseFrameGap(core.measureElement), { size: 80, gap: 20 });
});

test("the ref-callback path keeps the cached size without reading layout", () => {
  // Rows start at 120px, not the 100px estimate: resizeItem caches only a
  // non-zero delta, so an estimate-sized row would never be cached.
  const { h, rows } = deferredHarness({ measurer: measureRowLive, scrollTop: 9880, indexes: [100] });
  const row = rows.get(100);
  const before = row.reads;
  h.virtualizer.elementsCache.delete("row-100");
  h.virtualizer.measureElement(row.node);
  assert.equal(row.reads - before, 0);
});

// Forced layouts = layout reads that follow a DOM write (the host's direct DOM
// updates write the sizer and transforms inside onChange; scrollToFn writes
// scrollTop), on the unbatched end-pinned flush path.
function countForcedLayouts(measurer) {
  const { h, rows, deliver } = deferredHarness({
    measurer,
    scrollTop: 19400,
    indexes: [195, 196, 197, 198],
    harnessOptions: { anchorTo: "end" },
  });
  h.emitScroll(h.maxScrollOffset(), false);
  h.runRafs();
  assert.ok(h.virtualizer.isAtEnd(), "end-pinned (unbatched) path");
  let dirty = false;
  let layouts = 0;
  const read = () => {
    if (dirty) {
      layouts += 1;
      dirty = false;
    }
  };
  for (const row of rows.values()) {
    const prev = Object.getOwnPropertyDescriptor(row.node, "offsetHeight").get;
    Object.defineProperty(row.node, "offsetHeight", {
      get() {
        read();
        return prev.call(this);
      },
    });
  }
  Object.defineProperty(h.element, "scrollHeight", {
    get() {
      read();
      return h.domSizerHeight;
    },
  });
  const options = h.virtualizer.options;
  h.virtualizer.setOptions({
    ...options,
    onChange: (...args) => {
      options.onChange(...args);
      dirty = true;
    },
    scrollToFn: (...args) => {
      options.scrollToFn(...args);
      dirty = true;
    },
  });
  const sizes = [
    [195, 140],
    [196, 150],
    [197, 160],
    [198, 170],
  ];
  for (const [index, size] of sizes) rows.get(index).live = size;
  deliver(sizes);
  dirty = false;
  h.runRafs();
  return { layouts, realScrollTop: h.realScrollTop, sizer: h.domSizerHeight };
}

test("live reads add no forced layouts on the end-pinned flush", () => {
  assert.deepEqual(countForcedLayouts(measureRowLive), countForcedLayouts(core.measureElement));
});
