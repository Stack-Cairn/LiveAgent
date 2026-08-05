import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function createTunnel(overrides = {}) {
  return {
    id: "tun-1",
    slug: "",
    name: "Local app",
    targetUrl: "http://localhost:3000",
    publicPath: "/",
    publicUrl: "http://127.0.0.1:19273/?t=token-abc",
    port: 19273,
    createdAt: 1_700_000_000,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    activeConnections: 0,
    projectPathKey: "project:/workspace",
    local: { status: "ok", httpStatus: 200, error: "", checkedAt: 1_700_000_100, rttMs: 12 },
    ...overrides,
  };
}

function createSnapshot(tunnels, overrides = {}) {
  return {
    revision: 1,
    agentOnline: true,
    relay: null,
    tunnels,
    ...overrides,
  };
}

function createToolCall(args) {
  return {
    type: "toolCall",
    id: "call-tunnel",
    name: "TunnelManager",
    arguments: args,
  };
}

async function buildRegistry(params = {}) {
  const loader = createTsModuleLoader();
  const { buildBuiltinToolRegistry } = loader.loadModule("src/lib/tools/builtinRegistry.ts");
  const { createFileToolState } = loader.loadModule("src/lib/tools/fileToolState.ts");
  return buildBuiltinToolRegistry({
    workdir: "/workspace",
    providerId: "codex",
    fileState: createFileToolState(),
    skillsEnabled: false,
    runtimeScope: "chat",
    currentChatModel: { customProviderId: "p", model: "m" },
    getMcpSettings: () => ({ selected: [], servers: [] }),
    ...params,
  });
}

test("TunnelManager is injected only when Remote Web Tunnels are enabled", async () => {
  const disabledRegistry = await buildRegistry({
    remoteWebTunnelsEnabled: false,
  });
  assert.equal(disabledRegistry.hasTool("TunnelManager"), false);

  // Gateway link being offline no longer gates the tool: offline mutations queue
  // on the agent and are reconciled when the link is restored.
  const enabledRegistry = await buildRegistry({
    remoteWebTunnelsEnabled: true,
  });
  assert.equal(enabledRegistry.hasTool("TunnelManager"), true);
  assert.equal(
    enabledRegistry.metadataByName.get("TunnelManager").kind,
    "tunnel_manager",
  );

  const cronRegistry = await buildRegistry({
    runtimeScope: "cron_auto_prompt",
    remoteWebTunnelsEnabled: true,
  });
  assert.equal(cronRegistry.hasTool("TunnelManager"), false);
});

