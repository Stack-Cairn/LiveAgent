import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Battle 2: this suite now drives crates/core, the engine that actually ships.
// The frontend copy under src/lib was a duplicate and has been removed.
// crates/core modules that talk to the Rust backend read this at import time.
process.env.LIVEAGENT_BACKEND_PORT ??= "0";
const coreRootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)), "../core");
const coreSrc = (rel) => path.join(coreRootDir, "src", rel);
// core 走 HTTP callBackend，前端副本走 tauri invoke —— 迁移后 mock 换成前者。
const backendClientPath = coreSrc("backendClient.ts");

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushPromises() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

test("invokeWithAbort releases the caller immediately and cleans up a late result", async () => {
  const invocation = deferred();
  const invokeCalls = [];
  const loader = createTsModuleLoader({
    mocks: {
      [backendClientPath]: {
        callBackend(command, args) {
          invokeCalls.push({ command, args });
          return invocation.promise;
        },
      },
    },
  });
  const { invokeWithAbort, ToolInvocationCancelledError } = loader.loadModule(
    coreSrc("tools/invokeWithAbort.ts"),
  );
  const controller = new AbortController();
  let abortCalls = 0;
  const lateResults = [];

  const result = invokeWithAbort(
    "slow_tool",
    { run_id: "run-1" },
    controller.signal,
    {
      onAbort() {
        abortCalls += 1;
      },
      onLateResult(value) {
        lateResults.push(value);
      },
    },
  );
  controller.abort();

  await assert.rejects(result, (error) => error instanceof ToolInvocationCancelledError);
  assert.equal(abortCalls, 1);
  assert.deepEqual(invokeCalls, [{ command: "slow_tool", args: { run_id: "run-1" } }]);

  invocation.resolve({ id: "late-process" });
  await flushPromises();
  assert.deepEqual(lateResults, [{ id: "late-process" }]);
});

test("waitForAbortablePromise rejects without waiting for the underlying promise", async () => {
  const loader = createTsModuleLoader({
    mocks: {
      [backendClientPath]: {
        async callBackend() {
          return undefined;
        },
      },
    },
  });
  const { waitForAbortablePromise, ToolInvocationCancelledError } = loader.loadModule(
    coreSrc("tools/invokeWithAbort.ts"),
  );
  const gate = deferred();
  const controller = new AbortController();
  const result = waitForAbortablePromise(gate.promise, controller.signal);

  controller.abort();
  await assert.rejects(result, (error) => error instanceof ToolInvocationCancelledError);
  gate.resolve("late");
});

test("createToolRunId is unique even for identical tool-call ids", async () => {
  const loader = createTsModuleLoader({
    mocks: {
      [backendClientPath]: {
        async callBackend() {
          return undefined;
        },
      },
    },
  });
  const { createToolRunId } = loader.loadModule(coreSrc("tools/invokeWithAbort.ts"));

  // Provider tool-call ids are not globally unique (local models reuse
  // "call_1" across conversations); duplicate run ids cancel each other in
  // the Rust run registry, so every id must carry a unique suffix.
  const first = createToolRunId("mcp", "call_1");
  const second = createToolRunId("mcp", "call_1");
  assert.ok(first.startsWith("mcp:call_1:"));
  assert.ok(second.startsWith("mcp:call_1:"));
  assert.notEqual(first, second);
});
