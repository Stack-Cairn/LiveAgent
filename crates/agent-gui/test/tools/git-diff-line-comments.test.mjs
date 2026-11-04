import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const messages = {
  "projectTools.gitReview.lineComments.pending": "{count} pending comments",
  "projectTools.gitReview.lineComments.pendingOne": "1 pending comment",
  "projectTools.gitReview.lineComments.lineLabel": "Line {line}",
  "projectTools.gitReview.lineComments.deletedLineLabel": "Deleted line {line}",
  "projectTools.gitReview.lineComments.composerHeading": "Review comments on the diff:",
};
const locale = { locale: "en-US", t: (key) => messages[key] ?? key };
const NullIcon = () => null;
// Every IconSet export renders nothing; the loader's default "~icons/*" mock
// returns plain objects that real react-dom refuses to render.
const iconSet = new Proxy({}, { get: (_target, key) => (key === "__esModule" ? false : NullIcon) });

const SplitSide = { old: 1, new: 2, 1: "old", 2: "new" };
const diffViewRenders = [];
let ReactRef = null;

// Stand-in for the @git-diff-view renderer: exposes a "+" per line the real
// gutter would offer, owns the open-widget state like the library does, and
// renders saved comments through renderExtendLine from extendData.
function FakeDiffView(props) {
  const h = ReactRef.createElement;
  const [widget, setWidget] = ReactRef.useState(null);
  diffViewRenders.push(props);
  const lines = [
    { lineNumber: 1, side: SplitSide.new },
    { lineNumber: 2, side: SplitSide.old },
    { lineNumber: 2, side: SplitSide.new },
  ];
  const extend = [];
  for (const [sideName, side] of [
    ["oldFile", SplitSide.old],
    ["newFile", SplitSide.new],
  ]) {
    for (const [lineNumber, entry] of Object.entries(props.extendData?.[sideName] ?? {})) {
      extend.push(
        h(
          "div",
          { key: `${sideName}:${lineNumber}`, "data-extend": `${SplitSide[side]}:${lineNumber}` },
          props.renderExtendLine?.({
            diffFile: props.diffFile,
            side,
            lineNumber: Number(lineNumber),
            data: entry.data,
            onUpdate: () => {},
          }),
        ),
      );
    }
  }
  return h(
    "div",
    { "data-fake-diff": props.diffFile._oldFileName ?? "" },
    props.diffViewAddWidget
      ? lines.map((line) =>
          h(
            "button",
            {
              key: `${line.side}:${line.lineNumber}`,
              type: "button",
              "data-add": `${SplitSide[line.side]}:${line.lineNumber}`,
              onClick: () => setWidget(line),
            },
            "+",
          ),
        )
      : null,
    widget && props.renderWidgetLine
      ? h(
          "div",
          { "data-widget": "" },
          props.renderWidgetLine({
            diffFile: props.diffFile,
            side: widget.side,
            lineNumber: widget.lineNumber,
            onClose: () => setWidget(null),
          }),
        )
      : null,
    ...extend,
  );
}

const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/i18n/index": { useLocale: () => locale },
    "@liveagent/ui/components/IconSet": iconSet,
    "@git-diff-view/react": {
      DiffModeEnum: { Unified: 4, Split: 3 },
      DiffView: (props) => FakeDiffView(props),
      SplitSide,
    },
  },
});
const { React, act, createRoot } = env;
ReactRef = React;
const lib = env.loadModule("@liveagent/ui/lib/chat/diffLineComments.ts");
const { DiffContent } = env.loadModule(
  "@liveagent/ui/components/project-tools/git-review/DiffView.tsx",
);
const { MentionComposer } = env.loadModule("@liveagent/ui/components/chat/MentionComposer.tsx");
const { formatCodeMentionToken } = env.loadModule("@liveagent/ui/lib/chat/mentionReferences.ts");

const PATCH_A = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  " const c = 4;",
  "",
].join("\n");
const PATCH_B = [
  "diff --git a/src/b.ts b/src/b.ts",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -1,2 +1,2 @@",
  " export const x = 1;",
  "-export const y = 2;",
  "+export const y = 20;",
  "",
].join("\n");

function serializeSegments(segments) {
  return segments
    .map((segment) =>
      segment.type === "codeMention" ? formatCodeMentionToken(segment.reference) : segment.text,
    )
    .join("");
}

function input(overrides = {}) {
  return {
    fileKey: "chunk-a",
    path: "src/a.ts",
    side: "new",
    lineNumber: 2,
    lineKind: "add",
    code: "const b = 3;\n",
    comment: "why 3?",
    ...overrides,
  };
}

