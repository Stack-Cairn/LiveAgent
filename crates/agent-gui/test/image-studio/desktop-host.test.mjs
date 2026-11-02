import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const requests = [];
const loader = createTsModuleLoader({ mocks: {
  "../lib/host": { isTauriHost: () => false },
  "@liveagent/app/shims/tauriCore": { invoke: async () => assert.fail("native export is unavailable for browser hosts") },
  "./transport": { fetchKBrain: async (path, init, options) => {
    requests.push({ path, init, options });
    return Response.json({ status: "ok" });
  } },
} });
const { createDesktopImageStudioHost } = loader.loadModule("src/agent-ui-adapters/imageStudio.ts");
const { createBrowserImageDownload } = loader.loadModule("src/agent-ui-adapters/imageDownload.ts");
const runtime = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");
const connection = { baseUrl: "http://127.0.0.1:47321/", token: "private-test-token", protocolVersion: "kbrain.agent.v1" };

test("desktop host pins transport and isolates backend/workspace drafts; disposal aborts the client", async () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const a = createDesktopImageStudioHost(connection, "/repo/a", storage);
  const b = createDesktopImageStudioHost({ ...connection, baseUrl: "http://127.0.0.1:47322" }, "/repo/b", storage);
  try {
    assert.equal(a.host.ownerId, "local");
    assert.notEqual(a.host.backendId, b.host.backendId);
    assert.notEqual(a.host.scopeKey, b.host.scopeKey);
    a.host.storage.setItem("draft", "one");
    assert.equal(b.host.storage.getItem("draft"), null);
    assert.deepEqual(await a.host.client.capabilities(), { supported: false });
    assert.equal(requests.at(-1).path, "/v1/health");
    assert.equal(requests.at(-1).options.baseUrl, connection.baseUrl);
    assert.equal(requests.at(-1).options.token, connection.token);
    assert.equal(requests.at(-1).init.redirect, "error");
    assert.equal(new Headers(requests.at(-1).init.headers).has("X-Owner-Id"), false);
    await assert.rejects(a.host.client.exportAsset("ia_a", "remote_workspace"));
    a.dispose();
    const requestCount = requests.length;
    await assert.rejects(a.host.client.capabilities(), { code: "IMAGE_ABORTED" });
    assert.equal(requests.length, requestCount);
  } finally { a.dispose(); b.dispose(); }
});

test("native export is limited to manager-local connections and sanitizes failures", async () => {
  const calls = [];
  let result = { saved: true }, failure;
  const nativeLoader = createTsModuleLoader({ mocks: {
    "../lib/host": { isTauriHost: () => true },
    "@liveagent/app/shims/tauriCore": { invoke: async (command, args) => {
      calls.push({ command, args });
      if (failure) throw failure;
      return result;
    } },
  } });
  const { createNativeImageExports } = nativeLoader.loadModule("src/agent-ui-adapters/imageExport.ts");
  assert.equal(createNativeImageExports(connection), undefined);
  const exports = createNativeImageExports({ ...connection, managedLocal: true });
  assert.deepEqual(Object.keys(exports), ["download", "local_workspace"]);
  assert.deepEqual(await exports.local_workspace("ia_a"), { saved: true });
  assert.deepEqual(calls[0], { command: "image_export_asset", args: { request: { assetId: "ia_a", backendBaseUrl: connection.baseUrl, destination: "local_workspace" } } });
  result = { saved: false };
  assert.deepEqual(await exports.download("ia_a"), { saved: false });
  failure = { code: "INVALID_ARGUMENT", message: "secret raw filesystem path" };
  await assert.rejects(exports.download("ia_a"), error => error.code === "IMAGE_INVALID_INPUT" && !error.message.includes("secret"));
  failure = "secret backend URL";
  await assert.rejects(exports.download("ia_a"), error => error.code === "IMAGE_EXPORT_FAILED" && !error.message.includes("secret"));
});

test("runtime connection subscription observes backend replacement and cleanup", () => {
  let changes = 0;
  const unsubscribe = runtime.subscribeKBrainRuntimeConnection(() => changes++);
  runtime.setKBrainRuntimeConnection(connection);
  runtime.clearKBrainRuntimeConnection();
  assert.equal(changes, 2);
  unsubscribe();
  runtime.setKBrainRuntimeConnection(connection);
  assert.equal(changes, 2);
  runtime.clearKBrainRuntimeConnection();
});

test("browser download confirms write completion, cancellation and write failure", async () => {
  const operations = [];
  const blob = new Blob(["original"], { type: "image/webp" });
  const read = async (_id, variant) => { assert.equal(variant, "original"); operations.push("read"); return blob; };
  const picker = async () => { operations.push("pick"); return { createWritable: async () => ({
    write: async value => { assert.equal(value, blob); operations.push("write"); },
    close: async () => operations.push("close"), abort: async () => operations.push("abort"),
  }) }; };
  assert.deepEqual(await createBrowserImageDownload(read, picker)("ia_a"), { saved: true });
  assert.deepEqual(operations, ["pick", "read", "write", "close"]);
  const cancel = async () => { throw new DOMException("Cancelled", "AbortError"); };
  assert.deepEqual(await createBrowserImageDownload(read, cancel)("ia_a"), { saved: false });
  const broken = async () => ({ createWritable: async () => ({ write: async () => { throw Error("disk full"); }, close: async () => assert.fail("must not close"), abort: async () => operations.push("abort") }) });
  await assert.rejects(createBrowserImageDownload(read, broken)("ia_a"), /disk full/);
  assert.equal(operations.at(-1), "abort");
});

test("desktop verification journal is isolated by backend and workspace and survives host recreation",()=>{
  const values=new Map();const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
  const prefix=JSON.stringify(["local",connection.baseUrl.replace(/\/+$/,""),"/repo/a"]);
  const attempt={version:1,targetId:"it_test",key:"stable-key",input:{expectedRevision:1,projectId:"ip_test",connectionId:"ic_test",remoteId:"gpt-image-2",targetRevision:1,operation:"generate",count:1,prompt:"fixture",confirmPaid:true}};
  values.set(prefix+":image-verification:v1:it_test",JSON.stringify(attempt));
  const a=createDesktopImageStudioHost(connection,"/repo/a",storage);
  const b=createDesktopImageStudioHost({...connection,baseUrl:"http://127.0.0.1:47322"},"/repo/a",storage);
  const c=createDesktopImageStudioHost(connection,"/repo/b",storage);
  try {
    assert.equal(a.host.client.loadVerificationAttempt("it_test").key,"stable-key");
    assert.equal(b.host.client.loadVerificationAttempt("it_test"),null);
    assert.equal(c.host.client.loadVerificationAttempt("it_test"),null);
  }finally {a.dispose();b.dispose();c.dispose();}
});