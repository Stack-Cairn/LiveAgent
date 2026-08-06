import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { RuntimePlatform } from "../runtimePlatform";
import {
  type McpSettings,
  type McpSettingsOp,
  type ProviderId,
  type SshHostConfig,
  selectEnabledMcpServers,
} from "../settings";
import { createAskUserQuestionTools } from "./askUserQuestionTools";
import type {
  BuiltinToolBundle,
  BuiltinToolExecutionContext,
  BuiltinToolMetadata,
} from "./builtinTypes";
import { createCronTools } from "./cronTools";
import { createFileToolState, type FileToolState } from "./fileToolState";
import { createFsTools } from "./fsTools";
import { createMcpManagerTools } from "./mcpManagerTools";
import { createMcpTools } from "./mcpTools";
import { createMemoryTools } from "./memoryTools";
import { createShellTools } from "./shellTools";
import type { SkillAccessPolicy } from "./skillAccessPolicy";
import { createSkillTools } from "./skillTools";
import { createSSHManagerTools, type SshManagerSessionChange } from "./sshManagerTools";
import { createSubagentTools } from "../subagents/agentTool";
import { createSendMessageTools } from "../subagents/sendMessageTool";
import type { SubagentConversationStore } from "../subagents/store";
import type { SubagentScheduler } from "../subagents/scheduler";
import { SUBAGENT_PARENT_ID, type SubagentTemplate } from "../subagents/types";
import type { ProviderRuntimeConfig } from "../providers/runtime/types";
import type { SystemToolRuntimeScope } from "./systemToolOptions";
import { createTerminalTools } from "./terminalTools";
import { createTodoTools, type TodoToolState } from "./todoTools";
import { createTunnelManagerTools, type TunnelManagerChange } from "./tunnelManagerTools";
import { homedir } from "node:os";

export type BuiltinToolRegistry = {
  tools: BuiltinToolBundle["tools"];
  executeToolCall: (
    toolCall: ToolCall,
    signal?: AbortSignal,
    context?: BuiltinToolExecutionContext,
  ) => Promise<ToolResultMessage>;
  metadataByName: Map<string, BuiltinToolMetadata>;
  hasTool: (toolName: string) => boolean;
};

// 第三方来源(MCP server / 插件)的工具名不受我们控制,可能撞车。撞车时不能像
// 内置工具那样 throw 打断整轮——那等于让一个坏插件废掉整个对话。改为:先到先
// 得、跳过后来者并告警;仅当两侧都是可信内置组时才 throw(那是编译期的开发 bug)。
const UNTRUSTED_TOOL_GROUPS: ReadonlySet<BuiltinToolBundle["groupId"]> = new Set(["mcp"]);

function createBuiltinToolRegistry(bundles: BuiltinToolBundle[]): BuiltinToolRegistry {
  const tools: BuiltinToolBundle["tools"] = [];
  const metadataByName = new Map<string, BuiltinToolMetadata>();
  const executorsByName = new Map<string, BuiltinToolBundle["executeToolCall"]>();
  const groupIdByToolName = new Map<string, BuiltinToolBundle["groupId"]>();
  const canonicalToolNameByLookupKey = new Map<string, string | null>();

  const registerCanonicalToolName = (toolName: string) => {
    const key = toolName.trim().toLowerCase();
    if (!key) return;
    const existing = canonicalToolNameByLookupKey.get(key);
    if (existing === undefined) {
      canonicalToolNameByLookupKey.set(key, toolName);
    } else if (existing !== toolName) {
      canonicalToolNameByLookupKey.set(key, null);
    }
  };

  const resolveToolName = (toolName: string) => {
    if (executorsByName.has(toolName)) return toolName;
    const canonical = canonicalToolNameByLookupKey.get(toolName.trim().toLowerCase());
    return canonical && executorsByName.has(canonical) ? canonical : null;
  };

  for (const bundle of bundles) {
    for (const tool of bundle.tools) {
      if (executorsByName.has(tool.name)) {
        const existingGroup = groupIdByToolName.get(tool.name);
        const bothTrusted =
          !UNTRUSTED_TOOL_GROUPS.has(bundle.groupId) &&
          existingGroup !== undefined &&
          !UNTRUSTED_TOOL_GROUPS.has(existingGroup);
        if (bothTrusted) {
          // 两个内置工具同名:编译期就该修的开发 bug,继续保持强失败。
          throw new Error(`Duplicate builtin tool name detected: ${tool.name}`);
        }
        // 涉及 MCP/插件的撞车:先到先得,跳过后来者,绝不打断整轮。
        console.warn(
          `[tools] Tool name "${tool.name}" from group "${bundle.groupId}" collides with an ` +
            `already-registered tool (group "${existingGroup ?? "unknown"}"); skipping the newcomer.`,
        );
        continue;
      }
      tools.push(tool);
      executorsByName.set(tool.name, bundle.executeToolCall);
      groupIdByToolName.set(tool.name, bundle.groupId);
      registerCanonicalToolName(tool.name);
      const metadata = bundle.metadataByName.get(tool.name);
      if (metadata) {
        metadataByName.set(tool.name, metadata);
      }
    }
  }

  return {
    tools,
    metadataByName,
    hasTool: (toolName) => resolveToolName(toolName) !== null,
    async executeToolCall(toolCall, signal, context) {
      const resolvedToolName = resolveToolName(toolCall.name);
      if (!resolvedToolName) {
        return {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: "text", text: `Unknown tool: ${toolCall.name}` }],
          details: {},
          isError: true,
          timestamp: Date.now(),
        };
      }
      const execute = executorsByName.get(resolvedToolName);
      if (!execute) {
        return {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: "text", text: `Unknown tool: ${toolCall.name}` }],
          details: {},
          isError: true,
          timestamp: Date.now(),
        };
      }
      const effectiveToolCall =
        resolvedToolName === toolCall.name ? toolCall : { ...toolCall, name: resolvedToolName };
      return execute(effectiveToolCall, signal, context);
    },
  };
}

