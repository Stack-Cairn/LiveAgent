import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function createHookHarness() {
  const refs = [];
  const effects = [];
  let refIndex = 0;
  let effectIndex = 0;
  return {
    react: {
      useRef(initialValue) {
        const index = refIndex++;
        refs[index] ??= { current: initialValue };
        return refs[index];
      },
      useCallback(callback) {
        return callback;
      },
      useEffect(effect, deps) {
        const index = effectIndex++;
        const previous = effects[index];
        const changed =
          !previous ||
          deps.length !== previous.deps.length ||
          deps.some((value, depIndex) => value !== previous.deps[depIndex]);
        if (!changed) return;
        previous?.cleanup?.();
        effects[index] = { deps: [...deps], cleanup: effect() };
      },
    },
    render(callback) {
      refIndex = 0;
      effectIndex = 0;
      callback();
    },
    cleanup() {
      for (const effect of effects) {
        effect?.cleanup?.();
      }
    },
  };
}

function installFakeTimers() {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let nextId = 1;
  const timeouts = new Map();
  const intervals = new Map();
  globalThis.setTimeout = (callback) => {
    const id = nextId++;
    timeouts.set(id, callback);
    return id;
  };
  globalThis.clearTimeout = (id) => {
    timeouts.delete(id);
  };
  globalThis.setInterval = (callback) => {
    const id = nextId++;
    intervals.set(id, callback);
    return id;
  };
  globalThis.clearInterval = (id) => {
    intervals.delete(id);
  };
  return {
    runTimeouts() {
      const callbacks = [...timeouts.values()];
      timeouts.clear();
      for (const callback of callbacks) callback();
    },
    restore() {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    },
  };
}

function createTranscriptStore(readText = () => "streaming") {
  return {
    getSnapshot() {
      return {
        draftAssistantText: readText(),
        toolStatus: null,
        liveRounds: [],
        retryAttempts: [],
        isSettled: false,
      };
    },
  };
}

test("run mirror batches deltas and durably commits terminal after the batch", async () => {
  const timers = installFakeTimers();
  const harness = createHookHarness();
  const calls = [];
  try {
    const loader = createTsModuleLoader({
      mocks: {
        react: harness.react,
        "@tauri-apps/api/event": {
          async listen() {
            return () => undefined;
          },
        },
        "@tauri-apps/api/core": {
          async invoke(command, payload) {
            calls.push({ command, payload });
            if (command === "gateway_send_chat_ingress_batch") {
              return { firstSeq: 1, lastSeq: 1, locallyAccepted: true };
            }
            return { sourceSeq: 2, durablyPersisted: true, sha256: "hash" };
          },
        },
      },
    });
    const { useBackendRunMirrorCoordinator } = loader.loadModule(
      "src/pages/chat/bridge/useRunMirrorCoordinator.ts",
    );
    let mirror;
    harness.render(() => {
      mirror = useBackendRunMirrorCoordinator();
    });
    mirror.registerBackendRunMirror({
      runId: "run-1",
      conversationId: "conv-1",
      workerId: "gui-live",
      userMessage: { role: "user", id: "user-1", content: "hello" },
      transcriptStore: createTranscriptStore(),
    });
    mirror.queueBackendBridgeEventForRequest(
      "run-1",
      { type: "token", text: "hello ", conversation_id: "conv-1" },
      { workerId: "gui-live" },
    );
    mirror.queueBackendBridgeEventForRequest(
      "run-1",
      { type: "token", text: "world", conversation_id: "conv-1" },
      { workerId: "gui-live" },
    );
    mirror.queueBackendBridgeEventForRequest("run-1", {
      type: "done",
      conversation_id: "conv-1",
    });
    await mirror.finishBackendRunMirror({
      runId: "run-1",
      conversationId: "conv-1",
      entriesJson: '[{"id":"a1","kind":"assistant","text":"hello world"}]',
      state: "completed",
      contentComplete: true,
    });

    assert.deepEqual(
      calls.map((call) => call.command),
      ["gateway_send_chat_ingress_batch", "gateway_commit_chat_checkpoint"],
    );
    const records = calls[0].payload.input.records;
    assert.equal(records.length, 1, "adjacent token deltas share one logical record");
    assert.equal(JSON.parse(records[0].eventJson).text, "hello world");
    assert.equal(calls[1].payload.input.kind, "terminal");
    assert.equal(calls[1].payload.input.contentComplete, true);
    harness.cleanup();
  } finally {
    timers.restore();
  }
});

