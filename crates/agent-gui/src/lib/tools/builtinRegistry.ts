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
import { createExitPlanModeTools, isPlanModeAllowedTool } from "./planModeTools";
import { createShellTools, type ShellSandboxSettings } from "./shellTools";
import type { SkillAccessPolicy } from "./skillAccessPolicy";
import { createSkillTools } from "./skillTools";
import { createSSHManagerTools, type SshManagerSessionChange } from "./sshManagerTools";
import { createTaskTools, type TaskStateStore } from "./taskTools";
import { createTerminalTools } from "./terminalTools";
import { createToolSearchTools, shouldDeferMcpTools } from "./toolSearchTools";
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
  /** MCP 懒加载已启用:调用方应给 runner 挂 requestToolFilter(未激活的 MCP
   * 工具不进模型请求)。工具仍全量在 tools 里——执行层必须找得到它们。 */
  mcpToolDeferralActive?: boolean;
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
  /** OS 级沙箱设置;透传给 Bash / ManagedProcess 执行层。 */
  sandbox?: ShellSandboxSettings;
  skillsEnabled: boolean;
  skillsRootDir?: string;
  skillAccessPolicy?: SkillAccessPolicy;
  onManagedSkillsChanged?: (change: {
    action: "install" | "create" | "delete";
    names: string[];
    baseDirs: string[];
  }) => void | Promise<void>;
  runtimeScope: SystemToolRuntimeScope;
  /** 会话检查点上下文;chat 场景传入,Cron 等自动化场景缺省(不捕获前像)。
   * turnId 是每用户轮唯一的稳定 ID(与时钟无关),序号由 Rust 侧分配。 */
  checkpoint?: { conversationId: string; turnId: string };
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

type McpBusinessToolBundle = Awaited<ReturnType<typeof createMcpTools>>;

type BaseBuiltinToolBundles = {
  bundles: BuiltinToolBundle[];
  /** MCP 业务工具 bundle(懒加载判定与 ToolSearch 目录的输入)。McpManager 与它
   * 同为 groupId "mcp",绝不能按 groupId 搜索定位——必须持有这份直接引用。 */
  mcpBusinessBundle: McpBusinessToolBundle | undefined;
};

async function buildBaseBuiltinToolBundles(
  params: BuildBuiltinBaseToolRegistryParams,
): Promise<BaseBuiltinToolBundles> {
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
      resumableShellEnabled: params.runtimeScope === "chat",
      resolveHomeDir,
      sandbox: params.sandbox,
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
      // 沙箱模式下 McpManager 不得成为无围栏的 stdio spawn 入口(P1#1):
      // 运行时探测与 create/update/enable 写入路径一律拒绝 stdio。
      sandbox: params.sandbox,
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
  let mcpBusinessBundle: McpBusinessToolBundle | undefined;
  if (enabledServers.length > 0) {
    mcpBusinessBundle = await createMcpTools({
      servers: enabledServers,
      onLoadError: params.onMcpLoadError,
      loadFailureMode: params.mcpLoadFailureMode,
    });
    baseBundles.push(mcpBusinessBundle);
  }

  return { bundles: baseBundles, mcpBusinessBundle };
}

