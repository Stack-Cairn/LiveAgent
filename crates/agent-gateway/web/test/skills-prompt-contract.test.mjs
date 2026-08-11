import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});
const skills = loader.loadModule("@liveagent/ui/lib/skills/index.ts");

const enabledSkills = [
  {
    name: "code-review",
    description: "Review local code changes",
    skillFile: "code-review/SKILL.md",
    baseDir: "code-review",
  },
];

test("buildSkillsSystemPrompt uses skill:// paths instead of the removed root-scoped contract", () => {
  const prompt = skills.buildSkillsSystemPrompt({
    rootDir: "/skills",
    selected: enabledSkills,
  });

  assert.match(prompt, /skill:\/\/<baseDir>\/\.\.\./);
  assert.doesNotMatch(prompt, /root=["']skills["']/);
  assert.doesNotMatch(prompt, /Read\(root=/);
});
