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
const markdownStyles = readFileSync(
  new URL("../../../agent-ui/src/components/markdown/markdownStyles.ts", import.meta.url),
  "utf8",
);

test("Skill and workspace files share the document Markdown presentation", () => {
  assert.match(skillDrawerSource, /<DocumentMarkdown content=\{previewContent\}/);
  assert.match(workspacePreviewSource, /<DocumentMarkdown/);
  assert.match(documentMarkdownSource, /"document-markdown"/);
});

test("document Markdown keeps its typography separate from chat Markdown", () => {
  assert.match(markdownStyles, /DOCUMENT_MARKDOWN_CLASS/);
  assert.match(markdownStyles, /\[&_p\]:text-scaled-13px/);
  assert.match(markdownStyles, /\[&_\[data-streamdown=heading-2\]\]/);
  assert.match(markdownStyles, /\[&_\[data-streamdown=list-item\]>p\]:my-0/);
  assert.match(markdownStyles, /\[&_\[data-streamdown=code-block-body\]\]:rounded-lg/);
  assert.match(markdownStyles, /\[&_\[data-streamdown=heading-1\]\]:text-lg/);
});

test("Skill detail sections use whitespace instead of large divider lines", () => {
  assert.doesNotMatch(skillDrawerSource, /<Separator/);
  assert.doesNotMatch(skillDrawerSource, /SheetHeader[^>]*border-b/);
});