export async function buildBuiltinToolRegistry(
  params: BuildBuiltinBaseToolRegistryParams & {
    subagentRuntime?: SubagentRuntimeConfig;
    taskStateStore?: TaskStateStore;
    /** chat 场景注入交互式提问工具；子代理/自动化场景无人值守，不注册。 */
    askUserQuestionConversationId?: string;
    /** Plan mode:非只读工具不进注册表,注入 ExitPlanMode,子代理强制 readonly。 */
    planMode?: {
      conversationId: string;
    };
    /** MCP 懒加载:schema 总量超阈值时注入 ToolSearch,MCP 工具延迟到激活后
     * 才进模型请求(执行层始终全量注册)。仅 chat 场景;plan mode 下无意义
     * (MCP 工具非只读,本就不在表内)。 */
    toolSearch?: {
      conversationId: string;
    };
  },
) {
  const planModeActive = Boolean(params.planMode);
  const { bundles: baseBundles, mcpBusinessBundle } = await buildBaseBuiltinToolBundles(params);
  // MCP 懒加载判定:对"会进请求的 schema JSON"估算 token(与 tokenLedger 同
  // 口径),超阈值才启用——多一次检索回合的代价只在真省下可观 context 时才值。
  // 判定与目录的输入必须是 MCP 业务工具 bundle 的直接引用:McpManager 也注册在
  // groupId "mcp" 下且先入列,按 groupId find 会命中它,让延迟判定永远失效。
  const mcpToolDeferralActive = Boolean(
    params.toolSearch &&
      params.runtimeScope === "chat" &&
      !planModeActive &&
      mcpBusinessBundle &&
      shouldDeferMcpTools(mcpBusinessBundle.tools),
  );
  const toolSearchBundles =
    mcpToolDeferralActive && params.toolSearch && mcpBusinessBundle
      ? [
          createToolSearchTools({
            conversationId: params.toolSearch.conversationId,
            entries: mcpBusinessBundle.tools.map((tool) => ({
              tool,
              serverLabel: mcpBusinessBundle.toolNameMap.get(tool.name)?.serverLabel ?? "",
            })),
          }),
        ]
      : [];
  const taskBundles =
    params.runtimeScope === "chat" && params.taskStateStore
      ? [createTaskTools(params.taskStateStore)]
      : [];
  const askUserQuestionBundles =
    params.runtimeScope === "chat" && params.askUserQuestionConversationId
      ? [createAskUserQuestionTools({ conversationId: params.askUserQuestionConversationId })]
      : [];
  const planModeBundles =
    params.runtimeScope === "chat" && params.planMode
      ? [
          createExitPlanModeTools({
            conversationId: params.planMode.conversationId,
          }),
        ]
      : [];
  const chatBundles = [
    ...taskBundles,
    ...askUserQuestionBundles,
    ...planModeBundles,
    ...toolSearchBundles,
  ];

  // Plan mode:在注册表组装层裁掉非只读工具(而非 deny 后备拦截)——模型根本
  // 看不到写工具,不浪费 token 也无泄漏面。子代理协作工具(Agent/SendMessage)
  // 保留,Agent 由 forceReadonly 在 validate 层强制 readonly。
  const filterForPlanMode = (registry: ReturnType<typeof createBuiltinToolRegistry>) => {
    const withDeferralFlag: BuiltinToolRegistry = {
      ...registry,
      mcpToolDeferralActive,
    };
    if (!planModeActive) return withDeferralFlag;
    return {
      ...withDeferralFlag,
      tools: withDeferralFlag.tools.filter((tool) =>
        isPlanModeAllowedTool(tool.name, withDeferralFlag.metadataByName.get(tool.name)),
      ),
    };
  };

  const subagentRuntime = params.subagentRuntime;
  if (!subagentRuntime) {
    return filterForPlanMode(createBuiltinToolRegistry([...baseBundles, ...chatBundles]));
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
  return filterForPlanMode(
    createBuiltinToolRegistry([
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
        // Plan mode:子代理只许 readonly,worktree 请求按参数错误拒绝。
        forceReadonly: planModeActive,
        // 仅供 worktree apply 在合并回父工作区前捕获前像(blocker-2),
        // 不进入子代理自身的工具注册表(见下方 checkpoint: undefined)。
        checkpoint: params.checkpoint,
        createSubagentToolRegistry: async (workdir) =>
          createBuiltinToolRegistry(
            (
              await buildBaseBuiltinToolBundles({
                ...params,
                workdir,
                additionalRoots: subagentAdditionalRoots,
                fileState: createFileToolState(),
                skillsEnabled: false,
                applyMcpOps: undefined,
                mcpLoadFailureMode: "continue",
                memoryToolMode: "ro",
                // Worktree 子代理的 workdir 是临时 git worktree,改动经 apply
                // 合并回父工作区后临时目录即被清理——若继承父轮 checkpoint,
                // 捕获的是死路径的前像,rewind 会"恢复"已不存在的临时目录。
                // 父工作区的真实前像由 subagent_worktree_apply 在合并前捕获。
                checkpoint: undefined,
              })
            ).bundles,
          ),
      }),
    ]),
  );
}
