import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const assets = loader.loadModule(
  "@liveagent/ui/components/workspace-editor/workspaceMarkdownAssets.ts",
);

test("resolves markdown-relative asset paths against the file directory", () => {
  assert.equal(
    assets.resolveWorkspaceMarkdownPath("docs/guide/intro.md", "./images/a.png"),
    "docs/guide/images/a.png",
  );
  assert.equal(
    assets.resolveWorkspaceMarkdownPath("docs/guide/intro.md", "images/a.png"),
    "docs/guide/images/a.png",
  );
  assert.equal(
    assets.resolveWorkspaceMarkdownPath("docs/guide/intro.md", "../shared/b.png"),
    "docs/shared/b.png",
  );
  assert.equal(assets.resolveWorkspaceMarkdownPath("README.md", "assets/logo.svg"), "assets/logo.svg");
});

test("treats leading-slash targets as workspace-root relative", () => {
  assert.equal(
    assets.resolveWorkspaceMarkdownPath("docs/guide/intro.md", "/assets/root.png"),
    "assets/root.png",
  );
});

test("strips query and fragment and decodes percent-encoded segments", () => {
  assert.equal(
    assets.resolveWorkspaceMarkdownPath("docs/intro.md", "img/dark.png#gh-dark-mode-only"),
    "docs/img/dark.png",
  );
  assert.equal(
    assets.resolveWorkspaceMarkdownPath("docs/intro.md", "img/pic.png?raw=true"),
    "docs/img/pic.png",
  );
  assert.equal(
    assets.resolveWorkspaceMarkdownPath("docs/intro.md", "my%20images/a%20b.png"),
    "docs/my images/a b.png",
  );
});

test("rejects targets that escape the workspace root", () => {
  assert.equal(assets.resolveWorkspaceMarkdownPath("README.md", "../outside.png"), null);
  assert.equal(assets.resolveWorkspaceMarkdownPath("docs/intro.md", "../../outside.png"), null);
  assert.equal(assets.resolveWorkspaceMarkdownPath("docs/intro.md", ""), null);
});

test("classifies external, inline, hash, and workspace targets", () => {
  assert.deepEqual(assets.classifyWorkspaceMarkdownTarget("docs/intro.md", "https://example.com/x"), {
    kind: "external",
    url: "https://example.com/x",
  });
  assert.deepEqual(assets.classifyWorkspaceMarkdownTarget("docs/intro.md", "mailto:a@b.c"), {
    kind: "external",
    url: "mailto:a@b.c",
  });
  assert.deepEqual(
    assets.classifyWorkspaceMarkdownTarget("docs/intro.md", "//cdn.example.com/x.png"),
    { kind: "external", url: "https://cdn.example.com/x.png" },
  );
  assert.deepEqual(
    assets.classifyWorkspaceMarkdownTarget("docs/intro.md", "data:image/png;base64,AAAA"),
    { kind: "inline", url: "data:image/png;base64,AAAA" },
  );
  assert.deepEqual(assets.classifyWorkspaceMarkdownTarget("docs/intro.md", "#quick-start"), {
    kind: "hash",
    fragment: "quick-start",
  });
  assert.deepEqual(assets.classifyWorkspaceMarkdownTarget("docs/intro.md", "./other.md#section"), {
    kind: "workspace",
    path: "docs/other.md",
  });
});

test("classifies scriptable and unresolvable targets as unsupported", () => {
  assert.deepEqual(assets.classifyWorkspaceMarkdownTarget("docs/intro.md", "javascript:alert(1)"), {
    kind: "unsupported",
  });
  assert.deepEqual(assets.classifyWorkspaceMarkdownTarget("docs/intro.md", "file:///etc/passwd"), {
    kind: "unsupported",
  });
  assert.deepEqual(assets.classifyWorkspaceMarkdownTarget("docs/intro.md", "../../escape.md"), {
    kind: "unsupported",
  });
  assert.deepEqual(assets.classifyWorkspaceMarkdownTarget("docs/intro.md", undefined), {
    kind: "unsupported",
  });
});

test("heading slugs approximate the GitHub anchor format", () => {
  assert.equal(assets.workspaceMarkdownHeadingSlug("Quick Start"), "quick-start");
  assert.equal(assets.workspaceMarkdownHeadingSlug("  A & B  "), "a--b");
  assert.equal(assets.workspaceMarkdownHeadingSlug("使用说明"), "使用说明");
  assert.equal(assets.workspaceMarkdownHeadingSlug("v1.2.3 (beta)"), "v123-beta");
});
