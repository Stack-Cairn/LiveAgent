import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  listSubagentIdentities,
  listSubagentRuns,
  type SubagentIdentityRecord,
  type SubagentRunSummary,
} from "../chat/subagent/subagentHistory";
import type { SubagentRuntimeManager } from "../chat/subagent/subagentRuntimeManager";
import type { SubagentScheduler } from "../chat/subagent/subagentScheduler";
import type {
  AgentPromptTemplate,
  CodexRequestFormat,
  McpServerConfig,
  ProviderId,
  ProviderModelConfig,
  ReasoningLevel,
} from "../settings";
import type {
  BuiltinToolBundle,
  BuiltinToolExecutionContext,
  BuiltinToolMetadata,
} from "./builtinTypes";
import { createCronTools } from "./cronTools";
import {
  CRATEBAY_SYSTEM_TOOL_IDS,
  type SystemToolId,
  type SystemToolRuntimeScope,
} from "./customSystemTools";
import { createCustomSystemTools } from "./customSystemTools";
import { createSubagentMessageTools } from "./delegate/messageTools";
import { createDelegateTools } from "./delegateTools";
import { createFileToolState, type FileToolState } from "./fileToolState";
import { createFsTools } from "./fsTools";
import { createMcpManagerTools } from "./mcpManagerTools";
import { createMcpTools } from "./mcpTools";
import { createMemoryTools } from "./memoryTools";
import { createShellTools } from "./shellTools";
import type { SkillAccessPolicy } from "./skillAccessPolicy";
import { createSkillTools } from "./skillTools";
import { createTerminalTools } from "./terminalTools";

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

export type DelegateToolRuntimeConfig = {
  providerId: ProviderId;
  model: string;
  runtime: {
    baseUrl: string;
    apiKey: string;
    requestFormat?: CodexRequestFormat;
    reasoning?: ReasoningLevel;
    promptCachingEnabled?: boolean;
    nativeWebSearchEnabled?: boolean;
    modelConfig?: ProviderModelConfig;
  };
  conversationId?: string;
  sessionId?: string;
  agentTemplates?: AgentPromptTemplate[];
  conversationSubagentIdentities?: SubagentIdentityRecord[];
  conversationSubagentRuns?: SubagentRunSummary[];
  subagentRuntimeManager?: SubagentRuntimeManager;
  subagentScheduler?: SubagentScheduler;
};

async function loadExistingSubagentRuns(conversationId?: string): Promise<SubagentRunSummary[]> {
  const parentConversationId = conversationId?.trim();
  if (!parentConversationId) return [];
  try {
    return await listSubagentRuns({
      parentConversationId,
      limit: 50,
    });
  } catch (error) {
    console.warn("Failed to load existing delegated subagent runs", error);
    return [];
  }
}

async function loadExistingSubagentIdentities(
  conversationId?: string,
): Promise<SubagentIdentityRecord[]> {
  const parentConversationId = conversationId?.trim();
  if (!parentConversationId) return [];
  try {
    return await listSubagentIdentities({
      parentConversationId,
      limit: 200,
    });
  } catch (error) {
    console.warn("Failed to load delegated subagent identities", error);
    return [];
  }
}

function createBuiltinToolRegistry(bundles: BuiltinToolBundle[]): BuiltinToolRegistry {
  const tools: BuiltinToolBundle["tools"] = [];
  const metadataByName = new Map<string, BuiltinToolMetadata>();
  const executorsByName = new Map<string, BuiltinToolBundle["executeToolCall"]>();

  for (const bundle of bundles) {
    for (const tool of bundle.tools) {
      if (executorsByName.has(tool.name)) {
        throw new Error(`Duplicate builtin tool name detected: ${tool.name}`);
      }
      tools.push(tool);
      executorsByName.set(tool.name, bundle.executeToolCall);
      const metadata = bundle.metadataByName.get(tool.name);
      if (metadata) {
        metadataByName.set(tool.name, metadata);
      }
    }
  }

  return {
    tools,
    metadataByName,
    hasTool: (toolName) => executorsByName.has(toolName),
    async executeToolCall(toolCall, signal, context) {
      const execute = executorsByName.get(toolCall.name);
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
      return execute(toolCall, signal, context);
    },
  };
}

type BuildBuiltinBaseToolRegistryParams = {
  workdir: string;
  providerId: ProviderId;
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
  selectedSystemToolIds: SystemToolId[];
  mcpSettings: {
    servers: McpServerConfig[];
    selected: string[];
  };
  updateMcpSettings?: (next: { servers: McpServerConfig[]; selected: string[] }) => void;
  enabledMcpServerIds: string[];
  selectableMcpServers: McpServerConfig[];
  onMcpLoadError?: (message: string) => void;
  mcpLoadFailureMode?: "continue" | "throw";
  memoryToolMode?: "rw" | "ro";
};

