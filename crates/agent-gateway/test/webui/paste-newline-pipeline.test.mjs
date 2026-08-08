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

const reviewerSkill = {
  name: "reviewer",
  description: "Review changed code",
  skillFile: "reviewer/SKILL.md",
  baseDir: "reviewer",
};

function structuredClipboardSegments() {
  return [
    { type: "text", text: "Inspect " },
    {
      type: "fileMention",
      reference: { path: "src/App.tsx", kind: "file" },
    },
    {
      type: "fileMention",
      reference: { path: "docs/guides", kind: "dir" },
    },
    { type: "skillMention", skill: reviewerSkill },
    {
      type: "commitMention",
      commit: {
        sha: "abcdef1234567890",
        shortSha: "abcdef1",
        subject: "Preserve tags",
        body: "Full commit body",
        authorName: "Author",
        authorEmail: "author@example.com",
        authorDate: "2026-08-08T00:00:00Z",
        fileCount: 2,
        filesChanged: 2,
        insertions: 12,
        deletions: 3,
        stat: "2 files changed",
        remoteName: "origin",
        remoteUrl: "https://github.com/example/repo.git",
        githubUrl: "https://github.com/example/repo/commit/abcdef1234567890",
      },
    },
    {
      type: "gitFileMention",
      file: {
        path: "src/App.tsx",
        oldPath: "src/OldApp.tsx",
        status: "M",
        commitSha: "abcdef1234567890",
        shortSha: "abcdef1",
        refName: "main",
        remoteName: "origin",
        remoteUrl: "https://github.com/example/repo.git",
        githubUrl:
          "https://github.com/example/repo/blob/abcdef1234567890/src/App.tsx",
      },
    },
    {
      type: "codeMention",
      reference: { path: "src/App.tsx", startLine: 4, endLine: 9 },
    },
    {
      type: "largePaste",
      paste: {
        id: "large-paste-copy",
        label: "Pasted text 1",
        text: "large\nclipboard\nbody",
        charCount: 999,
        lineCount: 999,
        preview: "stale preview",
      },
    },
  ];
}

test("composer clipboard payload round trips every structured tag", () => {
  const payload = composer.serializeComposerClipboardPayload(structuredClipboardSegments());
  const restored = composer.parseComposerClipboardPayload(payload, [reviewerSkill]);

  assert.deepEqual(
    restored.map((segment) => segment.type),
    [
      "text",
      "fileMention",
      "fileMention",
      "skillMention",
      "commitMention",
      "gitFileMention",
      "codeMention",
      "largePaste",
    ],
  );
  assert.equal(restored[1].reference.path, "src/App.tsx");
  assert.equal(restored[2].reference.kind, "dir");
  assert.deepEqual(restored[3].skill, reviewerSkill);
  assert.equal(restored[4].commit.body, "Full commit body");
  assert.equal(
    restored[4].commit.githubUrl,
    "https://github.com/example/repo/commit/abcdef1234567890",
  );
  assert.equal(restored[5].file.oldPath, "src/OldApp.tsx");
  assert.equal(
    restored[5].file.githubUrl,
    "https://github.com/example/repo/blob/abcdef1234567890/src/App.tsx",
  );
  assert.deepEqual(restored[6].reference, {
    path: "src/App.tsx",
    startLine: 4,
    endLine: 9,
  });
  assert.equal(restored[7].paste.charCount, "large\nclipboard\nbody".length);
  assert.equal(restored[7].paste.lineCount, 3);
});

test("clipboard skill metadata cannot escape the currently enabled skill", () => {
  const payload = composer.serializeComposerClipboardPayload([
    {
      type: "skillMention",
      skill: { ...reviewerSkill, baseDir: "another-skill" },
    },
  ]);
  assert.deepEqual(composer.parseComposerClipboardPayload(payload, [reviewerSkill]), [
    { type: "text", text: "/reviewer" },
  ]);
});

