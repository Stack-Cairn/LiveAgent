import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Tool row headers name an MCP tool's server by its display label (GET /v1/mcp/tools
// serverLabel, else the configured id or settings name) instead of the name key inside
// `mcp__<serverKey>__<tool>`; hosts without labels keep the key.

const source = (name) => new URL(`../../src/${name}`, import.meta.url).pathname;
const client = { tools: 0, settings: 0, toolsBody: {}, settingsBody: {}, fail: false };
const listeners = { saved: [], connection: [] };
const loader = createTsModuleLoader({
  mocks: {
    [source("lib/kbrain/client.ts")]: {
      createKBrainClient: () => ({
        discoverMcpTools: async () => {
          client.tools += 1;
          if (client.fail) throw new Error("offline");
          return client.toolsBody;
        },
        getMcpSettings: async () => {
          client.settings += 1;
          if (client.fail) throw new Error("offline");
          return client.settingsBody;
        },
      }),
    },
    [source("lib/kbrain/mcp.ts")]: {
      subscribeKBrainMcpSettingsSaved: (listener) => {
        listeners.saved.push(listener);
        return () => {};
      },
    },
    [source("lib/kbrain/runtimeConnection.ts")]: {
      subscribeKBrainRuntimeConnection: (listener) => {
        listeners.connection.push(listener);
        return () => {};
      },
    },
  },
});
const { kbrainMcpServerLabels } = loader.loadModule("src/lib/kbrain/mcpToolList.ts");
const store = loader.loadModule("src/lib/kbrain/mcpServerLabels.ts");
const { kbrainMcpServerKey } = loader.loadModule("@liveagent/ui/lib/chat/mcpApps.ts");
const utils = loader.loadModule(
  "@liveagent/ui/components/chat/assistant-bubble/assistantBubbleUtils.ts",
);

const flush = () => new Promise((resolve) => setImmediate(resolve));
const HASHED_ID = "fixture apps";
const HASHED_KEY = kbrainMcpServerKey(HASHED_ID);

test("labels by server key: serverLabel first, then configured id, then settings", () => {
  assert.match(HASHED_KEY, /^fixture-apps_[0-9a-f]{8}$/);
  const labels = kbrainMcpServerLabels(
    {
      tools: [
        // Newer backend: configured id, name key and label.
        { name: `mcp__${HASHED_KEY}__show_chart`, serverId: HASHED_ID, serverKey: HASHED_KEY, serverLabel: "Fixture Apps" },
        { name: `mcp__${HASHED_KEY}__refresh`, serverId: HASHED_ID, serverKey: HASHED_KEY, serverLabel: "Other" },
        // No label: the configured id names it.
        { name: "mcp__docs_1a2b3c4d__search", serverId: "docs.v2", serverKey: "docs_1a2b3c4d" },
        // Older backend: serverId and serverLabel are the key itself.
        { name: "mcp__plain__run", serverId: "plain", serverLabel: "plain" },
        { name: "", serverId: "ignored", serverLabel: "Ignored" },
      ],
    },
    {
      settings: {
        servers: [
          { id: HASHED_ID, name: "Settings Name" },
          { id: "notes app", name: "  Notes  " },
          { id: "shell tools" },
          { id: "plain" },
          { name: "No id" },
        ],
      },
    },
  );
  assert.deepEqual(Object.fromEntries(labels), {
    [HASHED_KEY]: "Fixture Apps",
    docs_1a2b3c4d: "docs.v2",
    [kbrainMcpServerKey("notes app")]: "Notes",
    [kbrainMcpServerKey("shell tools")]: "shell tools",
  });
  assert.deepEqual(kbrainMcpServerLabels(null, null).size, 0);
});

test("the header shows the label when there is one, else the key", () => {
  const name = `mcp__${HASHED_KEY}__show_chart`;
  assert.equal(utils.getToolDisplayName(name, "Fixture Apps"), "Fixture Apps · show_chart");
  assert.equal(utils.getToolDisplayName(name), `${HASHED_KEY} · show_chart`);
  assert.equal(utils.getToolDisplayName(name, "  "), `${HASHED_KEY} · show_chart`);
  assert.equal(utils.getToolDisplayName("Read", "Fixture Apps"), "Read");
  assert.deepEqual(utils.getToolDisplayTitle({ name, arguments: {} }, "Fixture Apps"), {
    name: "Fixture Apps · show_chart",
    action: "",
  });
});