test("a rejected local delta batch does not prevent durable terminal repair", async () => {
  const timers = installFakeTimers();
  const harness = createHookHarness();
  const calls = [];
  try {
    const loader = createTsModuleLoader({
      mocks: {
        react: harness.react,
        "@tauri-apps/api/event": {
          async listen() {
            return () => undefined;
          },
        },
        "@tauri-apps/api/core": {
          async invoke(command, payload) {
            calls.push({ command, payload });
            if (command === "gateway_send_chat_ingress_batch") {
              throw new Error("actor queue full");
            }
            return { sourceSeq: 1, durablyPersisted: true, sha256: "hash" };
          },
        },
      },
    });
    const { useBackendRunMirrorCoordinator } = loader.loadModule(
      "src/pages/chat/bridge/useRunMirrorCoordinator.ts",
    );
    let mirror;
    harness.render(() => {
      mirror = useBackendRunMirrorCoordinator();
    });
    mirror.registerBackendRunMirror({
      runId: "run-1",
      conversationId: "conv-1",
      userMessage: { role: "user", id: "user-1", content: "hello" },
      transcriptStore: createTranscriptStore(),
    });
    mirror.queueBackendBridgeEventForRequest("run-1", {
      type: "token",
      text: "partial",
      conversation_id: "conv-1",
    });
    await assert.rejects(mirror.flushBackendBridgeEventsForRequest("run-1"), /actor queue full/);
    await mirror.finishBackendRunMirror({
      runId: "run-1",
      conversationId: "conv-1",
      entriesJson: '[{"id":"a1","kind":"assistant","text":"complete"}]',
      state: "completed",
      contentComplete: true,
    });

    assert.equal(calls.at(-1).command, "gateway_commit_chat_checkpoint");
    harness.cleanup();
  } finally {
    timers.restore();
  }
});

test("run mirror flushes after 25ms and enforces record and byte batch bounds", async () => {
  const timers = installFakeTimers();
  const harness = createHookHarness();
  const calls = [];
  let nextSeq = 1;
  try {
    const loader = createTsModuleLoader({
      mocks: {
        react: harness.react,
        "@tauri-apps/api/event": {
          async listen() {
            return () => undefined;
          },
        },
        "@tauri-apps/api/core": {
          async invoke(command, payload) {
            calls.push({ command, payload });
            if (command === "gateway_send_chat_ingress_batch") {
              const firstSeq = nextSeq;
              nextSeq += payload.input.records.length;
              return { firstSeq, lastSeq: nextSeq - 1, locallyAccepted: true };
            }
            return { sourceSeq: nextSeq++, durablyPersisted: true, sha256: "hash" };
          },
        },
      },
    });
    const { useBackendRunMirrorCoordinator } = loader.loadModule(
      "src/pages/chat/bridge/useRunMirrorCoordinator.ts",
    );
    let mirror;
    harness.render(() => {
      mirror = useBackendRunMirrorCoordinator();
    });
    mirror.registerBackendRunMirror({
      runId: "run-bounds",
      conversationId: "conv-bounds",
      workerId: "gui-live",
      userMessage: { role: "user", id: "user-bounds", content: "hello" },
      transcriptStore: createTranscriptStore(),
    });

    mirror.queueBackendBridgeEventForRequest("run-bounds", {
      type: "tool_status",
      status: "timer",
      conversation_id: "conv-bounds",
    });
    assert.equal(calls.length, 0, "the first record waits for the 25ms batch timer");
    timers.runTimeouts();
    await mirror.flushBackendBridgeEventsForRequest("run-bounds");
    assert.equal(calls.length, 1, "the timer flushes the pending batch");

    for (let index = 0; index < 65; index += 1) {
      const pending = mirror.queueBackendBridgeEventForRequest("run-bounds", {
        type: "tool_status",
        status: `record-${index}`,
        conversation_id: "conv-bounds",
      });
      if (pending) await pending;
    }
    for (let index = 0; index < 40; index += 1) {
      const pending = mirror.queueBackendBridgeEventForRequest("run-bounds", {
        type: "tool_result",
        id: `large-${index}`,
        content: "x".repeat(4_000),
        conversation_id: "conv-bounds",
      });
      if (pending) await pending;
    }
    await mirror.finishBackendRunMirror({
      runId: "run-bounds",
      conversationId: "conv-bounds",
      entriesJson: "[]",
      state: "completed",
      contentComplete: true,
    });

    const batches = calls.filter((call) => call.command === "gateway_send_chat_ingress_batch");
    assert.ok(batches.some((call) => call.payload.input.records.length === 64));
    assert.ok(batches.every((call) => call.payload.input.records.length <= 64));
    const encoder = new TextEncoder();
    for (const call of batches) {
      const encodedBytes =
        encoder.encode(call.payload.input.runId).byteLength +
        encoder.encode(call.payload.input.conversationId).byteLength +
        32 +
        call.payload.input.records.reduce(
          (total, record) =>
            total +
            encoder.encode(record.eventJson).byteLength +
            (record.workerId ? encoder.encode(record.workerId).byteLength : 0) +
            16,
          0,
        );
      assert.ok(encodedBytes <= 64 * 1024, `batch exceeded 64KiB: ${encodedBytes}`);
    }
    harness.cleanup();
  } finally {
    timers.restore();
  }
});

