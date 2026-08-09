import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const baseServer = {
  id: "demo",
  enabled: true,
  transport: "stdio",
  command: "demo-mcp",
  args: [],
  url: "",
  env: undefined,
  cwd: undefined,
  headers: undefined,
  timeoutMs: 60_000,
  messageUrl: undefined,
};

function createMcpBundle({
  settings = { servers: [], selected: [] },
  runtimeScope = "chat",
  workdir = "/workspace",
  invokeImpl,
  writable = true,
  resolveHomeDir,
} = {}) {
  const invocations = [];
  const updates = [];
  const events = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          events.push(`invoke:${command}`);
          if (invokeImpl) {
            return invokeImpl(command, args);
          }
          throw new Error(`unexpected invoke: ${command}`);
        },
      },
    },
  });
  const mcpOps = loader.loadModule("src/lib/settings/mcpOps.ts");
  const mcpManagerTools = loader.loadModule("src/lib/tools/mcpManagerTools.ts");
  // The harness mirrors App.setSettings: reads and commits are synchronous
  // against a single mutable authority, writes go through the real reducer.
  let currentSettings = settings;
  const bundle = mcpManagerTools.createMcpManagerTools({
    workdir,
    getMcpSettings: () => currentSettings,
    applyMcpOps: writable
      ? (ops) => {
          currentSettings = mcpOps.applyMcpOps(currentSettings, ops);
          updates.push(currentSettings);
          events.push("commit");
        }
      : undefined,
    runtimeScope,
    resolveHomeDir,
  });

  return {
    bundle,
    invocations,
    updates,
    events,
    redaction: mcpManagerTools.redactMcpServerConfig,
    applyExternal(mutator) {
      currentSettings = mutator(currentSettings);
    },
    get settings() {
      return currentSettings;
    },
  };
}

async function callMcpManager(bundle, arguments_, signal) {
  return bundle.executeToolCall(
    {
      type: "toolCall",
      id: `mcp-${arguments_.action}`,
      name: "McpManager",
      arguments: arguments_,
    },
    signal,
  );
}

test("McpManager is always registered as a builtin tool", async () => {
  const loader = createTsModuleLoader();
  const registryModule = loader.loadModule("src/lib/tools/builtinRegistry.ts");
  const fileToolState = loader.loadModule("src/lib/tools/fileToolState.ts");

  const registry = await registryModule.buildBuiltinToolRegistry({
    workdir: "/workspace",
    providerId: "codex",
    fileState: fileToolState.createFileToolState(),
    skillsEnabled: false,
    runtimeScope: "chat",
    getMcpSettings: () => ({ servers: [], selected: [] }),
  });

  assert.equal(registry.hasTool("McpManager"), true);
  assert.equal(registry.metadataByName.get("McpManager").kind, "manage_mcp");
});

test("builtin registry resolves tool names with casing drift before execution", async () => {
  const loader = createTsModuleLoader();
  const registryModule = loader.loadModule("src/lib/tools/builtinRegistry.ts");
  const fileToolState = loader.loadModule("src/lib/tools/fileToolState.ts");

  const registry = await registryModule.buildBuiltinToolRegistry({
    workdir: "/workspace",
    providerId: "codex",
    fileState: fileToolState.createFileToolState(),
    skillsEnabled: false,
    runtimeScope: "chat",
    getMcpSettings: () => ({ servers: [], selected: [] }),
  });

  assert.equal(registry.hasTool("mcpmanager"), true);

  const result = await registry.executeToolCall({
    type: "toolCall",
    id: "call-lower-mcp-manager",
    name: "mcpmanager",
    arguments: { action: "list" },
  });

  assert.equal(result.isError, false);
  assert.equal(result.toolName, "McpManager");
  assert.equal(result.details.kind, "manage_mcp");
});

