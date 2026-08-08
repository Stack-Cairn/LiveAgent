import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const markdownLoader = createWebModuleLoader({
  mocks: {
    "@streamdown/cjk": { cjk: {} },
    "@streamdown/code": { code: {} },
    "@streamdown/math": { math: {} },
    "@streamdown/mermaid": { mermaid: {} },
    streamdown: {
      Streamdown(props) {
        return { type: "Streamdown", props };
      },
      defaultRemarkPlugins: {},
      defaultRehypePlugins: { raw: () => {}, sanitize: [() => {}, {}], harden: () => {} },
    },
    "react-dom": { createPortal: (children, container) => ({ children, container }) },
    "../i18n": { useLocale: () => ({ t: (key) => key }) },
    "../lib/shared/utils": { cn: (...parts) => parts.filter(Boolean).join(" ") },
    "./icons": new Proxy(
      {},
      { get: (_target, name) => (props) => ({ type: String(name), props }) },
    ),
    "./ui/button": { Button: (props) => ({ type: "Button", props }) },
  },
});
const markdownModule = markdownLoader.loadModule("@liveagent/ui/components/Markdown.tsx");
const {
  decodeChatFileLinkPayload,
  encodeChatFileLink,
  parseChatFileLink,
} = loader.loadModule("src/lib/chat/chatFileLinks.ts");

const validCases = [
  ["C:/work/src/a.ts", { path: "C:/work/src/a.ts", source: "absolute" }],
  [String.raw`C:\work\src\a.ts`, { path: "C:/work/src/a.ts", source: "absolute" }],
  [String.raw`C:\\project\\file.ts`, { path: "C:/project/file.ts", source: "absolute" }],
  ["D:/other/a.ts", { path: "D:/other/a.ts", source: "absolute" }],
  ["C:/work/src/a.ts:12", { path: "C:/work/src/a.ts", line: 12, source: "absolute" }],
  [
    "C:/work/src/a.ts:12:4",
    { path: "C:/work/src/a.ts", line: 12, column: 4, source: "absolute" },
  ],
  ["C:/work/src/a.ts#L12", { path: "C:/work/src/a.ts", line: 12, source: "absolute" }],
  [
    "C:/work/src/a.ts#L12-L20",
    { path: "C:/work/src/a.ts", line: 12, endLine: 20, source: "absolute" },
  ],
  ["C:/path with spaces/a.ts", { path: "C:/path with spaces/a.ts", source: "absolute" }],
  ["C:/path%20with%20spaces/a.ts", { path: "C:/path with spaces/a.ts", source: "absolute" }],
  ["C:/路径/文件.ts", { path: "C:/路径/文件.ts", source: "absolute" }],
  ["file:///C:/work/a.ts", { path: "C:/work/a.ts", source: "file-url" }],
  [
    "file:///C:/path%20with%20spaces/%E6%96%87%E4%BB%B6.ts#L7-L9",
    {
      path: "C:/path with spaces/文件.ts",
      line: 7,
      endLine: 9,
      source: "file-url",
    },
  ],
  ["/home/user/work/a.ts", { path: "/home/user/work/a.ts", source: "absolute" }],
  ["./src/a.ts", { path: "./src/a.ts", source: "relative" }],
  ["../src/a.ts:3:2", { path: "../src/a.ts", line: 3, column: 2, source: "relative" }],
  ["src/a.ts", { path: "src/a.ts", source: "relative" }],
  ["README.md", { path: "README.md", source: "relative" }],
  [
    String.raw`\\server\share\folder\a.ts:8`,
    { path: "//server/share/folder/a.ts", line: 8, source: "absolute" },
  ],
  [
    "file://server/share/folder/a.ts#L4",
    { path: "//server/share/folder/a.ts", line: 4, source: "file-url" },
  ],
];

