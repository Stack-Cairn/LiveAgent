import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const {
  appendDesktopLiveTrajectory,
  clearDesktopLiveTrajectory,
  desktopLiveTrajectoryEvents,
} = loader.loadModule("src/lib/trajectory/liveTrajectory.ts");
const { acquireTrajectoryRecorder, discardTrajectoryRecorder } = loader.loadModule(
  "src/lib/trajectory/recorderRegistry.ts",
);

test("desktop live trajectory snapshots update and clear per conversation", () => {
  clearDesktopLiveTrajectory("desktop-live-c1");
  const empty = desktopLiveTrajectoryEvents("desktop-live-c1");
  appendDesktopLiveTrajectory("desktop-live-c1", [{ k: "user", t: 1, at: 1 }]);
  const first = desktopLiveTrajectoryEvents("desktop-live-c1");
  assert.equal(first.length, 1);
  assert.notEqual(first, empty);
  appendDesktopLiveTrajectory("desktop-live-c1", [{ k: "turn_end", t: 1, at: 2, st: "complete" }]);
  const second = desktopLiveTrajectoryEvents("desktop-live-c1");
  assert.equal(second.length, 2);
  assert.notEqual(second, first);
  clearDesktopLiveTrajectory("desktop-live-c1");
  assert.equal(desktopLiveTrajectoryEvents("desktop-live-c1").length, 0);
});

test("desktop production store deduplicates replays and enforces the shared global bound", () => {
  const prefix = "desktop-live-bounds";
  const conversationIds = Array.from({ length: 6 }, (_, index) => `${prefix}-${index}`);
  const events = (turnOffset) =>
    Array.from({ length: 20_000 }, (_, index) => ({
      k: "user",
      t: turnOffset + index,
      at: index,
    }));

  appendDesktopLiveTrajectory(conversationIds[0], [{ k: "user", t: -1, at: -1 }]);
  appendDesktopLiveTrajectory(conversationIds[0], [{ k: "user", t: -1, at: -1 }]);
  assert.equal(desktopLiveTrajectoryEvents(conversationIds[0]).length, 1);
  clearDesktopLiveTrajectory(conversationIds[0]);

  for (const [index, conversationId] of conversationIds.entries()) {
    appendDesktopLiveTrajectory(conversationId, events(index * 20_000));
  }
  assert.equal(desktopLiveTrajectoryEvents(conversationIds[0]).length, 0);
  assert.equal(
    conversationIds
      .slice(1)
      .reduce((total, conversationId) => total + desktopLiveTrajectoryEvents(conversationId).length, 0),
    100_000,
  );

  for (const conversationId of conversationIds) clearDesktopLiveTrajectory(conversationId);
});

test("the recorder appends locally and publishes each event once", () => {
  const conversationId = "desktop-live-recorder-c1";
  const published = [];
  clearDesktopLiveTrajectory(conversationId);
  const { recorder } = acquireTrajectoryRecorder(conversationId, 0, (events) => {
    published.push(...events);
  });

  try {
    recorder.beginTurn({ turn: 1, messageIndex: 0, text: "hello" });
    assert.equal(desktopLiveTrajectoryEvents(conversationId).length, 1);
    assert.equal(published.length, 1);
  } finally {
    discardTrajectoryRecorder(conversationId);
  }
});

test("the recorder registry exclusively owns desktop live trajectory writes", () => {
  const registrySource = readFileSync(
    new URL("../../src/lib/trajectory/recorderRegistry.ts", import.meta.url),
    "utf8",
  );
  const publisherSources = [
    "../../src/pages/chat/runtime/useSendChatTurn.ts",
    "../../src/pages/chat/runtime/useManualCompaction.ts",
  ].map((relativePath) => readFileSync(new URL(relativePath, import.meta.url), "utf8"));

  assert.match(registrySource, /appendDesktopLiveTrajectory\(conversationId, events\)/);
  for (const source of publisherSources) {
    assert.doesNotMatch(source, /appendDesktopLiveTrajectory/);
  }
});
