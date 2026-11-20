import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function load() {
  return createTsModuleLoader().loadModule("src/lib/kbrain/folderTrust.ts");
}

function fakeBackend(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const call = {
      method: init.method ?? "GET",
      path: parsed.pathname,
      workdir: parsed.searchParams.get("workdir"),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      auth: new Headers(init.headers).get("Authorization"),
    };
    calls.push(call);
    const [status, body] = routes(call);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, options: { baseUrl: "http://127.0.0.1:1", token: "trust-token", fetch } };
}

test("folder trust client reads, grants and revokes through /v1/trust", async () => {
  const { createKBrainFolderTrustClient, subscribeKBrainFolderTrustChanged } = load();
  let trusted = false;
  const backend = fakeBackend((call) => {
    if (call.method === "POST") trusted = call.body.trusted ?? true;
    if (call.method === "DELETE") trusted = false;
    return [200, { version: "kbrain.agent.v1", workdir: "/real/project dir", trusted, ...(trusted ? { source: "/real/project dir" } : {}) }];
  });
  const changes = [];
  const unsubscribe = subscribeKBrainFolderTrustChanged((status) => changes.push(status));
  const client = createKBrainFolderTrustClient(backend.options);

  assert.deepEqual(await client.get(" /link/project dir "), { workdir: "/real/project dir", trusted: false });
  assert.deepEqual(await client.trust("/link/project dir"), {
    workdir: "/real/project dir",
    trusted: true,
    source: "/real/project dir",
  });
  assert.deepEqual(await client.revoke("/link/project dir"), { workdir: "/real/project dir", trusted: false });
  unsubscribe();
  await client.trust("/link/project dir");

  assert.deepEqual(
    backend.calls.map(({ method, path, workdir, body }) => ({ method, path, workdir, body })),
    [
      { method: "GET", path: "/v1/trust", workdir: "/link/project dir", body: undefined },
      { method: "POST", path: "/v1/trust", workdir: null, body: { workdir: "/link/project dir" } },
      { method: "DELETE", path: "/v1/trust", workdir: "/link/project dir", body: undefined },
      { method: "POST", path: "/v1/trust", workdir: null, body: { workdir: "/link/project dir" } },
    ],
  );
  assert.ok(backend.calls.every((call) => call.auth === "Bearer trust-token"));
  assert.deepEqual(
    changes.map((status) => status.trusted),
    [true, false],
    "grant and revoke notify trust-dependent views; reads and unsubscribed listeners do not",
  );
});

test("folder trust client surfaces backend errors and rejects malformed replies", async () => {
  const { createKBrainFolderTrustClient } = load();
  const failing = createKBrainFolderTrustClient(
    fakeBackend(() => [400, { version: "kbrain.agent.v1", error: "workdir must be absolute" }]).options,
  );
  await assert.rejects(failing.get("relative"), (error) => {
    assert.equal(error.message, "workdir must be absolute");
    assert.equal(error.status, 400);
    return true;
  });
  await assert.rejects(failing.trust("relative"), /workdir must be absolute/);

  const malformed = createKBrainFolderTrustClient(fakeBackend(() => [200, { workdir: "/x" }]).options);
  await assert.rejects(malformed.get("/x"), /Invalid K-brain folder trust response/);
});

test("folder trust is unsupported when health lacks the capability or is unreachable", async () => {
  const { createKBrainFolderTrustClient } = load();
  const missing = createKBrainFolderTrustClient(fakeBackend(() => [404, "not found"]).options);
  assert.equal(await missing.supported(), false);
  const offline = createKBrainFolderTrustClient({
    baseUrl: "http://127.0.0.1:1",
    token: "t",
    fetch: async () => {
      throw new TypeError("connection refused");
    },
  });
  assert.equal(await offline.supported(), false);
});
