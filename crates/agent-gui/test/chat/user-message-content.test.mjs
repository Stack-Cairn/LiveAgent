import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const userMessageContent = loader.loadModule("@liveagent/ui/lib/chat/userMessageContent.tsx");
const mentionReferences = loader.loadModule("@liveagent/ui/lib/chat/mentionReferences.ts");
const { createTextComposerDraft } = loader.loadModule("@liveagent/ui/lib/chat/composerDraft.ts");
const reactRenderLoader = createTsModuleLoader({
  mocks: {
    "react/jsx-runtime": jsxRuntime,
    "@tauri-apps/plugin-opener": {
      openUrl() {
        throw new Error("openUrl mock was not expected to be called");
      },
    },
    // ~icons mocks return plain objects that are not renderable React
    // elements; file-type icons must resolve to a real component here.
    "@liveagent/ui/components/chat/fileTypeIcons": {
      getFileTypeIcon() {
        return () => null;
      },
      getFileTypeIconSvg() {
        return '<svg viewBox="0 0 24 24"></svg>';
      },
    },
    "@liveagent/ui/components/IconSet": {
      MessageSquareText() {
        return null;
      },
      SkillIcon() {
        return null;
      },
    },
  },
});
const renderedUserMessageContent = reactRenderLoader.loadModule(
  "@liveagent/ui/lib/chat/userMessageContent.tsx",
);

function compactSegments(segments) {
  return segments.map((segment) => {
    if (segment.type === "mention") {
      return {
        type: "mention",
        path: segment.reference.path,
        kind: segment.reference.kind,
      };
    }
    if (segment.type === "text") {
      return { type: "text", value: segment.value };
    }
    return { type: segment.type };
  });
}

test("user message skill mentions style only skill-like tokens", () => {
  assert.equal(userMessageContent.isSkillMentionToken("/code-review"), true);
  assert.equal(userMessageContent.isSkillMentionToken("/release_notes"), true);
  assert.equal(userMessageContent.isSkillMentionToken("/PATH"), false);
  assert.equal(userMessageContent.isSkillMentionToken("price/tag"), false);
  assert.equal(userMessageContent.isSkillMentionToken("/bad.name"), false);
  // "$" is no longer a skill mention marker.
  assert.equal(userMessageContent.isSkillMentionToken("$code-review"), false);
  assert.equal(userMessageContent.isSkillMentionToken("$release_notes"), false);
});

test("slash skill mentions tokenize at word boundaries but leave paths alone", () => {
  assert.deepEqual(
    compactSegments(userMessageContent.tokenizeUserMessage("请用 /code-review 检查", [])),
    [
      { type: "text", value: "请用 " },
      { type: "skill" },
      { type: "text", value: " 检查" },
    ],
  );
  assert.deepEqual(
    compactSegments(userMessageContent.tokenizeUserMessage("查看 /usr/bin 目录", [])),
    [{ type: "text", value: "查看 /usr/bin 目录" }],
  );
});

test("file mention markdown references round trip through transcript tokenization", () => {
  const token = mentionReferences.formatFileMentionToken({
    path: "crates/agent-gui/src/components/AppUpdateButton.tsx",
    kind: "file",
  });

  assert.equal(
    token,
    "[AppUpdateButton.tsx](crates/agent-gui/src/components/AppUpdateButton.tsx)",
  );
  assert.deepEqual(compactSegments(userMessageContent.tokenizeUserMessage(`查看 ${token}`, [])), [
    { type: "text", value: "查看 " },
    {
      type: "mention",
      path: "crates/agent-gui/src/components/AppUpdateButton.tsx",
      kind: "file",
    },
  ]);
});

