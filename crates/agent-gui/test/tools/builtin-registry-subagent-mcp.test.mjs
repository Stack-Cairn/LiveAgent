import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
import { createFakeStoreIpc } from "../subagents/harness.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const agentRunnerModulePath = path.join(rootDir, "src/lib/chat/runner/agentRunner.ts");

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

function createAgentToolCall(argumentsValue, id = "call-agent") {
  return { type: "toolCall", id, name: "Agent", arguments: argumentsValue };
}

const DOCS_SERVER = {
  id: "docs",
  enabled: true,
  transport: "stdio",
  command: "mock-mcp-server",
  args: [],
  env: {},
};

function createRegistryHarness({ onRun } = {}) {
  const runnerCalls = [];
  const listedServerIds = [];
  const listedServerCommands = [];
  const invokeCalls = [];
  const loader = createTsModuleLoader({
    mocks: {
      [agentRunnerModulePath]: {
        async runAssistantWithTools(params) {
          runnerCalls.push(params);
          params.onTurnStart?.(1);
          if (onRun) return onRun(params);
          const assistant = createAssistant("subagent done");
          return { assistant, messages: [assistant], emittedMessages: [assistant] };
        },
      },
      "@tauri-apps/api/path": {
        async homeDir() {
          return "/Users/test";
        },
      },
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invokeCalls.push({ command, args });
          if (command === "mcp_list_tools") {
            listedServerIds.push((args.servers ?? []).map((server) => server.id));
            listedServerCommands.push((args.servers ?? []).map((server) => server.command));
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
          if (command === "subagent_worktree_create") {
            return {
              repoRoot: "/repo",
              worktreeRoot: "/tmp/liveagent-subagents/agent-a",
              workdir: "/tmp/liveagent-subagents/agent-a",
              branchName: "liveagent/subagent/agent-a",
            };
          }
          if (command === "subagent_worktree_status") {
            return {
              changed: false,
              status: "",
              diffStat: "",
              diff: "",
              diffTruncated: false,
              untrackedFiles: [],
            };
          }
          if (command === "subagent_worktree_cleanup") {
            return {
              worktreeRoot: args.input.worktreeRoot,
              branchName: args.input.branchName,
              removed: true,
              branchDeleted: true,
            };
          }
          if (command === "shell_session_start") {
            return {
              status: "completed",
              session_id: args.session_id,
              cursor: 0,
              output: [],
              output_truncated: false,
              has_more: false,
              exit_code: 0,
              duration_ms: 1,
              shell: "bash",
              platform: "linux",
              profile: "posix-bash",
              shell_family: "posix",
              sandbox: "bubblewrap",
              timeout_ms: null,
            };
          }
          throw new Error(`Unexpected invoke: ${command}`);
        },
      },
    },
  });
  return { loader, runnerCalls, listedServerIds, listedServerCommands, invokeCalls };
}

async function buildRegistry(harness, { withSubagentRuntime, storeIpc, sandbox } = {}) {
  const { loader } = harness;
  const { buildBuiltinToolRegistry } = loader.loadModule("src/lib/tools/builtinRegistry.ts");
  const { createFileToolState } = loader.loadModule("src/lib/tools/fileToolState.ts");
  const mcpSettingsHolder = { value: { selected: ["docs"], servers: [DOCS_SERVER] } };
  const baseParams = {
    workdir: "/tmp/liveagent-subagent-registry-test",
    providerId: "codex",
    fileState: createFileToolState(),
    skillsEnabled: true,
    runtimeScope: "chat",
    getMcpSettings: () => mcpSettingsHolder.value,
    sandbox,
  };
  if (!withSubagentRuntime) {
    return { registry: await buildBuiltinToolRegistry(baseParams), mcpSettingsHolder };
  }

  const storeModule = loader.loadModule("src/lib/subagents/store.ts");
  const schedulerModule = loader.loadModule("src/lib/subagents/scheduler.ts");
  const ipc = storeIpc ?? createFakeStoreIpc();
  const store = storeModule.createSubagentConversationStore({
    conversationId: "conversation-1",
    ipc,
  });
  const registry = await buildBuiltinToolRegistry({
    ...baseParams,
    subagentRuntime: {
      providerId: "codex",
      model: "gpt-5",
      runtime: { baseUrl: "https://api.example.test/v1", apiKey: "test-key" },
      sessionId: "parent-session",
      templates: [
        {
          id: "reviewer",
          name: "Reviewer",
          description: "Review code paths",
          prompt: "Focus on concrete defects.",
        },
      ],
      store,
      scheduler: schedulerModule.createSubagentScheduler(),
    },
  });
  return { registry, store, ipc, mcpSettingsHolder };
}

