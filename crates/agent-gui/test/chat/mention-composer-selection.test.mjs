import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sourceRoots = [
  new URL("../../src/components/", import.meta.url),
  new URL("../../../agent-gateway/web/src/components/", import.meta.url),
];

function source(root, relativePath) {
  return readFileSync(new URL(relativePath, root), "utf8");
}

test("both composers restore the last editor selection before external mention insertion", () => {
  for (const root of sourceRoots) {
    const composer = source(root, "chat/MentionComposer.tsx");
    assert.match(composer, /lastEditorSelectionRef = useRef<Range \| null>\(null\)/);
    assert.match(composer, /document\.addEventListener\("selectionchange", rememberEditorSelection\)/);
    assert.equal(
      (composer.match(/focusEditorAtSavedSelection\(\);/g) ?? []).length,
      5,
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
    extractFunction(source(root, "chat/MentionComposer.tsx"), "insertNodeAtCursor"),
  );
  // Both frontends must keep the hardened implementation byte-identical.
  assert.equal(bodies[0], bodies[1]);
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

test("right-dock context menus preserve composer selection on both frontends", () => {
  for (const root of sourceRoots) {
    for (const relativePath of [
      "project-tools/file-tree/index.tsx",
      "project-tools/git-review/StatusView.tsx",
      "project-tools/git-review/HistoryView.tsx",
    ]) {
      const panel = source(root, relativePath);
      assert.doesNotMatch(panel, /window\.getSelection\(\)\?\.removeAllRanges\(\)/);
    }
  }
});

test("composer caret measurement never splits text nodes and restores the selection", () => {
  const bodies = sourceRoots.map((root) =>
    extractFunction(source(root, "chat/MentionComposer.tsx"), "measureComposerCaretRect"),
  );
  // Both frontends must keep the hardened implementation byte-identical.
  assert.equal(bodies[0], bodies[1]);
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
    extractFunction(source(root, "chat/MentionComposer.tsx"), "scrollSelectionIntoComposerView"),
  );
  assert.equal(scrollBodies[0], scrollBodies[1]);
  assert.match(scrollBodies[0], /measureComposerCaretRect\(range\)/);
  assert.doesNotMatch(scrollBodies[0], /cloneRange\(\)/);
});
