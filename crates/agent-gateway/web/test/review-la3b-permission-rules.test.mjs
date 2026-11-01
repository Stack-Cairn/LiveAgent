import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

// LA-3b independent review. Real modules: GatewayWebSocketRpcClient.permissionRules and the
// transport's requestWithRecovery, the v2 frame encoder, the WebUI settings adapter and the
// shared PermissionRulesSection. Only the socket is replaced: `request` is answered by an
// in-memory K-brain rules store. Assertions compare strings/booleans, never DOM nodes.

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const uiPath = (relative) => fileURLToPath(new URL(`../../../agent-ui/src/${relative}`, import.meta.url));
const DISCONNECTED = "Gateway WebSocket disconnected (code=1006)";

// Encode with the real v2 adapter, decode the bytes with the generated schema.
function encodedPermissionRules(loadModule, type, payload) {
  const adapters = loadModule("src/lib/gatewaySocketV2/adapters.ts");
  const pb = loadModule("@bufbuild/protobuf");
  const v2 = loadModule("src/lib/proto/gen/proto/v2/gateway_ws_pb.ts");
  const frame = pb.fromBinary(v2.WebClientFrameSchema, adapters.encodeRequestFrame("r", type, payload, "agent-1"));
  const request = frame.payload.value.payload;
  assert.equal(request.case, "permissionRules");
  return [request.value.action, JSON.parse(request.value.inputJson)];
}

function rpcModule() {
  return createWebModuleLoader({ rootDir: webRoot }).loadModule("src/lib/gatewaySocketRpc.ts");
}

// A client on the real prototype; `request` is the socket. The transport's real
// requestWithRecovery decides whether a failed request is sent again.
function fixtureClient(rpc, answer) {
  const client = Object.create(rpc.GatewayWebSocketRpcClient.prototype);
  client.disposed = false;
  client.sent = [];
  client.recoverTransport = async () => {};
  client.request = async (type, payload) => {
    client.sent.push([type, payload]);
    return answer(type, payload);
  };
  return client;
}

test("review LA-3b: only list is sent again after a dropped socket; add and delete are sent once", async () => {
  const rpc = rpcModule();
  let drop = true;
  const client = fixtureClient(rpc, (type) => {
    if (drop) {
      drop = false;
      throw new Error(DISCONNECTED);
    }
    return type === "permission.rules.list" ? { rules: [] } : { ok: true };
  });
  assert.deepEqual(await client.permissionRules("list", {}), { rules: [] });
  assert.deepEqual(client.sent.map(([type]) => type), ["permission.rules.list", "permission.rules.list"]);

  for (const action of ["add", "delete"]) {
    client.sent.length = 0;
    drop = true;
    await assert.rejects(client.permissionRules(action, { id: "r_1", scope: "user" }), /disconnected/);
    assert.deepEqual(client.sent.map(([type]) => type), [`permission.rules.${action}`], `${action} is not replayed`);
  }
});

test("review LA-3b: the WebUI adapter's fields survive the real frame encoder unchanged", async () => {
  const rpc = rpcModule();
  const client = fixtureClient(rpc, (type) => (type === "permission.rules.list" ? { rules: [] } : { id: "r_2", rule: "x", effect: "deny", scope: "project" }));
  const loader = createWebModuleLoader({
    rootDir: webRoot,
    mocks: {
      "../lib/gatewaySocket": { getGatewayWebSocketClient: () => client },
      "../lib/storage": { loadToken: () => "fixture" },
      "../pages/settings/DevicesSection": { DevicesSection: () => null },
      "@liveagent/ui/components/IconSet": { MonitorSmartphone: () => null },
      "@liveagent/ui/lib/resourceHost": { configureResourceHostCapabilities() {}, kbrainResourceHostCapabilities: {} },
    },
  });
  const kbrain = loader.loadModule("src/agent-ui-adapters/settingsExtension.tsx").settingsHostAdapter.kbrain;
  const workspace = "D:\\项目\\a b+c%20#?&";
  await kbrain.addPermissionRule({ rule: "Bash(python -c 'print(1)':*)", effect: "deny", scope: "project", workspace });
  await kbrain.deletePermissionRule({ id: "r_2", scope: "project", workspace });
  await kbrain.listPermissionRules({ workspace });
  const decoded = client.sent.map(([type, payload]) => encodedPermissionRules(loader.loadModule, type, payload));
  assert.deepEqual(decoded, [
    ["add", { workspace, rule: "Bash(python -c 'print(1)':*)", effect: "deny", scope: "project" }],
    ["delete", { workspace, scope: "project", id: "r_2" }],
    ["list", { workspace }],
  ]);
});

