import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "./helpers/load-ts-module.mjs";

function createRowHarness() {
  const loader = createTsModuleLoader({
    mocks: {
      react: {
        memo(component) {
          return component;
        },
      },
      "@liveagent/ui/i18n/index": {
        useLocale() {
          return { t: (key) => key };
        },
      },
      "@liveagent/ui/components/IconSet": {
        ChevronRight: (props) => ({ type: "ChevronRight", props }),
        Loader2: (props) => ({ type: "Loader2", props }),
      },
      "@liveagent/ui/lib/shared/utils": {
        cn(...values) {
          return values.filter(Boolean).join(" ");
        },
      },
      "@liveagent/ui/components/chat/fileTypeIcons": {
        getFileTypeIcon() {
          return (props) => ({ type: "FileTypeIcon", props });
        },
      },
    },
  });
  return loader.loadModule("@liveagent/ui/components/project-tools/file-tree/Row.tsx");
}

function findAll(node, predicate, matches = []) {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, matches);
    return matches;
  }
  if (!node || typeof node !== "object") return matches;
  if (predicate(node)) matches.push(node);
  findAll(node.props?.children, predicate, matches);
  return matches;
}

function renderRow(overrides = {}) {
  const { FileTreeRow } = createRowHarness();
  const calls = [];
  const tree = FileTreeRow({
    path: "assets/preview.png",
    name: "preview.png",
    kind: "file",
    hidden: false,
    depth: 1,
    expanded: false,
    selected: false,
    loading: false,
    title: "assets/preview.png",
    onToggle: (...args) => calls.push(["toggle", ...args]),
    onSelect: (...args) => calls.push(["select", ...args]),
    onOpen: (...args) => calls.push(["open", ...args]),
    onContextMenu() {},
    ...overrides,
  });
  return { tree, calls };
}

test("workspace file tree opens files from anywhere in the hovered row", () => {
  const { tree, calls } = renderRow();

  assert.equal(tree.props.onDoubleClick, undefined);
  assert.match(tree.props.className, /\bw-full\b/);
  assert.equal(typeof tree.props.onClick, "function");
  tree.props.onClick();

  assert.deepEqual(calls, [
    ["select", "assets/preview.png"],
    ["open", "assets/preview.png"],
  ]);
});

test("workspace file tree expands directories with one click", () => {
  const { tree, calls } = renderRow({
    path: "assets",
    name: "assets",
    kind: "dir",
  });
  const [expandButton] = findAll(tree, (node) => node.type === "button");

  tree.props.onClick();
  assert.deepEqual(calls, [
    ["select", "assets"],
    ["toggle", "assets", false],
  ]);

  calls.length = 0;
  let propagationStopped = false;
  expandButton.props.onClick({
    stopPropagation() {
      propagationStopped = true;
    },
  });
  assert.equal(propagationStopped, true);
  assert.deepEqual(calls, [["toggle", "assets", false]]);
});