test("running checkpoint is an ordered barrier and cannot cross terminal", async () => {
  const timers = installFakeTimers();
  const harness = createHookHarness();
  const calls = [];
  let checkpointListener = null;
  let transcriptText = "first";
  let nextSeq = 1;
  try {
    const loader = createTsModuleLoader({
      mocks: {
        react: harness.react,
        "@tauri-apps/api/event": {
          async listen(_eventName, listener) {
            checkpointListener = listener;
            return () => undefined;
          },
        },
        "@tauri-apps/api/core": {
          async invoke(command, payload) {
            calls.push({ command, payload });
            if (command === "gateway_send_chat_ingress_batch") {
              const firstSeq = nextSeq;
              nextSeq += payload.input.records.length;
              return { firstSeq, lastSeq: nextSeq - 1, locallyAccepted: true };
            }
            return { sourceSeq: nextSeq++, durablyPersisted: true, sha256: "hash" };
          },
        },
      },
    });
    const { useBackendRunMirrorCoordinator } = loader.loadModule(
      "src/pages/chat/bridge/useRunMirrorCoordinator.ts",
    );
    let mirror;
    harness.render(() => {
      mirror = useBackendRunMirrorCoordinator();
    });
    mirror.registerBackendRunMirror({
      runId: "run-barrier",
      conversationId: "conv-barrier",
      userMessage: { role: "user", id: "user-barrier", content: "hello" },
      transcriptStore: createTranscriptStore(() => transcriptText),
    });
    mirror.queueBackendBridgeEventForRequest("run-barrier", {
      type: "token",
      text: "first",
      conversation_id: "conv-barrier",
    });
    checkpointListener({
      payload: {
        runId: "run-barrier",
        conversationId: "conv-barrier",
        reason: "gap",
      },
    });
    checkpointListener({
      payload: {
        runId: "run-barrier",
        conversationId: "conv-barrier",
        reason: "duplicate-gap-request",
      },
    });
    await Promise.resolve();
    await mirror.flushBackendBridgeEventsForRequest("run-barrier");

    transcriptText = "firstsecond";
    mirror.queueBackendBridgeEventForRequest("run-barrier", {
      type: "token",
      text: "second",
      conversation_id: "conv-barrier",
    });
    mirror.queueBackendBridgeEventForRequest("run-barrier", {
      type: "done",
      conversation_id: "conv-barrier",
    });
    await Promise.all([
      mirror.finishBackendRunMirror({
        runId: "run-barrier",
        conversationId: "conv-barrier",
        entriesJson: '[{"id":"a1","kind":"assistant","text":"firstsecond"}]',
        state: "completed",
        contentComplete: true,
      }),
      mirror.finishBackendRunMirror({
        runId: "run-barrier",
        conversationId: "conv-barrier",
        entriesJson: '[{"id":"a1","kind":"assistant","text":"firstsecond"}]',
        state: "completed",
        contentComplete: true,
      }),
    ]);

    assert.deepEqual(
      calls.map((call) =>
        call.command === "gateway_send_chat_ingress_batch"
          ? `batch:${JSON.parse(call.payload.input.records[0].eventJson).text}`
          : call.payload.input.kind,
      ),
      ["batch:first", "checkpoint", "batch:second", "terminal"],
    );
    assert.equal(
      calls.filter(
        (call) =>
          call.command === "gateway_commit_chat_checkpoint" &&
          call.payload.input.kind === "terminal",
      ).length,
      1,
      "concurrent finalizers share the same durable terminal commit",
    );
    assert.deepEqual(
      calls
        .filter((call) => call.command === "gateway_commit_chat_checkpoint")
        .map((call) => call.payload.input.revision),
      [1, 2],
      "checkpoint revisions remain monotonic across the terminal barrier",
    );
    assert.equal(
      calls.filter(
        (call) =>
          call.command === "gateway_commit_chat_checkpoint" &&
          call.payload.input.kind === "checkpoint",
      ).length,
      1,
      "concurrent checkpoint requests share one durable projection",
    );
    const runningCheckpoint = calls.find(
      (call) =>
        call.command === "gateway_commit_chat_checkpoint" &&
        call.payload.input.kind === "checkpoint",
    );
    assert.equal(
      JSON.parse(runningCheckpoint.payload.input.entriesJson).at(-1).text,
      "first",
      "the running checkpoint freezes the projection at its sequence barrier",
    );
    harness.cleanup();
  } finally {
    timers.restore();
  }
});

