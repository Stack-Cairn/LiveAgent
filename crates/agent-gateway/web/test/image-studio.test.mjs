import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const { createGatewayImageClient, createGatewayImageTransport } = loader.loadModule("src/lib/imageStudio.ts");
const { createWebImageStudioHost, gatewayImageErrorNotice } = loader.loadModule("src/agent-ui-adapters/imageStudio.ts");
const fixture = JSON.parse(readFileSync(new URL("../../../agent-ui/src/lib/imaging/testdata/wire-v1.json", import.meta.url), "utf8"));
const version = fixture.version;
const connection = { baseUrl: "https://gateway.example", backendId: "selected /?&后端", token: "gateway-token" };
const identity = { ownerId: "verified-user", backendId: connection.backendId, gatewayOrigin: connection.baseUrl, accessToken: connection.token };
const json = (body, status = 200) => Response.json({ version, ...body }, { status });
const failure = (status, code) => json({ error: { code, message: "server detail", retryable: false, requestId: "req-image" } }, status);
const profileSet = {
  revision: 1,
  profiles: [{
    id: "ic_fixture", name: "Example provider", platform: "openai", baseUrl: "https://example.invalid", enabled: true,
    models: fixture.settings.targets.map((target) => target.remoteId), apiKeyConfigured: true,
    targets: fixture.settings.targets.map((target) => ({
      id: target.id, model: target.remoteId, adapter: target.adapter, capabilities: target.capabilities, parameters: target.parameters, ready: target.enabled,
    })),
  }],
};
const asset = { id: "ia_fixture", hash: "hash", mime: "image/png", bytes: 3, width: 1, height: 1, source: "upload", parentAssetIds: [], createdAt: fixture.job.createdAt, available: true };

test("all shared client HTTP routes use explicit backend and authenticated gateway health", async () => {
  const calls = [];
  const client = createGatewayImageClient({ ...connection, fetch: async (url, init) => {
    const parsed = new URL(url);
    calls.push({ parsed, init });
    assert.equal(parsed.origin, connection.baseUrl);
    assert.deepEqual(parsed.searchParams.getAll("backendId"), [connection.backendId]);
    assert.equal(init.headers.get("Authorization"), "Bearer gateway-token");
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    assert.equal(init.cache, "no-store");
    assert.ok(init.signal instanceof AbortSignal);
    if (parsed.pathname.endsWith("/health")) return Response.json({ status: "ok", capabilities: { image: { supported: true, version } } });
    if (parsed.pathname.endsWith("/profiles")) return json(profileSet);
    if (parsed.pathname.endsWith("/settings")) return json({ settings: fixture.settings });
    if (parsed.pathname.endsWith("/secrets")) return json({ ref: "opaque-ref", configured: true });
    if (parsed.pathname.endsWith("/projects")) return json({ items: [], nextCursor: "next" });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    if (parsed.pathname.endsWith("/jobs") && !init.method) return json({ items: [fixture.job] });
    return json({ job: fixture.job, replayed: false });
  } });
  assert.deepEqual(await client.capabilities(), { supported: true, version });
  assert.equal((await client.listTargets()).length, 2);
  assert.equal((await client.getSettings()).revision, 1);
  await client.saveSettings({ expectedRevision: 1, connections: [], targets: [] });
  await client.writeSecret({ connectionId: "ic_fixture", purpose: "bearer", value: "secret" });
  await client.listProjects("cursor &?#");
  await client.deleteProject("ip_fixture");
  await client.createJob(fixture.job.request, "explicit-idempotency-key");
  await client.getJob("ij_fixture");
  await client.listJobs("ip_fixture", "cursor?&");
  await client.cancelJob("ij_fixture");
  assert.equal(calls[0].parsed.pathname, "/api/image/health");
  assert.equal(calls[5].parsed.searchParams.get("cursor"), "cursor &?#");
  assert.equal(calls[7].init.headers.get("Idempotency-Key"), "explicit-idempotency-key");
  assert.equal(calls[9].parsed.searchParams.get("projectId"), "ip_fixture");
  assert.equal(calls[9].parsed.searchParams.get("cursor"), "cursor?&");
  assert.equal(calls[10].parsed.pathname, "/api/image/jobs/ij_fixture/cancel");
});