test("clipboard github URLs that fail the plain-text channel validation are dropped", () => {
  const segments = structuredClipboardSegments();
  const commit = segments.find((segment) => segment.type === "commitMention").commit;
  const file = segments.find((segment) => segment.type === "gitFileMention").file;
  const hostileUrls = [
    "javascript:alert(1)",
    "liveagent://internal/action",
    "ftp://github.com/example/repo/commit/abcdef1234567890",
    "https://evil.example/example/repo/commit/abcdef1234567890",
    "https://github.com.evil.example/example/repo/commit/abcdef1234567890",
    "https://github.com/example/repo",
  ];
  for (const githubUrl of hostileUrls) {
    const payload = composer.serializeComposerClipboardPayload([
      { type: "commitMention", commit: { ...commit, githubUrl } },
      { type: "gitFileMention", file: { ...file, githubUrl } },
    ]);
    const restored = composer.parseComposerClipboardPayload(payload, []);
    assert.deepEqual(
      restored.map((segment) => segment.type),
      ["commitMention", "gitFileMention"],
      githubUrl,
    );
    assert.equal(restored[0].commit.githubUrl, undefined, githubUrl);
    assert.equal(restored[1].file.githubUrl, undefined, githubUrl);
  }
});

test("oversized text segments restored from the clipboard collapse into large-paste chips", () => {
  let counter = 0;
  const createLargePaste = (text) => ({
    id: `fresh-${++counter}`,
    label: `Pasted text ${counter}`,
    text,
    charCount: text.length,
    lineCount: text.split("\n").length,
    preview: text.slice(0, 160),
  });
  const overCharLimit = "x".repeat(8_000);
  const overLineLimit = "line\n".repeat(200);
  const rebuilt = composer.rebuildClipboardSegmentsForPaste(
    [
      { type: "text", text: "small" },
      { type: "text", text: overCharLimit },
      { type: "text", text: overLineLimit },
      {
        type: "largePaste",
        paste: {
          id: "stale-id",
          label: "Pasted text 9",
          text: "chunk",
          charCount: 5,
          lineCount: 1,
          preview: "chunk",
        },
      },
    ],
    createLargePaste,
  );
  assert.deepEqual(
    rebuilt.map((segment) => segment.type),
    ["text", "largePaste", "largePaste", "largePaste"],
  );
  assert.equal(rebuilt[1].paste.text, overCharLimit);
  assert.equal(rebuilt[2].paste.text, overLineLimit);
  assert.equal(rebuilt[3].paste.text, "chunk");
  assert.notEqual(rebuilt[3].paste.id, "stale-id");
});

test("serialized user bubble tokens restore composer tags as a plain-text fallback", () => {
  const text = [
    "Inspect",
    "[App.tsx](src/App.tsx)",
    "[guides](docs/guides/)",
    "/reviewer",
    "[commit abcdef1: Preserve tags](https://github.com/example/repo/commit/abcdef1234567890)",
    "[git file main: src/App.tsx](https://github.com/example/repo/blob/abcdef1234567890/src/App.tsx)",
    "[App.tsx:4-9](src/App.tsx#L4-L9)",
  ].join(" ");
  const restored = composer.parseSerializedComposerText(text, [reviewerSkill]);
  assert.deepEqual(
    restored.filter((segment) => segment.type !== "text").map((segment) => segment.type),
    [
      "fileMention",
      "fileMention",
      "skillMention",
      "commitMention",
      "gitFileMention",
      "codeMention",
    ],
  );
  assert.equal(composer.parseSerializedComposerText("[OpenAI](https://openai.com)", []), null);
});

test("outbound skill tokens use the same slash contract as composer and user bubbles", () => {
  const draft = draftFromSegments([{ type: "skillMention", skill: reviewerSkill }]);
  assert.equal(draftText.buildTextFromComposerDraft(draft), "/reviewer");
});