test("upsert keeps one comment per line, edits in place and drops blank comments", () => {
  let comments = lib.upsertDiffLineComment([], input());
  assert.equal(comments.length, 1);
  assert.equal(comments[0].code, "const b = 3;");
  assert.equal(comments[0].comment, "why 3?");

  comments = lib.upsertDiffLineComment(comments, input({ side: "old", lineKind: "delete" }));
  assert.equal(comments.length, 2, "same line number on the other side is a separate comment");

  comments = lib.upsertDiffLineComment(comments, input({ comment: "  use a constant  \r\n" }));
  assert.equal(comments.length, 2);
  assert.equal(comments[0].comment, "use a constant");

  comments = lib.upsertDiffLineComment(comments, input({ comment: "   " }));
  assert.deepEqual(
    comments.map((entry) => entry.side),
    ["old"],
  );
  const id = comments[0].id;
  assert.deepEqual(lib.removeDiffLineComment(comments, id), []);
  assert.equal(lib.removeDiffLineComment(comments, "missing"), comments);
});

test("prune and sort follow the rendered chunk order", () => {
  const comments = [
    lib.upsertDiffLineComment([], input({ fileKey: "b", path: "src/b.ts", lineNumber: 9 }))[0],
    lib.upsertDiffLineComment([], input({ fileKey: "a", lineNumber: 5 }))[0],
    lib.upsertDiffLineComment([], input({ fileKey: "a", lineNumber: 2 }))[0],
    lib.upsertDiffLineComment([], input({ fileKey: "gone", lineNumber: 1 }))[0],
  ];
  const pruned = lib.pruneDiffLineComments(comments, ["a", "b"]);
  assert.equal(pruned.length, 3);
  assert.equal(lib.pruneDiffLineComments(pruned, ["a", "b"]), pruned);
  const sorted = lib.sortDiffLineComments(pruned, ["a", "b"]);
  assert.deepEqual(
    sorted.map((entry) => `${entry.fileKey}:${entry.lineNumber}`),
    ["a:2", "a:5", "b:9"],
  );
});

test("segments use a code mention for new-file lines and plain text for deleted lines", () => {
  const comments = [
    lib.upsertDiffLineComment([], input({ comment: "why 3?\nexplain" }))[0],
    lib.upsertDiffLineComment(
      [],
      input({ side: "old", lineKind: "delete", code: "const b = 2;", comment: "keep this" }),
    )[0],
    lib.upsertDiffLineComment(
      [],
      input({ lineNumber: 7, lineKind: "context", code: "const s = `x```;", comment: "fence" }),
    )[0],
  ];
  const segments = lib.buildDiffLineCommentSegments(comments, { heading: "Review:" });
  assert.equal(segments[0].type, "text");
  assert.equal(segments[1].type, "codeMention");
  assert.deepEqual(segments[1].reference, { path: "src/a.ts", startLine: 2, endLine: 2 });
  assert.equal(
    serializeSegments(segments),
    [
      "Review:",
      "",
      "[a.ts:2](src/a.ts#L2) — why 3?",
      "explain",
      "```diff",
      "+const b = 3;",
      "```",
      "",
      "src/a.ts:2 (deleted) — keep this",
      "```diff",
      "-const b = 2;",
      "```",
      "",
      "[a.ts:7](src/a.ts#L7) — fence",
      "````diff",
      " const s = `x```;",
      "````",
    ].join("\n"),
  );
  assert.equal(lib.formatDiffLineCommentsMarkdown(comments), serializeSegments(
    lib.buildDiffLineCommentSegments(comments),
  ));
  assert.deepEqual(lib.buildDiffLineCommentSegments([]), []);

  const absolute = lib.upsertDiffLineComment([], input({ path: "/etc/hosts" }))[0];
  assert.deepEqual(lib.buildDiffLineCommentSegments([absolute])[0], {
    type: "text",
    text: "/etc/hosts:2 — why 3?\n```diff\n+const b = 3;\n```",
  });
});

test("composer block separator starts appended blocks on their own paragraph", () => {
  assert.equal(lib.composerBlockSeparator(""), "");
  assert.equal(lib.composerBlockSeparator("  \n"), "");
  assert.equal(lib.composerBlockSeparator("draft"), "\n\n");
  assert.equal(lib.composerBlockSeparator("draft\n"), "\n");
  assert.equal(lib.composerBlockSeparator("draft\n\n"), "");
});