test("conversation mention references preserve the selected id and render as a chip", () => {
  const reference = {
    id: "conversation/previous-42",
    title: "修复登录流程",
  };
  const token = mentionReferences.formatConversationMentionToken(reference);

  assert.equal(
    token,
    "[conversation: 修复登录流程](conversation:conversation%2Fprevious-42)",
  );
  const segments = userMessageContent.tokenizeUserMessage(`继续 ${token}`, []);
  assert.deepEqual(compactSegments(segments), [
    { type: "text", value: "继续 " },
    { type: "conversation" },
  ]);
  assert.deepEqual(segments[1].reference, reference);

  const html = renderToStaticMarkup(
    jsxRuntime.jsx(renderedUserMessageContent.UserMessageContent, { text: token }),
  );
  assert.match(html, /修复登录流程/);
  assert.doesNotMatch(html, /conversation%2Fprevious-42/);
});

test("conversation reference normalization truncates Unicode scalars without splitting emoji", () => {
  const boundaryTitle = `${"a".repeat(239)}😀`;
  const boundary = mentionReferences.createConversationMentionReference({
    id: "conversation-boundary",
    title: boundaryTitle,
  });
  assert.equal(boundary.title, boundaryTitle);
  assert.equal([...boundary.title].length, 240);
  assert.equal(boundary.title.endsWith("😀"), true);

  const overLimit = mentionReferences.createConversationMentionReference({
    id: "conversation-long",
    title: "😀".repeat(241),
  });
  assert.equal([...overLimit.title].length, 240);
  assert.equal(overLimit.title, "😀".repeat(240));

  const unicodeWhitespace = mentionReferences.createConversationMentionReference({
    id: "conversation-whitespace",
    title: " Earlier\u0085investigation ",
  });
  assert.equal(unicodeWhitespace.title, "Earlier investigation");
  assert.equal(
    mentionReferences.createConversationMentionReference({
      id: "conversation\u0085invalid",
      title: "Invalid id",
    }),
    null,
  );
});

test("conversation-looking links without the canonical label stay plain text", () => {
  const text = "[not a conversation](conversation:previous-42)";
  assert.deepEqual(compactSegments(userMessageContent.tokenizeUserMessage(text, [])), [
    { type: "text", value: text },
  ]);
});

test("remote conversation mentions require a matching structured id", () => {
  const reference = {
    id: "conversation-source",
    title: "Earlier investigation",
    cwd: "/workspace/source",
  };
  const token = mentionReferences.formatConversationMentionToken(reference);

  const authorized = createTextComposerDraft(`compare ${token}`, [reference]);
  assert.deepEqual(authorized.conversationMentions, [reference]);
  assert.equal(authorized.segments[1].type, "conversationMention");

  const textOnly = createTextComposerDraft(`compare ${token}`);
  assert.deepEqual(textOnly.conversationMentions, []);
  assert.deepEqual(textOnly.segments, [{ type: "text", text: `compare ${token}` }]);

  const normalizedTitle = createTextComposerDraft(`compare ${token}`, [
    { ...reference, title: "Different title" },
  ]);
  assert.deepEqual(normalizedTitle.conversationMentions, [
    { ...reference, title: "Different title" },
  ]);
  assert.equal(normalizedTitle.segments[1].type, "conversationMention");

  const forgedId = createTextComposerDraft(
    "compare [conversation: Forged](conversation:conversation-forged)",
    [reference],
  );
  assert.deepEqual(forgedId.conversationMentions, []);
});

test("directory mention markdown references preserve trailing slash display semantics", () => {
  const token = mentionReferences.formatFileMentionToken({
    path: "docs/my folder",
    kind: "dir",
  });

  assert.equal(token, "[my folder](<docs/my folder/>)");
  assert.deepEqual(compactSegments(userMessageContent.tokenizeUserMessage(token, [])), [
    {
      type: "mention",
      path: "docs/my folder",
      kind: "dir",
    },
  ]);
});

test("directory mention markdown references require slashless labels", () => {
  assert.deepEqual(
    compactSegments(userMessageContent.tokenizeUserMessage("[my folder/](<docs/my folder/>)", [])),
    [{ type: "text", value: "[my folder/](<docs/my folder/>)" }],
  );
});

test("inline file mention tokens remain plain text", () => {
  assert.deepEqual(
    compactSegments(userMessageContent.tokenizeUserMessage("打开 @src/main.tsx 和 @docs/", [])),
    [{ type: "text", value: "打开 @src/main.tsx 和 @docs/" }],
  );
});

