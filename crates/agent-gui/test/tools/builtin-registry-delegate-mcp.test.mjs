import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const agentRunnerModulePath = path.join(rootDir, "src/lib/chat/runner/agentRunner.ts");

function createToolCall(argumentsValue) {
  return {
    type: "toolCall",
    id: "call-agent",
    name: "Agent",
    arguments: argumentsValue,
  };
}

function createAssistant(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5",
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

test("delegated worktree agents inherit enabled MCP business tools but not McpManager", async () => {
  const runnerCalls = [];
  const listedServerIds = [];
  const loader = createTsModuleLoader({
    mocks: {
      [agentRunnerModulePath]: {
        async runAssistantWithTools(params) {
          runnerCalls.push(params);
          params.onTurnStart?.(1);
          return {
            assistant: createAssistant("subagent done"),
            messages: [createAssistant("subagent done")],
            emittedMessages: [createAssistant("subagent done")],
          };
        },
      },
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          if (command === "mcp_list_tools") {
            listedServerIds.push((args.servers ?? []).map((server) => server.id));
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
          if (command === "delegate_create_worktree") {
            return {
              repo_root: "/repo",
              worktree_root: "/tmp/liveagent-subagents/agent-a",
              workdir: "/tmp/liveagent-subagents/agent-a",
              branch_name: "liveagent/subagent/agent-a",
            };
          }
          if (command === "delegate_worktree_status") {
            return {
              changed: false,
              status: "",
              diff_stat: "",
              diff: "",
              diff_truncated: false,
              untracked_files: [],
            };
          }
          if (command === "delegate_cleanup_worktree") {
            return {
              worktreeRoot: args.worktree_root,
              branchName: args.branch_name,
              removed: true,
              branchDeleted: true,
            };
          }
          if (command === "subagent_run_upsert") {
            return { id: args.input.id };
          }
          if (command === "subagent_run_append_event") {
            return { id: 1, ...args.input };
          }
          if (command === "subagent_run_list") {
            return [];
          }
          throw new Error(`Unexpected invoke: ${command}`);
        },
      },
    },
  });

  const { buildBuiltinToolRegistry } = loader.loadModule("src/lib/tools/builtinRegistry.ts");
  const { createFileToolState } = loader.loadModule("src/lib/tools/fileToolState.ts");
  const registry = await buildBuiltinToolRegistry({
    workdir: "/tmp/liveagent-delegate-test",
    providerId: "codex",
    fileState: createFileToolState(),
    skillsEnabled: true,
    runtimeScope: "chat",
    selectedSystemToolIds: [],
    mcpSettings: {
      selected: ["docs"],
      servers: [
        {
          id: "docs",
          enabled: true,
          transport: "stdio",
          command: "mock-mcp-server",
          args: [],
          env: {},
        },
      ],
    },
    enabledMcpServerIds: ["docs"],
    selectableMcpServers: [
      {
        id: "docs",
        enabled: true,
        transport: "stdio",
        command: "mock-mcp-server",
        args: [],
        env: {},
      },
    ],
    delegateRuntime: {
      providerId: "codex",
      model: "gpt-5",
      runtime: {
        baseUrl: "https://api.example.test/v1",
        apiKey: "test-key",
      },
      sessionId: "parent-session",
      agentTemplates: [],
    },
  });

  const result = await registry.executeToolCall(
    createToolCall({
      description: "Use docs",
      prompt: "Search docs if useful.",
      mode: "worktree",
    }),
  );

  assert.equal(result.isError, false);
  assert.deepEqual(listedServerIds, [["docs"], ["docs"]]);
  assert.equal(runnerCalls.length, 1);
  assert.ok(runnerCalls[0].tools.some((tool) => tool.name === "mcp_docs_search"));
  assert.ok(!runnerCalls[0].tools.some((tool) => tool.name === "McpManager"));
  assert.ok(!runnerCalls[0].tools.some((tool) => tool.name === "Agent"));
});

