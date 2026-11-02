// Adversarial review round 3: readKBrainHealthResponse wraps response.arrayBuffer()
// in a catch that reports "not valid UTF-8". An abort or timeout while the body
// is still streaming is therefore reported as a health contract violation
// instead of the caller's abort reason (baseline request() surfaced the abort).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createKBrainClient } = loader.loadModule("src/lib/kbrain/client");
const health = loader.loadModule("@liveagent/ui/lib/kbrain/health.ts");

test("abort while the health body streams surfaces the abort, not a contract violation", async (t) => {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"status":"ok"');
    request.on("close", () => response.destroy());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const client = createKBrainClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
  const reason = new Error("cancelled by test");
  const controller = new AbortController();
  setTimeout(() => controller.abort(reason), 50);
  await assert.rejects(client.getHealth(controller.signal), (error) => {
    assert.ok(
      !(error instanceof health.KBrainHealthContractError),
      `abort was reported as ${error?.name}: ${error?.message}`,
    );
    return true;
  });
});