// The socket drops after the desktop has carried out the delete: K-brain no longer has
// the rule but the page never hears back. A second delete is refused with 404.
test("review LA-3b: after a delete whose answer was lost, the page still lists the deleted rule", async () => {
  const env = await createWebDomTestEnv({
    rootDir: webRoot,
    mocks: {
      "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
      "@liveagent/ui/components/ui/button": {
        Button: ({ children, size, variant, ...props }) => env.React.createElement("button", props, children),
      },
      "@liveagent/ui/components/settings/SettingsToggleGroup": {
        SettingsToggleGroup: ({ children }) => env.React.createElement("div", null, children),
        SettingsToggleGroupItem: ({ children, value, disabled }) =>
          env.React.createElement("button", { disabled, "data-toggle": value }, children),
      },
      [uiPath("components/ui/select.tsx")]: {
        Select: ({ children }) => env.React.createElement("select", null, children),
        SelectItem: ({ value, children }) => env.React.createElement("option", { value }, children),
        SelectValue: () => null,
      },
      [uiPath("components/settings/SettingsSelect.tsx")]: {
        SettingsSelectTrigger: () => null,
        SettingsSelectContent: ({ children }) => env.React.createElement(env.React.Fragment, null, children),
      },
      [uiPath("components/ui/confirm-action-popover.tsx")]: {
        ConfirmDeletePopover: ({ children, onConfirm }) => children(onConfirm),
      },
      "../lib/gatewaySocket": { getGatewayWebSocketClient: () => client },
      "../lib/storage": { loadToken: () => "fixture" },
      "../pages/settings/DevicesSection": { DevicesSection: () => null },
      "@liveagent/ui/lib/resourceHost": { configureResourceHostCapabilities() {}, kbrainResourceHostCapabilities: {} },
    },
  });
  // In-memory K-brain user rules; the desktop answers like gateway_bridge.rs does.
  const store = [{ id: "u1", rule: "Bash(npm test:*)", effect: "allow", scope: "user" }];
  let dropAfterDelete = true;
  const rpc = env.loadModule("src/lib/gatewaySocketRpc.ts");
  const client = fixtureClient(rpc, (type, payload) => {
    const [, input] = encodedPermissionRules(env.loadModule, type, payload);
    if (type === "permission.rules.list") return { rules: store.map((rule) => ({ ...rule })) };
    if (type === "permission.rules.delete") {
      const index = store.findIndex((rule) => rule.id === input.id);
      if (index < 0) throw new Error("permission rule not found (HTTP 404 Not Found)");
      store.splice(index, 1);
      if (dropAfterDelete) {
        dropAfterDelete = false;
        throw new Error(DISCONNECTED);
      }
      return { ok: true };
    }
    throw new Error(`unexpected ${type}`);
  });
  const kbrain = env.loadModule("src/agent-ui-adapters/settingsExtension.tsx").settingsHostAdapter.kbrain;
  const { PermissionRulesSection } = env.loadModule("@liveagent/ui/pages/settings/PermissionRulesSection.tsx");
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const settle = () => env.act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
  const rows = () => [...host.querySelectorAll('[data-permission-rules="user"] [data-permission-rule]')].map((row) => row.getAttribute("data-permission-rule"));
  const deleteFirst = async () => {
    // Once the page re-reads the list after the lost answer there is nothing left to retry.
    const button = host.querySelector('[data-permission-rules="user"] button[data-delete-rule]');
    if (!button) return;
    await env.act(async () => button.click());
    await settle();
  };
  const alertText = () => [...host.querySelectorAll('[role="alert"]')].map((node) => node.textContent).join(" | ");
  try {
    const settings = { system: { workspaceProjects: [], hiddenWorkspaceProjectPaths: [], archivedWorkspaceProjectPaths: [] } };
    await env.act(async () => root.render(env.React.createElement(PermissionRulesSection, { kbrain, settings })));
    await settle();
    assert.deepEqual(rows(), ["Bash(npm test:*)"]);

    await deleteFirst();
    assert.equal(store.length, 0, "K-brain did delete the rule");
    const firstError = alertText();
    const afterLostAnswer = rows();

    await deleteFirst();
    const secondError = alertText();
    const afterRetry = rows();

    assert.deepEqual(
      { afterLostAnswer, afterRetry, firstError, secondError },
      { afterLostAnswer: [], afterRetry: [], firstError, secondError },
      "a failed mutation must re-read the list: the deleted rule stays on screen and every retry fails with 404",
    );
  } finally {
    await env.act(async () => root.unmount());
    host.remove();
    env.cleanup();
  }
});