function setTextareaValue(textarea, value) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  ).set;
  setter.call(textarea, value);
  textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function buttonByText(container, text) {
  return [...container.querySelectorAll("button")].find(
    (button) => button.textContent.trim() === text,
  );
}

function renderDiffContent(initialProps) {
  const host = document.createElement("div");
  document.body.append(host);
  const reactRoot = createRoot(host);
  let props = initialProps;
  const render = async (next = {}) => {
    props = { ...props, ...next };
    await act(async () => reactRoot.render(React.createElement(DiffContent, props)));
  };
  return {
    host,
    render,
    click: async (element) => {
      assert.ok(element, "expected element to click");
      await act(async () => element.click());
    },
    type: async (value) => {
      const textarea = host.querySelector("[data-diff-line-comment] textarea");
      assert.ok(textarea, "expected an open comment editor");
      await act(async () => setTextareaValue(textarea, value));
      return textarea;
    },
    pending: () => host.querySelector('[data-diff-line-comment="pending"]'),
    chunk: (path) => host.querySelector(`[data-fake-diff="${path}"]`),
    cleanup: async () => {
      await act(async () => reactRoot.unmount());
      host.remove();
    },
  };
}

test("diff lines can be commented, edited, deleted and sent to the composer", async () => {
  const sent = [];
  const view = renderDiffContent({
    title: "Working Tree",
    diff: { patch: `${PATCH_A}${PATCH_B}`, stat: "", baseRef: "HEAD", headRef: "WORKTREE" },
    showStat: false,
    onInsertComposerSegments: (segments) => {
      sent.push(segments);
      return true;
    },
  });
  try {
    await view.render();
    const chunkA = view.chunk("src/a.ts");
    assert.ok(chunkA, "first file chunk renders through the diff viewer");
    assert.equal(view.pending(), null);

    // Add a comment on the added line.
    await view.click(chunkA.querySelector('[data-add="new:2"]'));
    await view.type("why 3?");
    await view.click(buttonByText(view.host, "projectTools.gitReview.lineComments.save"));
    assert.equal(chunkA.querySelector("[data-widget] textarea"), null, "editor closes on save");
    let card = chunkA.querySelector('[data-extend="new:2"]');
    assert.match(card.textContent, /Line 2/);
    assert.match(card.textContent, /why 3\?/);
    assert.match(view.pending().textContent, /1 pending comment/);

    // Comment the deleted line with Cmd+Enter; Escape cancels another editor.
    await view.click(chunkA.querySelector('[data-add="old:2"]'));
    const textarea = await view.type("keep the old value");
    await act(async () => {
      textarea.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }),
      );
    });
    assert.match(chunkA.querySelector('[data-extend="old:2"]').textContent, /Deleted line 2/);
    const chunkB = view.chunk("src/b.ts");
    await view.click(chunkB.querySelector('[data-add="new:1"]'));
    await act(async () => {
      chunkB
        .querySelector("[data-widget] textarea")
        .dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    assert.equal(chunkB.querySelector("[data-widget]"), null);
    assert.match(view.pending().textContent, /2 pending comments/);

    // Blank editor cannot be saved.
    await view.click(chunkB.querySelector('[data-add="new:2"]'));
    assert.equal(
      buttonByText(chunkB, "projectTools.gitReview.lineComments.save").disabled,
      true,
    );
    await view.type("rename y");
    await view.click(buttonByText(chunkB, "projectTools.gitReview.lineComments.save"));
    assert.match(view.pending().textContent, /3 pending comments/);

    // Edit the first comment in place.
    card = chunkA.querySelector('[data-extend="new:2"]');
    await view.click(card.querySelector('[aria-label="projectTools.gitReview.lineComments.edit"]'));
    const editTextarea = card.querySelector("textarea");
    assert.equal(editTextarea.value, "why 3?");
    await act(async () => setTextareaValue(editTextarea, "use a named constant"));
    await view.click(buttonByText(card, "projectTools.gitReview.lineComments.save"));
    assert.match(chunkA.querySelector('[data-extend="new:2"]').textContent, /use a named constant/);

    // Delete the deleted-line comment.
    await view.click(
      chunkA
        .querySelector('[data-extend="old:2"]')
        .querySelector('[aria-label="projectTools.gitReview.lineComments.delete"]'),
    );
    assert.equal(chunkA.querySelector('[data-extend="old:2"]'), null);
    assert.match(view.pending().textContent, /2 pending comments/);

    await view.click(buttonByText(view.pending(), "projectTools.gitReview.lineComments.send"));
    assert.equal(sent.length, 1);
    assert.equal(
      serializeSegments(sent[0]),
      [
        "Review comments on the diff:",
        "",
        "[a.ts:2](src/a.ts#L2) — use a named constant",
        "```diff",
        "+const b = 3;",
        "```",
        "",
        "[b.ts:2](src/b.ts#L2) — rename y",
        "```diff",
        "+export const y = 20;",
        "```",
      ].join("\n"),
    );
    assert.equal(view.pending(), null, "accepted comments are cleared");
    assert.equal(chunkA.querySelector("[data-extend]"), null);
  } finally {
    await view.cleanup();
  }
});