test("registry without a subagent runtime exposes neither Agent nor SendMessage", async () => {
  const harness = createRegistryHarness();
  const { registry } = await buildRegistry(harness, { withSubagentRuntime: false });
  const names = registry.tools.map((tool) => tool.name);
  assert.ok(!names.includes("Agent"));
  assert.ok(!names.includes("SendMessage"));
  // Sanity: the base surface is otherwise intact.
  assert.ok(names.includes("Read"));
  assert.ok(names.includes("mcp_docs_search"));
  // 内置工具不再声明 JSON-schema 约束采样(部分 provider 在 strict 模式下
  // 按白名单校验 schema 关键字,minimum/maxItems 等会 400 整轮请求)。
  assert.equal(
    registry.tools.find((tool) => tool.name === "Read").constrainedSampling,
    undefined,
  );
  assert.equal(
    registry.tools.find((tool) => tool.name === "mcp_docs_search").constrainedSampling,
    undefined,
  );
});

test("registry with a subagent runtime exposes Agent and the parent SendMessage", async () => {
  const harness = createRegistryHarness();
  const { registry } = await buildRegistry(harness, { withSubagentRuntime: true });
  const names = registry.tools.map((tool) => tool.name);
  assert.ok(names.includes("Agent"));
  assert.ok(names.includes("SendMessage"));
  assert.equal(registry.metadataByName.get("Agent").groupId, "subagent");
  assert.equal(registry.metadataByName.get("Agent").isReadOnly, false);
  assert.equal(registry.metadataByName.get("SendMessage").isReadOnly, true);
  assert.ok(registry.hasTool("agent"));
  assert.equal(
    registry.tools.find((tool) => tool.name === "Agent").constrainedSampling,
    undefined,
  );
});

test("Agent tool description embeds the hydrated roster and enabled templates", async () => {
  const harness = createRegistryHarness();
  const storeIpc = createFakeStoreIpc();
  storeIpc.seedIdentity({
    parentConversationId: "conversation-1",
    agentId: "historian",
    name: "Historian",
    role: "History research",
    identityPrompt: "",
    lastMode: "readonly",
    createdAt: 1,
    updatedAt: 2,
  });
  storeIpc.seedRun({
    run: {
      id: "run-1",
      parentConversationId: "conversation-1",
      parentToolCallId: "call-old",
      agentId: "historian",
      agentIndex: 0,
      agentTotal: 1,
      prompt: "study the era",
      mode: "readonly",
      status: "completed",
      providerId: "codex",
      model: "gpt-5",
      contextSchemaVersion: 2,
      activeSegmentIndex: 0,
      totalSegmentCount: 1,
      totalMessageCount: 2,
      roundCount: 1,
      toolCallCount: 0,
      compactionCount: 0,
      summary: "Era catalogued.",
      startedAt: 1,
      updatedAt: 2,
    },
    segments: [],
  });

  const { registry } = await buildRegistry(harness, { withSubagentRuntime: true, storeIpc });
  const agentTool = registry.tools.find((tool) => tool.name === "Agent");
  assert.match(
    agentTool.description,
    /id=historian name=Historian role=History research mode=readonly status=completed summary=Era catalogued\./,
  );
  assert.match(agentTool.description, /reviewer \(Reviewer\) - Review code paths/);
});