test("ManagedProcess is registered only for chat runtime", async () => {
  const loader = createTsModuleLoader();
  const registryModule = loader.loadModule("src/lib/tools/builtinRegistry.ts");
  const fileToolState = loader.loadModule("src/lib/tools/fileToolState.ts");

  const baseParams = {
    workdir: "/workspace",
    providerId: "codex",
    fileState: fileToolState.createFileToolState(),
    skillsEnabled: false,
    getMcpSettings: () => ({ servers: [], selected: [] }),
  };

  const chatRegistry = await registryModule.buildBuiltinToolRegistry({
    ...baseParams,
    runtimeScope: "chat",
  });
  const cronRegistry = await registryModule.buildBuiltinToolRegistry({
    ...baseParams,
    fileState: fileToolState.createFileToolState(),
    runtimeScope: "cron_auto_prompt",
  });

  assert.equal(chatRegistry.hasTool("ManagedProcess"), true);
  assert.equal(cronRegistry.hasTool("ManagedProcess"), false);
  assert.equal(cronRegistry.hasTool("Bash"), true);
});

test("McpManager create defaults to enabled without separate selection", async () => {
  const { bundle, updates } = createMcpBundle();

  const result = await callMcpManager(bundle, {
    action: "create",
    server: {
      id: "demo",
      transport: "stdio",
      command: "demo-mcp",
    },
  });

  assert.equal(result.isError, false);
  assert.equal(result.details.kind, "manage_mcp");
  assert.equal(result.details.action, "create");
  assert.equal(result.details.changed, true);
  assert.deepEqual(updates, [
    {
      servers: [baseServer],
      selected: [],
    },
  ]);
});

test("McpManager creates, updates, and lists MCP metadata", async () => {
  const context = createMcpBundle({
    invokeImpl(command, args) {
      assert.equal(command, "mcp_stop_server");
      return { serverId: args.server_id, stopped: true };
    },
  });

  const created = await callMcpManager(context.bundle, {
    action: "create",
    server: {
      id: "demo",
      description: "Search project docs",
      docsUrl: "https://docs.example.com/mcp",
      transport: "stdio",
      command: "demo-mcp",
    },
  });
  assert.equal(created.isError, false);
  assert.equal(context.settings.servers[0].description, "Search project docs");
  assert.equal(context.settings.servers[0].docsUrl, "https://docs.example.com/mcp");

  const listed = await callMcpManager(context.bundle, { action: "list" });
  assert.equal(listed.isError, false);
  assert.match(listed.content[0].text, /description="Search project docs"/);
  assert.match(listed.content[0].text, /docsUrl="https:\/\/docs\.example\.com\/mcp"/);

  const updated = await callMcpManager(context.bundle, {
    action: "update",
    server_id: "demo",
    patch: {
      description: "",
      docsUrl: "https://example.com/new-docs",
    },
  });
  assert.equal(updated.isError, false);
  assert.equal(context.settings.servers[0].description, undefined);
  assert.equal(context.settings.servers[0].docsUrl, "https://example.com/new-docs");
});

test("McpManager resolves local cwd inputs before persisting or testing servers", async () => {
  const workdir = "/workspace";
  const created = createMcpBundle({ workdir });

  const createResult = await callMcpManager(created.bundle, {
    action: "create",
    server: {
      id: "demo",
      transport: "stdio",
      command: "demo-mcp",
      cwd: "tools/mcp",
    },
  });

  assert.equal(createResult.isError, false);
  assert.equal(created.updates.at(-1).servers[0].cwd, "/workspace/tools/mcp");

  const updated = createMcpBundle({
    workdir,
    settings: { servers: [{ ...baseServer, cwd: "/workspace/tools/mcp" }], selected: ["demo"] },
    invokeImpl(command, args) {
      assert.equal(command, "mcp_stop_server");
      return { serverId: args.server_id, stopped: true };
    },
  });

  const updateResult = await callMcpManager(updated.bundle, {
    action: "update",
    server_id: "demo",
    patch: { cwd: "file:///workspace/tools/new-mcp" },
  });

  assert.equal(updateResult.isError, false);
  assert.equal(updated.updates.at(-1).servers[0].cwd, "/workspace/tools/new-mcp");

  const tested = createMcpBundle({
    workdir,
    invokeImpl(command, args) {
      assert.equal(command, "mcp_test_server");
      assert.equal(args.server.cwd, "/workspace/tools/inline-mcp");
      assert.equal(args.persist, false);
      return {
        serverId: args.server.id,
        ok: true,
        phase: "tools_list",
        transport: args.server.transport,
        durationMs: 1,
        running: true,
        initialized: true,
        toolsCount: 0,
        tools: [],
        error: null,
        stderrTail: null,
      };
    },
  });

  const testResult = await callMcpManager(tested.bundle, {
    action: "test",
    server: {
      id: "inline",
      transport: "stdio",
      command: "inline-mcp",
      cwd: "workspace:tools/inline-mcp",
    },
  });

  assert.equal(testResult.isError, false);
});

