import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const locale = { locale: "en-US", t: (key) => key };
const NullIcon = () => null;
// Every IconSet export renders nothing; the loader's default "~icons/*" mock
// returns plain objects that real react-dom refuses to render.
const iconSet = new Proxy({}, { get: (_target, key) => (key === "__esModule" ? false : NullIcon) });
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/i18n/index": { useLocale: () => locale },
    "@liveagent/ui/components/IconSet": iconSet,
  },
});
const { React, act, createRoot } = env;
window.Range.prototype.getClientRects = () => [];
window.Range.prototype.getBoundingClientRect = () => new window.DOMRect();
const { buildTextFromComposerDraft } = env.loadModule("@liveagent/ui/lib/chat/composerDraft.ts");
const quote = env.loadModule("@liveagent/ui/lib/chat/transcriptQuote.ts");
const { TranscriptQuoteSelection } = env.loadModule(
  "@liveagent/ui/components/chat/TranscriptQuoteSelection.tsx",
);
const { MentionComposer } = env.loadModule("@liveagent/ui/components/chat/MentionComposer.tsx");

const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 30));

function buildTranscript() {
  const root = document.createElement("div");
  root.innerHTML = `
    <div data-row="user">
      <span data-quote-source="user" id="user">Please refactor the parser</span>
      <button id="copy">Copy</button>
    </div>
    <div data-row="assistant">
      <div data-quote-source="assistant" id="assistant">
        <p id="p1">First paragraph of the reply.</p>
        <p id="p2">Second paragraph.</p>
        <div class="monaco-editor"><span id="editor">let x = 1;</span></div>
      </div>
      <div data-assistant-operation=""><span id="tool">Bash ls</span></div>
    </div>`;
  document.body.append(root);
  return root;
}

function selectText(startNode, startOffset, endNode, endOffset) {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

function textOf(id) {
  return document.getElementById(id).firstChild;
}

test("blockquote formatting preserves long selections and internal line breaks", () => {
  assert.equal(quote.formatMarkdownBlockquote("one  \r\ntwo"), "> one  \n> two");
  assert.equal(quote.formatMarkdownBlockquote("\n\na\n\n\n\nb\n\n"), "> a\n>\n>\n>\n> b");
  assert.equal(quote.formatMarkdownBlockquote("   \n  "), "");
  const long = "x".repeat(8_050) + " end";
  assert.equal(quote.formatMarkdownBlockquote(long), "> " + long);
});

test("composer insertion separates the quote from existing draft text", () => {
  assert.equal(quote.buildComposerQuoteInsertion("", "hi"), "> hi\n\n");
  assert.equal(quote.buildComposerQuoteInsertion("draft", "hi"), "\n\n> hi\n\n");
  assert.equal(quote.buildComposerQuoteInsertion("draft\n", "hi"), "\n> hi\n\n");
  assert.equal(quote.buildComposerQuoteInsertion("draft\n\n", "hi"), "> hi\n\n");
  assert.equal(quote.buildComposerQuoteInsertion("draft", "  "), "");
});

test("button placement prefers above the selection, flips below and clamps to the viewport", () => {
  const button = { width: 80, height: 28 };
  const viewport = { width: 1000, height: 800 };
  const rect = (left, top, width, height) => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  });
  assert.deepEqual(quote.resolveQuoteButtonPosition(rect(400, 300, 200, 20), button, viewport), {
    left: 460,
    top: 264,
  });
  assert.deepEqual(quote.resolveQuoteButtonPosition(rect(400, 10, 200, 20), button, viewport), {
    left: 460,
    top: 38,
  });
  assert.equal(quote.resolveQuoteButtonPosition(rect(0, 300, 10, 20), button, viewport).left, 8);
  assert.equal(
    quote.resolveQuoteButtonPosition(rect(990, 300, 10, 20), button, viewport).left,
    1000 - 80 - 8,
  );
});

