import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const changedFiles = loader.loadModule("src/lib/chat/messages/changedFiles.ts");

let toolCallSeq = 0;

function toolBlock({ name, args, details, isError = false, settled = true }) {
  toolCallSeq += 1;
  return {
    kind: "tool",
    item: {
      toolCall: { type: "toolCall", id: `call-${toolCallSeq}`, name, arguments: args },
      toolResult: settled
        ? {
            role: "toolResult",
            toolCallId: `call-${toolCallSeq}`,
            toolName: name,
            content: [],
            details: details ?? {},
            isError,
            timestamp: 1,
          }
        : undefined,
    },
  };
}

function round(...blocks) {
  return { blocks };
}

test("collectChangedFiles aggregates Write/Edit stats per file across rounds", () => {
  const summary = changedFiles.collectChangedFiles([
    round(
      toolBlock({
        name: "Write",
        args: { path: "src/app.ts", content: "a\nb\nc" },
        details: { kind: "write", path: "src/app.ts", relativePath: "src/app.ts" },
      }),
      toolBlock({ name: "Read", args: { path: "src/app.ts" }, details: {} }),
    ),
    round(
      toolBlock({
        name: "Edit",
        args: { path: "src\\app.ts", old_string: "a\nb\n", new_string: "a\nb\nc\n" },
        details: { kind: "edit", path: "src\\app.ts", relativePath: "src/app.ts" },
      }),
      toolBlock({
        name: "Write",
        args: { path: "docs/readme.md", content: "hello" },
        details: { kind: "write", path: "docs/readme.md", relativePath: "docs/readme.md" },
      }),
    ),
  ]);

  assert.ok(summary);
  assert.equal(summary.files.length, 2);
  const [app, readme] = summary.files;
  // Write(3 行) + Edit(真 diff：+1/-0)，同文件跨 round 合并。
  assert.equal(app.path, "src/app.ts");
  assert.equal(app.added, 4);
  assert.equal(app.removed, 0);
  assert.equal(app.deleted, false);
  assert.equal(readme.path, "docs/readme.md");
  assert.equal(readme.added, 1);
  assert.equal(summary.totalAdded, 5);
  assert.equal(summary.totalRemoved, 0);
});

test("failed or unsettled operations never count", () => {
  assert.equal(
    changedFiles.collectChangedFiles([
      round(
        toolBlock({
          name: "Write",
          args: { path: "a.ts", content: "x" },
          details: { kind: "write", path: "a.ts" },
          isError: true,
        }),
        toolBlock({
          name: "Edit",
          args: { path: "b.ts", old_string: "x", new_string: "y" },
          settled: false,
        }),
        toolBlock({ name: "Bash", args: { command: "ls" }, details: {} }),
      ),
    ]),
    null,
  );
});

test("Delete marks the file deleted and a later Write revives it", () => {
  const deletedOnly = changedFiles.collectChangedFiles([
    round(
      toolBlock({
        name: "Write",
        args: { path: "tmp/task.md", content: "a\nb" },
        details: { kind: "write", path: "tmp/task.md", relativePath: "tmp/task.md" },
      }),
      toolBlock({
        name: "Delete",
        args: { path: "tmp/task.md" },
        details: { kind: "delete", path: "tmp/task.md", relativePath: "tmp/task.md" },
      }),
    ),
  ]);
  assert.ok(deletedOnly);
  assert.equal(deletedOnly.files[0].deleted, true);

  const revived = changedFiles.collectChangedFiles([
    round(
      toolBlock({
        name: "Delete",
        args: { path: "tmp/task.md" },
        details: { kind: "delete", path: "tmp/task.md" },
      }),
      toolBlock({
        name: "Write",
        args: { path: "tmp/task.md", content: "fresh" },
        details: { kind: "write", path: "tmp/task.md" },
      }),
    ),
  ]);
  assert.ok(revived);
  assert.equal(revived.files[0].deleted, false);
  assert.equal(revived.files[0].added, 1);
});

test("path falls back to tool arguments when result details lack it", () => {
  const summary = changedFiles.collectChangedFiles([
    round(
      toolBlock({
        name: "Edit",
        args: { path: "lib/util.ts", old_string: "a", new_string: "b" },
        details: {},
      }),
    ),
  ]);
  assert.ok(summary);
  assert.equal(summary.files[0].path, "lib/util.ts");
  assert.equal(summary.files[0].added, 1);
  assert.equal(summary.files[0].removed, 1);
});

test("display path from details wins and dedup ignores slash/case drift", () => {
  const summary = changedFiles.collectChangedFiles([
    round(
      toolBlock({
        name: "Write",
        args: { path: "SRC\\Main.ts", content: "x" },
        details: { kind: "write", path: "C:\\repo\\src\\Main.ts", displayPath: "src/Main.ts" },
      }),
      toolBlock({
        name: "Edit",
        args: { path: "src/main.ts", old_string: "x\ny\n", new_string: "x\ny\nz\n" },
        details: { kind: "edit", displayPath: "src/Main.ts" },
      }),
    ),
  ]);
  assert.ok(summary);
  assert.equal(summary.files.length, 1);
  assert.equal(summary.files[0].path, "src/Main.ts");
  assert.equal(summary.files[0].added, 2);
});
