// Settings LiveAgent keeps for K-brain: the old per-server MCP approval moves into
// K-brain's policy, project skills overrides are saved per workdir, and a run carries
// the project's MCP server choice.
import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};

const connection = { baseUrl: "http://127.0.0.1:1", token: "", storageId: "data-root-a" };
const loader = createTsModuleLoader({
  mocks: {
    [new URL("../../src/lib/kbrain/runtimeConnection.ts", import.meta.url).pathname]: {
      getConfiguredKBrainConnection: () => connection,
    },
  },
});
const { migrateLegacyMcpServerPolicies } = loader.loadModule("src/lib/settings/mcpPolicyMigration.ts");
const {
  changedWorkspaceSkillsOverrides,
  saveWorkspaceSkillsOverrides,
  syncWorkspaceSkillsOverridesOnce,
  workspaceSkillsOverrides,
} = loader.loadModule("src/lib/kbrain/workspaceSkills.ts");
const { canonicalRunOptions } = loader.loadModule("src/pages/chat/turns/runKBrainConversationTurn");
const { getDefaultSettings, resolveWorkspaceResources, workspaceMcpServerIds } =
  loader.loadModule("src/lib/settings");

function document(servers) {
  return { settings: { servers, selected: [] }, statuses: [] };
}

test("an MCP server approval saved by older builds moves into K-brain's policy once", async () => {
  storage.clear();
  const saved = [];
  const save = async (settings) => {
    saved.push(settings);
    return { settings, statuses: [] };
  };
  const current = document([
    { id: "docs", enabled: true, transport: "stdio", command: "docs-mcp" },
    { id: "web", enabled: true, transport: "http", url: "https://mcp.example", policy: { "*": "ask" } },
    { id: "plain", enabled: true, transport: "stdio", command: "plain-mcp" },
  ]);
  const local = { "server:docs": "deny", "server:web": "allow", Bash: "ask" };

  const result = await migrateLegacyMcpServerPolicies(local, current, save);

  assert.equal(saved.length, 1);
  const [docs, web, plain] = saved[0].servers;
  assert.deepEqual(docs.policy, { "*": "deny" });
  // A policy K-brain already has wins over the local value.
  assert.deepEqual(web.policy, { "*": "ask" });
  assert.equal("policy" in plain, false);
  // Migrated keys leave LiveAgent's local policies; unrelated tool policies stay.
  assert.deepEqual(result.toolPolicies, { Bash: "ask" });
  assert.deepEqual(result.document.settings.servers[0].policy, { "*": "deny" });

  // Second run: already migrated for this data root, so nothing is saved again, and
  // a local key left behind (the app quit before saving settings) is dropped.
  const again = await migrateLegacyMcpServerPolicies(
    { "server:docs": "allow", Bash: "ask" },
    current,
    async () => assert.fail("must not save twice"),
  );
  assert.deepEqual(again.toolPolicies, { Bash: "ask" });
  assert.equal(again.document, current);
});

test("a failed policy migration keeps the local approval for the next try", async () => {
  storage.clear();
  const local = { "server:docs": "deny" };
  const current = document([{ id: "docs", enabled: true, transport: "stdio", command: "docs-mcp" }]);
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const failed = await migrateLegacyMcpServerPolicies(local, current, async () => {
      throw new Error("offline");
    });
    assert.deepEqual(failed.toolPolicies, local);
    assert.equal(failed.document, current);
  } finally {
    console.warn = originalWarn;
  }
  const retried = await migrateLegacyMcpServerPolicies(local, current, async (settings) => ({
    settings,
  }));
  assert.equal(retried.toolPolicies, undefined);
  assert.deepEqual(retried.document.settings.servers[0].policy, { "*": "deny" });
});

function withResources(entries) {
  const settings = getDefaultSettings();
  return {
    ...settings,
    skills: { ...settings.skills, enabled: true, selected: ["global-skill"] },
    system: { ...settings.system, workspaceResourceSettings: entries },
  };
}

function resource(mode, extra = {}) {
  return { mode, skillNames: [], mcpServerIds: [], projectPrompt: "", ...extra };
}

