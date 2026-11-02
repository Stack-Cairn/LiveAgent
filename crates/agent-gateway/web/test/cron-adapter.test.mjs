import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const source = (name) => fileURLToPath(new URL(`../${name}`, import.meta.url));
const requests = [];
const loader = createWebModuleLoader({
  mocks: {
    [source("src/lib/gatewaySocket.ts")]: {
      getGatewayWebSocketClient: () => ({
        cronManage: async (payload) => {
          requests.push(payload);
          return { action: payload.action, result_json: JSON.stringify(payload.action === "list_runs" ? { runs: [{ state: "leased", startedAt: 1 }] } : { ok: true }) };
        },
      }),
    },
    [source("src/lib/storage.ts")]: { loadToken: () => "gateway-token" },
  },
});
const { backend } = loader.loadModule("src/lib/automation/backend.ts");

test("Gateway cron adapter hydrates active runs and cancels through cron.manage", async () => {
  const runs = await backend.listRuns("task/1", 500);
  assert.deepEqual(runs, [{ state: "leased", startedAt: 1 }]);
  assert.equal(backend.canCancelRun(), true);
  await backend.cancelRun("task/1");
  await backend.cancelRun("task/1", "execution/1");
  assert.deepEqual(requests, [
    { action: "list_runs", task_id: "task/1", task_json: JSON.stringify({ limit: 500 }) },
    { action: "cancel_run", task_id: "task/1", task_json: undefined },
    { action: "cancel_run", task_id: "task/1", task_json: JSON.stringify({ executionId: "execution/1" }) },
  ]);
});
