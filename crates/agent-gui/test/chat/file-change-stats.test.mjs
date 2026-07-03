import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const fileChangeStats = loader.loadModule("src/lib/chat/messages/fileChangeStats.ts");
const odometer = loader.loadModule("src/components/chat/OdometerNumber.tsx");
const badge = loader.loadModule("src/components/chat/FileChangeBadge.tsx");

const PREVIEW_META_KEY = "__liveagent_stream_preview";

function editCall(args) {
  return { type: "toolCall", id: "edit-1", name: "Edit", arguments: args };
}

function writeCall(args) {
  return { type: "toolCall", id: "write-1", name: "Write", arguments: args };
}

test("deriveFileChangeStats reports real diff counts for Edit", () => {
  const oldLines = Array.from({ length: 50 }, (_, index) => `line-${index}`);
  const newLines = oldLines.slice();
  newLines[25] = "line-25-changed";

  assert.deepEqual(
    fileChangeStats.deriveFileChangeStats(
      editCall({ old_string: oldLines.join("\n"), new_string: newLines.join("\n") }),
    ),
    { added: 1, removed: 1 },
  );
  assert.deepEqual(
    fileChangeStats.deriveFileChangeStats(
      editCall({ old_string: "a\nb\n", new_string: "a\nb\nc\n" }),
    ),
    { added: 1, removed: 0 },
  );
  // Without a trailing newline the engine applies git's no-newline-at-eof
  // semantics (the last old line counts as rewritten) — same as EditDiffView.
  assert.deepEqual(
    fileChangeStats.deriveFileChangeStats(editCall({ old_string: "a\nb", new_string: "a\nb\nc" })),
    { added: 2, removed: 1 },
  );
  assert.deepEqual(
    fileChangeStats.deriveFileChangeStats(editCall({ old_string: "x\ny", new_string: "x\ny" })),
    { added: 0, removed: 0 },
  );
  assert.deepEqual(
    fileChangeStats.deriveFileChangeStats(editCall({ old_string: "", new_string: "" })),
    { added: 0, removed: 0 },
  );
});

test("deriveFileChangeStats falls back to meta line totals for truncated streams", () => {
  const stats = fileChangeStats.deriveFileChangeStats(
    editCall({
      old_string: "o".repeat(4000),
      new_string: "n".repeat(4000),
      [PREVIEW_META_KEY]: {
        v: 2,
        progress: 17_000,
        fields: {
          old_string: { chars: 9000, lines: 300, truncated: true },
          new_string: { chars: 8000, lines: 280, truncated: false },
        },
      },
    }),
  );
  assert.deepEqual(stats, { added: 280, removed: 300 });
});

test("deriveFileChangeStats shows the streamed side while the other is missing", () => {
  assert.deepEqual(fileChangeStats.deriveFileChangeStats(editCall({ old_string: "a\nb\nc" })), {
    added: undefined,
    removed: 3,
  });
  assert.equal(fileChangeStats.deriveFileChangeStats(editCall({ path: "src/App.tsx" })), undefined);
});

test("deriveFileChangeStats falls back to totals for oversized edits", () => {
  const body = Array.from({ length: 3500 }, (_, index) => `shared-${index}-${"x".repeat(28)}`);
  const stats = fileChangeStats.deriveFileChangeStats(
    editCall({
      old_string: [...body, "only-old-line"].join("\n"),
      new_string: [...body, "only-new-line"].join("\n"),
    }),
  );
  // A real diff would report {added: 1, removed: 1}; the cap keeps the hot
  // streaming path away from huge diffs and reports totals instead.
  assert.deepEqual(stats, { added: 3501, removed: 3501 });
});

test("deriveFileChangeStats counts Write content lines", () => {
  assert.deepEqual(fileChangeStats.deriveFileChangeStats(writeCall({ content: "l1\nl2\nl3" })), {
    added: 3,
  });
  assert.deepEqual(
    fileChangeStats.deriveFileChangeStats(
      writeCall({
        content: "preview…",
        [PREVIEW_META_KEY]: {
          v: 2,
          progress: 12_000,
          fields: { content: { chars: 12_000, lines: 800, truncated: true } },
        },
      }),
    ),
    { added: 800 },
  );
  assert.equal(
    fileChangeStats.deriveFileChangeStats(writeCall({ path: "src/App.tsx" })),
    undefined,
  );
});

test("deriveFileChangeStats ignores non-file tools", () => {
  assert.equal(
    fileChangeStats.deriveFileChangeStats({
      type: "toolCall",
      id: "bash-1",
      name: "Bash",
      arguments: { command: "ls" },
    }),
    undefined,
  );
  assert.equal(
    fileChangeStats.deriveFileChangeStats({
      type: "toolCall",
      id: "nb-1",
      name: "NotebookEdit",
      arguments: { new_source: "a\nb" },
    }),
    undefined,
  );
});

function childrenOf(node) {
  const children = node?.props?.children;
  if (children === undefined || children === null) return [];
  return Array.isArray(children) ? children : [children];
}

test("OdometerNumber renders one rolling column per digit", () => {
  const tree = odometer.OdometerNumber({ value: 205 });
  const [srOnly, strip] = childrenOf(tree);
  assert.equal(srOnly.props.className, "sr-only");
  assert.equal(srOnly.props.children, "205");
  assert.equal(strip.props["aria-hidden"], "true");

  const columns = childrenOf(strip);
  assert.equal(columns.length, 3);
  assert.deepEqual(
    columns.map((column) => column.key),
    ["p2", "p1", "p0"],
  );
  const transforms = columns.map((column) => childrenOf(column)[0].props.style.transform);
  assert.deepEqual(transforms, ["translateY(-2em)", "translateY(-0em)", "translateY(-5em)"]);
  for (const column of columns) {
    const reel = childrenOf(column)[0];
    assert.ok(reel.props.className.includes("transition-transform"));
    assert.ok(reel.props.className.includes("motion-reduce:transition-none"));
    assert.equal(childrenOf(reel).length, 10);
  }
});

test("OdometerNumber clamps invalid values to zero", () => {
  for (const value of [-3, Number.NaN, Number.POSITIVE_INFINITY]) {
    const [srOnly] = childrenOf(odometer.OdometerNumber({ value }));
    assert.equal(srOnly.props.children, "0");
  }
});

test("FileChangeBadge renders green added and red removed counts", () => {
  assert.equal(badge.FileChangeBadge({}), null);

  const addedOnly = badge.FileChangeBadge({ added: 2 });
  const [addedSpan, removedSpan] = childrenOf(addedOnly);
  assert.ok(addedSpan.props.className.includes("--chat-success"));
  assert.equal(removedSpan, null);
  const [addedSign, addedNumber] = childrenOf(addedSpan);
  assert.equal(addedSign, "+");
  assert.equal(addedNumber.type, odometer.OdometerNumber);
  assert.equal(addedNumber.props.value, 2);

  const both = badge.FileChangeBadge({ added: 2, removed: 1 });
  const [green, red] = childrenOf(both);
  assert.ok(green.props.className.includes("--chat-success"));
  assert.ok(red.props.className.includes("--chat-error"));
  const [removedSign, removedNumber] = childrenOf(red);
  assert.equal(removedSign, "-");
  assert.equal(removedNumber.props.value, 1);
});
