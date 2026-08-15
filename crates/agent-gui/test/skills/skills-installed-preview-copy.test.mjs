import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pageSources = [
  {
    label: "共享 Skills Hub",
    source: readFileSync(
      new URL(
        "../../../agent-ui/src/pages/skills-hub/InstalledSkillPreviewDrawer.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
  },
];

const copyButtonSource = readFileSync(
  new URL("../../../agent-ui/src/components/ui/copy-button.tsx", import.meta.url),
  "utf8",
);

for (const { label, source } of pageSources) {
  test(`${label} can copy the installed Skill description`, () => {
    assert.match(source, /<CopyButton\s+value=\{description\}/);
    assert.match(source, /settings\.skillsInstalledPreviewCopyDescription/);
  });

  test(`${label} can copy the displayed installed Skill file preview`, () => {
    assert.match(source, /<CopyButton\s+value=\{previewContent\}/);
    assert.match(source, /settings\.skillsInstalledPreviewCopyFile/);
  });

  test(`${label} uses the shared copy control with translated success feedback`, () => {
    assert.match(source, /components\/ui\/copy-button/);
    assert.match(source, /settings\.skillsInstalledPreviewCopied/);
  });
}

test("shared copy control explains its action and confirms success in a visible tooltip", () => {
  assert.match(
    copyButtonSource,
    /import \{ Tooltip, TooltipContent, TooltipTrigger \} from "\.\/tooltip"/,
  );
  assert.match(copyButtonSource, /<Tooltip\b/);
  assert.match(copyButtonSource, /<TooltipContent>/);
  assert.match(copyButtonSource, /setTooltipOpen\(true\)/);
  assert.match(copyButtonSource, /role="status"/);
});

test("shared copy control supports restricted webviews without the Clipboard API", () => {
  assert.match(copyButtonSource, /navigator\.clipboard\?\.writeText/);
  assert.match(copyButtonSource, /document\.execCommand\("copy"\)/);
});