test("only selections inside a single quote source of the transcript are quotable", () => {
  const root = buildTranscript();
  const outside = document.createElement("p");
  outside.textContent = "outside the transcript";
  document.body.append(outside);
  try {
    let selection = selectText(textOf("user"), 7, textOf("user"), 15);
    let result = quote.resolveTranscriptQuoteSelection(root, selection);
    assert.equal(result?.text, "refactor");
    assert.equal(result?.source, "user");

    selection = selectText(textOf("p1"), 0, textOf("p2"), 6);
    result = quote.resolveTranscriptQuoteSelection(root, selection);
    assert.equal(result?.source, "assistant");
    assert.match(result?.text ?? "", /^First paragraph of the reply\.\s*Second$/);

    // Spans two messages.
    selection = selectText(textOf("user"), 0, textOf("p1"), 5);
    assert.equal(quote.resolveTranscriptQuoteSelection(root, selection), null);
    // Inside a code editor / tool trace / control.
    selection = selectText(textOf("editor"), 0, textOf("editor"), 3);
    assert.equal(quote.resolveTranscriptQuoteSelection(root, selection), null);
    selection = selectText(textOf("tool"), 0, textOf("tool"), 4);
    assert.equal(quote.resolveTranscriptQuoteSelection(root, selection), null);
    selection = selectText(textOf("copy"), 0, textOf("copy"), 4);
    assert.equal(quote.resolveTranscriptQuoteSelection(root, selection), null);
    // Leaves the transcript.
    selection = selectText(textOf("p2"), 0, outside.firstChild, 7);
    assert.equal(quote.resolveTranscriptQuoteSelection(root, selection), null);
    // Collapsed.
    selection = selectText(textOf("p2"), 2, textOf("p2"), 2);
    assert.equal(quote.resolveTranscriptQuoteSelection(root, selection), null);
  } finally {
    window.getSelection().removeAllRanges();
    root.remove();
    outside.remove();
  }
});

function mountQuoteButton(onQuote) {
  const transcript = buildTranscript();
  const host = document.createElement("div");
  document.body.append(host);
  const reactRoot = createRoot(host);
  const rootRef = { current: transcript };
  const render = (props = {}) =>
    act(() =>
      reactRoot.render(
        React.createElement(TranscriptQuoteSelection, {
          rootRef,
          scopeKey: "conversation-1",
          onQuote,
          ...props,
        }),
      ),
    );
  render();
  return {
    transcript,
    render,
    button: () => document.querySelector("[data-transcript-quote-button]"),
    async selectAndRelease(...args) {
      selectText(...args);
      await act(async () => {
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        await nextFrame();
      });
    },
    cleanup() {
      window.getSelection().removeAllRanges();
      act(() => reactRoot.unmount());
      host.remove();
      transcript.remove();
    },
  };
}

test("floating quote button appears for a message selection and quotes it on click", async () => {
  const quoted = [];
  const view = mountQuoteButton((text) => quoted.push(text));
  try {
    assert.equal(view.button(), null);
    await view.selectAndRelease(textOf("p1"), 0, textOf("p1"), 15);
    const button = view.button();
    assert.ok(button, "quote button should render");
    assert.equal(button.textContent, "chat.quoteSelection");
    assert.equal(button.getAttribute("aria-label"), "chat.quoteSelectionHint");

    // Mouse down on the button must not collapse the selection.
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    button.dispatchEvent(down);
    assert.equal(down.defaultPrevented, true);

    await act(async () => button.click());
    assert.deepEqual(quoted, ["First paragraph"]);
    assert.equal(window.getSelection().isCollapsed, true);
    assert.equal(view.button(), null);
  } finally {
    view.cleanup();
  }
});

test("quote button hides on scroll, click-away, Escape and scope change", async () => {
  const view = mountQuoteButton(() => {});
  try {
    const select = () => view.selectAndRelease(textOf("user"), 0, textOf("user"), 6);

    await select();
    assert.ok(view.button());
    await act(async () => view.transcript.dispatchEvent(new Event("scroll")));
    assert.equal(view.button(), null);

    await select();
    assert.ok(view.button());
    await act(async () =>
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })),
    );
    assert.equal(view.button(), null);

    await select();
    assert.ok(view.button());
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true })),
    );
    assert.equal(view.button(), null);

    await select();
    assert.ok(view.button());
    view.render({ scopeKey: "conversation-2" });
    assert.equal(view.button(), null);
  } finally {
    view.cleanup();
  }
});

