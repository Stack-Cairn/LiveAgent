import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { applyMcpOps, applyMcpOpsToAppSettings, selectEnabledMcpServers } = loader.loadModule(
  "src/lib/settings/mcpOps.ts",
);
const { normalizeSettings, normalizeMcpSettings } = loader.loadModule("src/lib/settings/index.ts");

const serverA = normalizeMcpSettings({
  servers: [{ id: "a", enabled: true, transport: "stdio", command: "a-mcp" }],
}).servers[0];
const serverB = normalizeMcpSettings({
  servers: [{ id: "b", enabled: true, transport: "http", url: "https://example.test/mcp" }],
}).servers[0];

function baseSettings() {
  return normalizeMcpSettings({ servers: [serverA, serverB], selected: ["a", "b"] });
}

test("applyMcpOps is pure: same input twice yields deep-equal output and never mutates prev", () => {
  const prev = baseSettings();
  const snapshot = JSON.stringify(prev);
  const ops = [
    { kind: "patch", serverId: "a", patch: { command: "a-mcp-v2" } },
    { kind: "setEnabled", serverIds: ["b"], enabled: false },
  ];

  const first = applyMcpOps(prev, ops);
  const second = applyMcpOps(prev, ops);

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(prev), snapshot);
  assert.equal(first.servers[0].command, "a-mcp-v2");
  assert.equal(first.servers[1].enabled, false);
});

test("applyMcpOps returns the prev identity for no-op batches", () => {
  const prev = baseSettings();

  assert.equal(applyMcpOps(prev, []), prev);
  assert.equal(
    applyMcpOps(prev, [{ kind: "patch", serverId: "missing", patch: { command: "x" } }]),
    prev,
  );
  assert.equal(applyMcpOps(prev, [{ kind: "remove", serverId: "missing" }]), prev);
  assert.equal(
    applyMcpOps(prev, [{ kind: "setEnabled", serverIds: ["a", "b"], enabled: true }]),
    prev,
  );
  assert.equal(applyMcpOps(prev, [{ kind: "upsert", server: serverA }]), prev);
});

test("applyMcpOps upsert appends new servers and replaces same-id servers", () => {
  const prev = baseSettings();
  const serverC = { ...serverA, id: "c", command: "c-mcp" };

  const appended = applyMcpOps(prev, [{ kind: "upsert", server: serverC }]);
  assert.deepEqual(
    appended.servers.map((server) => server.id),
    ["a", "b", "c"],
  );

  const replaced = applyMcpOps(prev, [
    { kind: "upsert", server: { ...serverA, command: "a-mcp-replaced" } },
  ]);
  assert.deepEqual(
    replaced.servers.map((server) => server.id),
    ["a", "b"],
  );
  assert.equal(replaced.servers[0].command, "a-mcp-replaced");
});

test("applyMcpOps remove drops the server and its selection", () => {
  const prev = baseSettings();
  const next = applyMcpOps(prev, [{ kind: "remove", serverId: "a" }]);

  assert.deepEqual(
    next.servers.map((server) => server.id),
    ["b"],
  );
  assert.deepEqual(next.selected, ["b"]);
});

test("applyMcpOps patch merges fields and keeps the id immutable", () => {
  const prev = baseSettings();
  const next = applyMcpOps(prev, [
    { kind: "patch", serverId: "b", patch: { id: "hijacked", timeoutMs: 5000 } },
  ]);

  assert.equal(next.servers[1].id, "b");
  assert.equal(next.servers[1].timeoutMs, 5000);
  assert.equal(next.servers[1].url, "https://example.test/mcp");
});

test("applyMcpOpsToAppSettings passes prev identity through for no-op batches", () => {
  const prev = normalizeSettings({ mcp: baseSettings() });
  assert.equal(
    applyMcpOpsToAppSettings(prev, [{ kind: "remove", serverId: "missing" }]),
    prev,
  );

  const next = applyMcpOpsToAppSettings(prev, [{ kind: "remove", serverId: "a" }]);
  assert.notEqual(next, prev);
  assert.deepEqual(
    next.mcp.servers.map((server) => server.id),
    ["b"],
  );
});

test("selectEnabledMcpServers filters disabled and id-less servers", () => {
  const settings = normalizeMcpSettings({
    servers: [serverA, { ...serverB, enabled: false }, { ...serverA, id: "" }],
  });
  assert.deepEqual(
    selectEnabledMcpServers(settings).map((server) => server.id),
    ["a"],
  );
});
