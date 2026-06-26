import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

if (typeof globalThis.window === "undefined") {
  globalThis.window = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
}

const loader = createWebModuleLoader();
const trackerModule = loader.loadModule("src/lib/chatRunTracker.ts");
const { ChatRunTracker, resolveRunKey } = trackerModule;

function makeRuntime(runId, extras = {}) {
  return { runId, workdir: "/tmp", firstSeq: 1, runEpoch: 1, updatedAt: Date.now(), ...extras };
}

test("queued_in_gui -> remote_running sets correct state", () => {
  const tracker = new ChatRunTracker();
  const id = "conv-1";

  tracker.markQueuedInGui(id);
  assert.equal(tracker.getState(id), "queued_in_gui");
  assert.equal(tracker.isAwaitingRemote(id), true);

  const runtime = makeRuntime("run-1");
  tracker.markRemoteRunning(id, runtime);
  assert.equal(tracker.getState(id), "remote_running");
  assert.equal(tracker.isRemoteRunning(id), true);
  assert.equal(tracker.getRunId(id), "run-1");
  assert.equal(tracker.isAwaitingRemote(id), false);
});

test("remote_running -> markCompleted sets completedAt and completedRunId", () => {
  const tracker = new ChatRunTracker();
  const id = "conv-2";
  tracker.markRemoteRunning(id, makeRuntime("run-2"));
  assert.equal(tracker.getState(id), "remote_running");

  tracker.markCompleted(id);
  assert.equal(tracker.getState(id), "idle");

  const entry = tracker.getFullEntry(id);
  assert.ok(entry.completedAt !== null, "completedAt should be set");
  assert.equal(entry.completedRunId, "run-2");
});

test("markCancelled does not set completedAt", () => {
  const tracker = new ChatRunTracker();
  const id = "conv-3";
  tracker.markRemoteRunning(id, makeRuntime("run-3"));

  tracker.markCancelled(id);
  assert.equal(tracker.getState(id), "idle");

  const entry = tracker.getFullEntry(id);
  assert.equal(entry.completedAt, null, "completedAt should NOT be set after cancel");
  assert.equal(entry.completedRunId, "", "completedRunId should be empty after cancel");
});

test("idle -> remote_running after cancel succeeds immediately", () => {
  const tracker = new ChatRunTracker();
  const id = "conv-4";

  tracker.markRemoteRunning(id, makeRuntime("run-a"));
  tracker.markCancelled(id);
  assert.equal(tracker.getState(id), "idle");

  tracker.markRemoteRunning(id, makeRuntime("run-b"));
  assert.equal(tracker.getState(id), "remote_running");
  assert.equal(tracker.getRunId(id), "run-b");
});

test("shouldSuppressIdleEvent suppresses same run ID within 30s", () => {
  const tracker = new ChatRunTracker();
  const id = "conv-5";

  tracker.markRemoteRunning(id, makeRuntime("run-x"));
  tracker.markCompleted(id);

  assert.equal(
    tracker.shouldSuppressIdleEvent(id, "run-x"),
    true,
    "should suppress idle for same run that just completed",
  );

  assert.equal(
    tracker.shouldSuppressIdleEvent(id, "run-y"),
    false,
    "should NOT suppress idle for a different run",
  );
});

test("shouldSuppressIdleEvent does not suppress after cancel", () => {
  const tracker = new ChatRunTracker();
  const id = "conv-6";

  tracker.markRemoteRunning(id, makeRuntime("run-c"));
  tracker.markCancelled(id);

  assert.equal(
    tracker.shouldSuppressIdleEvent(id, "run-c"),
    false,
    "cancel should not cause suppression",
  );
  assert.equal(
    tracker.shouldSuppressIdleEvent(id, "run-d"),
    false,
    "cancel should not cause suppression for any run",
  );
});

test("remote_running with new run ID aborts old event stream controller", () => {
  const tracker = new ChatRunTracker();
  const id = "conv-7";

  tracker.markRemoteRunning(id, makeRuntime("run-1"));
  const oldController = new AbortController();
  tracker.setEventStreamController(id, oldController, "run-1");
  assert.equal(tracker.hasActiveStream(id), true);

  tracker.markRemoteRunning(id, makeRuntime("run-2"));
  assert.equal(oldController.signal.aborted, true, "old controller should be aborted");
  assert.equal(tracker.getEventStreamRunKey(id), "", "event stream run key should be cleared");
});

test("canSubscribeEventStream returns true for queue and running states", () => {
  const tracker = new ChatRunTracker();
  const id = "conv-8";

  assert.equal(tracker.canSubscribeEventStream(id), false, "idle should not subscribe");

  tracker.markQueuedInGui(id);
  assert.equal(tracker.canSubscribeEventStream(id), true, "queued_in_gui should subscribe");

  tracker.markRemoteRunning(id, makeRuntime("run-1"));
  assert.equal(tracker.canSubscribeEventStream(id), true, "remote_running should subscribe");

  tracker.markCompleted(id);
  assert.equal(tracker.canSubscribeEventStream(id), false, "idle (completed) should not subscribe");
});

test("onReconcile fires on state transitions", () => {
  const tracker = new ChatRunTracker();
  const id = "conv-9";
  const reconciled = [];
  tracker.onReconcile((cid) => reconciled.push(cid));

  tracker.markSending(id, new AbortController());
  tracker.markQueuedInGui(id);
  tracker.markRemoteRunning(id, makeRuntime("run-1"));
  tracker.markCompleted(id);

  assert.deepEqual(reconciled, [id, id, id, id], "reconcile should fire on each transition");
});

test("resolveRunKey extracts trimmed runId", () => {
  assert.equal(resolveRunKey(null), "");
  assert.equal(resolveRunKey(undefined), "");
  assert.equal(resolveRunKey({ runId: "" }), "");
  assert.equal(resolveRunKey({ runId: "  run-1  " }), "run-1");
  assert.equal(resolveRunKey({ runId: "run-2" }), "run-2");
});

test("markRemoteRunning ignores empty runId", () => {
  const tracker = new ChatRunTracker();
  const id = "conv-10";
  tracker.markRemoteRunning(id, makeRuntime(""));
  assert.equal(tracker.getState(id), "idle", "should remain idle for empty runId");
});

test("snapshot reflects running state", () => {
  const tracker = new ChatRunTracker();
  const id = "conv-11";
  const runtime = makeRuntime("run-1");

  let snap = tracker.getSnapshot();
  assert.equal(snap.remoteRunningIds.has(id), false);

  tracker.markRemoteRunning(id, runtime);
  snap = tracker.getSnapshot();
  assert.equal(snap.remoteRunningIds.has(id), true);
  assert.deepEqual(snap.remoteRuntime.get(id), runtime);

  tracker.markCompleted(id);
  snap = tracker.getSnapshot();
  assert.equal(snap.remoteRunningIds.has(id), false);
});