async function buildBaseBuiltinToolBundles(params: BuildBuiltinBaseToolRegistryParams) {
  let currentMcpSettings = params.mcpSettings;
  const baseBundles: BuiltinToolBundle[] = [
    createFsTools({
      workdir: params.workdir,
      fileState: params.fileState,
      skillsRootEnabled: params.skillsEnabled,
      skillsRootDir: params.skillsRootDir,
      skillAccessPolicy: params.skillAccessPolicy,
    }),
    createShellTools({
      workdir: params.workdir,
      providerId: params.providerId,
      skillsRootEnabled: params.skillsEnabled,
      skillsRootDir: params.skillsRootDir,
      skillAccessPolicy: params.skillAccessPolicy,
      managedProcessEnabled: params.runtimeScope === "chat",
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
    }),
    createMcpManagerTools({
      getMcpSettings: () => currentMcpSettings,
      setMcpSettings: params.updateMcpSettings
        ? (next) => {
            currentMcpSettings = next;
            params.updateMcpSettings?.(next);
          }
        : undefined,
      runtimeScope: params.runtimeScope,
    }),
    createCustomSystemTools({
      selectedToolIds: params.selectedSystemToolIds,
      runtimeScope: params.runtimeScope,
      currentChatModel: params.currentChatModel,
    }),
    createMemoryTools({
      workdir: params.workdir,
      mode: params.memoryToolMode ?? "rw",
    }),
    ...(params.runtimeScope === "chat"
      ? [
          createTerminalTools({
            workdir: params.workdir,
          }),
        ]
      : []),
  ];

  if (params.enabledMcpServerIds.length > 0) {
    const enabledMcpServerIdSet = new Set(params.enabledMcpServerIds);
    const enabledServers = params.selectableMcpServers.filter((server) =>
      enabledMcpServerIdSet.has(server.id),
    );
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
    delegateRuntime?: DelegateToolRuntimeConfig;
  },
) {
  const baseBundles = await buildBaseBuiltinToolBundles(params);

  if (!params.delegateRuntime) {
    return createBuiltinToolRegistry(baseBundles);
  }

  const baseRegistry = createBuiltinToolRegistry(baseBundles);
  const crateBaySystemToolIdSet = new Set<SystemToolId>(CRATEBAY_SYSTEM_TOOL_IDS);
  const inheritedSandboxToolIds = params.selectedSystemToolIds.filter((toolId) =>
    crateBaySystemToolIdSet.has(toolId),
  );
  const parentMessageBundle = params.delegateRuntime.conversationId?.trim()
    ? createSubagentMessageTools({
        parentConversationId: params.delegateRuntime.conversationId,
        currentAgentId: "parent",
        currentAgentName: "Parent Agent",
      })
    : null;
  const parentBundles = parentMessageBundle ? [...baseBundles, parentMessageBundle] : baseBundles;
  const storedSubagentRuns = Array.isArray(params.delegateRuntime.conversationSubagentRuns)
    ? []
    : await loadExistingSubagentRuns(params.delegateRuntime.conversationId);
  const existingSubagentRuns = [
    ...(params.delegateRuntime.conversationSubagentRuns ?? []),
    ...storedSubagentRuns,
  ];
  const storedSubagentIdentities = Array.isArray(
    params.delegateRuntime.conversationSubagentIdentities,
  )
    ? []
    : await loadExistingSubagentIdentities(params.delegateRuntime.conversationId);
  const existingSubagentIdentities = [
    ...(params.delegateRuntime.conversationSubagentIdentities ?? []),
    ...storedSubagentIdentities,
  ];
  return createBuiltinToolRegistry([
    ...parentBundles,
    createDelegateTools({
      providerId: params.delegateRuntime.providerId,
      model: params.delegateRuntime.model,
      runtime: params.delegateRuntime.runtime,
      workdir: params.workdir,
      parentConversationId: params.delegateRuntime.conversationId,
      sessionId: params.delegateRuntime.sessionId,
      agentTemplates: params.delegateRuntime.agentTemplates,
      existingSubagentIdentities,
      existingSubagentRuns,
      subagentRuntimeManager: params.delegateRuntime.subagentRuntimeManager,
      subagentScheduler: params.delegateRuntime.subagentScheduler,
      baseTools: baseRegistry.tools,
      executeToolCall: baseRegistry.executeToolCall,
      metadataByName: baseRegistry.metadataByName,
      createSubagentToolRegistry: async (workdir) =>
        createBuiltinToolRegistry(
          await buildBaseBuiltinToolBundles({
            ...params,
            workdir,
            fileState: createFileToolState(),
            skillsEnabled: false,
            updateMcpSettings: undefined,
            selectedSystemToolIds: inheritedSandboxToolIds,
            enabledMcpServerIds: params.enabledMcpServerIds,
            mcpLoadFailureMode: "continue",
            memoryToolMode: "ro",
          }),
        ),
    }),
  ]);
}
