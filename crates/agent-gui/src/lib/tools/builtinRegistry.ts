import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { SystemToolRuntimeScope } from "@liveagent/ui/lib/tools/systemToolOptions";
import { homeDir } from "@tauri-apps/api/path";
import type { RuntimePlatform } from "../runtimePlatform";
import {
  type McpSettings,
  type McpSettingsOp,
  type ProviderId,
  type SshHostConfig,
  selectEnabledMcpServers,
} from "../settings";
import {
  createSendMessageTools,
  createSubagentTools,
  SUBAGENT_PARENT_ID,
  type SubagentRuntimeConfig,
} from "../subagents";
import type { AdditionalProjectRoot } from "./additionalProjectRoots";
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
import { createTaskTools, type TaskStateStore } from "./taskTools";
import { createTerminalTools } from "./terminalTools";
import { createTunnelManagerTools, type TunnelManagerChange } from "./tunnelManagerTools";

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
// 不再给内置工具声明 JSON-schema 约束采样(strict)。曾经声明过 "prefer"
// (pi 0.84.2 升级时引入),但部分 OpenAI 兼容 provider(如 Moonshot/Kimi)在
// strict 模式下按白名单校验 schema 关键字,内置工具常用的 minimum / maxItems
// 等一律 400,一个工具的 schema 就打死整轮请求;而 pi-ai 的本地预检
// (makeStrictJsonSchema)只拦结构性问题,拦不住这类关键字白名单差异,
// "prefer" 的降级判定在这里完全失效。v1.2.4 及之前不声明 strict,各家都能用
// ——回到那个行为。约束采样能消灭的"参数名写错、必填漏传"坏调用,由工具
// 实现自身的参数校验兜底。

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
  /** Structured file-tool roots only; never forwarded to shell/process tools. */
  additionalRoots?: readonly AdditionalProjectRoot[];
  providerId: ProviderId;
  runtimePlatform?: RuntimePlatform;
  fileState: FileToolState;
  skillsEnabled: boolean;
  skillsRootDir?: string;
  skillAccessPolicy?: SkillAccessPolicy;
  onManagedSkillsChanged?: (change: {
    action: "install" | "create" | "delete";
    names: string[];
    baseDirs: string[];
  }) => void | Promise<void>;
  runtimeScope: SystemToolRuntimeScope;
  /** 会话检查点上下文;chat 场景传入,Cron 等自动化场景缺省(不捕获前像)。 */
  checkpoint?: { conversationId: string; turnSeq: number };
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

const resolveHomeDir = () => homeDir();

async function buildBaseBuiltinToolBundles(params: BuildBuiltinBaseToolRegistryParams) {
  const baseBundles: BuiltinToolBundle[] = [
    createFsTools({
      workdir: params.workdir,
      additionalRoots: params.additionalRoots,
      fileState: params.fileState,
      skillsRootEnabled: params.skillsEnabled,
      skillsRootDir: params.skillsRootDir,
      skillAccessPolicy: params.skillAccessPolicy,
      resolveHomeDir,
      checkpoint: params.checkpoint,
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
    subagentRuntime?: SubagentRuntimeConfig;
    taskStateStore?: TaskStateStore;
    /** chat 场景注入交互式提问工具；子代理/自动化场景无人值守，不注册。 */
    askUserQuestionConversationId?: string;
  },
) {
  const baseBundles = await buildBaseBuiltinToolBundles(params);
  const taskBundles =
    params.runtimeScope === "chat" && params.taskStateStore
      ? [createTaskTools(params.taskStateStore)]
      : [];
  const askUserQuestionBundles =
    params.runtimeScope === "chat" && params.askUserQuestionConversationId
      ? [createAskUserQuestionTools({ conversationId: params.askUserQuestionConversationId })]
      : [];
  const chatBundles = [...taskBundles, ...askUserQuestionBundles];

  const subagentRuntime = params.subagentRuntime;
  if (!subagentRuntime) {
    return createBuiltinToolRegistry([...baseBundles, ...chatBundles]);
  }
  const subagentAdditionalRoots = params.additionalRoots?.map((root) => ({
    ...root,
    // Delegated agents can inspect parent-granted roots, but they never
    // inherit mutation capability for shared directories implicitly.
    access: "read" as const,
  }));

  const baseRegistry = createBuiltinToolRegistry(baseBundles);
  // The Agent tool description embeds the roster, so the store must be
  // hydrated before the bundle is created. Roster load failures degrade to an
  // empty roster instead of blocking the whole registry.
  try {
    await subagentRuntime.store.ready();
  } catch (error) {
    console.warn("Failed to load subagent roster for the Agent tool", error);
  }
  const parentMessageBundle = subagentRuntime.store.conversationId
    ? createSendMessageTools({
        store: subagentRuntime.store,
        senderId: SUBAGENT_PARENT_ID,
        senderName: "Parent Agent",
      })
    : null;
  const parentBundles = parentMessageBundle ? [...baseBundles, parentMessageBundle] : baseBundles;
  return createBuiltinToolRegistry([
    ...parentBundles,
    ...chatBundles,
    createSubagentTools({
      providerId: subagentRuntime.providerId,
      model: subagentRuntime.model,
      runtime: subagentRuntime.runtime,
      runtimePlatform: params.runtimePlatform,
      workdir: params.workdir,
      resolveHomeDir,
      sessionId: subagentRuntime.sessionId,
      templates: subagentRuntime.templates,
      store: subagentRuntime.store,
      scheduler: subagentRuntime.scheduler,
      baseTools: baseRegistry.tools,
      executeToolCall: baseRegistry.executeToolCall,
      metadataByName: baseRegistry.metadataByName,
      additionalRoots: subagentAdditionalRoots,
      createSubagentToolRegistry: async (workdir) =>
        createBuiltinToolRegistry(
          await buildBaseBuiltinToolBundles({
            ...params,
            workdir,
            additionalRoots: subagentAdditionalRoots,
            fileState: createFileToolState(),
            skillsEnabled: false,
            applyMcpOps: undefined,
            mcpLoadFailureMode: "continue",
            memoryToolMode: "ro",
          }),
        ),
    }),
  ]);
}