test("project skills changes are sent per workdir, and going back to inherit clears the override", () => {
  const before = withResources({
    "/work/a": resource("custom", { skillNames: ["one"] }),
    "/work/b": resource("off"),
  });
  const after = withResources({
    "/work/a": resource("inherit"),
    "/work/b": resource("off", { projectPrompt: "only the prompt changed" }),
    "/work/c": resource("custom", { skillNames: ["two"] }),
  });
  assert.deepEqual(changedWorkspaceSkillsOverrides(before, after), [
    { workdir: "/work/a", mode: "inherit", skillNames: [] },
    { workdir: "/work/c", mode: "custom", skillNames: ["two"] },
  ]);
  // A project that was removed from settings is cleared too.
  assert.deepEqual(changedWorkspaceSkillsOverrides(before, withResources({})), [
    { workdir: "/work/a", mode: "inherit", skillNames: [] },
    { workdir: "/work/b", mode: "inherit", skillNames: [] },
  ]);
  assert.deepEqual(workspaceSkillsOverrides(before), [
    { workdir: "/work/a", mode: "custom", skillNames: ["one"] },
    { workdir: "/work/b", mode: "off", skillNames: [] },
  ]);
});

function response(status, text = "") {
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

test("saving project skills tries every project, skips missing folders and reports the first error", async () => {
  const bodies = [];
  const answers = {
    "/gone": response(422, "stat /gone: no such file or directory"),
    "/inherit-gone": response(422, "anything"),
    "/broken": response(500, "disk full"),
    "/ok": response(200),
  };
  const put = async (body) => {
    bodies.push(body);
    return answers[body.workdir];
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(
      saveWorkspaceSkillsOverrides(
        [
          { workdir: "/gone", mode: "off", skillNames: [] },
          { workdir: "/inherit-gone", mode: "inherit", skillNames: [] },
          { workdir: "/broken", mode: "custom", skillNames: ["one"] },
          { workdir: "/ok", mode: "custom", skillNames: ["two"] },
        ],
        { enabled: true, selected: ["global-skill"] },
        put,
      ),
      /disk full/,
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(
    bodies.map((body) => body.workdir),
    ["/gone", "/inherit-gone", "/broken", "/ok"],
  );
  assert.deepEqual(bodies[3], {
    workdir: "/ok",
    enabled: true,
    selected: ["global-skill"],
    mode: "custom",
    skillNames: ["two"],
  });
  // Skill packs are left out so K-brain keeps them.
  assert.equal("packs" in bodies[3], false);
});

test("project skills saved by older builds are sent once per K-brain data root", async () => {
  storage.clear();
  const settings = withResources({ "/work/a": resource("off"), "/work/b": resource("inherit") });
  const sent = [];
  const put = async (body) => (sent.push(body.workdir), response(200));
  await syncWorkspaceSkillsOverridesOnce(settings, put);
  await syncWorkspaceSkillsOverridesOnce(settings, put);
  assert.deepEqual(sent, ["/work/a"]);

  // A failure leaves the marker unset, so the next start tries again.
  storage.clear();
  await assert.rejects(
    syncWorkspaceSkillsOverridesOnce(settings, async () => response(500, "busy")),
    /busy/,
  );
  await syncWorkspaceSkillsOverridesOnce(settings, put);
  assert.deepEqual(sent, ["/work/a", "/work/a"]);
});

test("an agent run carries the project's MCP server choice; chat runs never do", () => {
  const settings = {
    ...withResources({
      "/custom": resource("custom", { mcpServerIds: ["docs", "disabled"] }),
      "/none": resource("custom"),
      "/off": resource("off"),
    }),
    mcp: {
      servers: [
        { id: "docs", enabled: true, transport: "stdio", command: "docs-mcp" },
        { id: "disabled", enabled: false, transport: "stdio", command: "x" },
        { id: "web", enabled: true, transport: "http", url: "https://mcp.example" },
      ],
      selected: [],
    },
  };
  const idsFor = (workdir) => {
    const mcpServerIds = workspaceMcpServerIds(resolveWorkspaceResources(settings, workdir));
    return canonicalRunOptions({ effectiveWorkdir: workdir, runtime: {}, mcpServerIds })
      .mcp_server_ids;
  };
  assert.equal(idsFor("/inherit"), undefined);
  assert.deepEqual(idsFor("/custom"), ["docs"]);
  assert.deepEqual(idsFor("/none"), ["liveagent:no-mcp-servers"]);
  assert.deepEqual(idsFor("/off"), ["liveagent:no-mcp-servers"]);

  const chat = canonicalRunOptions({ conversationCwd: "/off", runtime: {}, mcpServerIds: [] });
  assert.equal("mcp_server_ids" in chat, false);
});
