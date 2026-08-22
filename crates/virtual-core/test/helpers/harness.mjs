import { loadVirtualCore } from "./load-core.mjs";

// Deterministic virtualizer harness: a fake scroll element whose DOM offset
// only moves when a scrollToFn write is allowed to land, an explicit rAF
// queue, and explicit scroll-event emission. Nothing is asynchronous — tests
// drive every step.
export function createHarness(options = {}) {
  const {
    count = 200,
    estimate = 100,
    viewport = 600,
    initialOffset = 10000,
    anchorTo = "end",
    scrollAnchoring,
    directionalOverscanPx,
    overscan = 0,
    scrollEndThreshold = 8,
  } = options;

  const core = loadVirtualCore();
  const state = {
    realScrollTop: initialOffset,
    swallowWrites: false,
    writes: [],
    rafQueue: new Map(),
    rafSeq: 0,
    scrollCb: null,
  };

  const fakeWindow = {
    performance: { now: () => Date.now() },
    requestAnimationFrame: (fn) => {
      const id = ++state.rafSeq;
      state.rafQueue.set(id, fn);
      return id;
    },
    cancelAnimationFrame: (id) => {
      state.rafQueue.delete(id);
    },
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (id) => clearTimeout(id),
  };

  const fakeElement = {
    ownerDocument: { defaultView: fakeWindow },
    addEventListener: () => {},
    removeEventListener: () => {},
    scrollTo: () => {},
    get scrollTop() {
      return state.realScrollTop;
    },
    get scrollHeight() {
      return virtualizer.getTotalSize();
    },
    clientHeight: viewport,
  };

  const virtualizer = new core.Virtualizer({
    count,
    getScrollElement: () => fakeElement,
    estimateSize: () => estimate,
    getItemKey: options.getItemKey ?? ((index) => `row-${index}`),
    scrollToFn: (offset, { adjustments }) => {
      const target = offset + (adjustments ?? 0);
      if (state.swallowWrites) {
        state.writes.push({ target, swallowed: true });
        return;
      }
      const max = Math.max(0, virtualizer.getTotalSize() - viewport);
      state.realScrollTop = Math.max(0, Math.min(max, target));
      state.writes.push({ target, swallowed: false, landed: state.realScrollTop });
    },
    observeElementRect: (_instance, cb) => {
      cb({ width: 800, height: viewport });
    },
    observeElementOffset: (_instance, cb) => {
      state.scrollCb = cb;
      cb(state.realScrollTop, false);
    },
    overscan,
    anchorTo,
    ...(scrollAnchoring !== undefined ? { scrollAnchoring } : {}),
    ...(directionalOverscanPx !== undefined ? { directionalOverscanPx } : {}),
    scrollEndThreshold,
    initialOffset,
  });
  virtualizer._didMount();
  virtualizer._willUpdate();
  // The mount-time offset sync write is bookkeeping noise for assertions.
  state.writes.length = 0;

  return {
    core,
    virtualizer,
    element: fakeElement,
    get realScrollTop() {
      return state.realScrollTop;
    },
    get writes() {
      return state.writes;
    },
    setSwallowWrites(value) {
      state.swallowWrites = value;
    },
    // The user (or compositor) moved the viewport and the browser reported it.
    emitScroll(offset, isScrolling = true) {
      state.realScrollTop = offset;
      state.scrollCb?.(offset, isScrolling);
    },
    // The browser echoes our own write back as a scroll event.
    emitEcho(isScrolling = true) {
      state.scrollCb?.(state.realScrollTop, isScrolling);
    },
    runRafs() {
      const pending = [...state.rafQueue.values()];
      state.rafQueue.clear();
      for (const fn of pending) fn();
    },
    // Coverage math in real-viewport coordinates: how many pixels at the top
    // of the visible viewport have no rendered row under them. Virtual items
    // are contiguous and position-sorted, so the first item's start bounds
    // the rendered region from above.
    blankBandAtViewportTop() {
      const items = virtualizer.getVirtualItems();
      const first = items[0];
      if (!first) return viewport;
      return Math.max(0, first.start - state.realScrollTop);
    },
    originOffset() {
      return virtualizer.originOffset ?? 0;
    },
    itemByKey(key) {
      const measurements = virtualizer.getMeasurements();
      for (let i = 0; i < measurements.length; i += 1) {
        const item = measurements[i];
        if (item && item.key === key) return { ...item };
      }
      return null;
    },
  };
}