test("no quote button for selections in code editors, tool traces or disabled hosts", async () => {
  const view = mountQuoteButton(() => {});
  try {
    await view.selectAndRelease(textOf("editor"), 0, textOf("editor"), 3);
    assert.equal(view.button(), null);
    await view.selectAndRelease(textOf("tool"), 0, textOf("tool"), 4);
    assert.equal(view.button(), null);
    await view.selectAndRelease(textOf("user"), 0, textOf("p1"), 4);
    assert.equal(view.button(), null);
    view.render({ enabled: false });
    await view.selectAndRelease(textOf("user"), 0, textOf("user"), 6);
    assert.equal(view.button(), null);
  } finally {
    view.cleanup();
  }
});

test("composer shows a quote chip and retains the full selection in its draft", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const reactRoot = createRoot(host);
  const composerRef = React.createRef();
  const sent = [];
  const props = {
    ref: composerRef,
    workdir: "",
    enabledSkills: [],
    conversations: [],
    mentionApps: [],
    onSend: () => sent.push(buildTextFromComposerDraft(composerRef.current.getDraft())),
  };
  await act(async () => reactRoot.render(React.createElement(MentionComposer, props)));
  try {
    const composer = composerRef.current;
    const editor = host.querySelector('[contenteditable="true"]');
    const long = "First line " + "content ".repeat(1_100) + "end of first line\n\nSecond line";
    await act(async () => composer.setText("Why is this?"));
    await act(async () => {
      assert.equal(composer.insertQuote(long), true);
      assert.equal(composer.insertQuote("Short quote"), true);
    });
    const chips = () => [...editor.querySelectorAll("[data-quote-text]")];
    assert.deepEqual(chips().map((chip) => chip.getAttribute("data-quote-text")), [long, "Short quote"]);
    assert.ok(chips()[0].querySelector(".truncate"));
    assert.match(chips()[0].textContent, /^First line/);
    assert.equal(chips()[1].textContent, "Short quote");
    assert.equal(document.activeElement, editor);
    assert.equal(window.getSelection().anchorNode.previousSibling, chips()[1]);

    // Insert text at the caret that insertQuote parked just after the last chip.
    await act(async () => {
      const { anchorNode, anchorOffset } = window.getSelection();
      anchorNode.insertData(anchorOffset, "Please explain.");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const expected =
      "Why is this?\n\n" + quote.formatMarkdownBlockquote(long) + "\n\n> Short quote\n\nPlease explain.";
    assert.equal(composer.getText(), expected);
    const draft = JSON.parse(JSON.stringify(composer.getDraft()));
    assert.equal(draft.text, expected);
    assert.equal(draft.textWithoutLargePastes, expected);
    assert.equal(draft.isEmpty, false);
    await act(async () => {
      composer.setText("Other conversation");
      composer.setDraft(draft);
    });
    assert.equal(chips().length, 2);
    assert.equal(composer.getDraft().text, expected);
    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    assert.deepEqual(sent, [expected]);

    await act(async () => {
      composer.clear();
      assert.equal(composer.insertQuote("solo"), true);
      assert.equal(composer.insertQuote("   "), false);
    });
    assert.equal(composer.getText(), "> solo\n\n");
    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
    });
    assert.equal(chips().length, 0);
    assert.equal(composer.getText(), "");
    assert.equal(composer.getDraft().isEmpty, true);

    await act(async () =>
      reactRoot.render(React.createElement(MentionComposer, { ...props, disabled: true })),
    );
    assert.equal(composerRef.current.insertQuote("blocked"), false);
  } finally {
    await act(async () => reactRoot.unmount());
    host.remove();
  }
});

test.after(() => env.cleanup());
