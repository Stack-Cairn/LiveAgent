import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader({
  mocks: {
    "@tauri-apps/api/core": { invoke: async () => ({}) },
    [new URL("../../src/lib/host.ts", import.meta.url).pathname]: {
      isTauriHost: () => true,
    },
  },
});
const connection = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");
const bootstrap = loader.loadModule("src/lib/kbrain/bootstrap.ts");

test("bootstrap runner shares an in-flight attempt and allows retry after failure", async () => {
  let calls = 0;
  let finish;
  const run = bootstrap.createKBrainBootstrapRunner(async () => {
    calls += 1;
    await new Promise((resolve, reject) => { finish = { resolve, reject }; });
  });
  const first = run();
  assert.equal(run(), first);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish.reject(new Error("startup failed"));
  await assert.rejects(first, /startup failed/);
  const retried = run();
  assert.notEqual(retried, first);
  assert.equal(run(), retried);
  await Promise.resolve();
  assert.equal(calls, 2);
  finish.resolve();
  await retried;
});

test("desktop bootstrap uses the native connection command and keeps the token in memory", async () => {
  const calls = [];
  const result = await bootstrap.connectKBrainBackend(async (command) => {
    calls.push(command);
    return { baseUrl: "http://127.0.0.1:49123/", token: "secret", protocolVersion: "kbrain.agent.v1", storageId: "local-stable-root" };
  });
  assert.deepEqual(calls, ["kbrain_backend_connection"]);
  assert.deepEqual(result, { baseUrl: "http://127.0.0.1:49123", token: "secret", protocolVersion: "kbrain.agent.v1", managedLocal: true, storageId: "local-stable-root" });
  assert.equal(globalThis.localStorage, undefined);
  assert.equal(connection.getConfiguredKBrainConnection().token, "secret");
});

test("desktop reports frontend ready even when the bootstrap path fails", async () => {
  const calls = [];
  await bootstrap.notifyFrontendReady(async (command) => {
    calls.push(command);
    return undefined;
  });
  assert.deepEqual(calls, ["app_frontend_ready"]);
});

test("desktop bootstrap retries and leaves no direct fallback after failure", async () => {
  let attempts = 0;
  await assert.rejects(
    bootstrap.connectKBrainBackendWithRetry(async () => {
      attempts += 1;
      throw new Error("backend unavailable");
    }, { retries: 2, delayMs: 0 }),
    /backend unavailable/,
  );
  assert.equal(attempts, 3);
  assert.equal(connection.getKBrainRuntimeConnection(), null);
});

test("bootstrap timeout clears its timer and abort listener after success", async () => {
  const browserLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": { invoke: async () => ({}) },
      [new URL("../../src/lib/host.ts", import.meta.url).pathname]: { isTauriHost: () => true },
    },
  });
  const browserBootstrap = browserLoader.loadModule("src/lib/kbrain/bootstrap.ts");
  const controller = new AbortController();
  const originalAdd = controller.signal.addEventListener.bind(controller.signal);
  const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
  let abortListenersAdded = 0;
  let abortListenersRemoved = 0;
  controller.signal.addEventListener = (type, listener, options) => {
    if (type === "abort") abortListenersAdded += 1;
    return originalAdd(type, listener, options);
  };
  controller.signal.removeEventListener = (type, listener, options) => {
    if (type === "abort") abortListenersRemoved += 1;
    return originalRemove(type, listener, options);
  };

  await browserBootstrap.connectKBrainBackend(async () => ({
    baseUrl: "http://127.0.0.1:49123",
    token: "",
    protocolVersion: "kbrain.agent.v1",
  }), { signal: controller.signal, timeoutMs: 30 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(abortListenersAdded, 1);
  assert.equal(abortListenersRemoved, 1);
});

test("browser bootstrap verifies health and protocol without opt-in", async () => {
  const browserLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": { invoke: async () => { throw new Error("native invoke"); } },
      [new URL("../../src/lib/host.ts", import.meta.url).pathname]: { isTauriHost: () => false },
    },
  });
  const browserBootstrap = browserLoader.loadModule("src/lib/kbrain/bootstrap.ts");
  const browserConnection = browserLoader.loadModule("src/lib/kbrain/runtimeConnection.ts");
  const requests = [];
  const result = await browserBootstrap.connectKBrainBackend(async () => {
    throw new Error("native invoke");
  }, {
    fetch: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ status: "ok", version: "kbrain.agent.v1" }), { status: 200 });
    },
  });
  assert.equal(result.baseUrl, "http://127.0.0.1:47321");
  assert.equal(requests[0].url, "http://127.0.0.1:47321/v1/health");
  assert.equal(browserConnection.getConfiguredKBrainConnection().protocolVersion, "kbrain.agent.v1");
});

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function fixtureFetch(fixtureUrl) {
  return (input, init) => {
    const url = new URL(String(input));
    url.port = new URL(fixtureUrl).port;
    return globalThis.fetch(url, init);
  };
}

test("browser bootstrap applies the full HTTP deadline to hanging headers and body", async (t) => {
  for (const phase of ["headers", "body"]) {
    const browserLoader = createTsModuleLoader({
      mocks: {
        "@tauri-apps/api/core": { invoke: async () => ({}) },
        [new URL("../../src/lib/host.ts", import.meta.url).pathname]: { isTauriHost: () => false },
      },
    });
    const browserBootstrap = browserLoader.loadModule("src/lib/kbrain/bootstrap.ts");
    const server = createServer((request, response) => {
      assert.equal(request.url, "/v1/health");
      if (phase === "body") {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"status":"ok"');
      }
      request.on("aborted", () => response.destroy());
    });
    const fixtureUrl = await listen(server);
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });

    const startedAt = Date.now();
    await assert.rejects(
      browserBootstrap.connectKBrainBackend(async () => ({}), {
        timeoutMs: 30,
        fetch: fixtureFetch(fixtureUrl),
      }),
      /timed out|aborted/i,
    );
    assert.ok(Date.now() - startedAt < 1_000);
  }
});

