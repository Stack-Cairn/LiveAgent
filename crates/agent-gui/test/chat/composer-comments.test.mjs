import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const locale = { locale: "en-US", t: (key) => key };
const NullIcon = () => null;
const iconSet = new Proxy({}, { get: (_target, key) => (key === "__esModule" ? false : NullIcon) });
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/i18n/index": { useLocale: () => locale, t: (key) => key },
    "@liveagent/ui/components/IconSet": iconSet,
  },
});
const { React, act, createRoot } = env;
window.Range.prototype.getClientRects = () => [];
window.Range.prototype.getBoundingClientRect = () => new window.DOMRect(100, 100, 120, 18);

const comments = env.loadModule("@liveagent/ui/lib/chat/composerComments.ts");
const { buildTextFromComposerDraft } = env.loadModule("@liveagent/ui/lib/chat/composerDraft.ts");
const { TranscriptQuoteSelection, transcriptSelectionToComment } = env.loadModule(
  "@liveagent/ui/components/chat/TranscriptQuoteSelection.tsx",
);
const { MentionComposer } = env.loadModule("@liveagent/ui/components/chat/MentionComposer.tsx");
const { TranscriptCommentProvider } = env.loadModule(
  "@liveagent/ui/components/chat/TranscriptCommentContext.tsx",
);
const { EditDiffView, buildEditDiffLineComment } = env.loadModule(
  "@liveagent/ui/components/chat/EditDiffView.tsx",
);

const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 30));

function typeInto(field, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function pressEnter(target, init = {}) {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }),
  );
}

