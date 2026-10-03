import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// ============================================================================
// 压缩 sinks 与轨迹订阅的装配单点（compactionBinding.ts）：发送链路与手动压缩共用。
// ============================================================================

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const abs = (rel) => path.join(rootDir, rel);
const invalidated = [];
const segmentUpdates = [];
const { createCompactionSinks, observeCompactionTrajectory } = createTsModuleLoader({
  mocks: {
    [abs("src/lib/chat/memory/injectionController.ts")]: {
      memoryTurnInjection: { invalidate: (conversationId) => invalidated.push(conversationId) },
    },
    [abs("src/lib/trajectory/recorderRegistry.ts")]: {
      updateTrajectoryRecorderSegment: (conversationId, segmentIndex) =>
        segmentUpdates.push([conversationId, segmentIndex]),
    },
  },
}).loadModule("src/pages/chat/runtime/compactionBinding.ts");

function createSinks() {
  const calls = [];
  const transcriptStore = { id: "store" };
  const sinks = createCompactionSinks({
    conversationId: "conv-1",
    transcriptStore,
    gatewayBridgeEvents: {
      queueToolStatus: (...args) => calls.push(["wire", ...args]),
      queueCheckpoint: (...args) => calls.push(["checkpoint", ...args]),
    },
    updateConversationRuntimeEntry: (conversationId, updater) =>
      calls.push(["entry", conversationId, updater({ kept: true })]),
    updateToolStatus: (status, store) => calls.push(["local", status, store]),
    resetLiveTranscript: (store) => calls.push(["reset", store]),
    applyState: (state) => calls.push(["apply", state]),
    persist: async () => true,
  });
  return { sinks, calls, transcriptStore };
}

test("applyStateMidRun applies the state and clears the stale live transcript", () => {
  const { sinks, calls, transcriptStore } = createSinks();
  const state = { id: "state" };
  sinks.applyStateMidRun(state);
  sinks.applyState(state);
  assert.deepEqual(calls, [
    ["apply", state],
    ["reset", transcriptStore],
    ["apply", state],
  ]);
});

test("tool status reaches the gateway and the local store; wire=false stays local", () => {
  const { sinks, calls, transcriptStore } = createSinks();
  sinks.setBridgeToolStatus("1.2k · 0:20", true);
  sinks.setBridgeToolStatus("1.3k · 0:22", true, false);
  sinks.setBridgeToolStatus(null);
  assert.deepEqual(calls, [
    ["wire", "1.2k · 0:20", true],
    ["local", "1.2k · 0:20", transcriptStore],
    ["local", "1.3k · 0:22", transcriptStore],
    ["wire", null, false],
    ["local", null, transcriptStore],
  ]);
});

test("status, checkpoint and the compacted notice reach their owners", () => {
  const { sinks, calls } = createSinks();
  const status = { phase: "idle" };
  invalidated.length = 0;
  sinks.publishStatus(status);
  sinks.queueCheckpoint({ id: "state" }, 1_234);
  sinks.onCompacted();
  assert.deepEqual(calls, [
    ["entry", "conv-1", { kept: true, compactionStatus: status }],
    ["checkpoint", { id: "state" }, 1_234],
  ]);
  // 载有 memory 增量块的消息已移出 active segment：注入状态必须整体失效。
  assert.deepEqual(invalidated, ["conv-1"]);
});

test("trajectory marks only manual compactions standalone and moves the segment only on complete", () => {
  let observer = null;
  const recorded = [];
  segmentUpdates.length = 0;
  observeCompactionTrajectory(
    {
      setObserver: (next) => {
        observer = next;
      },
    },
    {
      compactionStart: (info) => recorded.push(["start", info]),
      compactionEnd: (info) => recorded.push(["end", info]),
    },
    "conv-1",
  );

  observer.onStart({ trigger: "manual", tokensBefore: 100 });
  observer.onEnd({
    trigger: "manual",
    status: "complete",
    tokensBefore: 100,
    tokensAfter: 40,
    newSegmentIndex: 2,
  });
  observer.onStart({ trigger: "post-tool", tokensBefore: 90 });
  observer.onEnd({ trigger: "post-tool", status: "error", error: "boom", newSegmentIndex: 3 });

  assert.deepEqual(recorded, [
    ["start", { standalone: true }],
    ["end", { status: "complete", standalone: true, tokensBefore: 100, tokensAfter: 40 }],
    ["start", { standalone: false }],
    ["end", { status: "error", standalone: false, error: "boom" }],
  ]);
  assert.deepEqual(segmentUpdates, [["conv-1", 2]]);
});
