import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

function freshModule() {
  // 模块持有会话级缓冲，每个用例要一份干净的实例。
  const loader = createWebModuleLoader({
    rootDir: fileURLToPath(new URL("../", import.meta.url)),
  });
  return loader.loadModule("src/lib/trajectory/liveTrajectory.ts");
}

test("only trajectory events are absorbed; everything else passes through", () => {
  const live = freshModule();
  assert.equal(live.absorbTrajectoryChatEvent({ type: "token", conversation_id: "c1" }), false);
  assert.equal(live.absorbTrajectoryChatEvent({ type: "run_started", conversation_id: "c1" }), false);
  assert.equal(
    live.absorbTrajectoryChatEvent({
      type: "trajectory",
      conversation_id: "c1",
      event: { k: "user", t: 1, at: 1 },
    }),
    true,
  );
  assert.equal(live.liveTrajectoryEvents("c1").length, 1);
});

test("a rebase clears stale live trajectory but still reaches the transcript", () => {
  const live = freshModule();
  live.absorbTrajectoryChatEvent({
    type: "trajectory",
    conversation_id: "c1",
    event: { k: "user", t: 4, at: 1 },
  });
  assert.equal(live.liveTrajectoryEvents("c1").length, 1);
  assert.equal(
    live.absorbTrajectoryChatEvent({ type: "rebased", conversation_id: "c1" }),
    false,
  );
  assert.equal(live.liveTrajectoryEvents("c1").length, 0);
});

test("a trajectory event without a conversation or payload is swallowed, not stored", () => {
  const live = freshModule();
  assert.equal(live.absorbTrajectoryChatEvent({ type: "trajectory", event: { k: "user" } }), true);
  assert.equal(
    live.absorbTrajectoryChatEvent({ type: "trajectory", conversation_id: "c1", event: null }),
    true,
  );
  assert.equal(live.liveTrajectoryEvents("c1").length, 0);
});

test("events are bucketed per conversation", () => {
  const live = freshModule();
  live.absorbTrajectoryChatEvent({
    type: "trajectory",
    conversation_id: "a",
    event: { k: "user", t: 1, at: 1 },
  });
  live.absorbTrajectoryChatEvent({
    type: "trajectory",
    conversation_id: "b",
    event: { k: "user", t: 1, at: 1 },
  });
  live.absorbTrajectoryChatEvent({
    type: "trajectory",
    conversation_id: "b",
    event: { k: "step_start", t: 1, s: 1, at: 2 },
  });
  assert.equal(live.liveTrajectoryEvents("a").length, 1);
  assert.equal(live.liveTrajectoryEvents("b").length, 2);
  assert.equal(live.liveTrajectoryEvents("missing").length, 0);
});

test("an exact reconnect replay is idempotent", () => {
  const live = freshModule();
  const event = { k: "step_start", t: 7, s: 2, at: 99 };
  live.absorbTrajectoryChatEvent({ type: "trajectory", conversation_id: "c1", event });
  live.absorbTrajectoryChatEvent({ type: "trajectory", conversation_id: "c1", event: { ...event } });
  assert.equal(live.liveTrajectoryEvents("c1").length, 1);
});

test("the snapshot reference is stable until new events arrive", () => {
  const live = freshModule();
  const empty = live.liveTrajectoryEvents("c1");
  assert.equal(live.liveTrajectoryEvents("c1"), empty, "empty buckets share one reference");

  live.absorbTrajectoryChatEvent({ type: "trajectory", conversation_id: "c1", event: { k: "user" } });
  const first = live.liveTrajectoryEvents("c1");
  assert.equal(live.liveTrajectoryEvents("c1"), first, "no change means the same reference");

  live.absorbTrajectoryChatEvent({
    type: "trajectory",
    conversation_id: "c1",
    event: { k: "step_start" },
  });
  const second = live.liveTrajectoryEvents("c1");
  // useSyncExternalStore 用 Object.is 比较；同引用会让它认为「没变化」而不重渲染。
  assert.notEqual(second, first, "a new event must produce a new reference");
  assert.equal(second.length, 2);
});

test("clearing a conversation drops its buffer", () => {
  const live = freshModule();
  live.absorbTrajectoryChatEvent({ type: "trajectory", conversation_id: "c1", event: { k: "user" } });
  live.clearLiveTrajectory("c1");
  assert.equal(live.liveTrajectoryEvents("c1").length, 0);
});

test("subscribers are notified once per coalesce window and can unsubscribe", async () => {
  const live = freshModule();
  let calls = 0;
  const unsubscribe = live.subscribeLiveTrajectory(() => {
    calls += 1;
  });

  for (let index = 0; index < 5; index += 1) {
    live.absorbTrajectoryChatEvent({
      type: "trajectory",
      conversation_id: "c1",
      event: { k: "step_start", s: index },
    });
  }
  assert.equal(calls, 0, "notifications are deferred, not synchronous");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(calls, 1, "five events collapse into one notification");

  unsubscribe();
  live.absorbTrajectoryChatEvent({ type: "trajectory", conversation_id: "c1", event: { k: "user" } });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(calls, 1);
});

test("a throwing subscriber does not stop the others", async () => {
  const live = freshModule();
  let reached = false;
  live.subscribeLiveTrajectory(() => {
    throw new Error("listener exploded");
  });
  live.subscribeLiveTrajectory(() => {
    reached = true;
  });
  live.absorbTrajectoryChatEvent({ type: "trajectory", conversation_id: "c1", event: { k: "user" } });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(reached, true);
});

test("replayed trajectory frames are deduplicated before reaching the ledger", () => {
  const live = freshModule();
  live.clearLiveTrajectory("replay-c1");
  const frame = {
    type: "trajectory",
    conversation_id: "replay-c1",
    event: { k: "step_start", t: 9, s: 1, at: 1234 },
  };
  assert.equal(live.absorbTrajectoryChatEvent(frame), true);
  assert.equal(live.absorbTrajectoryChatEvent(frame), true);
  assert.equal(live.liveTrajectoryEvents("replay-c1").length, 1);
  live.clearLiveTrajectory("replay-c1");
});

test("exact replayed trajectory events are deduplicated in the live buffer", () => {
  const live = freshModule();
  live.clearLiveTrajectory("dedupe-c");
  const frame = {
    type: "trajectory",
    conversation_id: "dedupe-c",
    event: { k: "step_start", t: 7, s: 1, at: 123 },
  };
  live.absorbTrajectoryChatEvent(frame);
  live.absorbTrajectoryChatEvent(frame);
  assert.equal(live.liveTrajectoryEvents("dedupe-c").length, 1);
});

test("rebasing clears the live tail and advances the authoritative refresh revision", () => {
  const live = freshModule();
  live.clearLiveTrajectory("rebase-revision-c");
  const before = live.liveTrajectoryRefreshRevision("rebase-revision-c");
  live.absorbTrajectoryChatEvent({
    type: "trajectory",
    conversation_id: "rebase-revision-c",
    event: { k: "user", t: 1, at: 1 },
  });
  live.absorbTrajectoryChatEvent({ type: "rebased", conversation_id: "rebase-revision-c" });
  assert.equal(live.liveTrajectoryEvents("rebase-revision-c").length, 0);
  assert.equal(live.liveTrajectoryRefreshRevision("rebase-revision-c"), before + 1);
});
