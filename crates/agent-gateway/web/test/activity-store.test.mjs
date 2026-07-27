import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});

const { createActivityStore } = loader.loadModule("src/lib/chat/stream/activityStore.ts");

test("activity events drive the running map with run identity", () => {
  const store = createActivityStore();
  let notifications = 0;
  store.subscribe(() => {
    notifications += 1;
  });

  store.applyActivityEvent({
    conversationId: "conv-1",
    runId: "run-1",
    running: true,
    state: "running",
    workdir: "/workspace",
    updatedAt: 10,
  });
  assert.equal(store.isRunning("conv-1"), true);
  assert.equal(store.get("conv-1")?.runId, "run-1");
  assert.equal(notifications, 1);

  // Duplicate state is ignored.
  store.applyActivityEvent({
    conversationId: "conv-1",
    runId: "run-1",
    running: true,
    state: "running",
    workdir: "/workspace",
    updatedAt: 11,
  });
  assert.equal(notifications, 1);

  // A stale event (older than what we show) is ignored.
  store.applyActivityEvent({
    conversationId: "conv-1",
    runId: "run-0",
    running: true,
    state: "running",
    workdir: "/workspace",
    updatedAt: 5,
  });
  assert.equal(store.get("conv-1")?.runId, "run-1");

  store.applyActivityEvent({
    conversationId: "conv-1",
    runId: "run-1",
    running: false,
    state: null,
    workdir: null,
    updatedAt: 20,
  });
  assert.equal(store.isRunning("conv-1"), false);
  assert.equal(notifications, 2);
});

test("hydration drops stale entries and adopts the snapshot", () => {
  let clock = 0;
  const store = createActivityStore({ now: () => clock });
  store.applyActivityEvent({
    conversationId: "conv-stale",
    runId: "run-stale",
    running: true,
    state: "running",
    workdir: null,
    clientRequestId: null,
    updatedAt: 1,
  });

  clock = 60_000;
  store.hydrate([
    { conversationId: "conv-1", runId: "run-1", state: "running", workdir: "/w", updatedAt: 2 },
    { conversationId: "conv-2", runId: "run-2", state: "cancelling", updatedAt: 3 },
  ]);

  assert.equal(
    store.isRunning("conv-stale"),
    false,
    "entry older than the snapshot batch is dropped",
  );
  assert.equal(store.get("conv-1")?.runId, "run-1");
  assert.equal(store.get("conv-2")?.state, "cancelling");
});

test("hydration merges present entries newer-wins and drops stale absent ones", () => {
  let clock = 0;
  const store = createActivityStore({ now: () => clock });
  // A chat.activity push arrived after the history.list response was built.
  store.applyActivityEvent({
    conversationId: "conv-1",
    runId: "run-2",
    running: true,
    state: "running",
    workdir: "/w",
    clientRequestId: null,
    updatedAt: 30,
  });
  // Absent from the batch and received long ago: the authoritative snapshot
  // says it is not running, so it is dropped even though its updatedAt is
  // newer than every batch item (this is exactly the missed-stop zombie).
  store.applyActivityEvent({
    conversationId: "conv-live",
    runId: "run-live",
    running: true,
    state: "running",
    workdir: null,
    clientRequestId: null,
    updatedAt: 50,
  });

  clock = 60_000; // both pushes are now well past the recent-push window
  store.hydrate([
    // Stale row for conv-1 (the snapshot predates the run-2 handoff).
    { conversationId: "conv-1", runId: "run-1", state: "running", workdir: "/w", updatedAt: 10 },
    { conversationId: "conv-other", runId: "run-9", state: "running", updatedAt: 40 },
  ]);

  assert.equal(store.get("conv-1")?.runId, "run-2", "newer push beats the stale snapshot row");
  assert.equal(
    store.isRunning("conv-live"),
    false,
    "stale entry absent from the batch is dropped even with a newer updatedAt",
  );
  assert.equal(store.get("conv-other")?.runId, "run-9");
});

test("hydration keeps a just-received push absent from the batch", () => {
  let clock = 0;
  const store = createActivityStore({ now: () => clock });
  // A remote run's push lands moments before a batch built just too early to
  // include it; dropping it would blank a genuinely running conversation.
  store.applyActivityEvent({
    conversationId: "conv-fresh",
    runId: "run-fresh",
    running: true,
    state: "running",
    workdir: null,
    clientRequestId: null,
    updatedAt: 100,
  });

  clock = 5_000; // within the recent-push keep window
  store.hydrate([{ conversationId: "conv-1", runId: "run-1", state: "running", updatedAt: 10 }]);
  assert.equal(store.isRunning("conv-fresh"), true, "fresh push survives the stale batch");

  clock = 60_000; // past the window: the gateway's omission is authoritative
  store.hydrate([{ conversationId: "conv-1", runId: "run-1", state: "running", updatedAt: 10 }]);
  assert.equal(store.isRunning("conv-fresh"), false, "aged-out entry is dropped");
});

