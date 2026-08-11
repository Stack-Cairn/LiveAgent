import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = fileURLToPath(new URL("../..", import.meta.url));
const loader = createTsModuleLoader({ rootDir });
const markdownAssets = loader.loadModule(
  "@liveagent/ui/components/workspace-editor/workspaceMarkdownAssets.ts",
);

test("GUI Skill markdown keeps relative links inside the same Skill scope", () => {
  assert.equal(
    markdownAssets.resolveWorkspaceMarkdownPath(
      "skill://demo/docs/readme.md",
      "../assets/preview.png?size=2#image",
    ),
    "skill://demo/assets/preview.png",
  );
  assert.equal(
    markdownAssets.resolveWorkspaceMarkdownPath(
      "skill://demo/docs/nested/readme.md",
      "../../references/guide.md",
    ),
    "skill://demo/references/guide.md",
  );
  assert.equal(
    markdownAssets.resolveWorkspaceMarkdownPath(
      "skill://demo/docs/readme.md",
      "/assets/root.png",
    ),
    "skill://demo/assets/root.png",
  );
  assert.equal(
    markdownAssets.resolveWorkspaceMarkdownPath(
      "skill://demo/docs/readme.md",
      "../../other-skill/SKILL.md",
    ),
    null,
  );

  assert.deepEqual(
    markdownAssets.classifyWorkspaceMarkdownTarget(
      "skill://demo/docs/readme.md",
      "../assets/preview.png",
    ),
    { kind: "workspace", path: "skill://demo/assets/preview.png" },
  );
  assert.deepEqual(
    markdownAssets.classifyWorkspaceMarkdownTarget(
      "skill://demo/docs/readme.md",
      "skill://other/SKILL.md",
    ),
    { kind: "unsupported" },
  );
});

test("GUI workspace markdown path behavior remains unchanged", () => {
  assert.equal(
    markdownAssets.resolveWorkspaceMarkdownPath("docs/readme.md", "../assets/preview.png"),
    "assets/preview.png",
  );
});
