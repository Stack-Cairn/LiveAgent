import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Battle 2: this suite now drives crates/core, the engine that actually ships.
// The frontend copy under src/lib was a duplicate and has been removed.
// crates/core modules that talk to the Rust backend read this at import time.
process.env.LIVEAGENT_BACKEND_PORT ??= "0";
const coreRootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)), "../core");
const coreSrc = (rel) => path.join(coreRootDir, "src", rel);
// core 走 HTTP callBackend，前端副本走 tauri invoke —— 迁移后 mock 换成前者。
const backendClientPath = coreSrc("backendClient.ts");

function createToolCall(id, name, args = {}) {
  return {
    type: "toolCall",
    id,
    name,
    arguments: args,
  };
}

function createServer(id) {
  return {
    id,
    enabled: true,
    transport: "stdio",
    command: "mock-mcp-server",
    args: [],
    env: {},
  };
}

test("MCP business tool calls are serialized per server", async () => {
  let activeCalls = 0;
  let maxActiveCalls = 0;
  const events = [];
  const loader = createTsModuleLoader({
    mocks: {
      [backendClientPath]: {
        async callBackend(command, args) {
          if (command === "mcp_list_tools") {
            return [
              {
                serverId: "docs",
                serverLabel: "Docs",
                name: "search",
                description: "Search docs",
                inputSchema: { type: "object" },
              },
              {
                serverId: "docs",
                serverLabel: "Docs",
                name: "read",
                description: "Read docs",
                inputSchema: { type: "object" },
              },
            ];
          }
          if (command !== "mcp_call_tool") {
            throw new Error(`Unexpected invoke: ${command}`);
          }

          activeCalls += 1;
          maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
          events.push(`start:${args.tool_name}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
          events.push(`end:${args.tool_name}`);
          activeCalls -= 1;
          return {
            content: [{ type: "text", text: `ok:${args.tool_name}` }],
            isError: false,
            details: {},
          };
        },
      },
    },
  });

  const { createMcpTools } = loader.loadModule(coreSrc("tools/mcpTools.ts"));
  const bundle = await createMcpTools({
    servers: [createServer("docs")],
  });
  const search = bundle.tools.find((tool) => tool.name.endsWith("_search"));
  const read = bundle.tools.find((tool) => tool.name.endsWith("_read"));

  assert.ok(search);
  assert.ok(read);

  const [searchResult, readResult] = await Promise.all([
    bundle.executeToolCall(createToolCall("call-search", search.name, { q: "agent" })),
    bundle.executeToolCall(createToolCall("call-read", read.name, { id: "agent" })),
  ]);

  assert.equal(searchResult.isError, false);
  assert.equal(readResult.isError, false);
  assert.equal(maxActiveCalls, 1);
  assert.deepEqual(events, ["start:search", "end:search", "start:read", "end:read"]);
});

test("MCP business tool calls on different servers can run concurrently", async () => {
  let activeCalls = 0;
  let maxActiveCalls = 0;
  const loader = createTsModuleLoader({
    mocks: {
      [backendClientPath]: {
        async callBackend(command, args) {
          if (command === "mcp_list_tools") {
            return [
              {
                serverId: "docs",
                serverLabel: "Docs",
                name: "search",
                description: "Search docs",
                inputSchema: { type: "object" },
              },
              {
                serverId: "issues",
                serverLabel: "Issues",
                name: "search",
                description: "Search issues",
                inputSchema: { type: "object" },
              },
            ];
          }
          if (command !== "mcp_call_tool") {
            throw new Error(`Unexpected invoke: ${command}`);
          }

          activeCalls += 1;
          maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
          await new Promise((resolve) => setTimeout(resolve, 20));
          activeCalls -= 1;
          return {
            content: [{ type: "text", text: `ok:${args.server_id}` }],
            isError: false,
            details: {},
          };
        },
      },
    },
  });

  const { createMcpTools } = loader.loadModule(coreSrc("tools/mcpTools.ts"));
  const bundle = await createMcpTools({
    servers: [createServer("docs"), createServer("issues")],
  });
  const docsSearch = bundle.tools.find((tool) => tool.name.startsWith("mcp_docs_"));
  const issuesSearch = bundle.tools.find((tool) => tool.name.startsWith("mcp_issues_"));

  assert.ok(docsSearch);
  assert.ok(issuesSearch);

  await Promise.all([
    bundle.executeToolCall(createToolCall("call-docs", docsSearch.name, { q: "agent" })),
    bundle.executeToolCall(createToolCall("call-issues", issuesSearch.name, { q: "agent" })),
  ]);

  assert.equal(maxActiveCalls, 2);
});

test("MCP abort releases the tool call and requests Rust runtime cancellation", async () => {
  let resolveCall;
  const callPromise = new Promise((resolve) => {
    resolveCall = resolve;
  });
  const invocations = [];
  const loader = createTsModuleLoader({
    mocks: {
      [backendClientPath]: {
        async callBackend(command, args) {
          invocations.push({ command, args });
          if (command === "mcp_list_tools") {
            return [
              {
                serverId: "docs",
                serverLabel: "Docs",
                name: "search",
                description: "Search docs",
                inputSchema: { type: "object" },
              },
            ];
          }
          if (command === "mcp_call_tool") {
            return callPromise;
          }
          if (command === "runtime_cancel") {
            return { cancelled: true };
          }
          throw new Error("Unexpected invoke: " + command);
        },
      },
    },
  });
  const { createMcpTools } = loader.loadModule(coreSrc("tools/mcpTools.ts"));
  const bundle = await createMcpTools({ servers: [createServer("docs")] });
  const search = bundle.tools[0];
  const controller = new AbortController();

  const resultPromise = bundle.executeToolCall(
    createToolCall("call-abort", search.name, { q: "agent" }),
    controller.signal,
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const result = await resultPromise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Cancelled/);
  const callInvocation = invocations.find(
    (call) =>
      call.command === "mcp_call_tool" &&
      typeof call.args.run_id === "string" &&
      call.args.run_id.startsWith("mcp:call-abort:"),
  );
  assert.ok(callInvocation, "the tool call must carry a unique mcp run id");
  assert.ok(
    invocations.some(
      (call) =>
        call.command === "runtime_cancel" && call.args.run_id === callInvocation.args.run_id,
    ),
    "runtime cancel must target the same run id as the tool call",
  );

  resolveCall({ content: [], isError: false, details: {} });
});

test("an abort while queued on the per-server lock still releases the lock", async () => {
  let resolveFirstCall;
  const firstCallGate = new Promise((resolve) => {
    resolveFirstCall = resolve;
  });
  let sawFirstCall = false;
  const loader = createTsModuleLoader({
    mocks: {
      [backendClientPath]: {
        async callBackend(command) {
          if (command === "mcp_list_tools") {
            return [
              {
                serverId: "docs",
                serverLabel: "Docs",
                name: "search",
                description: "Search docs",
                inputSchema: { type: "object" },
              },
              {
                serverId: "docs",
                serverLabel: "Docs",
                name: "read",
                description: "Read docs",
                inputSchema: { type: "object" },
              },
            ];
          }
          if (command === "runtime_cancel") {
            return { cancelled: true };
          }
          if (command === "mcp_call_tool") {
            if (!sawFirstCall) {
              sawFirstCall = true;
              return firstCallGate;
            }
            return { content: [{ type: "text", text: "ok" }], isError: false, details: {} };
          }
          throw new Error("Unexpected invoke: " + command);
        },
      },
    },
  });
  const { createMcpTools } = loader.loadModule(coreSrc("tools/mcpTools.ts"));
  const bundle = await createMcpTools({ servers: [createServer("docs")] });
  const [searchTool, readTool] = bundle.tools;

  // Two concurrent calls against the same server: the second waits on the
  // per-server lock; the user then stops the run while it is still queued.
  const controller = new AbortController();
  const first = bundle.executeToolCall(createToolCall("c1", searchTool.name), controller.signal);
  const second = bundle.executeToolCall(createToolCall("c2", readTool.name), controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.isError, true);
  assert.equal(secondResult.isError, true);

  // A later call with a fresh signal must not hang: an abort while queued on
  // the lock has to release it (regression: the whole server deadlocked).
  const next = bundle.executeToolCall(createToolCall("c3", searchTool.name));
  const outcome = await Promise.race([
    next,
    new Promise((resolve) => setTimeout(() => resolve("deadlocked"), 2_000)),
  ]);
  assert.notEqual(outcome, "deadlocked", "per-server lock leaked after an aborted queued call");
  assert.equal(outcome.isError, false);

  resolveFirstCall({ content: [], isError: false, details: {} });
});
