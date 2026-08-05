import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const modulePath = path.join(rootDir, "src/lib/chat-scroll/scrollFollowCore.ts");
const {
  BOTTOM_ATTACH_THRESHOLD_PX,
  BOTTOM_REATTACH_ZONE_PX,
  DEFAULT_FOLLOW_CONFIG,
  createFollowState,
  isDominantVerticalWheel,
  reduceFollowEvent,
} = createTsModuleLoader({ rootDir }).loadModule(modulePath);

function run(events, { state = createFollowState(), config = DEFAULT_FOLLOW_CONFIG } = {}) {
  let pin = false;
  for (const event of events) {
    const step = reduceFollowEvent(state, event, config);
    state = step.state;
    pin = step.pin;
  }
  return { state, pin };
}

const wheelUp = (over = {}) => ({
  type: "wheel",
  deltaX: 0,
  deltaY: -40,
  gap: 0,
  hasOverflow: true,
  nestedCanConsume: false,
  now: 0,
  ...over,
});
// Default gap sits off the clamp so wheel-down helpers don't accidentally hit
// the at-bottom re-engage branch; clamp tests pass gap explicitly.
const wheelDown = (over = {}) => wheelUp({ deltaY: 40, gap: 400, ...over });
const scroll = (gap, now = 0) => ({ type: "scroll", gap, now });
const growth = (gap) => ({ type: "contentGrowth", gap });

test("constants coupling: reserve band and DPR tolerance", () => {
  // ChatTranscript's bottom reserve minimum imports the zone constant; the
  // attach threshold must clear the fractional-DPR clamp shortfall (1-3px).
  assert.ok(BOTTOM_REATTACH_ZONE_PX >= 192);
  assert.ok(BOTTOM_ATTACH_THRESHOLD_PX >= 4);
});

test("fractional-DPR clamp shortfall attaches inside the latch (c4d6471)", () => {
  // Windows 125%/150% scaling clamps scrollTop 1-3px short of the physical
  // bottom; a latched downward arrival landing there must still attach (the
  // attach threshold covers the shortfall).
  const { state } = run([
    wheelUp({ now: 0 }),
    growth(500),
    wheelDown({ now: 9_800 }), // latch until 10_300
    scroll(3, 10_000),
  ]);
  assert.equal(state.following, true);
});

test("content shrink clamping a detached reader never re-attaches", () => {
  // A reply settling out of the row list (or a collapsing block) shrinks
  // scrollHeight; the browser clamps scrollTop and emits a scroll event at
  // the bottom with no input and no latch. Follow must stay off, and the
  // regrowth that lands right after must not pin — this was the "jump to
  // the bottom when the reply finishes" bug.
  const clamped = run([wheelUp({ now: 0 }), growth(2000), scroll(0, 10_000)]);
  assert.equal(clamped.state.following, false);
  // The clamp still counts as downward movement for a later release check.
  assert.equal(clamped.state.dragTowardBottom, true);

  const regrown = run([growth(1800)], { state: clamped.state });
  assert.equal(regrown.state.following, false);
  assert.equal(regrown.pin, false);
});

test("pin echo at the clamp keeps following without a latch", () => {
  // While following, our own pin write echoes back as a scroll event at the
  // clamp long after any input; it must keep follow engaged.
  const { state } = run([growth(0), scroll(2, 10_000)]);
  assert.equal(state.following, true);
});

test("WebView2 stale smooth-scroll frames are corrected, never detach (99fd109)", () => {
  // After a programmatic pin the compositor emits a few scroll frames from
  // its stale wheel trajectory. No input, no drag → re-pin instead of detach.
  const { state, pin } = run([growth(0), scroll(130, 0)]);
  assert.equal(state.following, true);
  assert.equal(pin, true);
});

test("ResizeObserver deliveries never change follow state (80ae9aa)", () => {
  const detached = run([wheelUp(), growth(400)]);
  assert.equal(detached.state.following, false);
  assert.equal(detached.state.lastGap, 400);
  assert.equal(detached.pin, false);

  const following = run([growth(400)]);
  assert.equal(following.state.following, true);
  assert.equal(following.pin, true);
});

test("growth bookkeeping keeps the next scroll's direction honest (80ae9aa)", () => {
  // Content growth widens the gap between scroll events; without recording it
  // the user's next downward arrival would read as "moving away".
  const { state, pin } = run([
    wheelUp({ now: 1_000 }),
    growth(200),
    wheelDown({ now: 1_100 }),
    scroll(150, 1_200),
  ]);
  assert.equal(state.following, true);
  assert.equal(pin, true);
});

