import assert from "node:assert/strict";
import { PerformanceObserver } from "node:perf_hooks";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const { installReactDevTimelineLimit } = createTsModuleLoader().loadModule(
  "@liveagent/ui/lib/system/reactDevTimeline",
);

test("React development measures are bounded while application timing is retained", async (t) => {
  const previousObserver = globalThis.PerformanceObserver;
  globalThis.PerformanceObserver = PerformanceObserver;
  const stop = installReactDevTimelineLimit(20);
  t.after(() => {
    stop();
    globalThis.PerformanceObserver = previousObserver;
    for (const name of ["\u200bSidebar", "Render", "app-render", "same-name"]) performance.clearMeasures(name);
    performance.clearMarks("app-mark");
  });
  performance.mark("app-mark");
  performance.measure("app-render", { start: 0, detail: { purpose: "application" } });
  performance.measure("same-name", { start: 0, detail: { purpose: "application" } });
  performance.measure("same-name", { start: 0, detail: { devtools: { track: "Components ⚛" } } });
  for (let cycle = 0; cycle < 4; cycle += 1) {
    for (let index = 0; index < 25; index += 1) {
      performance.measure("\u200bSidebar", { start: 0, detail: { devtools: { track: "Components ⚛", properties: [["large-prop", "x".repeat(1000)]] } } });
      performance.measure("Render", { start: 0, detail: { devtools: { track: "Blocking", trackGroup: "Scheduler ⚛" } } });
    }
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(performance.getEntriesByName("\u200bSidebar").length, 0);
    assert.equal(performance.getEntriesByName("Render").length, 0);
  }
  assert.equal(performance.getEntriesByName("app-render").length, 1);
  assert.equal(performance.getEntriesByName("app-mark").length, 1);
  assert.equal(performance.getEntriesByName("same-name").length, 2);
  stop();
  performance.measure("\u200bSidebar", { start: 0, detail: { devtools: { track: "Components ⚛" } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(performance.getEntriesByName("\u200bSidebar").length, 1, "disposing stops the observer");
});
