import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { buildTrajectoryContentIndex } = loader.loadModule(
  "@liveagent/ui/lib/trajectory/contentIndex.ts",
);
const { buildTrajectoryLedger } = loader.loadModule(
  "@liveagent/ui/lib/trajectory/eventLog.ts",
);

function assistant(key, round, text) {
  return {
    key,
    role: "assistant",
    text: "",
    rounds: [{ round, blocks: [{ kind: "text", text }] }],
  };
}

test("tail-loaded transcript content aligns to absolute ledger turns", () => {
  const ledger = buildTrajectoryLedger([
    { k: "user", t: 92, at: 100, mi: 800 },
    { k: "step_start", t: 92, s: 1, at: 101 },
    { k: "step_end", t: 92, s: 1, at: 102, st: "complete" },
    { k: "turn_end", t: 92, at: 103, st: "complete" },
    { k: "user", t: 93, at: 200, mi: 812 },
    { k: "step_start", t: 93, s: 1, at: 201 },
    { k: "step_end", t: 93, s: 1, at: 202, st: "complete" },
    { k: "turn_end", t: 93, at: 203, st: "complete" },
  ]);

  // The transcript window contains only the latest turn, so local counting would call it Turn 1.
  const content = buildTrajectoryContentIndex(
    [
      { key: "u93", role: "user", text: "latest question", messageIndex: 0 },
      assistant("a93", 1, "latest answer"),
    ],
    ledger,
  );

  assert.equal(content.userByTurn.get(93)?.text, "latest question");
  assert.equal(content.assistantByStep.get(`93\u00001`)?.text, "latest answer");
  assert.equal(content.userByTurn.has(1), false);
});

test("a headless leading assistant group binds to the preceding absolute turn", () => {
  const ledger = buildTrajectoryLedger([
    { k: "user", t: 40, at: 100 },
    { k: "step_start", t: 40, s: 1, at: 101 },
    { k: "step_end", t: 40, s: 1, at: 102, st: "complete" },
    { k: "turn_end", t: 40, at: 103, st: "complete" },
    { k: "user", t: 41, at: 200 },
    { k: "step_start", t: 41, s: 1, at: 201 },
    { k: "step_end", t: 41, s: 1, at: 202, st: "complete" },
    { k: "turn_end", t: 41, at: 203, st: "complete" },
  ]);

  const content = buildTrajectoryContentIndex(
    [
      assistant("headless", 1, "tail of turn forty"),
      { key: "u41", role: "user", text: "turn forty one" },
      assistant("a41", 1, "answer forty one"),
    ],
    ledger,
  );

  assert.equal(content.assistantByStep.get(`40\u00001`)?.text, "tail of turn forty");
  assert.equal(content.userByTurn.get(41)?.text, "turn forty one");
});

test("same-millisecond context records keep distinct stable identities", () => {
  const { deriveTrajectoryLayout, flattenTrajectoryRecords } = loader.loadModule(
    "@liveagent/ui/lib/trajectory/layout.ts",
  );
  const ledger = buildTrajectoryLedger([
    { k: "user", t: 1, at: 100 },
    { k: "context", t: 1, at: 101, src: "memory", tx: "A" },
    { k: "context", t: 1, at: 101, src: "skills", tx: "B" },
  ]);
  const records = flattenTrajectoryRecords(deriveTrajectoryLayout({ ledger }));
  const contextRecords = records.filter((record) => record.kind === "context");
  assert.equal(contextRecords.length, 2);
  assert.equal(new Set(contextRecords.map((record) => record.recordId)).size, 2);
});