test("Gateway historical and streaming rows keep the explicit file-open prop chain", () => {
  const files = [
    "../src/app/GatewayApp.tsx",
    "../src/components/GatewayTranscript.tsx",
    "../../../agent-ui/src/components/chat/ThinkingActivity.tsx",
    "../src/pages/chat/AssistantBubble.tsx",
    "../src/pages/chat/assistant-bubble/RoundContent.tsx",
  ];
  for (const relativePath of files) {
    const source = fs.readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
    assert.match(source, /onOpenFileLink/, relativePath);
  }

  const roundContent = fs.readFileSync(
    fileURLToPath(new URL("../src/pages/chat/assistant-bubble/RoundContent.tsx", import.meta.url)),
    "utf8",
  );
  assert.match(roundContent, /isStreaming \? "streaming" : "static"/);
  assert.ok((roundContent.match(/onOpenFileLink=\{onOpenFileLink\}/g) ?? []).length >= 2);
  assert.ok((roundContent.match(/workdir=\{workdir\}/g) ?? []).length >= 2);

  const thinkingActivity = fs.readFileSync(
    fileURLToPath(
      new URL("../../../agent-ui/src/components/chat/ThinkingActivity.tsx", import.meta.url),
    ),
    "utf8",
  );
  assert.match(thinkingActivity, /<Markdown/);
  assert.match(thinkingActivity, /onOpenFileLink=\{onOpenFileLink\}/);
  assert.match(thinkingActivity, /workdir=\{workdir\}/);

  const gatewayApp = fs.readFileSync(
    fileURLToPath(new URL("../src/app/GatewayApp.tsx", import.meta.url)),
    "utf8",
  );
  assert.match(gatewayApp, /openInFileManager: true/);
  assert.match(gatewayApp, /!result\.outsideWorkspace/);
});

test("escaped Markdown file links stay literal in Gateway Web", () => {
  const source = String.raw`\[foo\*](README.md) and [foo*](README.md)`;
  const tree = {
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [
          {
            type: "text",
            value: "[foo*](README.md) and [foo*](README.md)",
            position: { start: { offset: 0 }, end: { offset: source.length } },
          },
        ],
      },
    ],
  };

  markdownModule.remarkChatFileLinks()(tree, { value: source });

  assert.deepEqual(tree.children[0].children, [
    { type: "text", value: "[foo*](README.md) and " },
    {
      type: "link",
      url: "README.md",
      children: [{ type: "text", value: "foo*" }],
    },
  ]);
});

test("parseChatFileLink supports the cross-platform chat path matrix", () => {
  for (const [input, expected] of validCases) {
    assert.deepEqual(parseChatFileLink(input), expected, input);
  }
});

test("parseChatFileLink rejects external, dangerous, internal, and malformed targets", () => {
  for (const input of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "https://example.com/a.ts",
    "http://example.com/a.ts",
    "mailto:user@example.com",
    "liveagent-file:path=C%3A%2Fa.ts&source=absolute",
    "C:drive-relative.txt",
    "C:/work/a.ts:4294967296",
    "file:///C:/work/a.ts#L999999999999999999999999",
    "#L12",
    "",
  ]) {
    assert.equal(parseChatFileLink(input), null, input);
  }

  assert.doesNotThrow(() => parseChatFileLink("file:///%E0%A4%A"));
});

test("the internal payload codec preserves locations and rejects malformed payloads", () => {
  const original = {
    path: "C:/路径/a file.ts",
    line: 12,
    endLine: 20,
    column: 4,
    source: "absolute",
  };
  const encoded = encodeChatFileLink(original);
  assert.match(encoded, /^liveagent-file:/);
  assert.deepEqual(
    decodeChatFileLinkPayload(encoded.slice("liveagent-file:".length)),
    original,
  );

  for (const payload of [
    "path=&source=absolute",
    "v=1&path=&source=absolute",
    "v=1&path=C%3A%2Fa.ts&source=unknown",
    "v=1&path=C%3A%2Fa.ts&source=absolute&line=0",
    "v=1&path=C%3A%2Fa.ts&source=absolute&line=-1",
    "v=1&path=C%3A%2Fa.ts&source=absolute&line=abc",
    "v=1&path=C%3A%2Fa.ts&source=absolute&line=4294967296",
    "v=1&path=C%3A%2Fa.ts&source=absolute&line=20&endLine=12",
    "v=1&path=C%3A%2Fa.ts&path=D%3A%2Fb.ts&source=absolute",
    "v=1&path=C%3A%2Fa.ts&source=absolute&extra=true",
  ]) {
    assert.equal(decodeChatFileLinkPayload(payload), null, payload);
  }
});
