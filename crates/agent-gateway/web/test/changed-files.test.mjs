import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const loader = createWebModuleLoader({ rootDir });
const changedFiles = loader.loadModule("src/lib/chat/changedFiles.ts");

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

test("web collectChangedFiles mirrors the GUI aggregation contract", () => {
  const summary = changedFiles.collectChangedFiles([
    {
      blocks: [
        toolBlock({
          name: "Write",
          args: { path: "src/app.ts", content: "a\nb\nc" },
          details: { kind: "write", relativePath: "src/app.ts" },
        }),
        toolBlock({
          name: "Edit",
          args: { path: "src\\app.ts", old_string: "a\nb\n", new_string: "a\nb\nc\n" },
          details: { kind: "edit", relativePath: "src/app.ts" },
        }),
        toolBlock({
          name: "Delete",
          args: { path: "tmp/scratch.md" },
          details: { kind: "delete", relativePath: "tmp/scratch.md" },
        }),
        toolBlock({
          name: "Edit",
          args: { path: "skip.ts", old_string: "a", new_string: "b" },
          isError: true,
        }),
        toolBlock({ name: "Bash", args: { command: "ls" } }),
      ],
    },
  ]);

  assert.ok(summary);
  assert.equal(summary.files.length, 2);
  assert.deepEqual(
    summary.files.map((file) => [file.path, file.added, file.removed, file.deleted]),
    [
      ["src/app.ts", 4, 0, false],
      ["tmp/scratch.md", 0, 0, true],
    ],
  );
  assert.equal(summary.totalAdded, 4);
  assert.equal(summary.totalRemoved, 0);
  assert.equal(changedFiles.collectChangedFiles([{ blocks: [] }]), null);
});