test("browser bootstrap links external cancellation to the real HTTP request", async (t) => {
  const browserLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": { invoke: async () => ({}) },
      [new URL("../../src/lib/host.ts", import.meta.url).pathname]: { isTauriHost: () => false },
    },
  });
  const browserBootstrap = browserLoader.loadModule("src/lib/kbrain/bootstrap.ts");
  let requestAborted;
  const aborted = new Promise((resolve) => { requestAborted = resolve; });
  const server = createServer((request, response) => {
    const timer = setTimeout(() => response.end(JSON.stringify({ status: "ok", version: "kbrain.agent.v1" })), 1_000);
    request.on("aborted", () => {
      clearTimeout(timer);
      requestAborted();
      response.destroy();
    });
  });
  const fixtureUrl = await listen(server);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const controller = new AbortController();
  const request = browserBootstrap.connectKBrainBackend(async () => ({}), {
    fetch: fixtureFetch(fixtureUrl),
    signal: controller.signal,
    timeoutMs: 5_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort(new Error("cancelled by test"));
  await assert.rejects(request, /cancelled by test|aborted/i);
  await aborted;
});

test("browser bootstrap rejects protocol mismatch, timeout, and cancellation", async () => {
  const browserLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": { invoke: async () => ({}) },
      [new URL("../../src/lib/host.ts", import.meta.url).pathname]: { isTauriHost: () => false },
    },
  });
  const browserBootstrap = browserLoader.loadModule("src/lib/kbrain/bootstrap.ts");
  await assert.rejects(
    browserBootstrap.connectKBrainBackend(async () => ({}), {
      fetch: async () => new Response(JSON.stringify({ status: "ok", version: "wrong" }), { status: 200 }),
    }),
    /protocol mismatch/,
  );
  // A03: structured fields that contradict the legacy v1 marker are a broken contract.
  await assert.rejects(
    browserBootstrap.connectKBrainBackend(async () => ({}), {
      fetch: async () =>
        new Response(
          JSON.stringify({ status: "ok", version: "kbrain.agent.v1", protocol: { name: "kbrain.agent", major: 2, minor: 0 } }),
          { status: 200 },
        ),
    }),
    /health contract violation: protocol/,
  );
  await assert.rejects(
    browserBootstrap.connectKBrainBackend(async () => ({}), {
      fetch: async () =>
        new Response(JSON.stringify({ status: "ok", version: "kbrain.agent.v1", protocol: null }), { status: 200 }),
    }),
    /protocol must be an object/,
  );
  await assert.rejects(
    browserBootstrap.connectKBrainBackend(async () => ({}), {
      timeoutMs: 1,
      fetch: () => new Promise(() => {}),
    }),
    /timed out/,
  );
  const controller = new AbortController();
  controller.abort(new Error("cancelled by test"));
  await assert.rejects(
    browserBootstrap.connectKBrainBackend(async () => ({}), { signal: controller.signal }),
    /cancelled by test/,
  );
});

test("client endpoint override does not inherit a different backend token", async () => {
  const localLoader = createTsModuleLoader();
  const localConnection = localLoader.loadModule("src/lib/kbrain/runtimeConnection.ts");
  localConnection.setKBrainRuntimeConnection({ baseUrl: "http://127.0.0.1:49123", token: "runtime-secret", protocolVersion: "kbrain.agent.v1" });
  const { createKBrainClient } = localLoader.loadModule("src/lib/kbrain/client.ts");
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, authorization: new Headers(init.headers).get("Authorization") ?? undefined });
    return new Response(JSON.stringify({ models: [] }), { status: 200 });
  };
  await createKBrainClient({ baseUrl: "https://another-backend.invalid", fetch }).listModels();
  await createKBrainClient({ baseUrl: "http://127.0.0.1:49123/", fetch }).listModels();
  await createKBrainClient({ baseUrl: "http://127.0.0.1:49123/other", fetch }).listModels();
  await createKBrainClient({ baseUrl: "https://another-backend.invalid", token: "explicit-secret", fetch }).listModels();
  assert.deepEqual(requests.map((request) => request.authorization), [undefined, "Bearer runtime-secret", undefined, "Bearer explicit-secret"]);
});

test("client without options uses the bootstrapped dynamic connection", async () => {
  connection.setKBrainRuntimeConnection({ baseUrl: "http://dynamic.invalid", token: "runtime-token", protocolVersion: "kbrain.agent.v1" });
  const requests = [];
  const clientLoader = createTsModuleLoader({
    mocks: {
      [new URL("../../src/lib/kbrain/runtimeConnection.ts", import.meta.url).pathname]: connection,
    },
  });
  const { createKBrainClient } = clientLoader.loadModule("src/lib/kbrain/client.ts");
  const client = createKBrainClient({ fetch: async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
  } });
  await client.listModels();
  assert.equal(requests[0].url, "http://dynamic.invalid/v1/models");
  assert.equal(new Headers(requests[0].init.headers).get("Authorization"), "Bearer runtime-token");
});
