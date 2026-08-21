import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import * as typebox from "typebox";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function loadModules() {
  const loader = createTsModuleLoader({ mocks: { typebox } });
  return {
    tools: loader.loadModule("src/lib/tools/toolSearchTools.ts"),
  };
}

function mcpTool(name, description, big = false) {
  return {
    name,
    description,
    parameters: {
      type: "object",
      properties: big
        ? Object.fromEntries(
            Array.from({ length: 40 }, (_, index) => [
              `field_${index}`,
              { type: "string", description: `冗长的字段描述占位内容 ${index} `.repeat(20) },
            ]),
          )
        : { q: { type: "string" } },
    },
  };
}

function createToolCall(argumentsValue, id = "call-search-1") {
  return { type: "toolCall", id, name: "ToolSearch", arguments: argumentsValue };
}

test("shouldDeferMcpTools compares estimated schema tokens with the threshold", () => {
  const { tools } = loadModules();
  assert.equal(tools.shouldDeferMcpTools([]), false);
  assert.equal(tools.shouldDeferMcpTools([mcpTool("mcp_a_x", "small")]), false);
  const heavy = Array.from({ length: 30 }, (_, index) =>
    mcpTool(`mcp_srv_tool_${index}`, "heavy schema", true),
  );
  assert.equal(tools.shouldDeferMcpTools(heavy), true);
  // 阈值可注入:同一批工具在极小阈值下必然延迟。
  assert.equal(tools.shouldDeferMcpTools([mcpTool("mcp_a_x", "small")], 1), true);
});

test("ToolSearch schema accepts query and optional max_results", () => {
  const { tools } = loadModules();
  const bundle = tools.createToolSearchTools({
    conversationId: "conv-schema",
    entries: [{ tool: mcpTool("mcp_docs_search", "Search docs"), serverLabel: "Docs" }],
  });
  const tool = bundle.tools.find((candidate) => candidate.name === "ToolSearch");
  assert.ok(tool);
  assert.match(tool.description, /1 MCP tools/);
  assert.match(tool.description, /Docs/);
  const args = validateToolArguments(tool, createToolCall({ query: "docs", max_results: 3 }));
  assert.equal(args.query, "docs");
});

test("search ranks by name/server/description and activates matches", async () => {
  const { tools } = loadModules();
  const conversationId = "conv-rank";
  const bundle = tools.createToolSearchTools({
    conversationId,
    entries: [
      { tool: mcpTool("mcp_github_create_issue", "Create a GitHub issue"), serverLabel: "GitHub" },
      { tool: mcpTool("mcp_github_list_repos", "List repositories"), serverLabel: "GitHub" },
      { tool: mcpTool("mcp_db_query", "Run a SQL query against the database"), serverLabel: "DB" },
    ],
  });

  const result = await bundle.executeToolCall(createToolCall({ query: "github issue" }));
  assert.equal(result.isError, false);
  assert.equal(result.details.kind, "tool_search");
  // 名称+描述双命中的 create_issue 排最前且被激活。
  assert.equal(result.details.activated[0], "mcp_github_create_issue");
  assert.match(result.content[0].text, /mcp_github_create_issue/);
  assert.match(result.content[0].text, /callable directly/);
  const activation = tools.getMcpToolActivation(conversationId);
  assert.ok(activation.has("mcp_github_create_issue"));
  assert.ok(!activation.has("mcp_db_query"));

  // 空命中给出引导而非报错。
  const miss = await bundle.executeToolCall(createToolCall({ query: "zzzz-nothing" }, "call-2"));
  assert.equal(miss.isError, false);
  assert.deepEqual(miss.details.activated, []);
  assert.match(miss.content[0].text, /No deferred MCP tools matched/);

  // 缺 query 报参数错误。
  const invalid = await bundle.executeToolCall(createToolCall({}, "call-3"));
  assert.equal(invalid.isError, true);
});

test("activation is per-conversation and clearable", async () => {
  const { tools } = loadModules();
  const entries = [{ tool: mcpTool("mcp_docs_search", "Search docs"), serverLabel: "Docs" }];
  const bundleA = tools.createToolSearchTools({ conversationId: "conv-a", entries });
  await bundleA.executeToolCall(createToolCall({ query: "docs" }, "call-a"));
  assert.ok(tools.getMcpToolActivation("conv-a").has("mcp_docs_search"));
  assert.ok(!tools.getMcpToolActivation("conv-b").has("mcp_docs_search"));

  tools.clearMcpToolActivation("conv-a");
  assert.ok(!tools.getMcpToolActivation("conv-a").has("mcp_docs_search"));
});

test("buildMcpRequestToolFilter hides only deactivated MCP tools", () => {
  const { tools } = loadModules();
  const conversationId = "conv-filter";
  const metadataByName = new Map([
    ["Read", { groupId: "fs", isReadOnly: true }],
    ["mcp_docs_search", { groupId: "mcp", isReadOnly: false }],
    ["mcp_db_query", { groupId: "mcp", isReadOnly: false }],
  ]);
  const filter = tools.buildMcpRequestToolFilter({ conversationId, metadataByName });
  assert.equal(filter("Read"), true);
  assert.equal(filter("ToolSearch"), true);
  assert.equal(filter("mcp_docs_search"), false);

  // 激活集是活引用:激活后同一谓词立即放行(runner 每轮重估)。
  tools.getMcpToolActivation(conversationId).add("mcp_docs_search");
  assert.equal(filter("mcp_docs_search"), true);
  assert.equal(filter("mcp_db_query"), false);
});
