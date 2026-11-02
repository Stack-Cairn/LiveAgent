import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const resourceHost = loader.loadModule("@liveagent/ui/lib/resourceHost.ts");
const hubSource = readFileSync(
  new URL("../../../agent-ui/src/pages/skills-hub/SkillsHubPage.tsx", import.meta.url),
  "utf8",
);
const installedSource = readFileSync(
  new URL("../../../agent-ui/src/pages/skills-hub/InstalledSkillsView.tsx", import.meta.url),
  "utf8",
);
const storeSource = readFileSync(
  new URL("../../../agent-ui/src/pages/skills-hub/SkillsStoreView.tsx", import.meta.url),
  "utf8",
);
const memorySource = readFileSync(
  new URL("../../../agent-ui/src/pages/settings/memory/MemoryPanel.tsx", import.meta.url),
  "utf8",
);
const memoryHookSource = readFileSync(
  new URL("../../../agent-ui/src/pages/settings/memory/useMemoryPanelData.ts", import.meta.url),
  "utf8",
);

test("unsupported classification is limited to K-brain resource boundaries", () => {
  assert.equal(
    resourceHost.isUnsupportedResourceError(
      new Error('WebUI shim does not implement invoke("memory_list")'),
    ),
    true,
  );
  assert.equal(
    resourceHost.isUnsupportedResourceError(
      new Error('WebUI shim does not implement invoke("provider_list")'),
    ),
    false,
  );
  assert.equal(
    resourceHost.isUnsupportedResourceError(new Error("ordinary backend request failed")),
    false,
  );
});

test("unsupported resource commands end loading and expose backend-managed state", () => {
  assert.match(hubSource, /setDiscoveryBackendManaged\(true\)/);
  assert.match(hubSource, /setLoading\(false\)/);
  assert.match(hubSource, /setExternalBackendManaged\(true\)/);
  assert.match(hubSource, /isUnsupportedResourceError\(err\)/);
  assert.match(memoryHookSource, /finally \{\s*setLoading\(false\);/);
  assert.match(memoryHookSource, /if \(isUnsupportedResourceError\(err\)\) setBackendManaged\(true\)/);
});

test("backend-managed resource surfaces disable local operations without empty success", () => {
  assert.match(hubSource, /!lockedByChatMode && !backendManaged/);
  assert.match(installedSource, /!backendManaged && !loading && !hasSkills/);
  assert.match(installedSource, /!backendManaged && loading && !hasSkills/);
  assert.match(installedSource, /skillsEnabled=\{skillsEnabled && !backendManaged\}/);
  assert.match(storeSource, /installDisabled=\{backendManaged\}/);
  assert.match(memorySource, /disabled=\{backendManaged \|\| saving\}/);
  assert.match(memorySource, /settings\.memoryBackendManaged/);
  assert.doesNotMatch(hubSource, /setSkills\(\[\]\).*setRootDir\(""\)/);
});
