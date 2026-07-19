import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const skillSource = readFileSync(
  new URL("../../src-tauri/prompt/skills/liveagent-code-review/SKILL.md", import.meta.url),
  "utf8",
);
const builtinRegistrySource = readFileSync(
  new URL("../../src-tauri/src/services/skills/builtin.rs", import.meta.url),
  "utf8",
);

test("built-in code review skill is registered under a collision-resistant name", () => {
  assert.match(skillSource, /^---\r?\nname: liveagent-code-review\r?\n/m);
  assert.match(builtinRegistrySource, /name: "liveagent-code-review"/);
  assert.match(
    builtinRegistrySource,
    /prompt\/skills\/liveagent-code-review\/SKILL\.md/,
  );
});

test("built-in code review skill covers PR and local review without remote writes", () => {
  assert.match(skillSource, /Anthropic's public Claude Code Code Review plugin/);
  assert.match(skillSource, /four roles/);
  assert.match(skillSource, /mode=readonly/);
  assert.match(skillSource, /confidence >= 80/);
  assert.match(skillSource, /current local branch/);
  assert.match(skillSource, /staged, unstaged, and untracked/);
  assert.match(skillSource, /Never write to GitHub/);
  assert.doesNotMatch(skillSource, /## Optional GitHub publication|event `COMMENT`/);
  assert.doesNotMatch(skillSource, /\/code-review\b/);
});

test("built-in code review seeding requires an ownership marker", () => {
  assert.match(builtinRegistrySource, /_liveagent_builtin\.json/);
  assert.match(builtinRegistrySource, /conflict_preserved/);
  assert.match(builtinRegistrySource, /builtin_skill_owns_target/);
});