test("McpManager normalizes Windows local cwd inputs", async () => {
  const workdir = "C:/Users/Alice/Repo";
  const created = createMcpBundle({ workdir });

  const createResult = await callMcpManager(created.bundle, {
    action: "create",
    server: {
      id: "demo",
      transport: "stdio",
      command: "demo-mcp",
      cwd: "C:\\Users\\Alice\\Repo\\tools\\mcp",
    },
  });

  assert.equal(createResult.isError, false);
  assert.equal(created.updates.at(-1).servers[0].cwd, "C:/Users/Alice/Repo/tools/mcp");

  const updated = createMcpBundle({
    workdir,
    settings: {
      servers: [{ ...baseServer, cwd: "C:/Users/Alice/Repo/tools/mcp" }],
      selected: ["demo"],
    },
    invokeImpl(command, args) {
      assert.equal(command, "mcp_stop_server");
      return { serverId: args.server_id, stopped: true };
    },
  });

  const updateResult = await callMcpManager(updated.bundle, {
    action: "update",
    server_id: "demo",
    patch: { cwd: "file:///C:/Users/Alice/Repo/tools/new-mcp" },
  });

  assert.equal(updateResult.isError, false);
  assert.equal(updated.updates.at(-1).servers[0].cwd, "C:/Users/Alice/Repo/tools/new-mcp");
});

test("McpManager read/list redact env and headers", async () => {
  const secretServer = {
    ...baseServer,
    env: { MCP_TOKEN: "env-secret" },
    headers: { Authorization: "Bearer header-secret" },
  };
  const { bundle, redaction } = createMcpBundle({
    settings: { servers: [secretServer], selected: ["demo"] },
  });

  assert.deepEqual(redaction(secretServer), {
    ...secretServer,
    env: { MCP_TOKEN: "<redacted>" },
    headers: { Authorization: "<redacted>" },
  });

  const list = await callMcpManager(bundle, { action: "list" });
  const read = await callMcpManager(bundle, { action: "read", server_id: "demo" });

  assert.equal(list.isError, false);
  assert.equal(read.isError, false);
  assert.doesNotMatch(list.content[0].text, /env-secret|header-secret/);
  assert.doesNotMatch(read.content[0].text, /env-secret|header-secret/);
  assert.match(read.content[0].text, /serverConfig:/);
  assert.match(read.content[0].text, /<redacted>/);
});

test("McpManager update rejects server id changes", async () => {
  const { bundle, updates } = createMcpBundle({
    settings: { servers: [baseServer], selected: ["demo"] },
  });

  const result = await callMcpManager(bundle, {
    action: "update",
    server_id: "demo",
    patch: { id: "renamed" },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /does not allow changing server id/);
  assert.deepEqual(updates, []);
});

test("McpManager create conflict fail/overwrite semantics are explicit", async () => {
  const { bundle, invocations, updates, events } = createMcpBundle({
    settings: { servers: [baseServer], selected: ["demo"] },
    invokeImpl(command, args) {
      assert.equal(command, "mcp_stop_server");
      return { serverId: args.server_id, stopped: true };
    },
  });

  const failed = await callMcpManager(bundle, {
    action: "create",
    server: {
      id: "demo",
      transport: "stdio",
      command: "replacement-mcp",
    },
  });
  const overwritten = await callMcpManager(bundle, {
    action: "create",
    conflict: "overwrite",
    server: {
      id: "demo",
      transport: "stdio",
      command: "replacement-mcp",
    },
  });

  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /already exists/);
  assert.equal(overwritten.isError, false);
  assert.equal(overwritten.details.stopped, true);
  assert.deepEqual(
    invocations.map((call) => call.args.server_id),
    ["demo"],
  );
  assert.deepEqual(updates.at(-1).servers[0], {
    ...baseServer,
    command: "replacement-mcp",
  });
  // The config commit is the source of truth and must land before the
  // best-effort runtime stop.
  assert.deepEqual(events, ["commit", "invoke:mcp_stop_server"]);
});