test("transport strips browser identity/delegation and cannot replace authorization or selected backend", async () => {
  let received;
  const transport = createGatewayImageTransport({ ...connection, fetch: async (url, init) => {
    received = { url: new URL(url), init };
    return json({});
  } });
  await transport("/api/image/targets?backendId=other&backendId=third", { headers: {
    "X-Owner-ID": "local", "X-Scope": "owner", "X-Image-Delegation": "fake", "X-Backend-ID": "other", Authorization: "Bearer fake",
  } });
  assert.deepEqual(received.url.searchParams.getAll("backendId"), [connection.backendId]);
  assert.deepEqual([...received.init.headers], [["authorization", "Bearer gateway-token"]]);
  for (const path of ["https://provider.example/api/image/jobs", "/api/image/../../other", "/api/image/jobs#fragment"]) {
    assert.throws(() => transport(path, {}), { code: "IMAGE_INVALID_INPUT" });
  }
  assert.throws(() => createGatewayImageClient({ ...connection, backendId: "" }), { code: "IMAGE_INVALID_INPUT" });
  assert.throws(() => createGatewayImageClient({ ...connection, token: "" }), { code: "IMAGE_AUTH_REQUIRED" });
});

test("multipart bytes and authenticated asset Blob stay on selected gateway backend", async () => {
  let uploaded;
  const client = createGatewayImageClient({ ...connection, fetch: async (url, init) => {
    const path = new URL(url);
    assert.equal(path.searchParams.get("backendId"), connection.backendId);
    if (init.method === "POST") {
      assert.equal(path.pathname, "/api/image/assets");
      assert.equal(init.headers.has("Content-Type"), false);
      assert.ok(init.body instanceof FormData);
      uploaded = init.body.get("file");
      return json({ asset });
    }
    assert.equal(path.pathname, "/api/image/assets/ia_fixture/content");
    assert.equal(path.searchParams.get("variant"), "original");
    return new Response(new Uint8Array([0, 128, 255]), { headers: { "Content-Type": "image/png" } });
  } });
  await client.upload(new Blob([new Uint8Array([0, 128, 255])], { type: "image/png" }), "sample.png");
  assert.equal(uploaded.name, "sample.png");
  assert.deepEqual(new Uint8Array(await uploaded.arrayBuffer()), new Uint8Array([0, 128, 255]));
  const blob = await client.readAsset("ia_fixture", "original");
  assert.ok(blob instanceof Blob);
  assert.equal(blob.type, "image/png");
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array([0, 128, 255]));
});

test("health auth and identity failures preserve HTTP status/code, not unsupported", async () => {
  for (const [status, code] of [[401, "IMAGE_AUTH_REQUIRED"], [403, "IMAGE_FORBIDDEN"], [503, "IMAGE_IDENTITY_UNAVAILABLE"], [502, "IMAGE_BACKEND_UNAVAILABLE"]]) {
    const client = createGatewayImageClient({ ...connection, fetch: async () => failure(status, code) });
    await assert.rejects(client.capabilities(), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      assert.match(gatewayImageErrorNotice(error), new RegExp(`HTTP ${status}`));
      assert.match(gatewayImageErrorNotice(error), new RegExp(code));
      return true;
    });
  }
});

test("ambiguous failed writes are never automatically replayed", async () => {
  for (const mode of ["network", "http"]) {
    let requests = 0;
    const client = createGatewayImageClient({ ...connection, fetch: async () => {
      requests++;
      if (mode === "network") throw new TypeError("connection closed");
      return failure(503, "IMAGE_IDENTITY_UNAVAILABLE");
    } });
    await assert.rejects(client.createJob(fixture.job.request, "persisted-key"));
    assert.equal(requests, 1);
    await assert.rejects(client.saveSettings({ expectedRevision: 1, connections: [], targets: [] }));
    assert.equal(requests, 2);
    await assert.rejects(client.upload(new Blob(["bytes"]), "sample.png"));
    assert.equal(requests, 3);
  }
});

test("SSE keeps auth/backend and last sequence; disposing aborts and cancels the reader", async () => {
  let requestSignal;
  let cancelled = false;
  let ready;
  const opened = new Promise((resolve) => { ready = resolve; });
  const session = createWebImageStudioHost({ ...connection, fetch: async (url, init) => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, "/api/image/jobs/ij_fixture/events");
    assert.equal(parsed.searchParams.get("backendId"), connection.backendId);
    assert.equal(init.headers.get("Authorization"), "Bearer gateway-token");
    assert.equal(init.headers.get("Last-Event-ID"), "4");
    requestSignal = init.signal;
    ready();
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "Content-Type": "text/event-stream" } });
  } }, identity, "/workspace");
  const pending = session.host.client.subscribe("ij_fixture", 4, () => assert.fail("unexpected event"));
  await opened;
  await new Promise((resolve) => setImmediate(resolve));
  session.dispose();
  await assert.rejects(pending, { code: "IMAGE_ABORTED" });
  assert.equal(requestSignal.aborted, true);
  assert.equal(cancelled, true);
});

