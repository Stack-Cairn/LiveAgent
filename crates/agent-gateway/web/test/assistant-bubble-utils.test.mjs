import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const loader = createWebModuleLoader({ rootDir });
const { BUILTIN_TOOL_CATALOG } = loader.loadModule("src/lib/tools/builtinToolCatalog.ts");
const { isBuiltinShareToolName } = loader.loadModule(
  "src/pages/chat/assistant-bubble/assistantBubbleUtils.ts",
);

test("shared history recognizes every catalog tool and supported alias as builtin", () => {
  for (const entry of BUILTIN_TOOL_CATALOG) {
    assert.equal(isBuiltinShareToolName(entry.toolName), true, entry.toolName);
  }
  assert.equal(isBuiltinShareToolName("HttpGetTest"), true);
  assert.equal(isBuiltinShareToolName("SshManager"), true);
  assert.equal(isBuiltinShareToolName("mcp_docs_search"), true);
  assert.equal(isBuiltinShareToolName(" bash "), true);
  assert.equal(isBuiltinShareToolName("MCP_docs_search"), true);
  assert.equal(isBuiltinShareToolName("WebSearch"), true);
  assert.equal(isBuiltinShareToolName("web_search_preview"), true);
  assert.equal(isBuiltinShareToolName("web_search_call_123"), true);
  assert.equal(isBuiltinShareToolName("CustomTool"), false);
});
