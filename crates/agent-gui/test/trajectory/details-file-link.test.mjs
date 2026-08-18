import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as jsxRuntime from "react/jsx-runtime";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// The shared Markdown module pulls in monaco/mermaid-heavy rendering that the
// Node test environment cannot host. Mock it by its resolved path — built the
// same way the loader resolves it — so the key stays valid on any machine.
const sharedSourceDir = fileURLToPath(new URL("../../../agent-ui/src", import.meta.url));
const markdownModulePath = path.join(sharedSourceDir, "components", "Markdown.tsx");

const loader = createTsModuleLoader({
  mocks: {
    "react/jsx-runtime": jsxRuntime,
    [markdownModulePath]: {
      Markdown() {
        return null;
      },
    },
  },
});
const { SourceBlocks } = loader.loadModule(
  "@liveagent/ui/components/trajectory/details/shared.tsx",
);

function findElement(node, type) {
  if (node === null || node === undefined || typeof node !== "object") return null;
  if (node.type === type) return node;
  const children = node.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findElement(child, type);
    if (found) return found;
  }
  return null;
}

test("attachment source block opens the structured relative file link", () => {
  const opened = [];
  const tree = SourceBlocks({
    blocks: [
      {
        type: "attachment:text",
        content: '{"relativePath":"docs/notes.md"}',
        imageAlt: "notes.md",
        filePath: "docs/notes.md",
        fileSource: "relative",
      },
    ],
    t: (key) => (key === "trajectory.details.openFile" ? "Open file" : key),
    workdir: "/workspace",
    onOpenFileLink: (link) => opened.push(link),
  });
  const button = findElement(tree, "button");
  assert.ok(button);
  assert.equal(button.props.title, "docs/notes.md");
  button.props.onClick();
  assert.deepEqual(opened, [{ path: "docs/notes.md", source: "relative" }]);
});

test("attachment source block stays non-interactive when the host has no file capability", () => {
  const tree = SourceBlocks({
    blocks: [
      {
        type: "attachment:text",
        content: "metadata",
        filePath: "docs/notes.md",
        fileSource: "relative",
      },
    ],
    t: (key) => key,
  });
  assert.equal(findElement(tree, "button"), null);
});
