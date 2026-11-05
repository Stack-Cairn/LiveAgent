import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { resolveKBrainPermissionMode, resolveKBrainRunSandbox } = loader.loadModule(
  "@liveagent/ui/lib/chat/permissionModes",
);
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

test("sandbox modes auto-edit and confine commands with the backend's OS sandbox", () => {
  for (const [mode, network] of [["sandbox", true], ["sandboxOffline", false]]) {
    assert.equal(normalizeCommandSafetyMode(mode), mode);
    assert.equal(normalizeGatewayCommandSafetyMode(mode), mode);
    assert.equal(resolveKBrainPermissionMode(mode), "auto_edit");
    assert.equal(resolveKBrainPermissionMode(mode, true), "plan");
    assert.deepEqual(resolveKBrainRunSandbox(mode), { mode: "workspace", network });
  }
  for (const mode of ["ask", "autoEdit", "autoReview", "always", "auto", undefined]) {
    assert.equal(resolveKBrainRunSandbox(mode), undefined);
  }
});

test("a sandboxed run is refused, never sent unconfined, when the backend cannot enforce it", async (t) => {
  const posts = [];
  let runSandbox;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/health") {
      const capabilities = { permission_modes: ["auto_edit"] };
      if (runSandbox) capabilities.run_sandbox = runSandbox;
      res.end(JSON.stringify({ status: "ok", version: "kbrain.agent.v1", capabilities }));
      return;
    }
    posts.push(JSON.parse(raw));
    res.end(JSON.stringify({ version: "kbrain.agent.v1", conversation_id: "session", run_id: "run", accepted_seq: 1 }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { createKBrainClient } = loader.loadModule("src/lib/kbrain/client");
  const url = `http://127.0.0.1:${server.address().port}`;
  const run = (network) =>
    createKBrainClient({ baseUrl: url }).startRun({
      conversation_id: "session",
      client_request_id: `r-${posts.length}-${network}`,
      prompt: "hi",
      options: { mode: "agent", permission_mode: "auto_edit", sandbox: { mode: "workspace", network } },
    });

  await assert.rejects(run(true), /cannot sandbox commands/);
  runSandbox = { supported: true, network_control: false };
  await assert.rejects(run(false), /offline sandbox/);
  assert.equal(posts.length, 0, "nothing reaches the backend unconfined");
  await run(true);
  runSandbox = { supported: true, network_control: true };
  await run(false);
  // A sandbox that leaves .liveagent and .git/hooks writable is no sandbox for LiveAgent.
  runSandbox = { supported: true, mechanism: "landlock", network_control: true, read_masking: false, path_protection: false };
  await assert.rejects(run(true), /protected paths/);
  await assert.rejects(run(false), /protected paths/);
  runSandbox = { supported: true, mechanism: "bubblewrap", network_control: true, read_masking: true, path_protection: true };
  await run(true);
  assert.deepEqual(posts.map((body) => body.options.sandbox), [
    { mode: "workspace", network: true },
    { mode: "workspace", network: false },
    { mode: "workspace", network: true },
  ]);
});

test("run sandbox health gate requires path protection", () => {
  const { supportsRunSandbox, runSandboxLacksPathProtection } = loader.loadModule("@liveagent/ui/lib/kbrain/health");
  const health = (runSandbox) => ({ capabilities: { run_sandbox: runSandbox } });
  const online = { network: true };
  const offline = { network: false };
  const landlock = { supported: true, mechanism: "landlock", network_control: true, read_masking: false, path_protection: false };
  assert.equal(runSandboxLacksPathProtection(landlock), true);
  assert.equal(supportsRunSandbox(health(landlock), online), false);
  assert.equal(supportsRunSandbox(health(landlock), offline), false);
  // Older K-brain omits the field and only used mechanisms that protect the paths.
  const legacy = { supported: true, mechanism: "seatbelt", network_control: true };
  assert.equal(runSandboxLacksPathProtection(legacy), false);
  assert.equal(supportsRunSandbox(health(legacy), online), true);
  assert.equal(supportsRunSandbox(health(legacy), offline), true);
  // ...except Landlock, which never protects them.
  assert.equal(runSandboxLacksPathProtection({ supported: true, mechanism: "landlock", network_control: true }), true);
  const protectedSandbox = { ...landlock, mechanism: "bubblewrap", read_masking: true, path_protection: true };
  assert.equal(supportsRunSandbox(health(protectedSandbox), online), true);
  assert.equal(supportsRunSandbox(health(protectedSandbox), offline), true);
  assert.equal(runSandboxLacksPathProtection(undefined), false);
  assert.equal(runSandboxLacksPathProtection({ ...landlock, supported: false }), false, "unsupported for its own reason");
  assert.equal(supportsRunSandbox({ capabilities: {} }, online), false);
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

test("agent turns carry the sandbox the composer mode asks for", () => {
  const { canonicalRunOptions } = loader.loadModule("src/pages/chat/turns/runKBrainConversationTurn");
  const agent = (commandSafetyMode) =>
    canonicalRunOptions({ effectiveWorkdir: "/w", runtime: {}, commandSafetyMode });
  assert.deepEqual(agent("sandbox").sandbox, { mode: "workspace", network: true });
  assert.equal(agent("sandbox").permission_mode, "auto_edit");
  assert.deepEqual(agent("sandboxOffline").sandbox, { mode: "workspace", network: false });
  assert.equal("sandbox" in agent("ask"), false);
  assert.equal("sandbox" in agent("always"), false);
  // Plan mode keeps the sandbox for anything it lets through.
  const plan = canonicalRunOptions({ effectiveWorkdir: "/w", runtime: {}, commandSafetyMode: "sandbox", planModeEnabled: true });
  assert.equal(plan.permission_mode, "plan");
  assert.deepEqual(plan.sandbox, { mode: "workspace", network: true });
});

test("the desktop reads the sandbox capability from K-brain health", () => {
  const { sandboxCapabilityFromHealth } = loader.loadModule("src/agent-ui-adapters/sandboxCapability");
  const old = sandboxCapabilityFromHealth({ capabilities: { permission_modes: ["auto_edit"] } });
  assert.equal(old.supported, false);
  assert.match(old.reason, /update K-brain/);
  assert.deepEqual(
    sandboxCapabilityFromHealth({
      capabilities: {
        run_sandbox: { supported: true, version: "kbrain.sandbox.v1", mechanism: "seatbelt", platform: "darwin", network_control: true, read_masking: true, modes: ["workspace"] },
      },
    }),
    { supported: true, mechanism: "seatbelt", platform: "darwin", network_control: true, read_masking: true },
  );
  const unsupported = sandboxCapabilityFromHealth({
    capabilities: { run_sandbox: { supported: false, network_control: true, reason: "bwrap not found" } },
  });
  assert.equal(unsupported.supported, false);
  assert.equal(unsupported.network_control, false, "no offline sandbox without a sandbox");
  assert.equal(unsupported.reason, "bwrap not found");
  const reason = "bwrap is not installed; using Landlock (ABI 6) with seccomp";
  const landlock = sandboxCapabilityFromHealth({
    capabilities: {
      run_sandbox: { supported: true, mechanism: "landlock", platform: "linux", network_control: true, read_masking: false, path_protection: false, reason },
    },
  });
  assert.deepEqual(
    landlock,
    { supported: false, mechanism: "landlock", platform: "linux", network_control: false, read_masking: false, path_protection: false, reason },
    "protected paths left writable disable both sandbox modes",
  );
  assert.deepEqual(
    sandboxCapabilityFromHealth({
      capabilities: {
        run_sandbox: { supported: true, mechanism: "bubblewrap", platform: "linux", network_control: true, read_masking: true, path_protection: true },
      },
    }),
    { supported: true, mechanism: "bubblewrap", platform: "linux", network_control: true, read_masking: true, path_protection: true },
  );
  // Landlock from a backend that predates the field is still unprotected.
  const unlabelled = sandboxCapabilityFromHealth({
    capabilities: { run_sandbox: { supported: true, mechanism: "landlock", platform: "linux", network_control: true } },
  });
  assert.equal(unlabelled.supported, false);
  assert.equal(unlabelled.path_protection, false);
  // An unsupported sandbox keeps the backend's reason; path protection is moot.
  const bwrapMissing = sandboxCapabilityFromHealth({
    capabilities: {
      run_sandbox: { supported: false, mechanism: "bubblewrap", platform: "linux", network_control: false, read_masking: false, path_protection: false, reason: "bubblewrap (bwrap) is not installed" },
    },
  });
  assert.equal(bwrapMissing.supported, false);
  assert.equal("path_protection" in bwrapMissing, false);
  assert.equal(bwrapMissing.reason, "bubblewrap (bwrap) is not installed");
});