test("hydration keeps absent conversations listed in keepConversationIds", () => {
  let clock = 0;
  const store = createActivityStore({ now: () => clock });
  store.applyActivityEvent({
    conversationId: "conv-pending",
    runId: "run-pending",
    running: true,
    state: "running",
    workdir: null,
    clientRequestId: null,
    updatedAt: 5,
  });
  store.applyActivityEvent({
    conversationId: "conv-gone",
    runId: "run-gone",
    running: true,
    state: "running",
    workdir: null,
    clientRequestId: null,
    updatedAt: 5,
  });

  clock = 60_000;
  store.hydrate(
    [{ conversationId: "conv-1", runId: "run-1", state: "running", updatedAt: 10 }],
    { keepConversationIds: new Set(["conv-pending"]) },
  );

  assert.equal(
    store.isRunning("conv-pending"),
    true,
    "locally pending conversation survives the authoritative batch",
  );
  assert.equal(store.isRunning("conv-gone"), false, "unlisted absent entry still dropped");
  assert.equal(store.get("conv-1")?.runId, "run-1");
});

test("settleRun clears the entry only on exact run identity", () => {
  const store = createActivityStore();
  let notifications = 0;
  store.subscribe(() => {
    notifications += 1;
  });
  store.applyActivityEvent({
    conversationId: "conv-1",
    runId: "run-2",
    running: true,
    state: "running",
    workdir: null,
    clientRequestId: null,
    updatedAt: 10,
  });
  assert.equal(notifications, 1);

  // A stale terminal for a superseded run must not clear the newer run's dot.
  store.settleRun("conv-1", "run-1");
  assert.equal(store.isRunning("conv-1"), true, "wrong run id leaves the entry");
  assert.equal(notifications, 1, "no notification without a change");

  // An empty run id matches nothing.
  store.settleRun("conv-1", "");
  assert.equal(store.isRunning("conv-1"), true);

  // Unknown conversation: no-op.
  store.settleRun("conv-x", "run-2");
  assert.equal(notifications, 1);

  store.settleRun("conv-1", "run-2");
  assert.equal(store.isRunning("conv-1"), false, "identity match settles the entry");
  assert.equal(notifications, 2);
});

test("a locally settled run cannot be resurrected by cancelling pushes or hydration", () => {
  const store = createActivityStore();
  store.applyActivityEvent({
    conversationId: "conv-1",
    runId: "run-1",
    running: true,
    state: "running",
    workdir: null,
    clientRequestId: null,
    updatedAt: 10,
  });

  store.settleRunLocally("conv-1", "run-1");
  store.applyActivityEvent({
    conversationId: "conv-1",
    runId: "run-1",
    running: true,
    state: "cancelling",
    workdir: null,
    clientRequestId: null,
    updatedAt: 11,
  });
  store.hydrate([
    { conversationId: "conv-1", runId: "run-1", state: "cancelling", updatedAt: 11 },
  ]);
  assert.equal(store.isRunning("conv-1"), false);

  store.releaseSettledRun("conv-1", "run-1");
  store.applyActivityEvent({
    conversationId: "conv-1",
    runId: "run-1",
    running: true,
    state: "running",
    workdir: null,
    clientRequestId: null,
    updatedAt: 12,
  });
  assert.equal(store.isRunning("conv-1"), true, "failed cancellation can be resynced");

  store.settleRunLocally("conv-1", "run-1");
  store.applyActivityEvent({
    conversationId: "conv-1",
    runId: "run-2",
    running: true,
    state: "running",
    workdir: null,
    clientRequestId: null,
    updatedAt: 13,
  });
  assert.equal(store.get("conv-1")?.runId, "run-2", "a newer run is never suppressed");
});

test("terminal confirmation prevents a failed cancel request from reviving the finished run", () => {
  const store = createActivityStore();
  store.applyActivityEvent({
    conversationId: "conv-1",
    runId: "run-1",
    running: true,
    state: "running",
    workdir: null,
    clientRequestId: null,
    updatedAt: 10,
  });

  store.settleRunLocally("conv-1", "run-1");
  store.settleRun("conv-1", "run-1");
  assert.equal(store.releaseSettledRun("conv-1", "run-1"), false);
  store.applyActivityEvent({
    conversationId: "conv-1",
    runId: "run-1",
    running: true,
    state: "cancelling",
    workdir: null,
    clientRequestId: null,
    updatedAt: 11,
  });
  assert.equal(store.isRunning("conv-1"), false);
});

test("filtering a stopped run from hydration preserves a recent push for another conversation", () => {
  let now = 1_000;
  const store = createActivityStore({ now: () => now });
  store.applyActivityEvent({
    conversationId: "conv-a",
    runId: "run-a",
    running: true,
    state: "running",
    workdir: null,
    clientRequestId: null,
    updatedAt: 10,
  });
  store.settleRunLocally("conv-a", "run-a");
  now += 1;
  store.applyActivityEvent({
    conversationId: "conv-b",
    runId: "run-b",
    running: true,
    state: "running",
    workdir: null,
    clientRequestId: null,
    updatedAt: 11,
  });

  store.hydrate([
    { conversationId: "conv-a", runId: "run-a", state: "cancelling", updatedAt: 10 },
  ]);
  assert.equal(store.get("conv-b")?.runId, "run-b");
  assert.equal(store.isRunning("conv-a"), false);
});

test("an empty hydration snapshot means idle everywhere", () => {
  const store = createActivityStore();
  store.applyActivityEvent({
    conversationId: "conv-1",
    runId: "run-1",
    running: true,
    state: "running",
    workdir: null,
    clientRequestId: null,
    updatedAt: 100,
  });
  store.hydrate([]);
  assert.equal(store.isRunning("conv-1"), false);
});
