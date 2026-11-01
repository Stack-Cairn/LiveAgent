import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

// LA-3b review, round 2: the failed-mutation re-read in PermissionRulesSection.run(),
// through the real WebUI adapter, rpc client and v2 encoder; the socket is an in-memory
// K-brain rules store. Assertions compare strings/booleans, never DOM nodes.

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const uiPath = (relative) => fileURLToPath(new URL(`../../../agent-ui/src/${relative}`, import.meta.url));
const DISCONNECTED = "Gateway WebSocket disconnected (code=1006)";

async function page(t, answer) {
  let client;
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
  const rpc = env.loadModule("src/lib/gatewaySocketRpc.ts");
  const adapters = env.loadModule("src/lib/gatewaySocketV2/adapters.ts");
  const pb = env.loadModule("@bufbuild/protobuf");
  const v2 = env.loadModule("src/lib/proto/gen/proto/v2/gateway_ws_pb.ts");
  const sent = [];
  client = Object.create(rpc.GatewayWebSocketRpcClient.prototype);
  client.disposed = false;
  client.recoverTransport = async () => {};
  client.request = async (type, payload) => {
    const frame = pb.fromBinary(v2.WebClientFrameSchema, adapters.encodeRequestFrame("r", type, payload, "agent-1"));
    const input = JSON.parse(frame.payload.value.payload.value.inputJson);
    sent.push(type.slice("permission.rules.".length));
    return answer(type.slice("permission.rules.".length), input);
  };
  const kbrain = env.loadModule("src/agent-ui-adapters/settingsExtension.tsx").settingsHostAdapter.kbrain;
  const { PermissionRulesSection } = env.loadModule("@liveagent/ui/pages/settings/PermissionRulesSection.tsx");
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  t.after(async () => {
    await env.act(async () => root.unmount());
    host.remove();
    env.cleanup();
  });
  const settle = () => env.act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
  const settings = { system: { workspaceProjects: [], hiddenWorkspaceProjectPaths: [], archivedWorkspaceProjectPaths: [] } };
  await env.act(async () => root.render(env.React.createElement(PermissionRulesSection, { kbrain, settings })));
  await settle();
  return {
    sent,
    rows: () => [...host.querySelectorAll('[data-permission-rules="user"] [data-permission-rule]')].map((row) => row.getAttribute("data-permission-rule")),
    alerts: () => [...host.querySelectorAll('[role="alert"]')].map((node) => node.textContent),
    draft: () => host.querySelector("input[data-permission-rule-input]").value,
    busy: () => host.querySelector('[data-testid="permission-rules-settings"]')?.getAttribute("aria-busy") ?? "",
    async deleteFirst() {
      await env.act(async () => host.querySelector('[data-permission-rules="user"] button[data-delete-rule]').click());
      await settle();
    },
    async add(rule) {
      await env.act(async () => {
        const input = host.querySelector("input[data-permission-rule-input]");
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, rule);
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
      const button = [...host.querySelectorAll("button")].find((b) => /^(添加|Add)$/.test(b.textContent.trim()));
      await env.act(async () => button.click());
      await settle();
    },
  };
}

test("review LA-3b r2: a lost delete answer re-reads the list once and keeps the disconnect message", async (t) => {
  const store = [
    { id: "u1", rule: "Bash(npm test:*)", effect: "allow", scope: "user" },
    { id: "u2", rule: "Bash(rm:*)", effect: "deny", scope: "user" },
  ];
  const view = await page(t, (action, input) => {
    if (action === "list") return { rules: store.map((rule) => ({ ...rule })) };
    if (action === "delete") {
      store.splice(store.findIndex((rule) => rule.id === input.id), 1);
      throw new Error(DISCONNECTED);
    }
    throw new Error(`unexpected ${action}`);
  });
  assert.deepEqual(view.rows(), ["Bash(npm test:*)", "Bash(rm:*)"]);
  await view.deleteFirst();
  assert.deepEqual(
    { rows: view.rows(), alerts: view.alerts(), sent: view.sent, busy: view.busy() },
    { rows: ["Bash(rm:*)"], alerts: [DISCONNECTED], sent: ["list", "delete", "list"], busy: "false" },
  );
});

test("review LA-3b r2: a refused add keeps the draft and the reason, and the other rules stay listed", async (t) => {
  const store = [{ id: "u1", rule: "Bash(npm test:*)", effect: "allow", scope: "user" }];
  const reason = 'permission rule "Bash(": missing closing parenthesis (HTTP 400 Bad Request)';
  const view = await page(t, (action) => {
    if (action === "list") return { rules: store.map((rule) => ({ ...rule })) };
    if (action === "add") throw new Error(reason);
    throw new Error(`unexpected ${action}`);
  });
  await view.add("Bash(");
  assert.deepEqual(
    { rows: view.rows(), alerts: view.alerts(), draft: view.draft(), sent: view.sent },
    { rows: ["Bash(npm test:*)"], alerts: [reason], draft: "Bash(", sent: ["list", "add", "list"] },
  );
});

// The desktop goes away mid-delete: the change fails and so does the re-read. Both
// reasons are on screen; the rules from before are not shown as if still current.
test("review LA-3b r2: when the re-read after a failed change also fails, both reasons are shown", async (t) => {
  let online = true;
  const view = await page(t, (action) => {
    if (!online) throw new Error("agent offline");
    if (action === "list") return { rules: [{ id: "u1", rule: "Bash(npm test:*)", effect: "allow", scope: "user" }] };
    online = false;
    throw new Error(DISCONNECTED);
  });
  await view.deleteFirst();
  const alerts = view.alerts();
  assert.deepEqual(
    { loadError: alerts.includes("agent offline"), actionError: alerts.includes(DISCONNECTED), rows: view.rows(), busy: view.busy() },
    { loadError: true, actionError: true, rows: [], busy: "false" },
  );
});