test("TunnelManager list/create/close/check call tunnel commands", async () => {
  const invocations = [];
  const tunnels = [createTunnel()];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          if (command === "tunnel_state") {
            return createSnapshot([...tunnels]);
          }
          if (command === "tunnel_create") {
            tunnels.push(
              createTunnel({
                id: "tun-created",
                publicUrl: "http://127.0.0.1:19274/?t=token-created",
                port: 19274,
                targetUrl: args.input.targetUrl,
                name: args.input.name ?? "",
                createdAt: 1_700_000_500,
                ...(args.input.ttlSeconds === 0 ? { expiresAt: 0 } : {}),
              }),
            );
            return undefined;
          }
          if (command === "tunnel_close") {
            return undefined;
          }
          if (command === "tunnel_check") {
            return undefined;
          }
          throw new Error(`unexpected invoke ${command}`);
        },
      },
    },
  });
  const { createTunnelManagerTools } = loader.loadModule("src/lib/tools/tunnelManagerTools.ts");
  const changes = [];
  const bundle = createTunnelManagerTools({
    enabled: true,
    runtimeScope: "chat",
    projectPathKey: "project:/workspace",
    publicBaseUrl: "https://gateway.example.test/",
    onTunnelsChanged: (change) => changes.push(change),
  });

  assert.deepEqual(bundle.tools.map((tool) => tool.name), ["TunnelManager"]);

  const listResult = await bundle.executeToolCall(createToolCall({ action: "list" }));
  assert.equal(listResult.isError, false);
  assert.equal(listResult.details.kind, "tunnel_manager");
  assert.equal(listResult.details.action, "list");
  assert.equal(listResult.details.tunnels.length, 1);
  assert.match(listResult.content[0].text, /link: online/);
  assert.match(listResult.content[0].text, /service: ok HTTP 200/);
  // 主机名被 publicBaseUrl 覆盖（远程访问），端口与 token 来自后端。
  assert.match(
    listResult.content[0].text,
    /public: https:\/\/gateway\.example\.test:19273\/\?t=token-abc/,
  );

  const createResult = await bundle.executeToolCall(
    createToolCall({
      action: "create",
      targetUrl: "http://localhost:5173/app",
      name: "Vite",
      ttlSeconds: 0,
    }),
  );
  assert.equal(createResult.isError, false);
  assert.equal(createResult.details.action, "create");
  assert.equal(createResult.details.tunnel.id, "tun-created");
  assert.match(createResult.content[0].text, /unlimited/);
  assert.match(
    createResult.content[0].text,
    /public: https:\/\/gateway\.example\.test:19274\/\?t=token-created/,
  );

  const closeResult = await bundle.executeToolCall(
    createToolCall({ action: "close", id: "tun-1" }),
  );
  assert.equal(closeResult.isError, false);
  assert.equal(closeResult.details.action, "close");
  assert.match(closeResult.content[0].text, /tun-1/);

  const checkResult = await bundle.executeToolCall(
    createToolCall({ action: "check", id: "tun-created" }),
  );
  assert.equal(checkResult.isError, false);
  assert.equal(checkResult.details.action, "check");
  assert.equal(checkResult.details.tunnel.id, "tun-created");
  assert.match(checkResult.content[0].text, /link: online/);

  assert.deepEqual(
    invocations.map((call) => [call.command, call.args]),
    [
      ["tunnel_state", undefined],
      ["tunnel_state", undefined],
      [
        "tunnel_create",
        {
          input: {
            targetUrl: "http://localhost:5173/app",
            name: "Vite",
            ttlSeconds: 0,
            projectPathKey: "project:/workspace",
          },
        },
      ],
      ["tunnel_state", undefined],
      ["tunnel_close", { tunnel_id: "tun-1" }],
      ["tunnel_check", { tunnel_id: "tun-created" }],
      ["tunnel_state", undefined],
    ],
  );
  assert.deepEqual(
    changes.map((change) => [change.action, change.projectPathKey]),
    [
      ["create", "project:/workspace"],
      ["close", "project:/workspace"],
      ["check", "project:/workspace"],
    ],
  );
});

test("TunnelManager rejects invalid arguments before invoking tunnel commands", async () => {
  const invocations = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });
  const { createTunnelManagerTools } = loader.loadModule("src/lib/tools/tunnelManagerTools.ts");
  const bundle = createTunnelManagerTools({ enabled: true, runtimeScope: "chat" });

  const invalidAction = await bundle.executeToolCall(createToolCall({ action: "probe" }));
  assert.equal(invalidAction.isError, true);
  assert.match(invalidAction.content[0].text, /action/);

  const missingTarget = await bundle.executeToolCall(createToolCall({ action: "create" }));
  assert.equal(missingTarget.isError, true);
  assert.match(missingTarget.content[0].text, /targetUrl/);

  const invalidTtl = await bundle.executeToolCall(
    createToolCall({ action: "create", targetUrl: "http://localhost:3000", ttlSeconds: 60 }),
  );
  assert.equal(invalidTtl.isError, true);
  assert.match(invalidTtl.content[0].text, /ttlSeconds/);

  const missingCloseTarget = await bundle.executeToolCall(createToolCall({ action: "close" }));
  assert.equal(missingCloseTarget.isError, true);
  assert.match(missingCloseTarget.content[0].text, /TunnelManager\.id is required/);

  assert.deepEqual(invocations, []);
});
