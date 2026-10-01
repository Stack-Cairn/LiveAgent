import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { transpileTypeScriptModule } from "../../../../scripts/typescript-source-tools.mjs";

// Execute the actual paging effect with a deterministic frame clock. This
// covers events that a real WebKit viewport can omit at its scroll boundary.
const source = fs.readFileSync(new URL("../../src/pages/chat/transcript/TranscriptList.tsx", import.meta.url), "utf8");
const effect = source.slice(source.indexOf("  // Prefetch near"), source.indexOf("  // Every mounted row"));
const js = transpileTypeScriptModule(effect, "/tmp/history-prefetch.ts");
const renderEffect = new Function("useRef", "useEffect", "historyItems", "scrollViewport", "hasMoreHistory", "isHistorySwitching", "virtualizer", "onLoadEarlierHistory", "requestAnimationFrame", "cancelAnimationFrame", "LOAD_EARLIER_THRESHOLD_PX", "HTMLElement", js);
function harness() {
  const refs = [], frames = new Map(), listeners = new Map();
  let cleanup, index = 0, frameId = 0, calls = 0, resolve, reject;
  let offset = 4000;
  const viewport = { scrollTop: 4000, clientHeight: 1000,
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
  };
  const h = {
    get calls() { return calls; },
    render(key = "page-1") {
      cleanup?.(); index = 0;
      renderEffect((value) => refs[index++] ?? (refs[index - 1] = { current: value }), (fn) => { cleanup = fn(); }, [{ key }], viewport, true, false,
        { getSettledScrollOffset: () => offset },
        () => { calls++; return new Promise((yes, no) => { resolve = yes; reject = no; }); },
        (fn) => { frames.set(++frameId, fn); return frameId; }, (id) => frames.delete(id), 1600, class HTMLElement {});
    },
    move(distance, domTop = distance) { offset = distance; viewport.scrollTop = domTop; },
    emit(name, event = {}) { listeners.get(name)?.(event); },
    frame() { const batch = [...frames.values()]; frames.clear(); batch.forEach((fn) => fn()); },
    async complete(error = false) { if (error) reject(new Error("offline")); else resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); },
    dispose() { cleanup?.(); },
  };
  h.render(); return h;
}
test("prefetch starts two viewports ahead and coalesces concurrent events", async () => {
  const h = harness();
  h.frame(); assert.equal(h.calls, 0);
  h.move(1800); h.emit("scroll"); h.frame(); assert.equal(h.calls, 1);
  h.emit("scroll"); h.emit("wheel", { deltaY: -20 }); h.frame(); assert.equal(h.calls, 1);
  await h.complete(); h.frame(); h.frame(); assert.equal(h.calls, 1);
  h.dispose();
});
test("a committed page cannot drain history while the reader stays at the top", async () => {
  const h = harness(); h.move(0); h.emit("wheel", { deltaY: -20 }); h.frame();
  h.render("page-2"); await h.complete();
  for (let i = 0; i < 100; i++) {
    h.emit("scroll"); h.emit("scrollend"); h.frame();
  }
  assert.equal(h.calls, 1, "layout and idle events must not request another page");
  h.emit("wheel", { deltaY: -20 }); h.frame();
  assert.equal(h.calls, 2, "a new upward gesture can load the next page");
  h.dispose(); await h.complete(); h.frame();
});
test("leaving the prefetch band rearms scrollbar navigation", async () => {
  const h = harness(); h.move(1800); h.emit("scroll"); h.frame();
  h.render("page-2"); await h.complete(); h.frame();
  h.move(5000); h.emit("scroll"); h.frame();
  h.move(1800); h.emit("scroll"); h.frame();
  assert.equal(h.calls, 2);
  h.dispose(); await h.complete();
});
test("continuous wheel events only fetch again after the previous page completes", async () => {
  const h = harness(); h.move(0); h.emit("wheel", { deltaY: -20 }); h.frame();
  for (let i = 0; i < 30; i++) { h.emit("wheel", { deltaY: -20 }); h.frame(); }
  assert.equal(h.calls, 1);
  h.render("page-2"); await h.complete(); h.frame();
  assert.equal(h.calls, 1);
  h.emit("wheel", { deltaY: -20 }); h.frame(); assert.equal(h.calls, 2);
  h.dispose(); await h.complete();
});
test("wheel at the hard top retries a failed request without a scroll event or retry loop", async () => {
  const h = harness(); h.move(0); h.emit("wheel", { deltaY: -20 }); h.frame();
  assert.equal(h.calls, 1); await h.complete(true); h.frame(); h.frame();
  assert.equal(h.calls, 1);
  h.emit("wheel", { deltaY: -20 }); h.frame(); assert.equal(h.calls, 2);
  h.dispose(); await h.complete(); h.frame(); h.frame(); assert.equal(h.calls, 2);
});

test("keyboard and touch can request more history without an idle retry", async () => {
  const h = harness(); h.move(0); h.emit("keydown", { key: "PageUp" }); h.frame();
  assert.equal(h.calls, 1);
  h.render("page-2"); await h.complete(); h.frame();
  h.emit("touchstart", { touches: [{ clientY: 100 }] });
  h.emit("touchmove", { touches: [{ clientY: 140 }] }); h.frame();
  assert.equal(h.calls, 2);
  h.dispose(); await h.complete();
});
test("parked native top does not stack pages while the logical anchor is far from the boundary", async () => {
  const h = harness(); h.move(0); h.emit("wheel", { deltaY: -20 }); h.frame();
  h.render("page-2"); h.move(50000, 0); await h.complete();
  for (let i = 0; i < 20; i++) {
    h.emit("scroll"); h.emit("wheel", { deltaY: -20 }); h.frame();
  }
  assert.equal(h.calls, 1);
  h.move(50000); h.emit("scroll"); h.frame();
  h.move(0); h.emit("scroll"); h.frame();
  assert.equal(h.calls, 2);
  h.dispose(); await h.complete();
});
