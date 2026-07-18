import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const userMessageContent = loader.loadModule("src/lib/chat/messages/userMessageContent.tsx");
const mentionReferences = loader.loadModule("src/lib/chat/messages/mentionReferences.ts");
const fileTypeIconsPath = path.resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
  "src/components/chat/fileTypeIcons.tsx",
);
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
    [fileTypeIconsPath]: {
      getFileTypeIcon() {
        return () => null;
      },
      getFileTypeIconSvg() {
        return '<svg viewBox="0 0 24 24"></svg>';
      },
    },
  },
});
const renderedUserMessageContent = reactRenderLoader.loadModule(
  "src/lib/chat/messages/userMessageContent.tsx",
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
  assert.equal(userMessageContent.isSkillMentionToken("$code-review"), true);
  assert.equal(userMessageContent.isSkillMentionToken("$release_notes"), true);
  assert.equal(userMessageContent.isSkillMentionToken("$PATH"), false);
  assert.equal(userMessageContent.isSkillMentionToken("$PATH:"), false);
  assert.equal(userMessageContent.isSkillMentionToken("price$tag"), false);
  assert.equal(userMessageContent.isSkillMentionToken("$bad.name"), false);
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
