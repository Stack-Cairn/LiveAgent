import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));

function loadBackend(resultJson) {
  const requests = [];
  const loader = createWebModuleLoader({
    rootDir,
    mocks: {
      [path.join(rootDir, "src/lib/gatewaySocket.ts")]: {
        getGatewayWebSocketClient(token) {
          return {
            async cronManage(request) {
              requests.push({ token, request });
              return { action: request.action, result_json: resultJson };
            },
          };
        },
      },
      [path.join(rootDir, "src/lib/storage.ts")]: {
        loadToken: () => " web-token ",
      },
    },
  });
  return { backend: loader.loadModule("src/lib/automation/backend.ts").backend, requests };
}

test("WebUI cron occurrences go through cron.manage occurrences", async () => {
  const payload = {
    timeZone: "Asia/Shanghai",
    now: 5,
    tasks: [{ id: "t", name: "Daily", cron: "0 0 9 * * *", kind: "bash" }],
    occurrences: [{ taskId: "t", at: 1 }],
    runs: [],
    summaries: [],
  };
  const { backend, requests } = loadBackend(JSON.stringify(payload));

  const result = await backend.cronOccurrences(1, 2);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].token, "web-token");
  assert.deepEqual(requests[0].request, {
    action: "occurrences",
    task_id: undefined,
    task_json: '{"from":1,"to":2}',
  });
  assert.deepEqual(result, payload);
});

test("WebUI cron occurrences surface malformed responses", async () => {
  const { backend } = loadBackend("not json");
  await assert.rejects(backend.cronOccurrences(1, 2), /not valid JSON/);
});
