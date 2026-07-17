import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});
const skills = loader.loadModule("src/lib/skills/builtin.ts");
const tools = loader.loadModule("src/lib/tools/builtinToolCatalog.ts");

const DESKTOP_TOOL_NAMES = ["ImageManager", "ImageGenerate", "ImageEdit", "PetManager"];

test("desktop-only skills cannot be selected or retained by the WebUI", () => {
  for (const name of ["api2img", "hatch-pet"]) {
    assert.equal(skills.isUserSelectableSkillName(name), false, `${name} is not selectable`);
  }

  assert.deepEqual(
    skills.mergeAlwaysEnabledSkillNames(["api2img", "hatch-pet", "custom-skill"]),
    ["skills-creator", "skills-installer", "custom-skill"],
  );
});

test("WebUI excludes desktop-only pet and image tools from its catalog", () => {
  const desktopTools = tools.BUILTIN_TOOL_CATALOG.filter((tool) => tool.desktopOnly);
  assert.deepEqual(
    desktopTools.map((tool) => tool.toolName),
    DESKTOP_TOOL_NAMES,
  );

  const webToolNames = tools.getBuiltinToolCatalog(false).map((tool) => tool.toolName);
  for (const name of DESKTOP_TOOL_NAMES) {
    assert.equal(webToolNames.includes(name), false, `${name} is not shown in WebUI`);
  }
});
