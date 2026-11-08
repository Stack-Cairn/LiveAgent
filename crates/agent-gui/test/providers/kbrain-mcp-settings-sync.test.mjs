// K-brain MCP settings sync: a LiveAgent save keeps the per-server policy, workspaceRoots
// and fields LiveAgent does not edit; statuses, reconnect and the run's MCP selection.
import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const mcp = createTsModuleLoader().loadModule("src/lib/kbrain/mcp.ts");
const {
  fromKBrainMcpSettings,
  KBRAIN_NO_MCP_SERVERS,
  kbrainMcpStatuses,
  kbrainRunMcpServerIds,
  mergeKBrainMcpSettings,
  reconnectKBrainMcp,
  workspaceMcpServerIds,
} = mcp;

const docs = {
  id: "docs",
  enabled: true,
  transport: "stdio",
  command: "docs-mcp",
  args: ["--stdio"],
  env: null,
  policy: { "*": "deny", "mcp__docs__write": "ask" },
  workspaceRoots: ["/work/a"],
};

function kbrain(servers, extra = {}) {
  return { settings: { servers, selected: [], ...extra }, statuses: [] };
}

test("a LiveAgent save keeps K-brain's per-server policy and workspaceRoots", () => {
  const current = kbrain([docs]);
  const loaded = fromKBrainMcpSettings(current, { servers: [], selected: [] });
  // The user only disables the server.
  const next = {
    ...loaded,
    servers: loaded.servers.map((server) => ({ ...server, enabled: false })),
  };
  const body = mergeKBrainMcpSettings(current, next, loaded);
  assert.equal(body.servers.length, 1);
  assert.equal(body.servers[0].enabled, false);
  assert.deepEqual(body.servers[0].policy, docs.policy);
  assert.deepEqual(body.servers[0].workspaceRoots, docs.workspaceRoots);
});

test("a save from a LiveAgent copy without policy (older build) keeps K-brain's policy", () => {
  const current = kbrain([docs]);
  const stale = {
    servers: [{ id: "docs", enabled: true, transport: "stdio", command: "docs-mcp", args: [] }],
    selected: [],
  };
  const body = mergeKBrainMcpSettings(current, stale, stale);
  assert.deepEqual(body.servers[0].policy, docs.policy);
  assert.deepEqual(body.servers[0].workspaceRoots, docs.workspaceRoots);
});

test("policy is three-way merged: LiveAgent's change wins, an edit made elsewhere survives", () => {
  const before = fromKBrainMcpSettings(kbrain([{ ...docs, policy: { "*": "allow" } }]), {
    servers: [],
    selected: [],
  });
  const changed = {
    ...before,
    servers: before.servers.map((server) => ({ ...server, policy: { "*": "deny" } })),
  };
  // Another client set "ask" meanwhile; LiveAgent changed the policy itself, so it wins.
  const elsewhere = kbrain([{ ...docs, policy: { "*": "ask" } }]);
  assert.deepEqual(mergeKBrainMcpSettings(elsewhere, changed, before).servers[0].policy, {
    "*": "deny",
  });
  // LiveAgent did not touch the policy: the other client's edit stays.
  const untouched = {
    ...before,
    servers: before.servers.map((server) => ({ ...server, enabled: false })),
  };
  assert.deepEqual(mergeKBrainMcpSettings(elsewhere, untouched, before).servers[0].policy, {
    "*": "ask",
  });
  // Entries are merged one by one: a tool rule another client added stays when
  // LiveAgent changes the server-wide entry.
  const withToolRule = kbrain([{ ...docs, policy: { "*": "allow", mcp__docs__read: "allow" } }]);
  assert.deepEqual(mergeKBrainMcpSettings(withToolRule, changed, before).servers[0].policy, {
    "*": "deny",
    mcp__docs__read: "allow",
  });
  // Clearing the policy in LiveAgent removes it.
  const cleared = {
    ...before,
    servers: before.servers.map(({ policy: _policy, ...server }) => server),
  };
  assert.equal("policy" in mergeKBrainMcpSettings(elsewhere, cleared, before).servers[0], false);
});

