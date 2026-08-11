import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pageSources = [
  {
    label: "共享 Skills Hub",
    source: readFileSync(
      new URL("../../../agent-ui/src/pages/skills-hub/SkillsHubPage.tsx", import.meta.url),
      "utf8",
    ),
  },
];

for (const { label, source } of pageSources) {
  test(`${label} can copy the installed Skill description`, () => {
    assert.match(source, /<SkillPreviewCopyButton\s+value=\{description\}/);
    assert.match(source, /settings\.skillsInstalledPreviewCopyDescription/);
  });

  test(`${label} can copy the displayed installed Skill file preview`, () => {
    assert.match(source, /<SkillPreviewCopyButton\s+value=\{previewContent\}/);
    assert.match(source, /settings\.skillsInstalledPreviewCopyFile/);
  });

  test(`${label} provides copy success feedback and a clipboard fallback`, () => {
    assert.match(source, /navigator\.clipboard\?\.writeText/);
    assert.match(source, /document\.execCommand\("copy"\)/);
    assert.match(source, /settings\.skillsInstalledPreviewCopied/);
  });
}