test("McpManager update stops the previous runtime after committing", async () => {
  const { bundle, invocations, updates, events } = createMcpBundle({
    settings: { servers: [baseServer], selected: ["demo"] },
    invokeImpl(command, args) {
      assert.equal(command, "mcp_stop_server");
      return { serverId: args.server_id, stopped: true };
    },
  });

  const result = await callMcpManager(bundle, {
    action: "update",
    server_id: "demo",
    patch: { command: "updated-mcp" },
  });

  assert.equal(result.isError, false);
  assert.equal(result.details.stopped, true);
  assert.deepEqual(
    invocations.map((call) => call.args.server_id),
    ["demo"],
  );
  assert.equal(updates.at(-1).servers[0].command, "updated-mcp");
  assert.deepEqual(events, ["commit", "invoke:mcp_stop_server"]);
});

test("McpManager delete and disable stop stale runtimes", async () => {
  const servers = [baseServer, { ...baseServer, id: "other", command: "other-mcp" }];
  const { bundle, invocations, updates } = createMcpBundle({
    settings: { servers, selected: ["demo", "other"] },
    invokeImpl(command, args) {
      assert.equal(command, "mcp_stop_server");
      return { serverId: args.server_id, stopped: true };
    },
  });

  const disable = await callMcpManager(bundle, {
    action: "disable",
    server_ids: ["demo"],
  });
  const deleteResult = await callMcpManager(bundle, {
    action: "delete",
    server_id: "other",
  });

  assert.equal(disable.isError, false);
  assert.equal(disable.details.stopped, true);
  assert.equal(deleteResult.isError, false);
  assert.equal(deleteResult.details.stopped, true);
  assert.deepEqual(
    invocations.map((call) => call.args.server_id),
    ["demo", "other"],
  );
  assert.deepEqual(updates.at(-1), {
    servers: [{ ...baseServer, enabled: false }],
    selected: ["demo"],
  });
});

test("McpManager validate is static and does not touch runtime", async () => {
  const { bundle, invocations } = createMcpBundle();

  const result = await callMcpManager(bundle, {
    action: "validate",
    server: {
      id: "broken",
      transport: "stdio",
      command: "",
    },
  });

  assert.equal(result.isError, false);
  assert.equal(result.details.ok, false);
  assert.match(result.content[0].text, /transport=stdio requires command/);
  assert.deepEqual(invocations, []);
});

test("McpManager test calls runtime and hides stderr unless requested", async () => {
  const { bundle, invocations } = createMcpBundle({
    settings: { servers: [baseServer], selected: ["demo"] },
    invokeImpl(command, args) {
      if (command === "mcp_runtime_status") {
        return {
          serverId: args.server_id,
          running: false,
          initialized: false,
          transport: "unknown",
          lastError: null,
        };
      }
      if (command === "mcp_test_server") {
        assert.equal(args.persist, true);
        return {
          serverId: args.server.id,
          ok: true,
          phase: "tools_list",
          transport: args.server.transport,
          durationMs: 12,
          running: true,
          initialized: true,
          toolsCount: 1,
          tools: [
            {
              serverId: args.server.id,
              serverLabel: args.server.id,
              name: "search",
              description: "Search",
              inputSchema: { type: "object" },
            },
          ],
          error: null,
          stderrTail: "diagnostic stderr",
        };
      }
      throw new Error(`unexpected invoke: ${command}`);
    },
  });

  const testResult = await callMcpManager(bundle, { action: "test", server_id: "demo" });
  const diagnoseResult = await callMcpManager(bundle, { action: "diagnose", server_id: "demo" });

  assert.equal(testResult.isError, false);
  assert.doesNotMatch(testResult.content[0].text, /diagnostic stderr/);
  assert.equal(diagnoseResult.isError, false);
  assert.match(diagnoseResult.content[0].text, /diagnostic stderr/);
  assert.deepEqual(
    invocations.map((call) => call.command),
    ["mcp_runtime_status", "mcp_test_server", "mcp_runtime_status", "mcp_test_server"],
  );
});

