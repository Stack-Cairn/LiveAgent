import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

test("Skills can render cached discovery on reentry without scanning again; mutations invalidate it", async () => {
  let reads = 0;
  const loader = createTsModuleLoader({ mocks: {
    "@liveagent/app/shims/tauriCore": { invoke: async (command, args) => {
      if (args?.payload?.action === "list") reads++;
      return { rootDir: "/skills", skills: [] };
    } },
  } });
  const api = loader.loadModule("@liveagent/ui/lib/skills/index.ts");
  assert.equal(api.getCachedSkillsDiscovery(), null);
  const initial = await api.discoverSkills();
  assert.equal(api.getCachedSkillsDiscovery(), initial);
  assert.equal(await api.discoverSkills(), initial);
  assert.equal(reads, 1);
  await api.discoverSkills({ force: true });
  assert.equal(reads, 2);
  await api.manageSkill({ action: "delete", name: "example" });
  assert.equal(api.getCachedSkillsDiscovery(), null);
  await api.discoverSkills();
  assert.equal(reads, 3);
});
