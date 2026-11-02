import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const source = (name) => new URL(`../../src/${name}`, import.meta.url).pathname;
const requests = [];
const loader = createTsModuleLoader({
  mocks: {
    [source("lib/kbrain/runtimeConnection.ts")]: {
      getConfiguredKBrainConnection: () => ({ baseUrl: "http://cron.test", token: "secret", protocolVersion: "kbrain.agent.v1" }),
      resolveKBrainClientOptions: (input) => ({ baseUrl: "http://cron.test", token: "secret", ...input }),
    },
  },
});
const adapter = loader.loadModule("src/lib/automation/kbrainCron.ts");
globalThis.fetch = async (url, init = {}) => {
  requests.push({ url, init });
  const path = new URL(url).pathname;
  const body = path === "/v1/cron" ? { revision: 3, tasks: [] } : path.endsWith("/runs") ? { runs: [] } : path.endsWith("run-now") ? { startedAt: 12 } : { ok: true };
  return { ok: true, json: async () => body, text: async () => "" };
};

test("K-brain cron adapter uses authoritative HTTP CRUD, run, history, and validation routes", async () => {
  assert.equal((await adapter.fetchKBrainCron()).revision, 3);
  await adapter.applyKBrainCron({ baseRevision: 3, ops: [] });
  await adapter.listKBrainCronRuns("task/1", 7);
  await adapter.clearKBrainCronRuns("task/1");
  assert.equal((await adapter.runKBrainCronNow("task/1")).startedAt, 12);
  await adapter.validateKBrainCron("* * * * * *");
  await adapter.cancelKBrainCron("task/1");
  assert.deepEqual(requests.map((request) => `${request.init.method ?? "GET"} ${new URL(request.url).pathname}`), [
    "GET /v1/cron", "PUT /v1/cron", "GET /v1/cron/task%2F1/runs", "DELETE /v1/cron/task%2F1/runs", "POST /v1/cron/task%2F1/run-now", "POST /v1/cron/validate", "POST /v1/cron/task%2F1/cancel",
  ]);
  assert.equal(new Headers(requests[1].init.headers).get("Authorization"), "Bearer secret");
});

test("cron cancellation encodes the exact execution identity", async () => {
  await adapter.cancelKBrainCron("task/1", "execution/1");
  assert.equal(new URL(requests.at(-1).url).pathname, "/v1/cron/task%2F1/runs/execution%2F1/cancel");
});

test("cron cancellation preserves backend errors for retry feedback", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 409,
    text: async () => '{"error":"cron task has no active run"}',
  });
  try {
    await assert.rejects(adapter.cancelKBrainCron("task/1"), /no active run/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("original automation adapter routes K-brain cron through HTTP and never claims frontend work", async () => {
  const loader = createTsModuleLoader({
    mocks: {
      [source("lib/host.ts")]: { isKBrainBackendEnabled: () => true, isKBrainBrowserHost: () => true },
      [source("shims/tauriCore.ts")]: { invoke: () => { throw new Error("unexpected native invocation"); } },
      [source("shims/tauriEvent.ts")]: { listen: async () => () => {} },
      [source("lib/kbrain/runtimeConnection.ts")]: {
        getConfiguredKBrainConnection: () => ({ baseUrl: "http://cron.test", token: "secret" }),
        resolveKBrainClientOptions: (input) => ({ baseUrl: "http://cron.test", token: "secret", ...input }),
      },
      [source("lib/automation/kbrainHooks.ts")]: {
        fetchKBrainHooks: async () => ({ revision: 0, hooks: [] }),
      },
    },
  });
  const { backend } = loader.loadModule("src/lib/automation/backend.ts");
  assert.equal((await backend.fetchSnapshot()).cron.revision, 3);
  await backend.cronApply({ baseRevision: 3, ops: [] });
  assert.deepEqual(await backend.listRuns("task"), []);
  assert.equal((await backend.runNow("task")).startedAt, 12);
  assert.equal(backend.canCancelRun(), true);
  await backend.cancelRun("task");
  await backend.clearRuns("task");
  await backend.validateCronExpression("* * * * * *");
  assert.deepEqual(await backend.claimPromptRuns(), []);
  await backend.releasePromptRun("run");
  assert.equal((await backend.completePromptRun({ executionId: "run", success: true, durationMs: 1, output: "done" })).status, "already_finished");
});