test("SSE parses terminal event through real shared reader without extra reconnect", async () => {
  let requests = 0;
  const events = [];
  const client = createGatewayImageClient({ ...connection, fetch: async () => {
    requests++;
    return new Response(`id: 5\nevent: image.event\ndata: ${JSON.stringify(fixture.event)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  } });
  await client.subscribe("ij_fixture", 4, (event) => events.push(event));
  assert.equal(events[0].seq, 5);
  assert.equal(requests, 1);
});

test("host rejects absent/mismatched trusted identity before touching owner drafts or network", () => {
  const storage = { getItem() { assert.fail("read"); }, setItem() { assert.fail("write"); }, removeItem() { assert.fail("remove"); } };
  const conn = { ...connection, fetch() { assert.fail("network"); } };
  assert.throws(() => createWebImageStudioHost(conn, undefined, "/workspace", storage), { code: "IMAGE_IDENTITY_UNAVAILABLE" });
  for (const changed of [{ ownerId: " " }, { backendId: "other" }, { gatewayOrigin: "https://other.example" }, { accessToken: "previous-login" }]) {
    assert.throws(() => createWebImageStudioHost(conn, { ...identity, ...changed }, "/workspace", storage));
  }
});

test("draft scope isolates gateway, trusted owner, selected backend and workspace; abort revokes old client", async () => {
  const data = new Map();
  const storage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) };
  const session = createWebImageStudioHost(connection, identity, "/workspace", storage);
  session.host.storage.setItem("draft", "prompt");
  assert.equal(session.host.ownerId, "verified-user");
  assert.equal(session.host.storage.getItem("draft"), "prompt");
  for (const [conn, who, workspace] of [
    [connection, identity, "/other"],
    [connection, { ...identity, ownerId: "other-user" }, "/workspace"],
    [{ ...connection, backendId: "other-backend" }, { ...identity, backendId: "other-backend" }, "/workspace"],
    [{ ...connection, baseUrl: "https://other.example" }, { ...identity, gatewayOrigin: "https://other.example" }, "/workspace"],
  ]) {
    const other = createWebImageStudioHost(conn, who, workspace, storage);
    assert.notEqual(other.host.scopeKey, session.host.scopeKey);
    assert.equal(other.host.storage.getItem("draft"), null);
    other.dispose();
  }
  assert.ok(!session.host.scopeKey.includes(connection.token));
  session.dispose();
  await assert.rejects(session.host.client.listTargets(), { code: "IMAGE_ABORTED" });
});

test("WebUI offers only observable browser download and reports saved after completed write", async () => {
  const previous = globalThis.showSaveFilePicker;
  try {
    const withoutPicker = createWebImageStudioHost(connection, identity, "/workspace");
    assert.deepEqual(withoutPicker.host.exportDestinations, []);
    await assert.rejects(withoutPicker.host.client.exportAsset("ia_fixture", "download"), { code: "IMAGE_UNSUPPORTED_OPERATION" });
    withoutPicker.dispose();
    const calls = [];
    globalThis.showSaveFilePicker = async () => {
      calls.push("picker");
      return { createWritable: async () => ({ write: async (blob) => { calls.push(await blob.text()); }, close: async () => { calls.push("closed"); }, abort: async () => calls.push("aborted") }) };
    };
    const session = createWebImageStudioHost({ ...connection, fetch: async () => new Response("pixels", { headers: { "Content-Type": "image/png" } }) }, identity, "/workspace");
    assert.deepEqual(session.host.exportDestinations, ["download"]);
    assert.deepEqual(await session.host.client.exportAsset("ia_fixture", "download"), { saved: true });
    assert.deepEqual(calls, ["picker", "pixels", "closed"]);
    for (const destination of ["local_workspace", "remote_workspace"]) {
      await assert.rejects(session.host.client.exportAsset("ia_fixture", destination), { code: "IMAGE_UNSUPPORTED_OPERATION" });
    }
    session.dispose();
    globalThis.showSaveFilePicker = async () => { throw new DOMException("cancelled", "AbortError"); };
    const cancelled = createWebImageStudioHost({ ...connection, fetch: async () => assert.fail("cancel must not download") }, identity, "/workspace");
    assert.deepEqual(await cancelled.host.client.exportAsset("ia_fixture", "download"), { saved: false });
    cancelled.dispose();
  } finally {
    if (previous === undefined) delete globalThis.showSaveFilePicker;
    else globalThis.showSaveFilePicker = previous;
  }
});