test("worktree children get fs/shell/ro-memory/MCP tools but no skills, system, or manager tools", async () => {
  const harness = createRegistryHarness();
  const { registry } = await buildRegistry(harness, { withSubagentRuntime: true });

  const result = await registry.executeToolCall(
    createAgentToolCall({
      agents: [{ id: "agent-a", prompt: "Use docs if useful.", mode: "worktree" }],
    }),
  );
  assert.equal(result.isError, false);
  // MCP tools listed once for the parent registry and once for the child.
  assert.deepEqual(harness.listedServerIds, [["docs"], ["docs"]]);
  assert.equal(harness.runnerCalls.length, 1);
  const names = harness.runnerCalls[0].tools.map((tool) => tool.name);

  assert.ok(names.includes("Read"));
  assert.ok(names.includes("Write"));
  assert.ok(names.includes("Bash"));
  assert.ok(names.includes("mcp_docs_search"));
  assert.ok(names.includes("SendMessage"));
  // Read-only memory stays available in worktree mode.
  assert.ok(names.includes("MemoryManager"));

  assert.ok(!names.includes("Agent"));
  assert.ok(!names.includes("SkillsManager"));
  assert.ok(!names.includes("McpManager"));
  assert.ok(!names.includes("CronTaskManager"));
  assert.ok(!names.includes("ReadTerminal"));

  // The child executed inside the isolated worktree workdir.
  assert.equal(harness.runnerCalls[0].workdir, "/tmp/liveagent-subagents/agent-a");
});

test("worktree children inherit the parent offline sandbox when Bash executes", async () => {
  const harness = createRegistryHarness({
    onRun: async (params) => {
      const toolCall = {
        type: "toolCall",
        id: "child-bash",
        name: "Bash",
        arguments: { command: "printf child" },
      };
      params.onToolExecutionStart?.(toolCall);
      const toolResult = await params.executeToolCall(toolCall);
      assert.equal(toolResult.isError, false);
      const assistant = createAssistant("subagent done");
      return {
        assistant,
        messages: [toolCall, toolResult, assistant],
        emittedMessages: [toolCall, toolResult, assistant],
      };
    },
  });
  const { registry } = await buildRegistry(harness, {
    withSubagentRuntime: true,
    sandbox: { enabled: true, allowNetwork: false },
  });

  const bash = registry.tools.find((tool) => tool.name === "Bash");
  assert.match(bash.description, /Sandbox mode is ON/);

  const result = await registry.executeToolCall(
    createAgentToolCall({
      agents: [{ id: "agent-a", prompt: "Run the probe.", mode: "worktree" }],
    }),
  );
  assert.equal(result.isError, false);
  assert.equal(harness.runnerCalls.length, 1);
  assert.equal(harness.runnerCalls[0].workdir, "/tmp/liveagent-subagents/agent-a");

  const sessionStart = harness.invokeCalls.find((call) => call.command === "shell_session_start");
  assert.ok(sessionStart);
  assert.equal(sessionStart.args.workdir, "/tmp/liveagent-subagents/agent-a");
  assert.equal(sessionStart.args.sandbox, true);
  assert.equal(sessionStart.args.sandbox_allow_network, false);
});

test("subagent registries list MCP servers from live settings, not turn-start snapshots", async () => {
  const harness = createRegistryHarness();
  const { registry, mcpSettingsHolder } = await buildRegistry(harness, {
    withSubagentRuntime: true,
  });

  // The config changes after the parent registry was built (e.g. the model
  // just ran McpManager update); the child registry must see the new config
  // instead of rolling the server back to the turn-start snapshot.
  mcpSettingsHolder.value = {
    selected: ["docs"],
    servers: [{ ...DOCS_SERVER, command: "mock-mcp-server-v2" }],
  };

  const result = await registry.executeToolCall(
    createAgentToolCall({
      agents: [{ id: "agent-live", prompt: "Use docs if useful.", mode: "worktree" }],
    }),
  );
  assert.equal(result.isError, false);
  assert.deepEqual(harness.listedServerCommands, [["mock-mcp-server"], ["mock-mcp-server-v2"]]);
});

