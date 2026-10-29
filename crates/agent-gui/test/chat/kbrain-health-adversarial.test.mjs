// Adversarial review: the same raw health bodies used by the Go
// (internal/kbrain/health_adversarial_test.go) and Rust
// (src-tauri/tests/kbrain_health_adversarial.rs) tests, sent through the real
// browser bootstrap and the real KBrainClient over a real HTTP server so number
// tokens such as 1.0 / -0 / 9007199254740993 reach response.json() unchanged.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const vectors = JSON.parse(
  readFileSync(new URL("./kbrain-health-adversarial-vectors.json", import.meta.url), "utf8"),
);

const browserLoader = createTsModuleLoader({
  mocks: {
    "@tauri-apps/api/core": { invoke: async () => ({}) },
    [new URL("../../src/lib/host.ts", import.meta.url).pathname]: { isTauriHost: () => false },
  },
});
const browserBootstrap = browserLoader.loadModule("src/lib/kbrain/bootstrap.ts");
const { createKBrainClient } = browserLoader.loadModule("src/lib/kbrain/client");
const health = browserLoader.loadModule("@liveagent/ui/lib/kbrain/health.ts");

async function rawHealthServer(t, raw) {
  const server = createServer((request, response) => {
    response.writeHead(request.url === "/v1/health" ? 200 : 404, { "content-type": "application/json" });
    response.end(raw);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function fixtureFetch(fixtureUrl) {
  return (input, init) => {
    const url = new URL(String(input));
    url.port = new URL(fixtureUrl).port;
    return globalThis.fetch(url, init);
  };
}

for (const vector of vectors.bodies) {
  test(`browser-direct health verdict: ${vector.name}`, async (t) => {
    const baseUrl = await rawHealthServer(t, vector.raw);
    const connect = browserBootstrap.connectKBrainBackend(async () => ({}), {
      fetch: fixtureFetch(baseUrl),
      timeoutMs: 2_000,
    });
    if (vector.expect === "accept") {
      await connect;
      const parsed = await createKBrainClient({ baseUrl }).getHealth();
      assert.equal(parsed.protocol.minor, vector.minor);
    } else {
      await assert.rejects(connect);
    }
  });
}

for (const vector of vectors.capabilities) {
  test(`desktop capability verdict: ${vector.name}`, async (t) => {
    const baseUrl = await rawHealthServer(t, vector.raw);
    const capabilities = await createKBrainClient({ baseUrl }).getCapabilities();
    let got = false;
    if (vector.frozen) got = health.hasFrozenCapability({ capabilities }, vector.frozen);
    for (const [name, minimum] of Object.entries(vector.atLeast ?? {})) {
      got = health.capabilityAtLeast({ capabilities }, name, minimum);
    }
    assert.equal(got, vector.expect);
  });
}