test("the desktop lookup loads once, is shared, and reloads after a settings save", async () => {
  client.toolsBody = {
    tools: [{ name: `mcp__${HASHED_KEY}__show_chart`, serverId: HASHED_ID, serverKey: HASHED_KEY, serverLabel: "Fixture Apps" }],
  };
  client.settingsBody = { settings: { servers: [{ id: HASHED_ID }] } };
  let notified = 0;
  store.subscribeKBrainMcpServerLabels(() => {
    notified += 1;
  });
  assert.equal(store.getKBrainMcpServerLabels().size, 0);
  for (let row = 0; row < 5; row += 1) store.requestKBrainMcpServerLabels();
  await flush();
  assert.equal(client.tools, 1);
  assert.equal(client.settings, 1);
  assert.equal(notified, 1);
  assert.equal(store.getKBrainMcpServerLabels().get(HASHED_KEY), "Fixture Apps");
  store.requestKBrainMcpServerLabels();
  await flush();
  assert.equal(client.tools, 1);

  client.toolsBody.tools[0].serverLabel = "Renamed";
  for (const listener of listeners.saved) listener();
  await flush();
  assert.equal(client.tools, 2);
  assert.equal(store.getKBrainMcpServerLabels().get(HASHED_KEY), "Renamed");

  // A failed reload keeps the last labels and does not retry right away.
  client.fail = true;
  for (const listener of listeners.connection) listener();
  await flush();
  store.requestKBrainMcpServerLabels();
  await flush();
  assert.equal(client.tools, 3);
  assert.equal(store.getKBrainMcpServerLabels().get(HASHED_KEY), "Renamed");
  client.fail = false;
});

const icons = new Proxy({}, { get: () => () => null });
const iconPath = fileURLToPath(new URL("../../../agent-ui/src/components/IconSet.tsx", import.meta.url));
const adapter = {
  readAskUserQuestionDeadline: () => undefined,
  useAskUserQuestionPending: () => false,
  usePlanDecisionState: () => ({ pending: false, approved: false }),
  retainRunningToolContent: false,
  submitAskUserQuestionAnswers() {},
  submitPlanDecision() {},
  usePendingToolApproval: () => false,
  usePermissionAutoResolved: () => null,
  deferLargeToolImages: false,
  useSubagentCard: () => null,
};

async function renderRow(toolName, labels) {
  const env = await createDomTestEnv({
    mocks: {
      "@liveagent/ui/components/IconSet": icons,
      [iconPath]: icons,
      "@liveagent/ui/i18n/index": { useLocale: () => ({ locale: "en-US", t: (key) => key }) },
      "@liveagent/ui/components/Markdown": { Markdown: () => null },
      "@liveagent/ui/components/chat/EditDiffView": { EditDiffView: () => null },
      "@liveagent/ui/components/chat/FileToolArgs": { FileToolArgsDisplay: () => null },
      "@liveagent/ui/components/chat/AskUserQuestionCard": { AskUserQuestionCard: () => null },
      "@liveagent/ui/components/chat/PlanModeCard": { PlanModeCard: () => null },
      "@liveagent/adapters/assistantBubble": adapter,
    },
  });
  const { MemoToolCallItem } = env.loadModule(
    "@liveagent/ui/components/chat/assistant-bubble/ToolCallItem.tsx",
  );
  const { McpServerLabelsProvider } = env.loadModule(
    "@liveagent/ui/components/chat/assistant-bubble/McpServerLabelsContext.tsx",
  );
  const item = {
    toolCall: { type: "toolCall", id: "call-1", name: toolName, arguments: { range: "7d" } },
  };
  const row = env.React.createElement(MemoToolCallItem, { item, isRunning: true });
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  await env.act(async () =>
    root.render(labels ? env.React.createElement(McpServerLabelsProvider, { value: labels }, row) : row),
  );
  return {
    host,
    async cleanup() {
      await env.act(async () => root.unmount());
      host.remove();
      env.cleanup();
    },
  };
}

test("a tool row names the server by the host's label and keeps the raw name as tooltip", async () => {
  const toolName = `mcp__${HASHED_KEY}__show_chart`;
  let requests = 0;
  const labels = { labels: new Map([[HASHED_KEY, "Fixture Apps"]]), request: () => (requests += 1) };
  const labelled = await renderRow(toolName, labels);
  try {
    const text = labelled.host.textContent;
    assert.ok(text.includes("Fixture Apps · show_chart"), text);
    assert.ok(!text.includes(HASHED_KEY), text);
    assert.ok(labelled.host.querySelector(`[title="${toolName}"]`));
    assert.equal(requests, 0);
  } finally {
    await labelled.cleanup();
  }

  // A key the host does not know yet asks it to load, and shows the key meanwhile.
  const unknown = await renderRow(toolName, { labels: new Map(), request: () => (requests += 1) });
  try {
    assert.ok(unknown.host.textContent.includes(`${HASHED_KEY} · show_chart`));
    assert.equal(unknown.host.querySelector(`[title="${toolName}"]`), null);
    assert.equal(requests, 1);
  } finally {
    await unknown.cleanup();
  }

  // No host labels (WebUI): the key, as before.
  const plain = await renderRow(toolName, null);
  try {
    assert.ok(plain.host.textContent.includes(`${HASHED_KEY} · show_chart`));
  } finally {
    await plain.cleanup();
  }
});