test("gesture-latched downward arrival inside the zone attaches (c4d6471)", () => {
  const { state, pin } = run([
    wheelUp({ now: 0 }),
    growth(140),
    wheelDown({ now: 500 }),
    scroll(60, 700),
  ]);
  assert.equal(state.following, true);
  assert.equal(pin, true);
});

test("descending scroll chain extends an active latch through momentum", () => {
  // Windows touchscreen flings keep emitting scroll events long after the
  // last touchmove; each descending event inside the window renews the latch.
  const { state } = run([
    wheelUp({ now: 0 }),
    growth(1000),
    wheelDown({ now: 100 }), // latch until 600
    scroll(800, 500),
    scroll(600, 900),
    scroll(400, 1300),
    scroll(250, 1700),
    scroll(120, 2100), // far past the original deadline, still latched
  ]);
  assert.equal(state.following, true);
});

test("an expired latch cannot attach in the zone", () => {
  const { state } = run([
    wheelUp({ now: 0 }),
    growth(140),
    wheelDown({ now: 100 }), // latch until 600
    scroll(60, 5000),
  ]);
  assert.equal(state.following, false);
});

test("descending scroll cannot create a latch on its own", () => {
  // Layout shifts and stale frames may drift toward the bottom without any
  // input event; with no active latch they must not attach.
  const { state } = run([wheelUp({ now: 0 }), growth(400), scroll(60, 10_000)]);
  assert.equal(state.following, false);
});

test("away-move during a real pointer drag detaches (c4d6471)", () => {
  const { state } = run([
    growth(20),
    { type: "pointerDown" },
    { type: "pointerDragStart" },
    scroll(90, 0),
  ]);
  assert.equal(state.following, false);
});

test("a static click plus a layout echo never detaches", () => {
  // pointerHeld without drag promotion (no movement past the slop) must not
  // turn a virtualizer compensation event into a drag-detach.
  const { state, pin } = run([growth(20), { type: "pointerDown" }, scroll(90, 0)]);
  assert.equal(state.following, true);
  assert.equal(pin, true);
});

test("a scrollbar track click detaches while following", () => {
  // Base UI track clicks jump scrollTop synchronously on pointerdown with no
  // pointer movement, so the hook promotes scrollbar presses to a drag
  // immediately — the jump must take the detach branch, not be corrected.
  const { state, pin } = run([
    growth(20),
    { type: "pointerDown" },
    { type: "pointerDragStart" }, // hook: press landed on [data-scroll-area-scrollbar]
    scroll(400, 0),
  ]);
  assert.equal(state.following, false);
  assert.equal(pin, false);
});

test("held pointer suppresses zone attach; release inside the zone re-engages", () => {
  const midDrag = run([
    wheelUp({ now: 0 }),
    growth(400),
    { type: "pointerDown" },
    { type: "pointerDragStart" },
    wheelDown({ now: 100 }),
    scroll(60, 200),
  ]);
  assert.equal(midDrag.state.following, false);
  assert.equal(midDrag.state.dragTowardBottom, true);

  const released = run([{ type: "pointerRelease", gap: 60 }], { state: midDrag.state });
  assert.equal(released.state.following, true);
  assert.equal(released.pin, true);
  assert.equal(released.state.pointerHeld, false);
  assert.equal(released.state.pointerDragging, false);
});

test("release above the zone or after upward movement stays detached", () => {
  const aboveZone = run([
    wheelUp({ now: 0 }),
    growth(800),
    { type: "pointerDown" },
    { type: "pointerDragStart" },
    scroll(500, 0),
    { type: "pointerRelease", gap: BOTTOM_REATTACH_ZONE_PX + 1 },
  ]);
  assert.equal(aboveZone.state.following, false);

  const upward = run([
    growth(20),
    { type: "pointerDown" },
    { type: "pointerDragStart" },
    scroll(90, 0), // drag away → detach, dragTowardBottom=false
    { type: "pointerRelease", gap: 90 },
  ]);
  assert.equal(upward.state.following, false);
});

test("wheel-up consumed by a nested scroller never detaches (c4d6471)", () => {
  const consumed = run([wheelUp({ nestedCanConsume: true })]);
  assert.equal(consumed.state.following, true);

  const notConsumed = run([wheelUp({ nestedCanConsume: false })]);
  assert.equal(notConsumed.state.following, false);
});