test("comments stay pending when the composer rejects them, and are pruned with their file", async () => {
  let accept = false;
  const view = renderDiffContent({
    title: "Working Tree",
    diff: { patch: `${PATCH_A}${PATCH_B}`, stat: "", baseRef: "HEAD", headRef: "WORKTREE" },
    showStat: false,
    onInsertComposerSegments: () => accept,
  });
  try {
    await view.render();
    await view.click(view.chunk("src/a.ts").querySelector('[data-add="new:2"]'));
    await view.type("first");
    await view.click(buttonByText(view.host, "projectTools.gitReview.lineComments.save"));
    await view.click(view.chunk("src/b.ts").querySelector('[data-add="new:2"]'));
    await view.type("second");
    await view.click(buttonByText(view.host, "projectTools.gitReview.lineComments.save"));

    await view.click(buttonByText(view.pending(), "projectTools.gitReview.lineComments.send"));
    assert.match(view.pending().textContent, /2 pending comments/);

    // Reloading keeps comments; switching to a diff without src/a.ts drops its comment.
    await view.render({ loading: true });
    assert.match(view.pending().textContent, /2 pending comments/);
    await view.render({
      loading: false,
      diff: { patch: PATCH_B, stat: "", baseRef: "HEAD", headRef: "WORKTREE" },
    });
    assert.match(view.pending().textContent, /1 pending comment/);

    await view.click(buttonByText(view.pending(), "projectTools.gitReview.lineComments.clear"));
    assert.equal(view.pending(), null);
    accept = true;
  } finally {
    await view.cleanup();
  }
});

test("line comments are off without a composer target", async () => {
  diffViewRenders.length = 0;
  const view = renderDiffContent({
    title: "Commit",
    diff: { patch: PATCH_A, stat: "", baseRef: "a", headRef: "b" },
    showStat: false,
  });
  try {
    await view.render();
    assert.ok(diffViewRenders.length > 0);
    for (const props of diffViewRenders) {
      assert.notEqual(props.diffViewAddWidget, true);
      assert.equal(props.renderWidgetLine, undefined);
      assert.equal(props.renderExtendLine, undefined);
    }
    assert.equal(view.host.querySelector("[data-add]"), null);
    assert.equal(view.pending(), null);
  } finally {
    await view.cleanup();
  }
});

test("composer appendSegments adds a separated block with chips and keeps the caret after it", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const reactRoot = createRoot(host);
  const composerRef = React.createRef();
  const props = {
    ref: composerRef,
    workdir: "",
    enabledSkills: [],
    conversations: [],
    mentionApps: [],
    onSend: () => {},
  };
  await act(async () => reactRoot.render(React.createElement(MentionComposer, props)));
  try {
    const composer = composerRef.current;
    await act(async () => composer.setText("Please address these"));
    const segments = lib.buildDiffLineCommentSegments([
      lib.upsertDiffLineComment([], input())[0],
    ]);
    let inserted;
    await act(async () => {
      inserted = composer.appendSegments(segments);
    });
    assert.equal(inserted, true);
    assert.equal(
      composer.getText(),
      "Please address these\n\n[a.ts:2](src/a.ts#L2) — why 3?\n```diff\n+const b = 3;\n```\n\n",
    );
    assert.deepEqual(composer.getDraft().codeMentions, [
      { path: "src/a.ts", startLine: 2, endLine: 2 },
    ]);
    const editor = host.querySelector('[contenteditable="true"]');
    assert.equal(document.activeElement, editor);
    assert.ok(editor.contains(window.getSelection().anchorNode));

    assert.equal(composer.appendSegments([]), false);
    await act(async () =>
      reactRoot.render(React.createElement(MentionComposer, { ...props, disabled: true })),
    );
    assert.equal(composerRef.current.appendSegments(segments), false);
  } finally {
    await act(async () => reactRoot.unmount());
    host.remove();
  }
});

test.after(() => env.cleanup());