test("fields from newer K-brain releases and top-level fields round-trip; messageUrl never goes", () => {
  const current = kbrain([{ ...docs, futureField: { keep: true } }], { futureTop: 3 });
  const loaded = fromKBrainMcpSettings(current, { servers: [], selected: [] });
  assert.deepEqual(loaded.servers[0].backendFields, { futureField: { keep: true } });
  const next = {
    ...loaded,
    servers: [
      ...loaded.servers.map((server) => ({ ...server, messageUrl: "http://legacy/messages" })),
      { id: "new", enabled: true, transport: "sse", url: "https://mcp.example", policy: { "*": "ask" } },
    ],
  };
  const body = mergeKBrainMcpSettings(current, next, loaded);
  assert.equal(body.futureTop, 3);
  assert.deepEqual(body.servers[0].futureField, { keep: true });
  for (const server of body.servers) {
    assert.equal("messageUrl" in server, false);
    assert.equal("backendFields" in server, false);
  }
  // A new server carries LiveAgent's policy; sse is sent as K-brain's http transport.
  assert.equal(body.servers[1].transport, "http");
  assert.deepEqual(body.servers[1].policy, { "*": "ask" });
});

test("a renamed server keeps the K-brain fields it was loaded with, limited to known fields", () => {
  const current = kbrain([{ ...docs, futureField: 1 }]);
  const loaded = fromKBrainMcpSettings(current, { servers: [], selected: [] });
  const renamed = {
    ...loaded,
    servers: loaded.servers.map((server) => ({
      ...server,
      id: "docs-2",
      backendFields: { ...server.backendFields, unknownToBackend: 1 },
    })),
  };
  const body = mergeKBrainMcpSettings(current, renamed, loaded);
  assert.equal(body.servers[0].id, "docs-2");
  assert.equal(body.servers[0].futureField, 1);
  assert.equal("unknownToBackend" in body.servers[0], false);
  assert.deepEqual(body.servers[0].policy, docs.policy);
});

test("a malformed K-brain document is refused instead of wiping settings", () => {
  assert.throws(() => mergeKBrainMcpSettings({}, { servers: [], selected: [] }), /Malformed/);
});

test("statuses are parsed per server", () => {
  assert.deepEqual(
    kbrainMcpStatuses({
      statuses: [
        { id: "docs", status: "ready", tools: 3, error: "" },
        { id: "bad", status: "failed", error: "exit status 1" },
        { id: 5, status: "ready" },
        null,
      ],
    }),
    [
      { id: "docs", status: "ready", tools: 3 },
      { id: "bad", status: "failed", error: "exit status 1", tools: 0 },
    ],
  );
  assert.deepEqual(kbrainMcpStatuses({}), []);
});

test("reconnect reloads, and falls back to saving the settings back unchanged", async () => {
  const calls = [];
  const statuses = [{ id: "docs", status: "connecting" }];
  const reloaded = await reconnectKBrainMcp({
    reloadMcp: async () => (calls.push("reload"), { statuses }),
    getMcpSettings: async () => assert.fail("not needed"),
    updateMcpSettings: async () => assert.fail("not needed"),
  });
  assert.deepEqual(reloaded, [{ id: "docs", status: "connecting", tools: 0 }]);

  const current = kbrain([docs]);
  let saved;
  const fallback = await reconnectKBrainMcp({
    reloadMcp: async () => {
      throw new Error("MCP settings file does not exist");
    },
    getMcpSettings: async () => current,
    updateMcpSettings: async (input) => ((saved = input), { statuses }),
  });
  assert.deepEqual(saved, current.settings);
  assert.equal(fallback.length, 1);

  await assert.rejects(
    reconnectKBrainMcp({
      reloadMcp: async () => {
        throw new Error("reload failed");
      },
      getMcpSettings: async () => ({}),
      updateMcpSettings: async () => assert.fail("must not save a malformed document"),
    }),
    /reload failed/,
  );
});

test("workspace MCP selection: inherit sends nothing, custom sends its servers, none is explicit", () => {
  const servers = [{ id: "docs" }, { id: "web" }];
  assert.equal(workspaceMcpServerIds({ mode: "inherit", mcpServers: servers }), undefined);
  assert.deepEqual(workspaceMcpServerIds({ mode: "custom", mcpServers: servers }), ["docs", "web"]);
  assert.deepEqual(workspaceMcpServerIds({ mode: "custom", mcpServers: [] }), []);
  assert.deepEqual(workspaceMcpServerIds({ mode: "off", mcpServers: servers }), []);

  assert.equal(kbrainRunMcpServerIds(undefined), undefined);
  assert.deepEqual(kbrainRunMcpServerIds(["docs"]), ["docs"]);
  // K-brain reads [] as "use the saved selection", so none is an id no server has.
  assert.deepEqual(kbrainRunMcpServerIds([]), [KBRAIN_NO_MCP_SERVERS]);
});