test("small Windows wheel-up inside the bottom tolerance stays detached", () => {
  const detached = run([
    wheelDown({ gap: 20, now: 900 }),
    wheelUp({ now: 1_000 }),
    scroll(BOTTOM_ATTACH_THRESHOLD_PX - 1, 1_001),
  ]);
  assert.equal(detached.state.following, false);
  assert.equal(detached.state.latchUntil, 0);

  const grown = run([growth(40)], { state: detached.state });
  assert.equal(grown.state.following, false);
  assert.equal(grown.pin, false);
});

test("wheel-up without viewport overflow never detaches", () => {
  const { state } = run([wheelUp({ hasOverflow: false })]);
  assert.equal(state.following, true);
});

test("horizontal trackpad drift is not a vertical scroll gesture (c4d6471)", () => {
  assert.equal(isDominantVerticalWheel(-40, -3), false);
  assert.equal(isDominantVerticalWheel(0, -3), true);
  assert.equal(isDominantVerticalWheel(0, 0), false);
  assert.equal(isDominantVerticalWheel(2, 120), true);

  const { state } = run([wheelUp({ deltaX: -40, deltaY: -3 })]);
  assert.equal(state.following, true);
});

test("wheel-down while clamped at the bottom re-attaches", () => {
  // No scroll event fires at the clamp, so the wheel handler itself must be
  // able to recover a detached-at-bottom state.
  const { state, pin } = run([wheelUp(), wheelDown({ gap: 5, now: 100 })]);
  assert.equal(state.following, true);
  assert.equal(pin, true);
});

test("history keys detach; follow keys only arm the latch", () => {
  const history = run([
    { type: "followKey", now: 100 },
    { type: "historyKey", hasOverflow: true, now: 200 },
    scroll(BOTTOM_ATTACH_THRESHOLD_PX - 1, 201),
  ]);
  assert.equal(history.state.following, false);
  assert.equal(history.state.latchUntil, 0);

  const noOverflow = run([{ type: "historyKey", hasOverflow: false, now: 0 }]);
  assert.equal(noOverflow.state.following, true);

  const followed = run([
    wheelUp({ now: 0 }),
    growth(140),
    { type: "followKey", now: 100 },
    scroll(60, 200),
  ]);
  assert.equal(followed.state.following, true);
});

test("touch drags detach off the clamp; upward finger at the clamp does not", () => {
  const down = run([
    { type: "followKey", now: 100 },
    { type: "touchMove", fingerMovedDown: true, gap: 0, hasOverflow: true, now: 200 },
    scroll(BOTTOM_ATTACH_THRESHOLD_PX - 1, 201),
  ]);
  assert.equal(down.state.following, false);
  assert.equal(down.state.latchUntil, 0);

  const atClamp = run([
    { type: "touchMove", fingerMovedDown: false, gap: 5, hasOverflow: true, now: 0 },
  ]);
  assert.equal(atClamp.state.following, true);

  const offClamp = run([
    { type: "touchMove", fingerMovedDown: false, gap: 50, hasOverflow: true, now: 0 },
  ]);
  assert.equal(offClamp.state.following, false);
});

test("forceFollow overrides everything and pins", () => {
  const { state, pin } = run([
    wheelUp({ now: 0 }),
    { type: "pointerDown" },
    { type: "pointerDragStart" },
    { type: "forceFollow" },
  ]);
  assert.equal(state.following, true);
  assert.equal(pin, true);
  assert.equal(state.pointerDragging, false);
  assert.equal(state.latchUntil, 0);
  // The physical press is still down.
  assert.equal(state.pointerHeld, true);
});

test("zone-less config (thinking block) still re-engages on release at the clamp", () => {
  const config = { ...DEFAULT_FOLLOW_CONFIG, reattachZonePx: 0 };
  const { state, pin } = run(
    [
      wheelUp({ now: 0 }),
      growth(200),
      { type: "pointerDown" },
      { type: "pointerDragStart" },
      scroll(5, 100), // lands at the clamp mid-drag → attach branch
      { type: "pointerRelease", gap: 5 },
    ],
    { config },
  );
  assert.equal(state.following, true);
  assert.equal(pin, true);

  // But a zone-sized gap must not attach on release when the zone is 0.
  const detached = run(
    [
      wheelUp({ now: 0 }),
      growth(400),
      { type: "pointerDown" },
      { type: "pointerDragStart" },
      wheelDown({ now: 50 }),
      scroll(60, 100),
      { type: "pointerRelease", gap: 60 },
    ],
    { config },
  );
  assert.equal(detached.state.following, false);
});

test("sub-slop gap wiggle never changes direction bookkeeping", () => {
  const { state } = run([wheelUp({ now: 0 }), growth(30), scroll(30.5, 100)]);
  assert.equal(state.following, false);
  assert.equal(state.dragTowardBottom, null);
});
