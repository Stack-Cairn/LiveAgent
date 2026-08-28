import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sourceRoots = [
  new URL("../../../agent-ui/src/components/", import.meta.url),
];
const sharedProjectToolsRoot = new URL("../../../agent-ui/src/components/", import.meta.url);

function composerSource(root) {
  return ["chat/MentionComposer.tsx", "chat/MentionComposerInternals.tsx"]
    .map((relativePath) => source(root, relativePath))
    .join("\n");
}

function source(root, relativePath) {
  return readFileSync(new URL(relativePath, root), "utf8");
}

test("the shared composer restores the last editor selection before external mention insertion", () => {
  for (const root of sourceRoots) {
    const composer = composerSource(root);
    assert.match(composer, /lastEditorSelectionRef = useRef<Range \| null>\(null\)/);
    assert.match(composer, /document\.addEventListener\("selectionchange", rememberEditorSelection\)/);
    assert.equal(
      (composer.match(/focusEditorAtSavedSelection\(\);/g) ?? []).length,
      // file/skill/app/commit/gitFile/code 六种外部插入 + beginTransientText。
      7,
    );
  }
});

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const end = src.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `unterminated function ${name}`);
  return src.slice(start, end + 3);
}

test("insertNodeAtCursor hops chip-inner boundaries and normalizes the caret anchor", () => {
  const bodies = sourceRoots.map((root) =>
    extractFunction(composerSource(root), "insertNodeAtCursor"),
  );
  const body = bodies[0];
  // A saved selection restored before external insertion can sit inside a
  // non-editable chip; the insert must hop outside instead of nesting.
  assert.match(body, /closestComposerChipFromNode\(root, range\.startContainer\)/);
  assert.match(body, /setStartAfter\(startChip\)/);
  assert.match(body, /closestComposerChipFromNode\(root, range\.endContainer\)/);
  assert.match(body, /setEndBefore\(endChip\)/);
  // The caret anchor must go through the canonical normalizer so split-off
  // text nodes are reused instead of leaving empty leftovers.
  assert.match(body, /ensureCaretAnchorAfterChip\(node\)/);
  assert.doesNotMatch(body, /range\.insertNode\(afterNode\)/);
});

test("shared right-dock context menus preserve composer selection", () => {
  for (const relativePath of [
    "project-tools/file-tree/index.tsx",
    "project-tools/git-review/StatusView.tsx",
    "project-tools/git-review/HistoryView.tsx",
  ]) {
    const panel = source(sharedProjectToolsRoot, relativePath);
    assert.doesNotMatch(panel, /window\.getSelection\(\)\?\.removeAllRanges\(\)/);
  }
});

test("composer caret measurement never splits text nodes and restores the selection", () => {
  const bodies = sourceRoots.map((root) =>
    extractFunction(composerSource(root), "measureComposerCaretRect"),
  );
  const body = bodies[0];
  // Range.insertNode() splits the text node under a line-boundary caret; the
  // caret then lands inside the degenerate empty text node left by the split
  // and WebKit stops painting it — the cursor vanished after Shift+Enter.
  // The probe must be inserted at a node boundary instead, and the selection
  // must be restored to the measured position afterwards.
  assert.doesNotMatch(body, /insertNode\(/);
  assert.match(body, /parent\.insertBefore\(marker, before\)/);
  assert.match(body, /sel\.collapse\(startContainer, startOffset\)/);

  const scrollBodies = sourceRoots.map((root) =>
    extractFunction(composerSource(root), "scrollSelectionIntoComposerView"),
  );
  assert.match(scrollBodies[0], /measureComposerCaretRect\(range\)/);
  assert.doesNotMatch(scrollBodies[0], /cloneRange\(\)/);
});

test("composer transient text exposes an anchored marker transaction", () => {
  const composer = composerSource(sourceRoots[0]);
  const transient = composer.slice(composer.indexOf("beginTransientText:"), composer.indexOf("focus: ()"));
  assert.match(transient, /clearTransientText\(false\)/);
  assert.match(transient, /activeRange\.insertNode\(end\)/);
  assert.match(transient, /activeRange\.insertNode\(textNode\)/);
  assert.match(transient, /activeRange\.insertNode\(start\)/);
  assert.match(transient, /transientTextRef\.current = \{ textNode, start, end \}/);
  assert.match(transient, /active\.textNode\.data = normalizeLogicalLineEndings\(text\)/);
  assert.match(transient, /range\.setStartAfter\(active\.end\)/);
  assert.match(transient, /clearTransientText\(true\)/);
  assert.match(transient, /clearTransientText\(options\?\.preserveLastText === true\)/);
});

test("transient cleanup protects mention nodes and locks composer controls during STT", () => {
  const composer = composerSource(sourceRoots[0]);
  assert.match(composer, /clearTransientText\(false\);[\s\S]*?setBusy\(false\)/);
  assert.match(composer, /closestComposerChipFromNode/);
  const bar = source(new URL("../../../agent-ui/src/pages/chat/", import.meta.url), "ChatComposerBar.tsx");
  assert.match(bar, /disabled=\{isInputDisabled \|\| stt\.active\}/);
  assert.match(bar, /disabled=\{controlsDisabled\}/);
  assert.match(bar, /const sendDisabled = isInputDisabled \|\| stt\.active \|\| isUploadingFiles \|\| !hasSendableDraft/);
});
