import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rawPlugin = () => {};
const sanitizePlugin = () => {};
const hardenPlugin = () => {};

const loader = createTsModuleLoader({
  mocks: {
    "@streamdown/cjk": {
      cjk: {},
    },
    "@streamdown/code": {
      code: {},
    },
    "@streamdown/math": {
      math: {},
    },
    "@streamdown/mermaid": {
      mermaid: {},
    },
    streamdown: {
      Streamdown(props) {
        return { type: "Streamdown", props };
      },
      defaultRemarkPlugins: {},
      defaultRehypePlugins: {
        raw: rawPlugin,
        sanitize: [
          sanitizePlugin,
          {
            protocols: {
              href: ["http", "https", "mailto"],
              src: ["http", "https"],
            },
          },
        ],
        harden: hardenPlugin,
      },
    },
    "@tauri-apps/plugin-opener": {
      openUrl() {
        throw new Error("openUrl mock was not expected to be called");
      },
    },
    "./ui/button": {
      Button(props) {
        return { type: "Button", props };
      },
    },
    "./ui/dialog": {
      Dialog: "Dialog",
      DialogContent: "DialogContent",
      DialogDescription: "DialogDescription",
      DialogTitle: "DialogTitle",
    },
    "../lib/shared/utils": {
      cn: (...parts) => parts.filter(Boolean).join(" "),
    },

  },
});

const markdownModule = loader.loadModule("@liveagent/ui/components/Markdown.tsx");

test("markdown image syntax falls back to alt text instead of rendering a real image", () => {
  const node = markdownModule.markdownComponents.img({
    alt: "东门老街",
    title: "深圳夜景",
  });

  assert.ok(node);
  assert.equal(node.type, "span");
  assert.equal(node.props["data-liveagent-markdown-image"], "text-fallback");
  assert.equal(node.props.title, "东门老街");
  assert.equal(node.props.children, "东门老街");

  const titleOnly = markdownModule.markdownComponents.img({ title: "南头古城" });
  assert.ok(titleOnly);
  assert.equal(titleOnly.props.children, "南头古城");

  const empty = markdownModule.markdownComponents.img({});
  assert.equal(empty, null);
});

test("chat file links are rewritten before sanitize and harden without widening unsafe schemes", () => {
  const fileNode = {
    type: "element",
    tagName: "a",
    properties: { href: "C:/Users/AlphaCat/claude-code-request.curl.ps1" },
    children: [{ type: "text", value: "claude-code-request.curl.ps1" }],
  };
  const httpsNode = {
    type: "element",
    tagName: "a",
    properties: { href: "https://example.com" },
    children: [],
  };
  const dangerousNode = {
    type: "element",
    tagName: "a",
    properties: { href: "javascript:alert(1)" },
    children: [],
  };
  const rawHtmlNode = {
    type: "element",
    tagName: "a",
    properties: { href: "C:/Users/AlphaCat/disguised.ps1" },
    position: { start: { offset: 0 } },
    children: [{ type: "text", value: "https://example.com" }],
  };
  markdownModule.rewriteChatFileLinks()({
    type: "root",
    children: [fileNode, httpsNode, dangerousNode],
  });
  markdownModule.rewriteChatFileLinks()(
    { type: "root", children: [rawHtmlNode] },
    { value: '<a href="C:/Users/AlphaCat/disguised.ps1">https://example.com</a>' },
  );

  assert.match(fileNode.properties.href, /^liveagent-file:/);
  assert.equal(fileNode.data.liveagentChatFileLink, fileNode.properties.href);
  assert.equal(httpsNode.properties.href, "https://example.com");
  assert.equal(dangerousNode.properties.href, "javascript:alert(1)");
  assert.equal(rawHtmlNode.properties.href, "C:/Users/AlphaCat/disguised.ps1");
  assert.equal(rawHtmlNode.data, undefined);

  const plugins = markdownModule.chatFileRehypePlugins;
  assert.equal(plugins[0], rawPlugin);
  assert.equal(plugins[1], markdownModule.rewriteChatFileLinks);
  assert.equal(plugins[2][0], sanitizePlugin);
  assert.equal(plugins.at(-1), hardenPlugin);
  const hrefProtocols = plugins[2][1].protocols.href;
  assert.ok(hrefProtocols.includes("liveagent-file"));
  for (const scheme of ["file", "c", "d", "javascript", "data", "vbscript"]) {
    assert.equal(hrefProtocols.includes(scheme), false, scheme);
  }
});

