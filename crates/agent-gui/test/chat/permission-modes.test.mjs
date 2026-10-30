import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { resolveKBrainPermissionMode } = loader.loadModule("@liveagent/ui/lib/chat/permissionModes");
const { normalizeCommandSafetyMode, strictestCommandSafetyMode } = loader.loadModule("src/lib/settings");
const { normalizeGatewayCommandSafetyMode } = loader.loadModule("src/pages/chat/gateway/gatewayBridgeTypes");

test("permission choices map to K-brain and plan always takes precedence", () => {
  for (const [mode, expected] of [["ask", "normal"], ["autoEdit", "auto_edit"], ["autoReview", "auto_review"], ["always", "always"]]) {
    assert.equal(normalizeCommandSafetyMode(mode), mode);
    assert.equal(normalizeGatewayCommandSafetyMode(mode), mode);
    assert.equal(resolveKBrainPermissionMode(mode), expected);
    assert.equal(resolveKBrainPermissionMode(mode, true), "plan");
  }
});

test("the retired full-access mode migrates to always allow", () => {
  assert.equal(normalizeCommandSafetyMode("auto"), "always");
  assert.equal(normalizeCommandSafetyMode(" auto "), "always");
  // An older client may still send "auto"; it runs as "always", never as full_access.
  assert.equal(resolveKBrainPermissionMode("auto"), "always");
  assert.equal(resolveKBrainPermissionMode("auto", true), "plan");
});

test("remote choices cannot bypass a stricter local selection", () => {
  assert.equal(strictestCommandSafetyMode("always", "ask"), "ask");
  assert.equal(strictestCommandSafetyMode("auto", "autoReview"), "autoReview");
  assert.equal(strictestCommandSafetyMode("always", "sandboxOffline"), "sandboxOffline");
  assert.equal(strictestCommandSafetyMode("autoEdit", "autoReview"), "ask");
  assert.equal(strictestCommandSafetyMode("autoReview", "autoEdit"), "ask");
});

test("new modes require backend support and preserve the exact request identity", async (t) => {
  const requests = [];
  let supported = false;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url, body: raw ? JSON.parse(raw) : null });
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/health") {
      res.end(JSON.stringify({status: "ok", version: "kbrain.agent.v1", capabilities: {permission_modes: supported ? ["always", "auto_review", "auto_edit"] : []}}));
    } else {
      res.end(JSON.stringify({version:"kbrain.agent.v1",conversation_id:"session",run_id:"run",accepted_seq:1}));
    }
  });
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  t.after(() => {server.closeAllConnections(); server.close();});
  const {createKBrainClient} = loader.loadModule("src/lib/kbrain/client");
  const client = createKBrainClient({baseUrl:`http://127.0.0.1:${server.address().port}`});
  const input = {conversation_id:"session",client_request_id:"stable-request",prompt:"hello",options:{mode:"agent",permission_mode:"always"}};
  await assert.rejects(client.startRun(input), /update the backend/);
  assert.equal(requests.length,1);
  supported=true;
  await client.startRun(input);
  assert.equal(requests.filter(req => req.path.endsWith("/runs")).length,1);
  assert.deepEqual(requests.at(-1).body,input);
});

test("a contradicting health handshake blocks elevated modes before any run is posted", async (t) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/v1/health"
      ? {status: "ok", version: "kbrain.agent.v1", protocol: {name: "kbrain.agent", major: 2, minor: 0}, capabilities: {permission_modes: ["auto_review"]}}
      : {version: "kbrain.agent.v1", conversation_id: "session", run_id: "run", accepted_seq: 1}));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {server.closeAllConnections(); server.close();});
  const {createKBrainClient} = loader.loadModule("src/lib/kbrain/client");
  const client = createKBrainClient({baseUrl: `http://127.0.0.1:${server.address().port}`});
  const input = {conversation_id: "session", client_request_id: "stable-request", prompt: "hello", options: {mode: "agent", permission_mode: "auto_review"}};
  await assert.rejects(client.startRun(input), /health contract violation/);
  assert.deepEqual(requests, ["/v1/health"]);
});

// K-brain with capability ai_review_per_run accepts review_scope "per_run": the composer's
// permission mode alone decides AI review (the global setting is hidden). Older backends
// reject unknown run options, so the field is sent only when the capability is proven, and a
// relay without /v1/health still runs normal-mode turns.
test("runs opt into per-run AI review only when the backend advertises it", async (t) => {
  const posts = [];
  let health = { status: "ok", version: "kbrain.agent.v1", capabilities: { permission_modes: ["auto_review"], ai_review_per_run: 1 } };
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/health") {
      if (!health) { res.statusCode = 404; res.end("{}"); return; }
      res.end(JSON.stringify(health));
      return;
    }
    posts.push(JSON.parse(raw));
    res.end(JSON.stringify({ version: "kbrain.agent.v1", conversation_id: "session", run_id: "run", accepted_seq: 1 }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { createKBrainClient } = loader.loadModule("src/lib/kbrain/client");
  const url = `http://127.0.0.1:${server.address().port}`;
  const run = (client, permission_mode) =>
    client.startRun({ conversation_id: "session", client_request_id: `r-${posts.length}`, prompt: "hi", options: { mode: "agent", permission_mode } });

  const perRun = createKBrainClient({ baseUrl: url });
  await run(perRun, "normal");
  await run(perRun, "auto_review");
  assert.deepEqual(posts.map((body) => body.options.review_scope), ["per_run", "per_run"]);

  health = { status: "ok", version: "kbrain.agent.v1", capabilities: { permission_modes: ["auto_review"] } };
  await run(createKBrainClient({ baseUrl: url }), "normal");
  assert.equal("review_scope" in posts.at(-1).options, false, "older backend gets no review_scope");

  health = null;
  await run(createKBrainClient({ baseUrl: url }), "normal");
  assert.equal("review_scope" in posts.at(-1).options, false, "a relay without health still runs");
});