test("rendered commit mentions do not include native title tooltips", () => {
  const html = renderToStaticMarkup(
    jsxRuntime.jsx(renderedUserMessageContent.UserMessageContent, {
      text: "看看 [commit 0e1a4fc: init](https://github.com/example/repo/commit/0e1a4fc1234567890)",
    }),
  );

  assert.match(html, /0e1a4fc/);
  assert.doesNotMatch(html, /title=/);
});

test("trailing newlines render a visual line anchor without changing DOM text", () => {
  const html = renderToStaticMarkup(
    jsxRuntime.jsx(renderedUserMessageContent.UserMessageContent, {
      text: "alpha\n",
    }),
  );
  assert.equal(
    html,
    'alpha\n<span aria-hidden="true" class="chat-user-trailing-newline-anchor"></span>',
  );
  assert.doesNotMatch(html, /\u200b/i);
});

test("code mention tokens round trip through transcript tokenization", () => {
  const reference = mentionReferences.createCodeMentionReference({
    path: "src/pages/ChatPage.tsx",
    startLine: 12,
    endLine: 20,
  });
  const token = mentionReferences.formatCodeMentionToken(reference);

  assert.equal(token, "[ChatPage.tsx:12-20](src/pages/ChatPage.tsx#L12-L20)");

  const segments = userMessageContent.tokenizeUserMessage(`帮我解释 ${token} 这段逻辑`, []);
  assert.deepEqual(compactSegments(segments), [
    { type: "text", value: "帮我解释 " },
    { type: "codeRef" },
    { type: "text", value: " 这段逻辑" },
  ]);
  const codeSegment = segments.find((segment) => segment.type === "codeRef");
  assert.deepEqual(codeSegment.reference, reference);
});

test("single-line code mention tokens collapse the range", () => {
  const reference = mentionReferences.createCodeMentionReference({
    path: "docs/my file.md",
    startLine: 7,
    endLine: 7,
  });
  const token = mentionReferences.formatCodeMentionToken(reference);

  assert.equal(token, "[my file.md:7](<docs/my file.md#L7>)");

  const segments = userMessageContent.tokenizeUserMessage(token, []);
  assert.deepEqual(compactSegments(segments), [{ type: "codeRef" }]);
  assert.deepEqual(segments[0].reference, reference);
});

test("code mention labels must match the destination to become chips", () => {
  assert.deepEqual(
    compactSegments(
      userMessageContent.tokenizeUserMessage(
        "[other.tsx:12-20](src/pages/ChatPage.tsx#L12-L20)",
        [],
      ),
    ),
    [{ type: "text", value: "[other.tsx:12-20](src/pages/ChatPage.tsx#L12-L20)" }],
  );
});

test("code mention line labels collapse single-line ranges", () => {
  assert.equal(mentionReferences.codeMentionLineLabel({ startLine: 7, endLine: 7 }), "7");
  assert.equal(mentionReferences.codeMentionLineLabel({ startLine: 7, endLine: 9 }), "7～9");
});

test("plain fenced code blocks without the line header stay text", () => {
  assert.deepEqual(
    compactSegments(userMessageContent.tokenizeUserMessage("```js\nconst x = 1;\n```", [])),
    [{ type: "text", value: "```js\nconst x = 1;\n```" }],
  );
});

test("rendered code mentions show 文件名：行区间 tags without the referenced content", () => {
  const reference = mentionReferences.createCodeMentionReference({
    path: "crates/agent-gui/src/pages/ChatPage.tsx",
    startLine: 100,
    endLine: 128,
  });
  const html = renderToStaticMarkup(
    jsxRuntime.jsx(renderedUserMessageContent.UserMessageContent, {
      text: mentionReferences.formatCodeMentionToken(reference),
    }),
  );

  assert.match(html, /ChatPage\.tsx：100～128/);
  assert.doesNotMatch(html, /#L100/);
});