test("McpManager tools action calls tools/list test path without business tool execution", async () => {
  const { bundle, invocations } = createMcpBundle({
    settings: { servers: [baseServer], selected: ["demo"] },
    invokeImpl(command, args) {
      if (command === "mcp_runtime_status") {
        return {
          serverId: args.server_id,
          running: true,
          initialized: true,
          transport: "stdio",
          lastError: null,
        };
      }
      if (command === "mcp_test_server") {
        assert.equal(args.persist, true);
        return {
          serverId: args.server.id,
          ok: true,
          phase: "tools_list",
          transport: "stdio",
          durationMs: 1,
          running: true,
          initialized: true,
          toolsCount: 1,
          tools: [
            {
              serverId: "demo",
              serverLabel: "demo",
              name: "read",
              description: "",
              inputSchema: { type: "object" },
            },
          ],
          error: null,
          stderrTail: null,
        };
      }
      throw new Error(`unexpected invoke: ${command}`);
    },
  });

  const result = await callMcpManager(bundle, {
    action: "tools",
    server_id: "demo",
    include_schema: true,
  });

  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /toolsJson:/);
  assert.match(result.content[0].text, /inputSchema/);
  assert.deepEqual(
    invocations.map((call) => call.command),
    ["mcp_runtime_status", "mcp_test_server"],
  );
});

test("McpManager inline test is transient and does not persist into runtime cache", async () => {
  const { bundle, invocations } = createMcpBundle({
    invokeImpl(command, args) {
      assert.equal(command, "mcp_test_server");
      assert.equal(args.persist, false);
      return {
        serverId: args.server.id,
        ok: true,
        phase: "tools_list",
        transport: args.server.transport,
        durationMs: 1,
        running: true,
        initialized: true,
        toolsCount: 0,
        tools: [],
        error: null,
        stderrTail: null,
      };
    },
  });

  const result = await callMcpManager(bundle, {
    action: "test",
    server: {
      id: "scratch",
      transport: "stdio",
      command: "scratch-mcp",
    },
  });

  assert.equal(result.isError, false);
  assert.deepEqual(
    invocations.map((call) => call.command),
    ["mcp_test_server"],
  );
});