test("terminal retry reuses the frozen revision after a lost local response", async () => {
  const timers = installFakeTimers();
  const harness = createHookHarness();
  const calls = [];
  let terminalAttempts = 0;
  try {
    const loader = createTsModuleLoader({
      mocks: {
        react: harness.react,
        "@tauri-apps/api/event": {
          async listen() {
            return () => undefined;
          },
        },
        "@tauri-apps/api/core": {
          async invoke(command, payload) {
            calls.push({ command, payload });
            if (command !== "gateway_commit_chat_checkpoint") {
              throw new Error(`unexpected command: ${command}`);
            }
            terminalAttempts += 1;
            if (terminalAttempts === 1) {
              throw new Error("IPC response lost after durable commit");
            }
            return { sourceSeq: 1, durablyPersisted: true, sha256: "hash" };
          },
        },
      },
    });
    const { useBackendRunMirrorCoordinator } = loader.loadModule(
      "src/pages/chat/bridge/useRunMirrorCoordinator.ts",
    );
    let mirror;
    harness.render(() => {
      mirror = useBackendRunMirrorCoordinator();
    });
    mirror.registerBackendRunMirror({
      runId: "run-terminal-retry",
      conversationId: "conv-terminal-retry",
      userMessage: { role: "user", id: "user-terminal-retry", content: "hello" },
      transcriptStore: createTranscriptStore(),
    });
    const frozenEntries = '[{"id":"a1","kind":"assistant","text":"complete"}]';

    await assert.rejects(
      mirror.finishBackendRunMirror({
        runId: "run-terminal-retry",
        conversationId: "conv-terminal-retry",
        entriesJson: frozenEntries,
        state: "completed",
        contentComplete: true,
      }),
      /IPC response lost/,
    );
    await mirror.finishBackendRunMirror({
      runId: "run-terminal-retry",
      conversationId: "conv-terminal-retry",
      entriesJson: '[{"id":"different","kind":"assistant","text":"must not replace frozen"}]',
      state: "failed",
      errorCode: "late-retry",
      contentComplete: false,
    });

    const terminalCalls = calls.filter(
      (call) => call.command === "gateway_commit_chat_checkpoint",
    );
    assert.equal(terminalCalls.length, 2);
    assert.deepEqual(
      terminalCalls.map((call) => call.payload.input.revision),
      [1, 1],
    );
    assert.deepEqual(
      terminalCalls.map((call) => call.payload.input.entriesJson),
      [frozenEntries, frozenEntries],
    );
    assert.deepEqual(
      terminalCalls.map((call) => call.payload.input.state),
      ["completed", "completed"],
    );
    harness.cleanup();
  } finally {
    timers.restore();
  }
});
