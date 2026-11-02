// Adversarial review round 2: byte-level health bodies (BOM, invalid UTF-8)
// sent by a real HTTP server through the real browser bootstrap and the real
// KBrainClient. Same vectors as the Go and Rust round-2 tests.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const vectors = JSON.parse(
  readFileSync(new URL("./kbrain-health-adversarial-r2-vectors.json", import.meta.url), "utf8"),
);

const loader = createTsModuleLoader({
  mocks: {
    "@tauri-apps/api/core": { invoke: async () => ({}) },
    [new URL("../../src/lib/host.ts", import.meta.url).pathname]: { isTauriHost: () => false },
  },
});
const browserBootstrap = loader.loadModule("src/lib/kbrain/bootstrap.ts");
const { createKBrainClient } = loader.loadModule("src/lib/kbrain/client");

async function rawHealthServer(t, bytes) {
  const server = createServer((request, response) => {
    response.writeHead(request.url === "/v1/health" ? 200 : 404, { "content-type": "application/json" });
    response.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

for (const vector of vectors.bodies) {
  test(`browser-direct bootstrap rejects: ${vector.name}`, async (t) => {
    const baseUrl = await rawHealthServer(t, Buffer.from(vector.base64, "base64"));
    await assert.rejects(
      browserBootstrap.connectKBrainBackend(async () => ({}), {
        fetch: (input, init) => {
          const url = new URL(String(input));
          url.port = new URL(baseUrl).port;
          return globalThis.fetch(url, init);
        },
        timeoutMs: 2_000,
      }),
    );
  });

  test(`desktop client getHealth rejects: ${vector.name}`, async (t) => {
    const baseUrl = await rawHealthServer(t, Buffer.from(vector.base64, "base64"));
    await assert.rejects(createKBrainClient({ baseUrl }).getHealth());
  });
}
