import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const composer = loader.loadModule("src/components/chat/MentionComposer.tsx");
const composerText = loader.loadModule("src/lib/chat/composerText.ts");
const draftText = loader.loadModule("src/app/chatDraft.ts");
const uploadedFiles = loader.loadModule("src/lib/chat/uploadedFiles.ts");

const originalNode = globalThis.Node;
globalThis.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };

test.after(() => {
  if (originalNode === undefined) delete globalThis.Node;
  else globalThis.Node = originalNode;
});

function textNode(text) {
  return { nodeType: Node.TEXT_NODE, textContent: text };
}

function elementNode(tagName, childNodes = [], attributes = {}) {
  return {
    nodeType: Node.ELEMENT_NODE,
    tagName,
    childNodes,
    getAttribute(name) {
      return attributes[name] ?? null;
    },
    hasAttribute(name) {
      return Object.hasOwn(attributes, name);
    },
  };
}

function chromiumPasteDom(clipboardText) {
  const normalized = clipboardText.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const children = [];
  if (lines[0]) children.push(textNode(lines[0]));
  else if (lines.length > 1) children.push(elementNode("DIV", [elementNode("BR")]));
  for (const line of lines.slice(1)) {
    children.push(elementNode("DIV", line ? [textNode(line)] : [elementNode("BR")]));
  }
  return elementNode("DIV", children);
}

function draftFromSegments(segments) {
  const text = segments.map((segment) => segment.text ?? "").join("");
  return {
    segments,
    text,
    textWithoutLargePastes: text,
    largePastes: [],
    skillMentions: [],
    commitMentions: [],
    gitFileMentions: [],
    codeMentions: [],
    isEmpty: text.trim().length === 0,
  };
}

const cases = [
  ["LF no blank line", "alpha\nbeta"],
  ["LF one blank line", "alpha\n\nbeta"],
  ["CRLF one blank line", "alpha\r\n\r\nbeta"],
  ["CR one blank line", "alpha\r\rbeta"],
  ["multiple blank lines", "alpha\n\n\nbeta"],
  ["leading newline", "\nalpha"],
  ["trailing newline", "alpha\n"],
  ["Markdown paragraphs", "first paragraph\n\nsecond paragraph"],
  ["Markdown list", "- one\n- two"],
  ["Markdown quote", "> quote\n> continued"],
  ["Markdown code block", "```ts\nconst value = 1;\n```"],
  ["Markdown table", "| a | b |\n| - | - |\n| 1 | 2 |"],
  ["Unicode and emoji", "你好🙂\n\nκαλημέρα"],
  ["long text", `${"x".repeat(20_000)}\n\n${"y".repeat(20_000)}`],
];

test("clipboard DOM -> composer draft -> outbound -> history preserves logical newlines", () => {
  for (const [name, clipboardText] of cases) {
    const expected = clipboardText.replace(/\r\n?/g, "\n");
    const segments = composer.serializeChildrenToSegments(chromiumPasteDom(clipboardText), new Map());
    const draft = draftFromSegments(segments);
    const outbound = draftText.buildTextFromComposerDraft(draft);
    const message = uploadedFiles.createUserMessageWithUploads(outbound, [], 1);
    const history = JSON.parse(JSON.stringify(message));

    assert.equal(draft.text, expected, `${name}: composer draft`);
    assert.equal(outbound, expected, `${name}: outbound payload`);
    assert.equal(history.content, expected, `${name}: history/replay`);
    assert.equal(
      uploadedFiles.getUserMessageDisplayText(history),
      expected,
      `${name}: transcript user bubble text`,
    );
  }
});

test("pure whitespace remains structurally intact in the draft but is not sendable", () => {
  const clipboardText = " \r\n\r\n ";
  const expected = " \n\n ";
  const segments = composer.serializeChildrenToSegments(chromiumPasteDom(clipboardText), new Map());
  const draft = draftFromSegments(segments);
  assert.equal(draft.text, expected);
  assert.equal(draftText.buildTextFromComposerDraft(draft), expected);
  assert.equal(uploadedFiles.createUserMessageWithUploads(expected, [], 1), null);
});

test("message creation normalizes line endings without trimming logical edge newlines", () => {
  const input = "\r\nalpha\r\nbeta\r";
  const expected = "\nalpha\nbeta\n";
  const message = uploadedFiles.createUserMessageWithUploads(input, [], 1);
  assert.equal(message.content, expected);
  assert.equal(uploadedFiles.getUserMessageDisplayText(message), expected);
});

test("plaintext HTML escaping preserves literal content and logical newlines", () => {
  assert.equal(
    composerText.plainTextToContentEditableHtml("<tag>& value\r\nnext"),
    "&lt;tag&gt;&amp; value\nnext",
  );
});

test("composer serialization preserves newlines around mention chips", () => {
  const root = elementNode("DIV", [
    textNode("first\n"),
    elementNode("SPAN", [], {
      "data-mention-path": "src/App.tsx",
      "data-mention-kind": "file",
    }),
    textNode("\nsecond"),
  ]);
  const segments = composer.serializeChildrenToSegments(root, new Map());
  assert.deepEqual(
    segments.map((segment) =>
      segment.type === "text"
        ? { type: "text", text: segment.text }
        : { type: segment.type, path: segment.reference?.path },
    ),
    [
      { type: "text", text: "first\n" },
      { type: "fileMention", path: "src/App.tsx" },
      { type: "text", text: "\nsecond" },
    ],
  );
});
