// WebUI parity for K-brain settings: the project's MCP server choice travels with each
// chat request, and the memory organizer schedule maps onto the gateway's
// `kbrainMemoryOrganizer` key.
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const loader = createWebModuleLoader({ rootDir });
const adapters = loader.loadModule("src/lib/gatewaySocketV2/adapters.ts");
const socketShared = loader.loadModule("src/lib/gatewaySocketShared.ts");
const pb = loader.loadModule("@bufbuild/protobuf");
const v2 = loader.loadModule("src/lib/proto/gen/proto/v2/gateway_ws_pb.ts");
const { buildGatewaySystemSettings } = loader.loadModule("src/app/chatEventUtils.ts");
const { getDefaultSettings } = loader.loadModule("src/lib/settings/index.ts");

function chatRequest(systemSettings) {
  const command = socketShared.buildChatCommandPayload({
    type: "chat.submit",
    message: "hi",
    clientRequestId: "client-1",
    systemSettings,
  });
  const frame = pb.fromBinary(
    v2.WebClientFrameSchema,
    adapters.encodeRequestFrame("req-1", "chat.command", command, "agent-a"),
  );
  return { payload: command.payload, request: frame.payload.value.request };
}

function settingsWith(workspaceResourceSettings) {
  const settings = getDefaultSettings();
  return {
    ...settings,
    mcp: {
      servers: [
        { id: "docs", enabled: true, transport: "stdio", command: "docs-mcp" },
        { id: "off-server", enabled: false, transport: "stdio", command: "x" },
      ],
      selected: [],
    },
    system: { ...settings.system, workspaceResourceSettings },
  };
}

function resource(mode, mcpServerIds = []) {
  return { mode, skillNames: [], mcpServerIds, projectPrompt: "" };
}

test("a chat request carries the project's MCP choice; inherit sends none", () => {
  const settings = settingsWith({
    "/custom": resource("custom", ["docs", "off-server"]),
    "/empty": resource("custom"),
    "/off": resource("off", ["docs"]),
  });

  const inherit = chatRequest(buildGatewaySystemSettings(settings, "/inherit"));
  assert.equal(inherit.payload.mcp_servers, undefined);
  assert.equal(inherit.request.mcpServers, undefined);

  const custom = chatRequest(buildGatewaySystemSettings(settings, "/custom"));
  assert.deepEqual(custom.payload.mcp_servers, { server_ids: ["docs"] });
  assert.deepEqual(custom.request.mcpServers.serverIds, ["docs"]);

  // "None" is present with no ids, which the gateway turns into no MCP server.
  for (const workdir of ["/empty", "/off"]) {
    const none = chatRequest(buildGatewaySystemSettings(settings, workdir));
    assert.deepEqual(none.payload.mcp_servers, { server_ids: [] }, workdir);
    assert.ok(none.request.mcpServers, `${workdir}: selection must stay present`);
    assert.deepEqual(none.request.mcpServers.serverIds, [], workdir);
  }
});

function loadSettingsAdapter(client) {
  const adapterLoader = createWebModuleLoader({
    rootDir,
    mocks: {
      "../lib/gatewaySocket": { getGatewayWebSocketClient: () => client },
      "../lib/storage": { loadToken: () => "fixture" },
      "../pages/settings/DevicesSection": { DevicesSection: () => null },
      "@liveagent/ui/components/IconSet": { MonitorSmartphone: () => null },
      "@liveagent/ui/lib/resourceHost": {
        configureResourceHostCapabilities() {},
        nativeResourceHostCapabilities: {},
      },
    },
  });
  return adapterLoader.loadModule("src/agent-ui-adapters/settingsExtension.tsx").settingsHostAdapter
    .kbrain;
}

test("the organizer schedule travels as kbrainMemoryOrganizer with only the changed field", async () => {
  let doc = {
    customProviders: [],
    kbrainMemory: { enabled: true },
    kbrainMemoryOrganizer: { enabled: true, intervalHours: 24 },
  };
  const updates = [];
  const kbrain = loadSettingsAdapter({
    getSettings: async () => doc,
    updateSettings: async (update) => {
      updates.push(update);
      doc = {
        ...doc,
        kbrainMemoryOrganizer: { ...doc.kbrainMemoryOrganizer, ...update.kbrainMemoryOrganizer },
      };
    },
  });
  assert.deepEqual((await kbrain.getSettings()).memoryOrganizer, { enabled: true, intervalHours: 24 });
  const next = await kbrain.updateSettings({ memoryOrganizer: { intervalHours: 6 } });
  assert.deepEqual(updates, [{ kbrainMemoryOrganizer: { intervalHours: 6 } }]);
  assert.deepEqual(next.memoryOrganizer, { enabled: true, intervalHours: 6 });
});

test("a desktop or backend without the schedule shows none in the WebUI", async () => {
  const kbrain = loadSettingsAdapter({
    getSettings: async () => ({ customProviders: [] }),
    updateSettings: async () => {},
  });
  assert.equal((await kbrain.getSettings()).memoryOrganizer, undefined);
});
