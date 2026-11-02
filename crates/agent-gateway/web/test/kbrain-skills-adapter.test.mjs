import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

test("Web Skills uses typed backend RPC for listing, reading, settings and management", async () => {
  const calls = [];
  let fail = false;
  const loader = createWebModuleLoader({ mocks: {
    "../lib/storage": { loadToken: () => "test-token" },
    "../lib/gatewaySocket": { getGatewayWebSocketClient: token => {
      assert.equal(token, "test-token");
      return { manageSkill: async body => {
        calls.push(body);
        if (fail) throw Error("backend unavailable");
        if (body.action === "list") return { rootDir: "/backend", skills: [], settings: { enabled: true, selected: [] } };
        if (body.action === "read") return { content: "Skill text", truncated: false };
        return { installJob: { phase: "completed" } };
      } };
    } },
  } });
  const adapter = loader.loadModule("src/agent-ui-adapters/kbrainSkills.ts").gatewaySkillsAdapter;
  assert.equal((await adapter.list("/project")).rootDir, "/backend");
  assert.equal((await adapter.read("one/SKILL.md", 3, 20)).content, "Skill text");
  await adapter.settings({ enabled: false, selected: [] });
  assert.equal((await adapter.manage({ action: "install_status", jobId: "job" })).installJob.phase, "done");
  assert.deepEqual(calls.slice(0, 3), [
    { action: "list", workdir: "/project" },
    { action: "read", path: "one/SKILL.md", offset: 3, length: 20 },
    { enabled: false, selected: [], action: "settings" },
  ]);
  fail = true;
  await assert.rejects(adapter.list(), /backend unavailable/);
});
