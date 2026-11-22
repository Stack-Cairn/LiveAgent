import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader({
  mocks: {
    "@tauri-apps/api/core": { invoke: async () => ({}) },
    [new URL("../../src/lib/host.ts", import.meta.url).pathname]: { isTauriHost: () => true },
  },
});
const { runStartupSequence } = loader.loadModule("src/lib/startup/sequence.ts");
const bootstrap = loader.loadModule("src/lib/kbrain/bootstrap.ts");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const never = new Promise(() => {});

function recordedSteps(log) {
  const connect = deferred();
  const bridge = deferred();
  const history = deferred();
  const app = deferred();
  const steps = {
    connect: (defer) => {
      log.push("connect:start");
      return connect.promise.then(() => {
        log.push("connect:done");
        defer(bridge.promise.then(() => log.push("bridge:done")));
      });
    },
    onConnected: () => log.push("connected"),
    checkHistory: () => {
      log.push("history:start");
      return history.promise.then(() => log.push("history:done"));
    },
    preloadApp: () => {
      log.push("app:start");
      return app.promise.then(() => log.push("app:done"));
    },
  };
  return { steps, connect, bridge, history, app };
}

test("startup connects before anything else, then checks history while the app code loads", async () => {
  const log = [];
  const { steps, connect, bridge, history, app } = recordedSteps(log);
  let settled;
  const run = runStartupSequence(steps, never).then((result) => {
    settled = result;
    log.push(`outcome:${result.outcome}`);
  });
  await flush();
  // Nothing that needs the backend starts before the connection.
  assert.deepEqual(log, ["connect:start"]);
  connect.resolve();
  await flush();
  // Both run side by side: the app code does not wait for the history check.
  assert.deepEqual(log, ["connect:start", "connect:done", "connected", "history:start", "app:start"]);
  app.resolve();
  history.resolve();
  await flush();
  // The deferred host bridge refresh still gates the "done" outcome.
  assert.equal(settled, undefined);
  bridge.resolve();
  await run;
  assert.equal(settled.outcome, "done");
  assert.deepEqual(log.slice(-4), ["app:done", "history:done", "bridge:done", "outcome:done"]);
});

test("rendering waits for the history check even when the app code is ready first", async () => {
  const log = [];
  const { steps, connect, bridge, history, app } = recordedSteps(log);
  let outcome;
  const run = runStartupSequence(steps, never).then((result) => {
    outcome = result.outcome;
  });
  connect.resolve();
  bridge.resolve();
  app.resolve();
  await flush();
  assert.equal(outcome, undefined);
  history.resolve();
  await run;
  assert.equal(outcome, "done");
});

test("a connect failure starts neither the history check nor the app code", async () => {
  const log = [];
  const { steps, connect } = recordedSteps(log);
  const run = runStartupSequence(steps, never);
  connect.reject(new Error("K-brain backend exited before becoming ready"));
  await assert.rejects(run, /exited before becoming ready/);
  assert.deepEqual(log, ["connect:start"]);
});

test("a history failure fails startup; an app code failure is left to opening the app", async () => {
  const log = [];
  const { steps, connect, bridge, history, app } = recordedSteps(log);
  const run = runStartupSequence(steps, never);
  connect.resolve();
  bridge.resolve();
  await flush();
  // Never an unhandled rejection: opening the app awaits the same load and reports it.
  app.reject(new Error("chunk failed"));
  await flush();
  history.reject(new Error("history page failed"));
  await assert.rejects(run, /history page failed/);
});

test("skip and retry end the wait without waiting for the history check", async () => {
  for (const choice of ["skip", "retry"]) {
    const log = [];
    const { steps, connect } = recordedSteps(log);
    const leave = deferred();
    const run = runStartupSequence(steps, leave.promise);
    connect.resolve();
    await flush();
    leave.resolve(choice);
    const result = await run;
    assert.equal(result.outcome, choice);
    // The history check keeps running and is handed back for background error reporting.
    assert.ok(result.history instanceof Promise);
  }
});

test("startup defers the host bridge refresh; reconnects still wait for it", async () => {
  const connection = { baseUrl: "http://127.0.0.1:49123", token: "t", protocolVersion: "kbrain.agent.v1", storageId: "s" };
  const refresh = deferred();
  const invoke = async (command) => {
    if (command === "host_bridge_status") return refresh.promise;
    return connection;
  };
  let handed;
  const connected = await bootstrap.connectKBrainBackend(invoke, {
    deferHostBridgeRefresh: (work) => {
      handed = work;
    },
  });
  assert.equal(connected.baseUrl, connection.baseUrl);
  assert.ok(handed instanceof Promise, "the refresh is handed to startup");

  let reconnected = false;
  const reconnect = bootstrap.connectKBrainBackend(invoke).then(() => {
    reconnected = true;
  });
  await flush();
  assert.equal(reconnected, false, "a reconnect waits for the refresh");
  refresh.resolve({ state: "registered", tools: [] });
  await reconnect;
  await handed;
});
