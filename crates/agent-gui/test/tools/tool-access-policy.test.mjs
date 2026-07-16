import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function createTool(name) {
  return { name, description: name, parameters: { type: "object", properties: {} } };
}

function createMetadata(isReadOnly) {
  return { groupId: "fs", kind: "test", isReadOnly, displayCategory: "file" };
}

function createToolCall(name, id = `call-${name}`) {
  return { type: "toolCall", id, name, arguments: {} };
}

function createRegistry() {
  const calls = [];
  const tools = [
    createTool("Read"),
    createTool("Write"),
    createTool("Agent"),
    createTool("SendMessage"),
    createTool("mcp_docs_search"),
  ];
  const metadataByName = new Map([
    ["Read", createMetadata(true)],
    ["Write", createMetadata(false)],
    ["Agent", createMetadata(false)],
    ["SendMessage", createMetadata(true)],
    ["mcp_docs_search", createMetadata(false)],
  ]);
  return {
    calls,
    registry: {
      tools,
      metadataByName,
      hasTool: (name) => tools.some((tool) => tool.name === name),
      async executeToolCall(toolCall) {
        calls.push(toolCall);
        return {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: "text", text: `executed:${toolCall.name}` }],
          details: {},
          isError: false,
          timestamp: Date.now(),
        };
      },
    },
  };
}

const loader = createTsModuleLoader();
const { restrictBuiltinToolRegistry, toolAccessModeForExecutionMode } = loader.loadModule(
  "src/lib/tools/toolAccessPolicy.ts",
);

test("execution modes map to none, readonly, and full tool access", () => {
  assert.equal(toolAccessModeForExecutionMode("text"), "none");
  assert.equal(toolAccessModeForExecutionMode("readonly"), "readonly");
  assert.equal(toolAccessModeForExecutionMode("tools"), "full");
  assert.equal(toolAccessModeForExecutionMode("agent-dev"), "full");
});

test("readonly schemas expose only classified read tools and delegation", () => {
  const { registry } = createRegistry();
  const restricted = restrictBuiltinToolRegistry(registry, "readonly");
  assert.deepEqual(
    restricted.tools.map((tool) => tool.name),
    ["Read", "Agent", "SendMessage"],
  );
  assert.equal(restricted.hasTool("read"), true);
  assert.equal(restricted.hasTool("WRITE"), false);
});

test("readonly dispatch rejects write and unclassified MCP tools", async () => {
  const { registry, calls } = createRegistry();
  const restricted = restrictBuiltinToolRegistry(registry, "readonly");
  const writeResult = await restricted.executeToolCall(createToolCall("Write"));
  const mcpResult = await restricted.executeToolCall(createToolCall("mcp_docs_search"));
  assert.equal(writeResult.details.kind, "tool_access_denied");
  assert.equal(mcpResult.details.kind, "tool_access_denied");
  assert.deepEqual(calls, []);
});

test("allowed dispatch canonicalizes tool names before execution", async () => {
  const { registry, calls } = createRegistry();
  const restricted = restrictBuiltinToolRegistry(registry, "readonly");
  const result = await restricted.executeToolCall(createToolCall("  rEaD  "));
  assert.equal(result.isError, false);
  assert.equal(calls[0].name, "Read");
});
