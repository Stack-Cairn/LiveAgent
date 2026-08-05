import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const modulePath = path.join(rootDir, "src/lib/transcript-virtual/liveScrollAdjustPolicy.ts");
const { createLiveRowScrollAdjustPolicy } = createTsModuleLoader({ rootDir }).loadModule(
  modulePath,
);

const makeItem = ({ index = 5, start, size }) => ({
  index,
  key: index,
  start,
  size,
  end: start + size,
  lane: 0,
});

const makeInstance = ({
  scrollOffset = 1000,
  scrollDirection = null,
  scrollAdjustments = 0,
  measuredKeys = [],
} = {}) => ({
  scrollOffset,
  scrollDirection,
  scrollAdjustments,
  itemSizeCache: new Map(measuredKeys.map((key) => [key, 1])),
});

const makePolicy = ({ liveStartIndex = -1, following = false } = {}) =>
  createLiveRowScrollAdjustPolicy({
    getLiveStartIndex: () => liveStartIndex,
    isFollowing: () => following,
  });

test("row entirely above the viewport keeps the default compensation", () => {
  const policy = makePolicy();
  const item = makeItem({ index: 1, start: 100, size: 200 });
  assert.equal(policy(item, 40, makeInstance()), true);
  assert.equal(policy(item, -40, makeInstance()), true);
});

test("row starting at or below the viewport top never adjusts", () => {
  const policy = makePolicy();
  assert.equal(policy(makeItem({ start: 1000, size: 200 }), 40, makeInstance()), false);
  assert.equal(policy(makeItem({ start: 1200, size: 200 }), 40, makeInstance()), false);
});

test("backward scroll suppresses re-measurements only (upstream 3.17.1 default)", () => {
  const policy = makePolicy();
  const item = makeItem({ index: 1, start: 100, size: 200 });
  // A row measured before jumps when re-measured during backward scroll.
  assert.equal(
    policy(item, 40, makeInstance({ scrollDirection: "backward", measuredKeys: [1] })),
    false,
  );
  // A first-ever measurement must land its estimate→actual delta regardless
  // of direction — this is the upstream "items jump while scrolling up" fix.
  assert.equal(policy(item, 40, makeInstance({ scrollDirection: "backward" })), true);
  assert.equal(
    policy(item, 40, makeInstance({ scrollDirection: "forward", measuredKeys: [1] })),
    true,
  );
});

test("detached reader inside the growing live row is left alone (streaming creep)", () => {
  const policy = makePolicy({ liveStartIndex: 5, following: false });
  // Live row spans 400..5400, viewport top at 3000: the reader scrolled up
  // into the streaming reply. Growth appends below the reading line.
  const item = makeItem({ index: 5, start: 400, size: 5000 });
  assert.equal(policy(item, 60, makeInstance({ scrollOffset: 3000, measuredKeys: [5] })), false);
});

test("the same live-row growth while following keeps compensating (pin assist)", () => {
  const policy = makePolicy({ liveStartIndex: 5, following: true });
  const item = makeItem({ index: 5, start: 400, size: 5000 });
  assert.equal(policy(item, 60, makeInstance({ scrollOffset: 3000, measuredKeys: [5] })), true);
});

test("live-row shrink keeps compensating so content under the reader stays put", () => {
  const policy = makePolicy({ liveStartIndex: 5, following: false });
  const item = makeItem({ index: 5, start: 400, size: 5000 });
  assert.equal(policy(item, -80, makeInstance({ scrollOffset: 3000, measuredKeys: [5] })), true);
});

test("settled row straddling the viewport keeps the default", () => {
  const policy = makePolicy({ liveStartIndex: 5, following: false });
  const item = makeItem({ index: 2, start: 400, size: 5000 });
  assert.equal(policy(item, 60, makeInstance({ scrollOffset: 3000, measuredKeys: [2] })), true);
});

test("idle transcript (liveStartIndex -1) keeps the default everywhere", () => {
  const policy = makePolicy({ liveStartIndex: -1, following: false });
  const item = makeItem({ index: 5, start: 400, size: 5000 });
  assert.equal(policy(item, 60, makeInstance({ scrollOffset: 3000, measuredKeys: [5] })), true);
});

test("live row entirely above the viewport still compensates", () => {
  const policy = makePolicy({ liveStartIndex: 5, following: false });
  // end (300) <= viewport top (1000): the growth lands above the reader.
  const item = makeItem({ index: 5, start: 100, size: 200 });
  assert.equal(policy(item, 40, makeInstance({ scrollOffset: 1000, measuredKeys: [5] })), true);
});

test("pending scroll adjustments fold into the viewport-top comparison", () => {
  const policy = makePolicy();
  const item = makeItem({ index: 1, start: 1040, size: 5 });
  // Without pending adjustments the row start sits below the viewport top…
  assert.equal(policy(item, 40, makeInstance({ scrollOffset: 1000 })), false);
  // …with 50px of un-echoed writes it counts as above, like upstream.
  assert.equal(policy(item, 40, makeInstance({ scrollOffset: 1000, scrollAdjustments: 50 })), true);
});

test("missing private scrollAdjustments field falls back to zero", () => {
  const policy = makePolicy();
  const item = makeItem({ index: 1, start: 100, size: 200 });
  assert.equal(
    policy(item, 40, { scrollOffset: 1000, scrollDirection: null, itemSizeCache: new Map() }),
    true,
  );
});
