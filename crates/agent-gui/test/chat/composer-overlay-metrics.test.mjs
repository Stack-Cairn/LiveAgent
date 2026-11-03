import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const { measureComposerOverlay } = createTsModuleLoader().loadModule(
  "@liveagent/ui/lib/chat/composerOverlayMetrics.ts",
);

const layer = { top: 700, bottom: 800, height: 100, left: 0, width: 1000 };
const pill = (columnTop) => ({ top: columnTop - 44, bottom: columnTop - 12, height: 32 });
const column = { left: 38, width: 960 };

test("reserve clears the entire composer, including queue and task pill", () => {
  const withQueue = { ...layer, top: 640, height: 160 };
  for (const [currentLayer, floating, expectedHeight] of [
    [layer, null, 100],
    [layer, undefined, 100],
    [layer, { top: 700, bottom: 700, height: 0 }, 100],
    [layer, pill(layer.top), 144],
    [withQueue, null, 160],
    [withQueue, pill(withQueue.top), 204],
  ]) {
    const metrics = measureComposerOverlay({ layer: currentLayer, floating, column });
    assert.deepEqual(metrics, { heightPx: expectedHeight, centerOffsetPx: 18 });
    const reserveTop = currentLayer.bottom - metrics.heightPx;
    assert.ok(reserveTop <= currentLayer.top, "queue and input must clear the transcript");
    if (floating?.height > 0) assert.ok(reserveTop <= floating.top, "pill must clear the transcript");
  }
});

test("reserve grows and shrinks with queue, goal bar, approval and multiline input", () => {
  for (const height of [100, 164, 220, 132, 280, 100]) {
    const currentLayer = { ...layer, top: layer.bottom - height, height };
    assert.equal(measureComposerOverlay({ layer: currentLayer, floating: null, column }).heightPx, height);
    assert.equal(measureComposerOverlay({ layer: currentLayer, floating: pill(currentLayer.top), column }).heightPx, height + 44);
  }
});

test("center offset follows the card column in narrow and split panes", () => {
  for (const [currentLayer, currentColumn, expected] of [
    [layer, { left: (1000 - 692) / 2 + 18, width: 692 }, 18],
    [layer, { left: 100, width: 800 }, 0],
    [{ ...layer, left: 500 }, { left: 538, width: 960 }, 18],
    [layer, null, 0],
    [layer, undefined, 0],
    [layer, { left: 0, width: 0 }, 0],
  ]) {
    assert.equal(measureComposerOverlay({ layer: currentLayer, floating: null, column: currentColumn }).centerOffsetPx, expected);
  }
});

test("hidden composer reserves no space, even with a stale pill rectangle", () => {
  const hidden = { top: 0, bottom: 0, height: 0, left: 0, width: 0 };
  for (const floating of [null, pill(0), { top: 0, bottom: 0, height: 0 }]) {
    assert.deepEqual(measureComposerOverlay({ layer: hidden, floating, column: null }), { heightPx: 0, centerOffsetPx: 0 });
  }
});

test("fractional geometry rounds once and interior floating content adds no space", () => {
  assert.equal(measureComposerOverlay({
    layer: { ...layer, top: 700.4, height: 99.6 },
    floating: { top: 656.4, bottom: 688.4, height: 32 },
    column,
  }).heightPx, 144);
  assert.equal(measureComposerOverlay({
    layer,
    floating: { top: 720, bottom: 752, height: 32 },
    column,
  }).heightPx, 100);
});

const composerBarSource = fs.readFileSync(
  new URL("../../../agent-ui/src/pages/chat/ChatComposerBar.tsx", import.meta.url), "utf8",
);
const transcriptSource = fs.readFileSync(
  new URL("../../src/pages/chat/transcript/ChatTranscript.tsx", import.meta.url), "utf8",
);

test("both surfaces publish the same measured height and observe floating content", () => {
  assert.equal((composerBarSource.match(/measureComposerOverlay\(\{/g) ?? []).length, 1);
  assert.match(composerBarSource, /onHeightChange\?\.\(metrics\.heightPx\)/);
  assert.match(composerBarSource, /"--gateway-chat-composer-overlay-height",\s*`\$\{metrics\.heightPx\}px`/);
  assert.match(composerBarSource, /resizeObserver\?\.observe\(taskProgressBarElement\)/);
  assert.match(composerBarSource, /resizeObserver\?\.observe\(composerColumnRef\.current\)/);
  assert.doesNotMatch(composerBarSource, /composerLayerHeight - queueHeight|queueHeight:/);
});

test("jump-to-bottom clears the full reserve without counting the pill twice", () => {
  const jumpButton = transcriptSource.match(/chat-jump-to-bottom[\s\S]*?<ChevronDown/)?.[0];
  assert.ok(jumpButton);
  assert.match(jumpButton, /left:\s*`calc\(50% \+ \$\{Math\.round\(composerCenterOffsetPx\)\}px\)`/);
  assert.match(jumpButton, /bottom:\s*Math\.ceil\(bottomReservePx\)\s*\+\s*16/);
  assert.doesNotMatch(transcriptSource, /floatingOverhangPx/);
});
