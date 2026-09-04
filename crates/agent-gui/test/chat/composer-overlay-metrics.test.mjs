import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const { measureComposerOverlay } = createTsModuleLoader().loadModule(
  "@liveagent/ui/lib/chat/composerOverlayMetrics.ts",
);

// Composer layer anchored to the bottom of an 800px-tall, 1000px-wide pane.
const layer = { top: 700, bottom: 800, height: 100, left: 0, width: 1000 };
// Task pill wrapper: 32px tall, mb-3 (12px) above the card column top.
const pill = (columnTop) => ({ top: columnTop - 44, bottom: columnTop - 12, height: 32 });
// Desktop card column: centered in the layer, then translated 18px right.
const column = { left: 20 + 18, width: 960 };

test("no floating chrome: reserve equals layer height and nothing overhangs", () => {
  const metrics = measureComposerOverlay({
    layer,
    queueHeight: 0,
    floating: { top: 700, bottom: 700, height: 0 },
    column,
  });
  assert.deepEqual(metrics, { heightPx: 100, floatingOverhangPx: 0, centerOffsetPx: 18 });

  for (const floating of [null, undefined]) {
    assert.deepEqual(measureComposerOverlay({ layer, queueHeight: 0, floating, column }), {
      heightPx: 100,
      floatingOverhangPx: 0,
      centerOffsetPx: 18,
    });
  }
});

test("task pill overhangs the reserve line by its height plus gap without growing the reserve", () => {
  const metrics = measureComposerOverlay({
    layer,
    queueHeight: 0,
    floating: pill(layer.top),
    column,
  });
  assert.deepEqual(metrics, { heightPx: 100, floatingOverhangPx: 44, centerOffsetPx: 18 });
});

test("queue panel is excluded from the reserve but counted as overhang", () => {
  const withQueue = { ...layer, top: 640, height: 160 };
  const queueOnly = measureComposerOverlay({
    layer: withQueue,
    queueHeight: 60,
    floating: null,
    column,
  });
  assert.deepEqual(queueOnly, { heightPx: 100, floatingOverhangPx: 60, centerOffsetPx: 18 });

  const queueAndPill = measureComposerOverlay({
    layer: withQueue,
    queueHeight: 60,
    floating: pill(withQueue.top),
    column,
  });
  assert.deepEqual(queueAndPill, { heightPx: 100, floatingOverhangPx: 104, centerOffsetPx: 18 });
});

test("center offset follows the card column, not its width", () => {
  // Narrow column (content width clamp) keeps the same center shift.
  const clamped = measureComposerOverlay({
    layer,
    queueHeight: 0,
    floating: null,
    column: { left: (1000 - 692) / 2 + 18, width: 692 },
  });
  assert.equal(clamped.centerOffsetPx, 18);

  // Column flush with the layer center (gateway-style) reports no shift.
  const centered = measureComposerOverlay({
    layer,
    queueHeight: 0,
    floating: null,
    column: { left: 100, width: 800 },
  });
  assert.equal(centered.centerOffsetPx, 0);

  // Offset layer (split pane not at x=0) still measures relative to itself.
  const shiftedLayer = measureComposerOverlay({
    layer: { ...layer, left: 500 },
    queueHeight: 0,
    floating: null,
    column: { left: 500 + 38, width: 960 },
  });
  assert.equal(shiftedLayer.centerOffsetPx, 18);

  for (const missing of [null, undefined, { left: 0, width: 0 }]) {
    assert.equal(
      measureComposerOverlay({ layer, queueHeight: 0, floating: null, column: missing })
        .centerOffsetPx,
      0,
    );
  }
});

test("hidden composer layer reports zero for every metric", () => {
  const metrics = measureComposerOverlay({
    layer: { top: 0, bottom: 0, height: 0, left: 0, width: 0 },
    queueHeight: 0,
    floating: { top: 0, bottom: 0, height: 0 },
    column: { left: 0, width: 0 },
  });
  assert.deepEqual(metrics, { heightPx: 0, floatingOverhangPx: 0, centerOffsetPx: 0 });
});

test("fractional geometry rounds and never goes negative", () => {
  const fractional = { ...layer, top: 700.4, height: 99.6 };
  const metrics = measureComposerOverlay({
    layer: fractional,
    queueHeight: 0,
    floating: { top: 656.4, bottom: 688.4, height: 32 },
    column: { left: 38.4, width: 960 },
  });
  assert.deepEqual(metrics, { heightPx: 100, floatingOverhangPx: 44, centerOffsetPx: 18 });

  const belowLine = measureComposerOverlay({
    layer,
    queueHeight: 0,
    // Floating rect that somehow sits inside the layer must not subtract.
    floating: { top: 720, bottom: 752, height: 32 },
    column,
  });
  assert.equal(belowLine.floatingOverhangPx, 0);
});

const composerBarSource = fs.readFileSync(
  new URL("../../../agent-ui/src/pages/chat/ChatComposerBar.tsx", import.meta.url),
  "utf8",
);
const transcriptSource = fs.readFileSync(
  new URL("../../src/pages/chat/transcript/ChatTranscript.tsx", import.meta.url),
  "utf8",
);
const paneHostSource = fs.readFileSync(
  new URL("../../src/pages/chat/surfaces/ConversationPaneHost.tsx", import.meta.url),
  "utf8",
);

test("composer bar measures the card column and task pill wrapper alongside the layer", () => {
  assert.match(composerBarSource, /ref=\{composerColumnRef\}/);
  assert.match(composerBarSource, /ref=\{setTaskProgressBarElement\}/);
  assert.match(composerBarSource, /resizeObserver\?\.observe\(composerColumnRef\.current\)/);
  assert.match(composerBarSource, /resizeObserver\?\.observe\(taskProgressBarElement\)/);
  assert.match(
    composerBarSource,
    /measureComposerOverlay\(\{\s*layer:\s*composerLayer\.getBoundingClientRect\(\),\s*queueHeight:[^}]*floating:\s*taskProgressBarElement\?\.getBoundingClientRect\(\),\s*column:\s*composerColumnRef\.current\?\.getBoundingClientRect\(\),\s*\}\)/s,
  );
  assert.match(composerBarSource, /onFloatingOverhangChange\?\.\(metrics\.floatingOverhangPx\)/);
  assert.match(composerBarSource, /onCenterOffsetChange\?\.\(metrics\.centerOffsetPx\)/);
});

test("jump-to-bottom centers on the composer card and clears its floating chrome", () => {
  const jumpButton = transcriptSource.match(/chat-jump-to-bottom[\s\S]*?<ChevronDown/)?.[0];
  assert.ok(jumpButton, "jump-to-bottom button markup not found");
  assert.doesNotMatch(jumpButton, /left-1\/2/);
  assert.match(
    jumpButton,
    /left:\s*`calc\(50% \+ \$\{Math\.round\(composerCenterOffsetPx\)\}px\)`/,
  );
  assert.match(
    jumpButton,
    /bottom:\s*Math\.ceil\(bottomReservePx\)\s*\+\s*Math\.ceil\(floatingOverhangPx\)\s*\+\s*16/,
  );

  assert.match(paneHostSource, /onFloatingOverhangChange=\{setComposerFloatingOverhang\}/);
  assert.match(paneHostSource, /floatingOverhangPx=\{composerFloatingOverhang\}/);
  assert.match(paneHostSource, /onCenterOffsetChange=\{setComposerCenterOffset\}/);
  assert.match(paneHostSource, /composerCenterOffsetPx=\{composerCenterOffset\}/);
});