test("raw spaces and backslashes become Markdown file links without touching code", () => {
  const source = "Open [space](C:/path with spaces/a.ts) and [windows](C:\\work\\src\\a.ts).";
  const tree = {
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [
          {
            type: "text",
            value: source,
            position: { start: { offset: 0 }, end: { offset: source.length } },
          },
        ],
      },
      {
        type: "code",
        value: "[literal](C:/path with spaces/a.ts)",
      },
      {
        type: "image",
        url: "C:/path with spaces/image.png",
        value: "image",
      },
      {
        type: "math",
        value: String.raw`[x](C:\math\formula.ts)`,
      },
      {
        type: "table",
        children: [{ type: "tableRow", children: [{ type: "text", value: "plain cell" }] }],
      },
    ],
  };
  markdownModule.remarkChatFileLinks()(tree, { value: source });

  const paragraph = tree.children[0].children;
  assert.equal(paragraph.filter((node) => node.type === "link").length, 2);
  assert.equal(paragraph[1].url, "C:/path with spaces/a.ts");
  assert.equal(paragraph[3].url, "C:\\work\\src\\a.ts");
  assert.equal(tree.children[1].value, "[literal](C:/path with spaces/a.ts)");
  assert.equal(tree.children[2].url, "C:/path with spaces/image.png");
  assert.equal(tree.children[3].value, String.raw`[x](C:\math\formula.ts)`);
  assert.equal(tree.children[4].type, "table");
  assert.equal(tree.children[4].children[0].children[0].value, "plain cell");
});

