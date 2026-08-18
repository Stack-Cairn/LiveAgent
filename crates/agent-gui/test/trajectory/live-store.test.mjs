import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createTrajectoryLiveStore } = loader.loadModule(
  "@liveagent/ui/lib/trajectory/liveStore.ts",
);

test("live store deduplicates semantic replays and keeps snapshot identity stable", () => {
  const store = createTrajectoryLiveStore({ notifyDelayMs: 0 });
  const event = { k: "user", t: 1, at: 1, id: "u1" };
  assert.equal(store.append("c1", [event]), true);
  const first = store.getSnapshot("c1");
  assert.equal(store.append("c1", [{ ...event }]), false);
  assert.equal(store.getSnapshot("c1"), first);
  assert.equal(first.length, 1);
});

test("live store enforces per-conversation and global LRU bounds", () => {
  const store = createTrajectoryLiveStore({
    maxEventsPerConversation: 3,
    maxTotalEvents: 4,
    maxConversations: 2,
    notifyDelayMs: 0,
  });
  store.append("a", [
    { k: "user", t: 1, at: 1 },
    { k: "step_start", t: 1, s: 1, at: 2 },
    { k: "first_token", t: 1, s: 1, at: 3 },
    { k: "step_end", t: 1, s: 1, at: 4, st: "complete" },
  ]);
  assert.deepEqual(
    store.getSnapshot("a").map((event) => event.k),
    ["step_start", "first_token", "step_end"],
  );
  store.append("b", [{ k: "user", t: 2, at: 5 }]);
  // Touch b so a remains the least-recently-used bucket.
  store.getSnapshot("b");
  store.append("c", [{ k: "user", t: 3, at: 6 }]);
  assert.equal(store.getSnapshot("a").length, 0);
  assert.deepEqual(store.stats(), { conversations: 2, events: 2 });
});

test("a throwing live listener cannot block healthy subscribers", async () => {
  const store = createTrajectoryLiveStore({ notifyDelayMs: 0 });
  let healthy = 0;
  store.subscribe(() => {
    throw new Error("boom");
  });
  store.subscribe(() => {
    healthy += 1;
  });
  store.append("c1", [{ k: "user", t: 1, at: 1 }]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(healthy, 1);
});

test("an external revision invalidation notifies subscribers without changing snapshots", async () => {
  const store = createTrajectoryLiveStore({ notifyDelayMs: 0 });
  let notifications = 0;
  store.subscribe(() => {
    notifications += 1;
  });
  const snapshot = store.getSnapshot("c1");
  store.invalidate();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(notifications, 1);
  assert.equal(store.getSnapshot("c1"), snapshot);
});
