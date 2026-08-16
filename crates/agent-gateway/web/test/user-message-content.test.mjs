import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const loader = createWebModuleLoader({ rootDir });
const webUserMessageContent = loader.loadModule("src/agent-ui-adapters/userMessageContent.ts");
const sharedUserMessageContent = loader.loadModule(
  "@liveagent/ui/lib/chat/userMessageContent.tsx",
);
const renderLoader = createWebModuleLoader({
  rootDir,
  mocks: {
    "react/jsx-runtime": jsxRuntime,
    "@liveagent/ui/components/chat/fileTypeIcons": {
      getFileTypeIcon() {
        return () => null;
      },
      getFileTypeIconSvg() {
        return '<svg viewBox="0 0 24 24"></svg>';
      },
    },
  },
});
const renderedUserMessageContent = renderLoader.loadModule(
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
    if (segment.type === "text") return { type: "text", value: segment.value };
    return { type: segment.type };
  });
}

test("WebUI preserves legacy inline file mentions without changing the shared default", () => {
  const text = "打开 @src/main.tsx 和 @docs/";

  assert.deepEqual(compactSegments(sharedUserMessageContent.tokenizeUserMessage(text, [])), [
    { type: "text", value: text },
  ]);
  assert.deepEqual(compactSegments(webUserMessageContent.tokenizeUserMessage(text, [])), [
    { type: "text", value: "打开 " },
    { type: "mention", path: "src/main.tsx", kind: "file" },
    { type: "text", value: " 和 " },
    { type: "mention", path: "docs", kind: "dir" },
  ]);
});

test("WebUI legacy inline file mentions reject unsafe paths", () => {
  for (const text of ["打开 @/etc/passwd", "打开 @../secret", "打开 @https://example.com/a"]) {
    assert.deepEqual(compactSegments(webUserMessageContent.tokenizeUserMessage(text, [])), [
      { type: "text", value: text },
    ]);
  }
});

test("WebUI history rendering emits legacy inline file mention chips", () => {
  const html = renderToStaticMarkup(
    jsxRuntime.jsx(renderedUserMessageContent.UserMessageContent, {
      text: "打开 @src/main.tsx 和 @docs/",
      legacyInlineFileMentions: true,
    }),
  );

  assert.match(html, /mention-chip/);
  assert.match(html, />main\.tsx</);
  assert.match(html, />docs<\/span>/);
});