test("escaped Markdown file links stay literal while a following link remains clickable", () => {
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

test("the shared editor applies linked locations once per request and tab", () => {
  const source = fs.readFileSync(
    fileURLToPath(
      new URL(
        "../../../agent-ui/src/components/workspace-editor/WorkspaceCodeEditorOverlay.tsx",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  assert.match(source, /linkedLocationKeyRef/);
  assert.match(source, /const locationKey = `\$\{openRequest\.id\}\\u0000\$\{activeTabKey\}`/);
  assert.match(source, /if \(linkedLocationKeyRef\.current === locationKey\) return/);
  assert.doesNotMatch(source, /\}, \[activeTab, openRequest\]\);/);
});

test("the reported ps1 link renders as one accessible click target and never executes itself", () => {
  const fileNode = {
    type: "element",
    tagName: "a",
    properties: { href: "C:/Users/AlphaCat/claude-code-request.curl.ps1" },
    children: [],
  };
  markdownModule.rewriteChatFileLinks()({ type: "root", children: [fileNode] });
  const opened = [];
  const button = markdownModule.MarkdownFileLink({
    children: "claude-code-request.curl.ps1",
    href: fileNode.properties.href,
    node: fileNode,
    workdir: "C:/Users/AlphaCat",
    onOpenFileLink(link) {
      opened.push(link);
    },
  });

  assert.equal(button.type, "button");
  assert.equal(button.props.type, "button");
  assert.equal(button.props["data-liveagent-file-link"], "true");
  assert.equal(button.props.children, "claude-code-request.curl.ps1");
  assert.doesNotMatch(String(button.props.children), /\[blocked\]/);
  assert.match(button.props.className, /overflow-wrap:anywhere/);
  assert.match(button.props.className, /max-w-full/);
  assert.match(button.props.className, /whitespace-normal/);
  button.props.onClick();
  assert.deepEqual(opened, [
    {
      path: "C:/Users/AlphaCat/claude-code-request.curl.ps1",
      source: "absolute",
    },
  ]);
});

test("historical and streaming assistant rows share the explicit file-open prop chain", () => {
  const files = [
    "../../src/pages/chat/transcript/ChatTranscript.tsx",
    "../../src/pages/chat/transcript/TranscriptList.tsx",
    "../../src/pages/chat/transcript/AssistantRenderUnit.tsx",
    "../../src/pages/chat/components/AssistantBubble.tsx",
    "../../../agent-ui/src/components/chat/assistant-bubble/RoundContent.tsx",
  ];
  for (const relativePath of files) {
    const source = fs.readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
    assert.match(source, /onOpenFileLink/, relativePath);
  }

  const roundContent = fs.readFileSync(
    fileURLToPath(
      new URL(
        "../../../agent-ui/src/components/chat/assistant-bubble/RoundContent.tsx",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  assert.match(roundContent, /export const RoundBlockContent/);
  assert.match(roundContent, /renderMode=\{renderMode\}/);
  // Markdown plus direct and grouped file tools must all reach the same
  // host-aware IDE navigation callback.
  assert.ok((roundContent.match(/onOpenFileLink=\{onOpenFileLink\}/g) ?? []).length >= 4);
  assert.ok((roundContent.match(/workdir=\{workdir\}/g) ?? []).length >= 2);

  const transcriptList = fs.readFileSync(
    fileURLToPath(new URL("../../src/pages/chat/transcript/TranscriptList.tsx", import.meta.url)),
    "utf8",
  );
  assert.match(transcriptList, /isCompactionRunning=\{row\.mutable/);
  assert.match(transcriptList, /workdir=\{workspaceRoot\}/);
  assert.match(transcriptList, /onOpenFileLink=\{onOpenFileLink\}/);

  const chatPage = fs.readFileSync(
    fileURLToPath(new URL("../../src/pages/ChatPage.tsx", import.meta.url)),
    "utf8",
  );
  assert.match(chatPage, /useChatFileLinkNavigation/);

  const navigation = fs.readFileSync(
    fileURLToPath(
      new URL("../../../agent-ui/src/lib/chat/useChatFileLinkNavigation.ts", import.meta.url),
    ),
    "utf8",
  );
  assert.match(navigation, /openInFileManager: true/);
  assert.match(navigation, /!result\.outsideWorkspace/);
});

test("forged internal payloads cannot become clickable file links", () => {
  let opened = 0;
  const forged = markdownModule.MarkdownFileLink({
    children: "not-a-real-marker.ps1",
    href: "liveagent-file:v=1&path=C%3A%2Fnot-a-real-marker.ps1&source=absolute",
    node: { type: "element", tagName: "a", properties: {} },
    onOpenFileLink() {
      opened += 1;
    },
  });
  const rendered = forged.type(forged.props);
  assert.equal(rendered.type, "span");
  assert.equal(rendered.props["data-liveagent-file-link"], undefined);
  assert.equal(opened, 0);
});

test("ordinary https links stay on the external-link path", () => {
  const routed = markdownModule.MarkdownLink({
    children: "example",
    href: "https://example.com",
    node: { type: "element", tagName: "a", properties: { href: "https://example.com" } },
    onOpenFileLink() {
      throw new Error("https link must not open as a chat file");
    },
  });
  assert.equal(routed.type.name, "MarkdownExternalLink");
});

test("fs tool descriptions keep Image as the only display path for images", () => {
  const sourcePath = fileURLToPath(new URL("../../src/lib/tools/fsTools.ts", import.meta.url));
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.match(
    source,
    /Use Image instead when the user asks to show, view, render, or display an image in the chat UI\. Do not use Markdown image syntax or HTML img tags to display files\./,
  );
  assert.match(
    source,
    /This is the only supported way for assistant-side image rendering\./,
  );
  assert.match(
    source,
    /Supports workspace paths, configured root:\/\/ project paths, enabled Skill paths, external absolute paths, http\/https URLs, base64 data URLs, and SVG images/,
  );
  assert.match(
    source,
    /For remote images, pass url\/urls or source\/sources directly instead of downloading the image first, unless the user explicitly asks to save it locally\./,
  );
  assert.match(
    source,
    /Multiple mixed image sources to display in order\. Use this for mixed path \+ URL \+ base64 galleries\./,
  );
  assert.match(
    source,
    /Do not embed images in final text with Markdown image syntax, HTML img tags, file:\/\/ URLs, or local relative image paths\./,
  );
  assert.match(
    source,
    /The structured, tracked way to intentionally delete a file\/directory in the workspace, a writable root:\/\/ project directory, or an enabled writable Skill/,
  );
  assert.match(source, /Delete results feed LiveAgent's Edited Files and file-ledger tracking/);
});