test("delegated read-only agents inherit enabled MCP business tools but not McpManager", async () => {
  const runnerCalls = [];
  const loader = createTsModuleLoader({
    mocks: {
      [agentRunnerModulePath]: {
        async runAssistantWithTools(params) {
          runnerCalls.push(params);
          params.onTurnStart?.(1);
          return {
            assistant: createAssistant("subagent done"),
            messages: [createAssistant("subagent done")],
            emittedMessages: [createAssistant("subagent done")],
          };
        },
      },
      "@tauri-apps/api/core": {
        async invoke(command) {
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
          if (command === "subagent_run_upsert") {
            return {};
          }
          if (command === "subagent_run_append_event") {
            return {};
          }
          if (command === "subagent_run_list") {
            return [];
          }
          throw new Error(`Unexpected invoke: ${command}`);
        },
      },
    },
  });

  const { buildBuiltinToolRegistry } = loader.loadModule("src/lib/tools/builtinRegistry.ts");
  const { createFileToolState } = loader.loadModule("src/lib/tools/fileToolState.ts");
  const docsServer = {
    id: "docs",
    enabled: true,
    transport: "stdio",
    command: "mock-mcp-server",
    args: [],
    env: {},
  };
  const registry = await buildBuiltinToolRegistry({
    workdir: "/tmp/liveagent-delegate-test",
    providerId: "codex",
    fileState: createFileToolState(),
    skillsEnabled: true,
    runtimeScope: "chat",
    selectedSystemToolIds: [],
    mcpSettings: {
      selected: ["docs"],
      servers: [docsServer],
    },
    enabledMcpServerIds: ["docs"],
    selectableMcpServers: [docsServer],
    delegateRuntime: {
      providerId: "codex",
      model: "gpt-5",
      runtime: {
        baseUrl: "https://api.example.test/v1",
        apiKey: "test-key",
      },
      sessionId: "parent-session",
      agentTemplates: [],
    },
  });

  const result = await registry.executeToolCall(
    createToolCall({
      description: "Use docs",
      prompt: "Search docs if useful.",
      mode: "readonly",
    }),
  );

  assert.equal(result.isError, false);
  assert.equal(runnerCalls.length, 1);
  assert.ok(runnerCalls[0].tools.some((tool) => tool.name === "mcp_docs_search"));
  assert.ok(!runnerCalls[0].tools.some((tool) => tool.name === "McpManager"));
  assert.ok(!runnerCalls[0].tools.some((tool) => tool.name === "Agent"));
});

test("delegated agents inherit enabled CrateBay sandbox system tools", async () => {
  const runnerCalls = [];
  const loader = createTsModuleLoader({
    mocks: {
      [agentRunnerModulePath]: {
        async runAssistantWithTools(params) {
          runnerCalls.push(params);
          params.onTurnStart?.(1);
          return {
            assistant: createAssistant("subagent done"),
            messages: [createAssistant("subagent done")],
            emittedMessages: [createAssistant("subagent done")],
          };
        },
      },
      "@tauri-apps/api/core": {
        async invoke(command) {
          if (command === "subagent_run_upsert") {
            return {};
          }
          if (command === "subagent_run_append_event") {
            return {};
          }
          if (command === "subagent_run_list") {
            return [];
          }
          throw new Error(`Unexpected invoke: ${command}`);
        },
      },
    },
  });

  const { buildBuiltinToolRegistry } = loader.loadModule("src/lib/tools/builtinRegistry.ts");
  const { createFileToolState } = loader.loadModule("src/lib/tools/fileToolState.ts");
  const registry = await buildBuiltinToolRegistry({
    workdir: "/tmp/liveagent-delegate-cratebay-test",
    providerId: "codex",
    fileState: createFileToolState(),
    skillsEnabled: true,
    runtimeScope: "chat",
    selectedSystemToolIds: ["cratebay_status", "http_get_test"],
    mcpSettings: {
      selected: [],
      servers: [],
    },
    enabledMcpServerIds: [],
    selectableMcpServers: [],
    delegateRuntime: {
      providerId: "codex",
      model: "gpt-5",
      runtime: {
        baseUrl: "https://api.example.test/v1",
        apiKey: "test-key",
      },
      sessionId: "parent-session",
      agentTemplates: [],
    },
  });

  const result = await registry.executeToolCall(
    createToolCall({
      description: "Use sandbox",
      prompt: "Check sandbox status if useful.",
      mode: "readonly",
    }),
  );

  assert.equal(result.isError, false);
  assert.equal(runnerCalls.length, 1);
  assert.ok(runnerCalls[0].tools.some((tool) => tool.name === "CrateBayStatus"));
  assert.ok(!runnerCalls[0].tools.some((tool) => tool.name === "HttpGetTest"));
  assert.ok(!runnerCalls[0].tools.some((tool) => tool.name === "Agent"));
});