type BuildBuiltinBaseToolRegistryParams = {
  workdir: string;
  providerId: ProviderId;
  runtimePlatform?: RuntimePlatform;
  fileState: FileToolState;
  skillsEnabled: boolean;
  skillsRootDir?: string;
  skillAccessPolicy?: SkillAccessPolicy;
  onManagedSkillsChanged?: (change: {
    action: "install" | "create";
    names: string[];
    baseDirs: string[];
  }) => void | Promise<void>;
  runtimeScope: SystemToolRuntimeScope;
  currentChatModel?: {
    customProviderId: string;
    model: string;
  };
  /** Live read of the authoritative MCP settings (never a turn-level snapshot). */
  getMcpSettings: () => McpSettings;
  /** Id-keyed merge commit into the authoritative settings; absent in read-only scopes. */
  applyMcpOps?: (ops: McpSettingsOp[]) => void;
  onMcpLoadError?: (message: string) => void;
  mcpLoadFailureMode?: "continue" | "throw";
  memoryToolMode?: "rw" | "ro";
  remoteWebTunnelsEnabled?: boolean;
  tunnelProjectPathKey?: string;
  tunnelPublicBaseUrl?: string;
  sshHosts?: SshHostConfig[];
  associatedSshHostIds?: string[];
  sshManagerRemoteAllowed?: boolean;
  onSshSessionsChanged?: (change: SshManagerSessionChange) => void | Promise<void>;
  onTunnelsChanged?: (change: TunnelManagerChange) => void | Promise<void>;
};

const resolveHomeDir = async () => {
  return homedir();
};

async function buildBaseBuiltinToolBundles(params: BuildBuiltinBaseToolRegistryParams) {
  const baseBundles: BuiltinToolBundle[] = [
    createFsTools({
      workdir: params.workdir,
      fileState: params.fileState,
      skillsRootEnabled: params.skillsEnabled,
      skillsRootDir: params.skillsRootDir,
      skillAccessPolicy: params.skillAccessPolicy,
      resolveHomeDir,
    }),
    createShellTools({
      workdir: params.workdir,
      providerId: params.providerId,
      runtimePlatform: params.runtimePlatform,
      skillsRootEnabled: params.skillsEnabled,
      skillsRootDir: params.skillsRootDir,
      skillAccessPolicy: params.skillAccessPolicy,
      managedProcessEnabled: params.runtimeScope === "chat",
      resolveHomeDir,
    }),
    ...(params.skillsEnabled
      ? [
          createSkillTools({
            workdir: params.workdir,
            skillAccessPolicy: params.skillAccessPolicy,
            onManagedSkillsChanged: params.onManagedSkillsChanged,
          }),
        ]
      : []),
    createCronTools({
      currentChatModel: params.currentChatModel,
      workdir: params.workdir,
    }),
    createMcpManagerTools({
      workdir: params.workdir,
      getMcpSettings: params.getMcpSettings,
      applyMcpOps: params.applyMcpOps,
      runtimeScope: params.runtimeScope,
      resolveHomeDir,
    }),
    createMemoryTools({
      workdir: params.workdir,
      mode: params.memoryToolMode ?? "rw",
    }),
    createTunnelManagerTools({
      enabled: params.remoteWebTunnelsEnabled === true && params.runtimeScope === "chat",
      runtimeScope: params.runtimeScope,
      projectPathKey: params.tunnelProjectPathKey,
      publicBaseUrl: params.tunnelPublicBaseUrl,
      onTunnelsChanged: params.onTunnelsChanged,
    }),
    createSSHManagerTools({
      enabled:
        params.runtimeScope === "chat" &&
        params.sshManagerRemoteAllowed !== false &&
        (params.associatedSshHostIds?.length ?? 0) > 0,
      runtimeScope: params.runtimeScope,
      workdir: params.workdir,
      projectPathKey: params.tunnelProjectPathKey,
      hosts: params.sshHosts,
      associatedHostIds: params.associatedSshHostIds,
      resolveHomeDir,
      onSshSessionsChanged: params.onSshSessionsChanged,
    }),
    ...(params.runtimeScope === "chat"
      ? [
          createTerminalTools({
            workdir: params.workdir,
          }),
        ]
      : []),
  ];

  const enabledServers = selectEnabledMcpServers(params.getMcpSettings());
  if (enabledServers.length > 0) {
    baseBundles.push(
      await createMcpTools({
        servers: enabledServers,
        onLoadError: params.onMcpLoadError,
        loadFailureMode: params.mcpLoadFailureMode,
      }),
    );
  }

  return baseBundles;
}