test("read-only children inherit MCP business tools but no write, shell, or manager tools", async () => {
  const harness = createRegistryHarness();
  const { registry } = await buildRegistry(harness, { withSubagentRuntime: true });

  const result = await registry.executeToolCall(
    createAgentToolCall({
      agents: [{ id: "agent-b", prompt: "Search docs if useful.", mode: "readonly" }],
    }),
  );
  assert.equal(result.isError, false);
  assert.equal(harness.runnerCalls.length, 1);
  const names = harness.runnerCalls[0].tools.map((tool) => tool.name);

  assert.ok(names.includes("Read"));
  assert.ok(names.includes("mcp_docs_search"));
  assert.ok(names.includes("SendMessage"));

  assert.ok(!names.includes("Write"));
  assert.ok(!names.includes("Bash"));
  assert.ok(!names.includes("Agent"));
  assert.ok(!names.includes("McpManager"));
  // Parent memory is read-write, so readonly children do not receive it.
  assert.ok(!names.includes("MemoryManager"));
});

test("plan mode filters the registry to read-only + plan + collaboration tools", async () => {
  const harness = createRegistryHarness();
  const { loader } = harness;
  const { buildBuiltinToolRegistry } = loader.loadModule("src/lib/tools/builtinRegistry.ts");
  const { createFileToolState } = loader.loadModule("src/lib/tools/fileToolState.ts");
  const storeModule = loader.loadModule("src/lib/subagents/store.ts");
  const schedulerModule = loader.loadModule("src/lib/subagents/scheduler.ts");
  const store = storeModule.createSubagentConversationStore({
    conversationId: "conversation-1",
    ipc: createFakeStoreIpc(),
  });
  const approvals = [];
  const registry = await buildBuiltinToolRegistry({
    workdir: "/tmp/liveagent-plan-mode-registry-test",
    providerId: "codex",
    fileState: createFileToolState(),
    skillsEnabled: true,
    runtimeScope: "chat",
    getMcpSettings: () => ({ selected: ["docs"], servers: [DOCS_SERVER] }),
    taskStateStore: {
      runId: "run-1",
      getState: () => undefined,
      commitState: async () => undefined,
    },
    askUserQuestionConversationId: "conversation-1",
    planMode: {
      conversationId: "conversation-1",
      onPlanApproved: (input) => approvals.push(input.plan),
    },
    subagentRuntime: {
      providerId: "codex",
      model: "gpt-5",
      runtime: { baseUrl: "https://api.example.test/v1", apiKey: "test-key" },
      sessionId: "parent-session",
      templates: [],
      store,
      scheduler: schedulerModule.createSubagentScheduler(),
    },
  });
  const names = registry.tools.map((tool) => tool.name);
  // 只读、计划闸门与子代理协作工具在表内。
  for (const expected of ["Read", "Glob", "Grep", "TaskList", "AskUserQuestion", "ExitPlanMode", "Agent", "SendMessage"]) {
    assert.ok(names.includes(expected), `expected ${expected} in plan-mode tools`);
  }
  // 一切写能力(内置与 MCP)不进模型工具表。
  for (const excluded of ["Bash", "Write", "Edit", "Delete", "TaskCreate", "TaskUpdate", "McpManager", "MemoryManager", "CronTaskManager", "mcp_docs_search"]) {
    assert.ok(!names.includes(excluded), `did not expect ${excluded} in plan-mode tools`);
  }
  // Agent 工具描述带 plan mode 提示(validate 层同时强制 readonly)。
  assert.match(registry.tools.find((tool) => tool.name === "Agent").description, /PLAN MODE/);
  // executeToolCall 仍能执行被裁掉的工具吗?——不应依赖:执行层由 gate 后备拦截。
});
