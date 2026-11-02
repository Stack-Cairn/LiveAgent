import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/pages/StatusDashboardPage.tsx", import.meta.url), "utf8");
const start = source.indexOf("  const activeWorkspaceProjects =");
const end = source.indexOf("  const latestTerminal =", start);
assert.ok(start >= 0 && end > start);

function project(settingsSnapshot) {
  return vm.runInNewContext(`${source.slice(start, end)}\n({ activeWorkspaceProjects, selectedModel, selectedProviderName, enabledMcpCount, configuredProviderCount, selectedSkillCount, remoteFeatureCount });`, {
    settingsSnapshot,
    providers: [],
    useAutomation: () => ({ cron: { tasks: [] }, hooks: { hooks: [] } }),
  });
}

test("dashboard accepts the provider-only K-brain settings projection", () => {
  const result = project({
    customProviders: [{ id: "provider", name: "Provider", type: "codex", apiKeyConfigured: true }],
    selectedModel: { customProviderId: "provider", model: "model" },
  });
  assert.equal(result.selectedProviderName, "Provider");
  assert.equal(result.configuredProviderCount, 1);
  assert.equal(result.activeWorkspaceProjects.length, 0);
  assert.equal(result.enabledMcpCount, 0);
  assert.equal(result.selectedSkillCount, 0);
  assert.equal(result.remoteFeatureCount, 0);
});

test("dashboard tolerates settings before loading and preserves desktop fields", () => {
  assert.equal(project(null).selectedModel, null);
  const result = project({
    system: { workspaceProjects: [{ id: "project", path: "/workspace" }] },
    mcp: { servers: [{ enabled: true }, { enabled: false }] },
    skills: { enabled: true, selected: ["skill"] },
    remote: { enableWebTerminal: true, enableWebGit: true, enableWebTunnels: false },
  });
  assert.equal(result.activeWorkspaceProjects.length, 1);
  assert.equal(result.enabledMcpCount, 1);
  assert.equal(result.selectedSkillCount, 1);
  assert.equal(result.remoteFeatureCount, 2);
});