export async function buildBuiltinToolRegistry(
  params: BuildBuiltinBaseToolRegistryParams & {
    todoState?: TodoToolState;
    /** chat 场景注入交互式提问工具；自动化场景无人值守，不注册。 */
    askUserQuestionConversationId?: string;
    /** 存在即启用子代理委派(Agent/SendMessage);缺省则完全不注册。 */
    subagents?: {
      model: string;
      runtime: ProviderRuntimeConfig;
      sessionId?: string;
      templates?: SubagentTemplate[];
      store: SubagentConversationStore;
      scheduler: SubagentScheduler;
    };
  },
) {
  const baseBundles = await buildBaseBuiltinToolBundles(params);
  const todoBundles =
    params.runtimeScope === "chat" && params.todoState
      ? [createTodoTools({ state: params.todoState })]
      : [];
  const askUserQuestionBundles =
    params.runtimeScope === "chat" && params.askUserQuestionConversationId
      ? [createAskUserQuestionTools({ conversationId: params.askUserQuestionConversationId })]
      : [];
  const coreBundles = [...baseBundles, ...todoBundles, ...askUserQuestionBundles];

  // 子代理只在 chat 场景注册:自动化(cron)无人值守,不该再派生子代理。
  const subagentConfig = params.runtimeScope === "chat" ? params.subagents : undefined;
  if (!subagentConfig) {
    return createBuiltinToolRegistry(coreBundles);
  }

  // 父级工具表是子代理 readonly 模式的取材来源,故先建一次基础 registry;
  // Agent/SendMessage 再作为独立 bundle 合并进最终 registry。
  const parentRegistry = createBuiltinToolRegistry(coreBundles);
  // roster/templates 块要反映最新 store 状态,故在构造工具描述前先 hydrate。
  await subagentConfig.store.ready().catch(() => undefined);

  const subagentBundle = createSubagentTools({
    providerId: params.providerId,
    model: subagentConfig.model,
    runtime: subagentConfig.runtime,
    runtimePlatform: params.runtimePlatform,
    workdir: params.workdir,
    resolveHomeDir,
    sessionId: subagentConfig.sessionId,
    templates: subagentConfig.templates ?? [],
    store: subagentConfig.store,
    scheduler: subagentConfig.scheduler,
    baseTools: parentRegistry.tools,
    executeToolCall: (toolCall, signal) => parentRegistry.executeToolCall(toolCall, signal),
    metadataByName: parentRegistry.metadataByName,
    // worktree 模式的子代理在隔离工作目录上重建一份自己的工具表(不含子代理工具)。
    createSubagentToolRegistry: async (childWorkdir) => {
      const childBundles = await buildBaseBuiltinToolBundles({
        ...params,
        workdir: childWorkdir,
        fileState: createFileToolState(),
        // selectWorktreeTools 只放行只读 memory;rw 元数据会把它整个滤掉。
        memoryToolMode: "ro",
      });
      const childRegistry = createBuiltinToolRegistry(childBundles);
      return {
        tools: childRegistry.tools,
        executeToolCall: childRegistry.executeToolCall,
        metadataByName: childRegistry.metadataByName,
      };
    },
  });

  // 父级自己的 SendMessage:让主 agent 也能回信给子代理。
  const parentSendMessageBundle = createSendMessageTools({
    store: subagentConfig.store,
    senderId: SUBAGENT_PARENT_ID,
    senderName: "Parent Agent",
  });

  return createBuiltinToolRegistry([...coreBundles, subagentBundle, parentSendMessageBundle]);
}
