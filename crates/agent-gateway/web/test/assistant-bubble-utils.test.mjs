import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const loader = createWebModuleLoader({ rootDir });
const { BUILTIN_TOOL_CATALOG } = loader.loadModule("@liveagent/ui/lib/tools/builtinToolCatalog.ts");
const { groupRoundBlocks, isBuiltinShareToolName } = loader.loadModule(
  "@liveagent/ui/components/chat/assistant-bubble/assistantBubbleUtils.ts",
);

test("shared history recognizes every catalog tool as builtin", () => {
  for (const entry of BUILTIN_TOOL_CATALOG) {
    assert.equal(isBuiltinShareToolName(entry.toolName), true, entry.toolName);
  }
  assert.equal(isBuiltinShareToolName("mcp_docs_search"), true);
  assert.equal(isBuiltinShareToolName("CustomTool"), false);
});

test("ordinary tool activity keeps one group identity as later tools append", () => {
  const tool = (id) => ({
    kind: "tool",
    item: { toolCall: { type: "toolCall", id, name: "Bash", arguments: {} } },
  });
  const first = groupRoundBlocks([tool("call-1")]);
  const appended = groupRoundBlocks([tool("call-1"), tool("call-2")]);

  assert.equal(first.length, 1);
  assert.equal(appended.length, 1);
  assert.equal(first[0].kind, "toolGroup");
  assert.equal(appended[0].kind, "toolGroup");
  assert.equal(appended[0].key, first[0].key);
});

test("special tool result updates preserve their direct activity identity", () => {
  for (const name of [
    "TaskCreate",
    "TaskUpdate",
    "TaskList",
    "AskUserQuestion",
    "Image",
    "Agent",
    "ProcessWait",
    "ProcessStop",
  ]) {
    const pendingItem = {
      toolCall: { type: "toolCall", id: `call-${name}`, name, arguments: {} },
    };
    const settledItem = {
      ...pendingItem,
      toolResult: {
        role: "toolResult",
        toolCallId: `call-${name}`,
        content: [],
        isError: name === "Image",
      },
    };
    const pending = groupRoundBlocks([{ kind: "tool", item: pendingItem }]);
    const settled = groupRoundBlocks([{ kind: "tool", item: settledItem }]);

    assert.equal(pending.length, 1, name);
    assert.equal(settled.length, 1, name);
    assert.equal(pending[0].kind, "tool", name);
    assert.equal(settled[0].kind, "tool", name);
    assert.equal(settled[0].key, pending[0].key, name);
  }
});

test("hosted search activity keeps one group identity as later searches append", () => {
  const first = groupRoundBlocks([{ kind: "hostedSearch", item: { id: "search-1" } }]);
  const appended = groupRoundBlocks([
    { kind: "hostedSearch", item: { id: "search-1" } },
    { kind: "hostedSearch", item: { id: "search-2" } },
  ]);

  assert.equal(first[0].kind, "hostedSearchGroup");
  assert.equal(appended[0].kind, "hostedSearchGroup");
  assert.equal(appended[0].key, first[0].key);
});

test("task tools stay standalone so transcript filtering cannot hide ordinary tools", () => {
  const tool = (id, name) => ({
    kind: "tool",
    item: { toolCall: { type: "toolCall", id, name, arguments: {} } },
  });
  const grouped = groupRoundBlocks([
    tool("task-1", "TaskCreate"),
    tool("read-1", "Read"),
    tool("read-2", "Read"),
  ]);

  assert.deepEqual(
    grouped.map((block) => block.kind),
    ["tool", "toolGroup"],
  );
  assert.equal(grouped[0].item.toolCall.name, "TaskCreate");
  assert.deepEqual(
    grouped[1].items.map((item) => item.toolCall.name),
    ["Read", "Read"],
  );
});