function selectText(startNode, startOffset, endNode, endOffset) {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

const ASSISTANT = { kind: "assistant" };

test("comments block: numbered entries with the snippet and where it came from", () => {
  const list = [
    comments.createComposerComment({
      id: "c1",
      quote: "Use a debounce of 300ms\nfor the search box.",
      comment: "Why 300 and not 150?",
      source: ASSISTANT,
    }),
    comments.createComposerComment({
      id: "c2",
      quote: "const delay = 300;",
      code: true,
      comment: "Make this configurable",
      source: { kind: "assistant", language: "ts" },
    }),
    comments.createComposerComment({
      id: "c3",
      quote: "-retry(3)",
      code: true,
      comment: "Keep the retry",
      source: {
        kind: "diff",
        path: "src/net/client.ts",
        startLine: 42,
        side: "old",
        language: "diff",
      },
    }),
    comments.createComposerComment({
      id: "c4",
      quote: "",
      comment: "1: Button is misaligned\n2: Wrong colour",
      source: { kind: "image", path: "screen-annotated.png" },
    }),
  ];
  assert.ok(list.every(Boolean));
  assert.equal(
    comments.appendComposerCommentsBlock("Please address these.  \n", list),
    [
      "Please address these.",
      "",
      "Comments on specific content:",
      "",
      "1. On the assistant's reply:",
      "> Use a debounce of 300ms",
      "> for the search box.",
      "",
      "Comment: Why 300 and not 150?",
      "",
      "2. On the assistant's reply:",
      "```ts",
      "const delay = 300;",
      "```",
      "",
      "Comment: Make this configurable",
      "",
      "3. On the diff of `src/net/client.ts:42`, removed lines:",
      "```diff",
      "-retry(3)",
      "```",
      "",
      "Comment: Keep the retry",
      "",
      "4. On the attached image `screen-annotated.png` (numbered markers):",
      "1: Button is misaligned",
      "2: Wrong colour",
    ].join("\n"),
  );
  // Only comments: the block is the whole message.
  assert.match(comments.appendComposerCommentsBlock("", list.slice(0, 1)), /^Comments on/);
  assert.equal(comments.appendComposerCommentsBlock("text", []), "text");
  // Code containing a fence gets a longer one.
  const fenced = comments.formatComposerCommentsBlock([
    comments.createComposerComment({
      quote: "```js\nx\n```",
      code: true,
      comment: "nested",
      source: ASSISTANT,
    }),
  ]);
  assert.match(fenced, /\n````\n```js\nx\n```\n````\n/);
});

test("comments: validation, ordering, in-place edit and removal", () => {
  assert.equal(comments.createComposerComment({ quote: "x", comment: "  ", source: ASSISTANT }), null);
  assert.equal(comments.createComposerComment({ quote: " ", comment: "c", source: ASSISTANT }), null);
  assert.equal(
    comments.createComposerComment({ quote: "x", comment: "c", source: { kind: "diff" } }),
    null,
    "diff comments need a path",
  );
  let list = [];
  for (const id of ["a", "b", "c"]) {
    list = comments.upsertComposerComment(list, { id, quote: id, comment: `on ${id}`, source: ASSISTANT });
  }
  assert.deepEqual(list.map((entry) => entry.id), ["a", "b", "c"]);
  list = comments.upsertComposerComment(list, { id: "b", quote: "b", comment: "edited", source: ASSISTANT });
  assert.deepEqual(list.map((entry) => [entry.id, entry.comment]), [
    ["a", "on a"],
    ["b", "edited"],
    ["c", "on c"],
  ]);
  list = comments.removeComposerComment(list, "a");
  assert.deepEqual(list.map((entry) => entry.id), ["b", "c"]);
  assert.equal(comments.removeComposerComment(list, "zzz"), list);
  const block = comments.formatComposerCommentsBlock(list);
  assert.match(block, /^Comments on specific content:\n\n1\. On the assistant's reply:\n> b\n\nComment: edited/);
  assert.match(block, /\n\n2\. On the assistant's reply:\n> c\n\nComment: on c$/);

  let full = [];
  for (let index = 0; index < comments.COMPOSER_COMMENT_MAX_COUNT + 5; index += 1) {
    full = comments.upsertComposerComment(
      full,
      comments.createComposerComment({ quote: `q${index}`, comment: "c", source: ASSISTANT }),
    );
  }
  assert.equal(full.length, comments.COMPOSER_COMMENT_MAX_COUNT);
});

test("selection payload carries the code block language", () => {
  assert.deepEqual(
    transcriptSelectionToComment({ text: "let a = 1;", source: "assistant", code: { language: "rust" } }, "Why?"),
    { quote: "let a = 1;", comment: "Why?", code: true, source: { kind: "assistant", language: "rust" } },
  );
  assert.deepEqual(transcriptSelectionToComment({ text: "hello", source: "user" }, "c"), {
    quote: "hello",
    comment: "c",
    source: { kind: "user" },
  });
});

test("rendered markdown code blocks report their language", () => {
  const { resolveTranscriptQuoteSelection } = env.loadModule("@liveagent/ui/lib/chat/transcriptQuote.ts");
  const root = document.createElement("div");
  // Shape of the rendered markdown code block: the language sits on the
  // wrapper and the <pre> class, not on <code>.
  root.innerHTML = `
    <div data-quote-source="assistant">
      <div data-streamdown="code-block" data-language="ts">
        <div data-streamdown="code-block-body" data-language="ts" class="language-ts">
          <pre class="language-ts"><code><span class="line" id="line">const SEARCH_DEBOUNCE_MS = 300;</span></code></pre>
        </div>
      </div>
    </div>`;
  document.body.append(root);
  try {
    const line = root.querySelector("#line").firstChild;
    selectText(line, 0, line, 31);
    const resolved = resolveTranscriptQuoteSelection(root, window.getSelection());
    assert.equal(resolved.text, "const SEARCH_DEBOUNCE_MS = 300;");
    assert.deepEqual(resolved.code, { language: "ts" });
  } finally {
    window.getSelection().removeAllRanges();
    root.remove();
  }
});

function mountTranscriptAndComposer() {
  const transcript = document.createElement("div");
  transcript.innerHTML = `
    <div data-quote-source="assistant" id="assistant">
      <p id="p1">Use a debounce of 300ms for the search box.</p>
      <pre><code class="language-ts" id="code">const delay = 300;</code></pre>
    </div>`;
  document.body.append(transcript);
  const host = document.createElement("div");
  document.body.append(host);
  const reactRoot = createRoot(host);
  const composerRef = React.createRef();
  const sent = [];
  const rootRef = { current: transcript };
  const render = (composerProps = {}) =>
    act(async () =>
      reactRoot.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(TranscriptQuoteSelection, {
            rootRef,
            scopeKey: "conversation-1",
            onQuote: () => {},
            onComment: (comment) => composerRef.current?.upsertComment(comment) != null,
          }),
          React.createElement(MentionComposer, {
            ref: composerRef,
            workdir: "",
            enabledSkills: [],
            conversations: [],
            mentionApps: [],
            onSend: () => sent.push(buildTextFromComposerDraft(composerRef.current.getDraft())),
            ...composerProps,
          }),
        ),
      ),
    );
  return {
    transcript,
    host,
    composerRef,
    sent,
    render,
    chips: () => [...host.querySelectorAll("[data-composer-comment-chip]")],
    async commentOn(startNode, startOffset, endNode, endOffset, text) {
      selectText(startNode, startOffset, endNode, endOffset);
      await act(async () => {
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        await nextFrame();
      });
      const button = document.querySelector("[data-transcript-comment-button]");
      assert.ok(button, "comment action sits next to quote");
      assert.ok(document.querySelector("[data-transcript-quote-button]"));
      await act(async () => button.click());
      await act(async () => nextFrame());
      const popover = document.querySelector("[data-transcript-comment-popover]");
      assert.ok(popover, "comment popover opens on the selection");
      const field = popover.querySelector("textarea");
      assert.equal(document.activeElement, field);
      await act(async () => typeInto(field, text));
      await act(async () => pressEnter(field));
      await act(async () => nextFrame());
    },
    async cleanup() {
      window.getSelection().removeAllRanges();
      await act(async () => reactRoot.unmount());
      host.remove();
      transcript.remove();
    },
  };
}

test("selection → comment popover → composer chip → sent message", async () => {
  const view = mountTranscriptAndComposer();
  await view.render();
  try {
    const p1 = document.getElementById("p1").firstChild;
    const code = document.getElementById("code").firstChild;
    await view.commentOn(p1, 0, p1, 23, "Why 300?");
    assert.equal(document.querySelector("[data-transcript-comment-popover]"), null);
    assert.equal(view.chips().length, 1);
    await view.commentOn(code, 0, code, 18, "Make it configurable");
    await view.commentOn(p1, 27, p1, 43, "Only this one?");
    assert.equal(view.chips().length, 3);
    const chipText = view.chips().map((chip) => chip.textContent);
    assert.match(chipText[0], /^1.*chat\.comment\.source\.assistant.*Why 300\?/);
    assert.match(chipText[1], /^2.*chat\.comment\.source\.codeBlock.*Make it configurable/);

    const composer = view.composerRef.current;
    assert.equal(composer.getDraft().isEmpty, false, "comments alone make a sendable draft");
    await act(async () => composer.setText("Please revise."));

    // Edit the second chip in place.
    await act(async () => view.chips()[1].querySelector("[data-composer-comment-edit]").click());
    await act(async () => nextFrame());
    const editField = document.querySelector("[data-composer-comment-editor] textarea");
    assert.equal(editField.value, "Make it configurable");
    await act(async () => typeInto(editField, "Read it from settings"));
    await act(async () => pressEnter(editField));
    await act(async () => nextFrame());

    // Remove the first chip; numbering follows the remaining order.
    await act(async () => view.chips()[0].querySelector("[data-composer-comment-remove]").click());
    assert.equal(view.chips().length, 2);

    const expected = [
      "Please revise.",
      "",
      "Comments on specific content:",
      "",
      "1. On the assistant's reply:",
      "```ts",
      "const delay = 300;",
      "```",
      "",
      "Comment: Read it from settings",
      "",
      "2. On the assistant's reply:",
      // The selection's leading space is trimmed.
      "> the search box.",
      "",
      "Comment: Only this one?",
    ].join("\n");
    assert.equal(composer.getText(), "Please revise.", "editor text stays free of the block");
    assert.equal(composer.getDraft().text, expected);
    assert.equal(buildTextFromComposerDraft(composer.getDraft()), expected);

    // Drafts persist comments across conversation switches.
    const draft = JSON.parse(JSON.stringify(composer.getDraft()));
    assert.equal(draft.comments.length, 2);
    await act(async () => composer.clear());
    assert.equal(view.chips().length, 0);
    assert.equal(composer.getDraft().isEmpty, true);
    await act(async () => composer.setDraft(draft));
    assert.equal(view.chips().length, 2);

    const editor = view.host.querySelector('[contenteditable="true"]');
    await act(async () => pressEnter(editor));
    assert.deepEqual(view.sent, [expected]);
  } finally {
    await view.cleanup();
  }
});

test("a disabled composer rejects comments and the popover stays open", async () => {
  const view = mountTranscriptAndComposer();
  await view.render({ disabled: true });
  try {
    const p1 = document.getElementById("p1").firstChild;
    await view.commentOn(p1, 0, p1, 10, "blocked");
    assert.equal(view.chips().length, 0);
    assert.ok(document.querySelector("[data-transcript-comment-popover]"));
    const cancel = [...document.querySelectorAll("[data-composer-comment-editor] button")].find(
      (button) => button.textContent === "chat.comment.cancel",
    );
    await act(async () => cancel.click());
    await act(async () => nextFrame());
    assert.equal(document.querySelector("[data-transcript-comment-popover]"), null);
  } finally {
    await view.cleanup();
  }
});

test("edit diff gutter: comment on an added or removed line", async () => {
  const received = [];
  const host = document.createElement("div");
  document.body.append(host);
  const reactRoot = createRoot(host);
  const renderDiff = (onComment) =>
    act(async () =>
      reactRoot.render(
        React.createElement(
          TranscriptCommentProvider,
          { onComment },
          React.createElement(EditDiffView, {
            beforeText: "",
            afterText: "",
            filePath: "src/net/client.ts",
            diffText: "41   const client = create();\n42 - retry(3)\n42 + retry(5)",
          }),
        ),
      ),
    );
  try {
    await renderDiff((comment) => {
      received.push(comment);
      return true;
    });
    const gutters = [...host.querySelectorAll("[data-diff-comment-line]")];
    assert.equal(gutters.length, 3);
    // Roving tab stop: one gutter button in the tab order.
    assert.deepEqual(
      gutters.map((button) => button.tabIndex),
      [0, -1, -1],
    );
    assert.equal(gutters[1].getAttribute("aria-label"), "chat.comment.diffLineRemoved");

    // Arrow keys move between gutter buttons.
    gutters[0].focus();
    await act(async () =>
      gutters[0].dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      ),
    );
    assert.equal(document.activeElement, gutters[1]);

    await act(async () => gutters[1].click());
    await act(async () => nextFrame());
    const popover = document.querySelector("[data-diff-comment-popover]");
    assert.ok(popover);
    const field = popover.querySelector("textarea");
    await act(async () => typeInto(field, "Keep three retries"));
    await act(async () => pressEnter(field));
    await act(async () => nextFrame());
    assert.equal(document.querySelector("[data-diff-comment-popover]"), null);
    assert.deepEqual(received, [
      {
        quote: "-retry(3)",
        code: true,
        comment: "Keep three retries",
        source: {
          kind: "diff",
          path: "src/net/client.ts",
          startLine: 42,
          endLine: 42,
          side: "old",
          language: "diff",
        },
      },
    ]);
    assert.equal(
      comments.formatComposerCommentsBlock([comments.createComposerComment(received[0])]),
      [
        "Comments on specific content:",
        "",
        "1. On the diff of `src/net/client.ts:42`, removed lines:",
        "```diff",
        "-retry(3)",
        "```",
        "",
        "Comment: Keep three retries",
      ].join("\n"),
    );
    assert.equal(
      buildEditDiffLineComment("a.ts", { type: "add", lineNumber: 7, pieces: [{ text: "x" }] }, "c")
        .source.side,
      "new",
    );

    // Without a comment host (read-only transcript) the gutter stays plain.
    await renderDiff(null);
    assert.equal(host.querySelectorAll("[data-diff-comment-line]").length, 0);
  } finally {
    await act(async () => reactRoot.unmount());
    host.remove();
  }
});

test.after(() => env.cleanup());
