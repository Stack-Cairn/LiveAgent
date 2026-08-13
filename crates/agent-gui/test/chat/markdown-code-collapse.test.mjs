import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function createMarkdownModule(expanded) {
  const loader = createTsModuleLoader({
    mocks: {
      react: {
        cloneElement(element, props) {
          return { ...element, props: { ...element.props, ...props } };
        },
        isValidElement(value) {
          return Boolean(value && typeof value === "object" && "type" in value);
        },
        memo(component) {
          return component;
        },
        useMemo(factory) {
          return factory();
        },
        useState() {
          return [expanded, () => {}];
        },
      },
      "@streamdown/cjk": { cjk: {} },
      "@streamdown/code": { code: {} },
      "@streamdown/math": { math: {} },
      "@streamdown/mermaid": { mermaid: {} },
      "@liveagent/app/shims/tauriOpener": { openUrl() {} },
      streamdown: {
        Streamdown(props) {
          return { type: "Streamdown", props };
        },
        defaultRemarkPlugins: {},
        defaultRehypePlugins: { raw: {}, sanitize: {} },
      },
      "remark-breaks": {},
      "react-dom": { createPortal(children) { return children; } },
      "@liveagent/ui/i18n/index": { useLocale() { return { t: (key) => key }; } },
      "../lib/shared/utils": { cn: (...parts) => parts.filter(Boolean).join(" ") },
      "@liveagent/ui/components/IconSet": {
        Check: "Check",
        ChevronDown: "ChevronDown",
        ChevronUp: "ChevronUp",
        Copy: "Copy",
        ExternalLink: "ExternalLink",
        X: "X",
      },
      "./ui/button": { Button: "Button" },
      "./ui/copy-button": { CopyButton: "CopyButton" },
    },
  });
  return loader.loadModule("@liveagent/ui/components/Markdown.tsx");
}

function findNode(root, predicate) {
  if (root === null || typeof root === "undefined" || typeof root === "boolean") return null;
  if (Array.isArray(root)) {
    for (const child of root) {
      const found = findNode(child, predicate);
      if (found) return found;
    }
    return null;
  }
  if (typeof root !== "object") return null;
  if (predicate(root)) return root;
  return findNode(root.props?.children, predicate);
}

function codeChild(lines, language = "ts") {
  return {
    type: "FullStreamdownCodeBlock",
    props: {
      className: `language-${language}`,
      children: `${lines.join("\n")}\n`,
    },
  };
}

test("collapsed long code renders exactly 24 plain-text lines without the Streamdown code child", () => {
  const { CollapsibleCodePre } = createMarkdownModule(false);
  const lines = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`);
  const rendered = CollapsibleCodePre({ children: codeChild(lines) });

  assert.equal(findNode(rendered, (node) => node.type === "FullStreamdownCodeBlock"), null);
  const preview = findNode(
    rendered,
    (node) => node.props?.["data-liveagent-code-preview"] === "collapsed",
  );
  assert.ok(preview);
  const previewCode = findNode(preview, (node) => node.type === "code");
  assert.ok(previewCode);
  assert.deepEqual(previewCode.props.children.split("\n"), lines.slice(0, 24));
});

test("expanding long code mounts the full Streamdown code child and removes the preview", () => {
  const { CollapsibleCodePre } = createMarkdownModule(true);
  const lines = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`);
  const rendered = CollapsibleCodePre({ children: codeChild(lines) });

  assert.ok(findNode(rendered, (node) => node.type === "FullStreamdownCodeBlock"));
  assert.equal(
    findNode(rendered, (node) => node.props?.["data-liveagent-code-preview"] === "collapsed"),
    null,
  );
});

test("code at the 24-line boundary keeps the normal Streamdown renderer", () => {
  const { CollapsibleCodePre } = createMarkdownModule(false);
  const lines = Array.from({ length: 24 }, (_, index) => `line ${index + 1}`);
  const rendered = CollapsibleCodePre({ children: codeChild(lines) });

  assert.ok(findNode(rendered, (node) => node.type === "FullStreamdownCodeBlock"));
  assert.equal(
    findNode(rendered, (node) => node.props?.["data-liveagent-code-preview"] === "collapsed"),
    null,
  );
});

test("very long single-line code stays out of Shiki and keeps a bounded text preview", () => {
  const { CollapsibleCodePre } = createMarkdownModule(false);
  const longLine = "x".repeat(50_000);
  const rendered = CollapsibleCodePre({ children: codeChild([longLine], "json") });

  assert.equal(findNode(rendered, (node) => node.type === "FullStreamdownCodeBlock"), null);
  const preview = findNode(
    rendered,
    (node) => node.props?.["data-liveagent-code-preview"] === "collapsed",
  );
  assert.ok(preview);
  const previewCode = findNode(preview, (node) => node.type === "code");
  assert.ok(previewCode);
  assert.equal(previewCode.props.children.length, 8_000);
});
