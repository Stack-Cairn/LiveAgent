import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const skillDrawerSource = readFileSync(
  new URL(
    "../../../agent-ui/src/pages/skills-hub/InstalledSkillPreviewDrawer.tsx",
    import.meta.url,
  ),
  "utf8",
);
const workspacePreviewSource = readFileSync(
  new URL(
    "../../../agent-ui/src/components/workspace-editor/WorkspaceMarkdownPreview.tsx",
    import.meta.url,
  ),
  "utf8",
);
const documentMarkdownSource = readFileSync(
  new URL("../../../agent-ui/src/components/markdown/DocumentMarkdown.tsx", import.meta.url),
  "utf8",
);
const desktopStyles = readFileSync(new URL("../../src/index.css", import.meta.url), "utf8");
const webStyles = readFileSync(
  new URL("../../../agent-gateway/web/src/index.css", import.meta.url),
  "utf8",
);
const sharedStyles = readFileSync(
  new URL("../../../agent-ui/src/styles/common-components.css", import.meta.url),
  "utf8",
);

test("Skill and workspace files share the document Markdown presentation", () => {
  assert.match(skillDrawerSource, /<DocumentMarkdown content=\{previewContent\}/);
  assert.match(workspacePreviewSource, /<DocumentMarkdown/);
  assert.match(documentMarkdownSource, /"document-markdown"/);
});

test("document Markdown keeps its typography separate from chat Markdown in both hosts", () => {
  for (const source of [desktopStyles, webStyles]) {
    assert.match(source, /agent-ui\/src\/styles\/common\.css/);
  }
  assert.match(sharedStyles, /\.document-markdown p/);
  assert.match(sharedStyles, /\.document-markdown \[data-streamdown="heading-2"\]/);
  assert.match(sharedStyles, /\.document-markdown \[data-streamdown="list-item"\] > p/);
  assert.match(sharedStyles, /\.document-markdown \[data-streamdown="code-block-body"\]/);
  assert.match(
    sharedStyles,
    /\.document-markdown \[data-streamdown="heading-1"\] \{\s*@apply[^;]*text-lg/,
  );
});

test("Skill detail sections use whitespace instead of large divider lines", () => {
  assert.doesNotMatch(skillDrawerSource, /<Separator/);
  assert.doesNotMatch(skillDrawerSource, /SheetHeader[^>]*border-b/);
});
