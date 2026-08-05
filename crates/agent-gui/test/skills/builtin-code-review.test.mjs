import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The built-in Skills shipped in agent-core are data assets: the runtime
// discovers them by directory and then trusts the frontmatter it finds. A
// mismatch between the two only shows up as a Skill that silently fails to
// resolve, so validate the assets themselves.
const skillsRoot = fileURLToPath(new URL("../../../agent-core/prompt/skills/", import.meta.url));

function parseFrontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return fields;
}

const builtinSkillDirs = readdirSync(skillsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

test("built-in Skills ship a parseable SKILL.md entrypoint", () => {
  assert.ok(builtinSkillDirs.length > 0, "no built-in Skills found");
  assert.ok(
    builtinSkillDirs.includes("liveagent-code-review"),
    "the code review Skill must stay built in",
  );

  for (const dir of builtinSkillDirs) {
    const source = readFileSync(path.join(skillsRoot, dir, "SKILL.md"), "utf8");
    assert.notEqual(parseFrontmatter(source), null, `${dir}: SKILL.md has no frontmatter`);
  }
});

test("each built-in Skill declares the name the runtime discovers it under", () => {
  for (const dir of builtinSkillDirs) {
    const fields = parseFrontmatter(readFileSync(path.join(skillsRoot, dir, "SKILL.md"), "utf8"));
    // Discovery keys Skills by directory; a frontmatter name that disagrees
    // makes the Skill unreachable by the name the model is told to use.
    assert.equal(fields.name, dir, `${dir}: frontmatter name must match the directory`);
  }
});

test("each built-in Skill carries a description the model can dispatch on", () => {
  for (const dir of builtinSkillDirs) {
    const fields = parseFrontmatter(readFileSync(path.join(skillsRoot, dir, "SKILL.md"), "utf8"));
    assert.ok(fields.description, `${dir}: frontmatter description is required`);
    // The description is the only signal the model gets before loading the
    // Skill body, so it has to say when to reach for it, not just what it is.
    assert.match(fields.description, /\bUse when\b/, `${dir}: description must state when to use`);
  }
});

test("the code review Skill never instructs the model to write to GitHub", () => {
  const source = readFileSync(
    path.join(skillsRoot, "liveagent-code-review", "SKILL.md"),
    "utf8",
  );
  // Review runs against a captured snapshot and reports back into the chat;
  // publishing comments or reviews from the Skill would be an unrequested
  // side effect on a real pull request.
  assert.match(source, /Never write to GitHub/);
  assert.doesNotMatch(source, /gh pr (?:comment|review)\b/);
});