test("McpManager rejects write actions in cron auto prompt runtime", async () => {
  const { bundle, updates } = createMcpBundle({
    runtimeScope: "cron_auto_prompt",
  });

  const result = await callMcpManager(bundle, {
    action: "create",
    server: {
      id: "cron-demo",
      transport: "stdio",
      command: "demo-mcp",
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not allowed in cron_auto_prompt/);
  assert.deepEqual(updates, []);
});

test("McpManager rejects restart and stop in cron auto prompt runtime", async () => {
  const { bundle, invocations } = createMcpBundle({
    runtimeScope: "cron_auto_prompt",
    writable: false,
    settings: { servers: [baseServer], selected: [] },
  });

  const restart = await callMcpManager(bundle, { action: "restart", server_id: "demo" });
  const stop = await callMcpManager(bundle, { action: "stop", server_id: "demo" });

  assert.equal(restart.isError, true);
  assert.match(restart.content[0].text, /not allowed in cron_auto_prompt/);
  assert.equal(stop.isError, true);
  assert.match(stop.content[0].text, /not allowed in cron_auto_prompt/);
  assert.deepEqual(invocations, []);
});

test("McpManager test outside chat never persists into the shared runtime pool", async () => {
  const { bundle } = createMcpBundle({
    runtimeScope: "cron_auto_prompt",
    writable: false,
    settings: { servers: [baseServer], selected: [] },
    invokeImpl(command, args) {
      if (command === "mcp_runtime_status") {
        return {
          serverId: args.server_id,
          running: false,
          initialized: false,
          transport: "stdio",
          lastError: null,
        };
      }
      if (command === "mcp_test_server") {
        assert.equal(args.persist, false);
        return {
          serverId: args.server.id,
          ok: true,
          phase: "tools_list",
          transport: "stdio",
          durationMs: 1,
          running: true,
          initialized: true,
          toolsCount: 0,
          tools: [],
          error: null,
          stderrTail: null,
        };
      }
      throw new Error(`unexpected invoke: ${command}`);
    },
  });

  const result = await callMcpManager(bundle, { action: "test", server_id: "demo" });
  assert.equal(result.isError, false);
});

test("McpManager commits merge with concurrent settings writers instead of overwriting them", async () => {
  let releaseHome;
  const homeGate = new Promise((resolve) => {
    releaseHome = resolve;
  });
  let signalHomeRequested;
  const homeRequested = new Promise((resolve) => {
    signalHomeRequested = resolve;
  });
  const ctx = createMcpBundle({
    resolveHomeDir: () => {
      signalHomeRequested();
      return homeGate;
    },
  });

  // The create call stalls on the ~ resolution await...
  const pending = callMcpManager(ctx.bundle, {
    action: "create",
    server: {
      id: "demo",
      transport: "stdio",
      command: "demo-mcp",
      cwd: "~/tools/mcp",
    },
  });
  await homeRequested;

  // ...while another writer (UI edit / gateway sync / concurrent turn) lands.
  ctx.applyExternal((prev) => ({
    servers: [...prev.servers, { ...baseServer, id: "ui-added", command: "ui-mcp" }],
    selected: prev.selected,
  }));
  releaseHome("/home/user");

  const result = await pending;
  assert.equal(result.isError, false);
  assert.deepEqual(
    ctx.settings.servers.map((server) => server.id).sort(),
    ["demo", "ui-added"],
  );
  assert.equal(ctx.settings.servers.find((server) => server.id === "demo").cwd, "/home/user/tools/mcp");
});

test("McpManager reads live settings instead of a build-time snapshot", async () => {
  const ctx = createMcpBundle();

  ctx.applyExternal(() => ({ servers: [baseServer], selected: [] }));

  const result = await callMcpManager(ctx.bundle, { action: "list" });
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /- demo \| transport=stdio/);
});

test("McpManager abort before commit leaves settings untouched", async () => {
  let releaseHome;
  const homeGate = new Promise((resolve) => {
    releaseHome = resolve;
  });
  let signalHomeRequested;
  const homeRequested = new Promise((resolve) => {
    signalHomeRequested = resolve;
  });
  const controller = new AbortController();
  const ctx = createMcpBundle({
    resolveHomeDir: () => {
      signalHomeRequested();
      return homeGate;
    },
  });

  const pending = callMcpManager(
    ctx.bundle,
    {
      action: "create",
      server: { id: "demo", transport: "stdio", command: "demo-mcp", cwd: "~/tools/mcp" },
    },
    controller.signal,
  );
  await homeRequested;
  controller.abort();
  releaseHome("/home/user");

  const result = await pending;
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "Cancelled");
  assert.deepEqual(ctx.updates, []);
});

test("McpManager abort after commit skips remaining runtime cleanup with a warning", async () => {
  const controller = new AbortController();
  const { bundle, invocations, updates } = createMcpBundle({
    settings: {
      servers: [baseServer, { ...baseServer, id: "other", command: "other-mcp" }],
      selected: [],
    },
    invokeImpl(command, args) {
      assert.equal(command, "mcp_stop_server");
      controller.abort();
      return { serverId: args.server_id, stopped: true };
    },
  });

  const result = await callMcpManager(
    bundle,
    { action: "disable", server_ids: ["demo", "other"] },
    controller.signal,
  );

  // The commit already happened; the abort only cancels the remaining
  // best-effort runtime stops and is surfaced as a warning, not an error.
  assert.equal(result.isError, false);
  assert.equal(result.details.changed, true);
  assert.equal(updates.length, 1);
  assert.deepEqual(
    invocations.map((call) => call.args.server_id),
    ["demo"],
  );
  assert.match(result.content[0].text, /cancelled before runtime cleanup for other/);
});
