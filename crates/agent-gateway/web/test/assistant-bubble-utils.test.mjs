import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const loader = createWebModuleLoader({ rootDir });
const { BUILTIN_TOOL_CATALOG } = loader.loadModule("src/lib/tools/builtinToolCatalog.ts");
const { groupRoundBlocks, isBuiltinShareToolName } = loader.loadModule(
  "src/pages/chat/assistant-bubble/assistantBubbleUtils.ts",
);

test("shared history recognizes every catalog tool as builtin", () => {
  for (const entry of BUILTIN_TOOL_CATALOG) {
    assert.equal(isBuiltinShareToolName(entry.toolName), true, entry.toolName);
  }
  assert.equal(isBuiltinShareToolName("mcp_docs_search"), true);
  assert.equal(isBuiltinShareToolName("CustomTool"), false);
});

test("TodoWrite stays standalone so transcript filtering cannot hide ordinary tools", () => {
  const tool = (id, name) => ({
    kind: "tool",
    item: { toolCall: { type: "toolCall", id, name, arguments: {} } },
  });
  const grouped = groupRoundBlocks([
    tool("todo-1", "TodoWrite"),
    tool("read-1", "Read"),
    tool("read-2", "Read"),
  ]);

  assert.deepEqual(
    grouped.map((block) => block.kind),
    ["tool", "toolGroup"],
  );
  assert.equal(grouped[0].item.toolCall.name, "TodoWrite");
  assert.deepEqual(
    grouped[1].items.map((item) => item.toolCall.name),
    ["Read", "Read"],
  );
});
