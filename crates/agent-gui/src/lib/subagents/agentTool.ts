import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type {
  SubagentBatchDetails,
  SubagentReportDetails,
} from "@liveagent/ui/lib/subagents/protocol";
import { Type } from "typebox";
import type { ProviderRuntimeConfig } from "../providers/runtime/types";
import type { RuntimePlatform } from "../runtimePlatform";
import type { ProviderId } from "../settings";
import type { AdditionalProjectRoot } from "../tools/additionalProjectRoots";
import {
  type BuiltinToolBundle,
  type BuiltinToolExecutionContext,
  type BuiltinToolMetadata,
  createBuiltinMetadataMap,
} from "../tools/builtinTypes";
import { ToolPathResolver } from "../tools/pathUtils";
import { buildSubagentCardResult, buildSubagentCardToolCall, renderBatchResultText } from "./cards";
import {
  buildRejectedBatchDetails,
  issue,
  renderBatchRejectionText,
  type SubagentIssue,
  toolErrorResult,
} from "./errors";
import { type SubagentWorktreeIpc, tauriSubagentWorktreeIpc } from "./ipc/worktree";
import { selectReadOnlyTools } from "./policy";
import {
  buildRosterEntries,
  buildTemplateEntries,
  createSubagentIdentity,
  formatRoster,
  formatTemplates,
} from "./roster";
import { buildSubagentRunId, executeSubagentRun, type SubagentRunEnvironment } from "./run";
import type { SubagentScheduler } from "./scheduler";
import { createSendMessageTools } from "./sendMessageTool";
import type { SubagentConversationStore } from "./store";
import {
  AGENT_TOOL_NAME,
  MAX_AGENTS,
  type SubagentActivitySink,
  type SubagentModelOptions,
  type SubagentTemplate,
  type SubagentToolRegistry,
} from "./types";
import { createSequentialQueue, normalizeErrorMessage, runWithConcurrency } from "./utils";
import { parseSubagentBatch, type ResolvedSubagentSpec } from "./validate";

const AGENT_PARAMETERS = Type.Object(
  {
    agents: Type.Array(
      Type.Object(
        {
          id: Type.String({
            minLength: 1,
            maxLength: 64,
            description:
              "Stable agent id (letters, digits, dots, dashes, underscores). Reuse the same id to resume that agent.",
          }),
          prompt: Type.String({
            minLength: 1,
            description:
              "Task for this run. For an existing id this is normally the only field needed besides id.",
          }),
          name: Type.Optional(
            Type.String({ description: "Display name. Only valid when the id is first created." }),
          ),
          role: Type.Optional(
            Type.String({ description: "Short role. Only valid when the id is first created." }),
          ),
          identity: Type.Optional(
            Type.String({
              description:
                "Long-lived persona/identity instructions. Only valid when the id is first created.",
            }),
          ),
          template: Type.Optional(
            Type.String({
              description:
                "Enabled AGENTS template id or name. Only valid when the id is first created.",
            }),
          ),
          mode: Type.Optional(
            Type.Union([Type.Literal("readonly"), Type.Literal("worktree")], {
              description:
                "readonly = inspect-only tools; worktree = file+shell tools in an isolated git worktree. Defaults: new agent readonly, resumed agent keeps its last mode.",
            }),
          ),
          apply_policy: Type.Optional(
            Type.Union([Type.Literal("none"), Type.Literal("explicit"), Type.Literal("auto")], {
              description:
                "Worktree merge-back policy. none (default) never applies; auto applies the patch; explicit applies only files matching allowed_output_paths.",
            }),
          ),
          allowed_output_paths: Type.Optional(
            Type.Array(Type.String(), {
              description:
                "Workspace-relative files/directories (globs allowed) permitted to merge back. Required with apply_policy=explicit.",
            }),
          ),
          resume: Type.Optional(
            Type.Boolean({
              description:
                "Defaults to true. Set false to start a fresh private context for the same stable id.",
            }),
          ),
          retain_worktree: Type.Optional(
            Type.Boolean({
              description:
                "Keep the worktree after a successful run even when it could be cleaned up safely.",
            }),
          ),
          model: Type.Optional(
            Type.String({
              description:
                "Run this agent on a different model of the SAME provider. Omit to inherit the parent conversation's model. Invalid or unavailable ids are rejected with the allowed list.",
            }),
          ),
          thinking: Type.Optional(
            Type.Union(
              [
                Type.Literal("off"),
                Type.Literal("minimal"),
                Type.Literal("low"),
                Type.Literal("medium"),
                Type.Literal("high"),
                Type.Literal("xhigh"),
                Type.Literal("max"),
              ],
              {
                description:
                  "Reasoning effort for this agent. Omit to use the effective model's default. Which levels exist depends on the model; an unsupported level is rejected with the allowed list.",
              },
            ),
          ),
        },
        { additionalProperties: false },
      ),
      {
        minItems: 1,
        maxItems: MAX_AGENTS,
        description: "One entry per delegated job. Independent entries run in parallel.",
      },
    ),
    concurrency: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_AGENTS,
        description: `Maximum agents running concurrently. Defaults to ${MAX_AGENTS}.`,
      }),
    ),
  },
  { additionalProperties: false },
);

async function resolveOutputPaths(params: {
  agents: ResolvedSubagentSpec[];
  workdir: string;
  resolveHomeDir?: () => Promise<string>;
}): Promise<{ agents: ResolvedSubagentSpec[]; issues: SubagentIssue[] }> {
  const resolver = new ToolPathResolver({
    workdir: params.workdir,
    resolveHomeDir: params.resolveHomeDir,
  });
  const issues: SubagentIssue[] = [];
  const agents: ResolvedSubagentSpec[] = [];
  for (const resolved of params.agents) {
    if (resolved.spec.allowedOutputPaths.length === 0) {
      agents.push(resolved);
      continue;
    }
    const allowedOutputPaths: string[] = [];
    for (const rawPath of resolved.spec.allowedOutputPaths) {
      try {
        const resolvedPath = await resolver.resolvePath(rawPath, {
          label: `Agent.allowed_output_paths for ${resolved.spec.id}`,
          intent: "write",
          required: true,
        });
        if (resolvedPath.scope !== "workspace") {
          throw new Error("does not resolve inside the workspace");
        }
        const relativePath = resolvedPath.relativePath ?? "";
        if (relativePath && !allowedOutputPaths.includes(relativePath)) {
          allowedOutputPaths.push(relativePath);
        }
      } catch (error) {
        issues.push(
          issue(
            "output_path_outside_workspace",
            `allowed_output_paths entry "${rawPath}" must resolve inside the workspace: ${normalizeErrorMessage(error, "invalid path")}`,
            resolved.spec.id,
          ),
        );
      }
    }
    agents.push({ ...resolved, spec: { ...resolved.spec, allowedOutputPaths } });
  }
  return { agents, issues };
}

/**
 * Everything the chat turn supplies to enable subagent delegation. The store
 * is the conversation's single source of truth (its conversationId doubles as
 * the parent conversation id); the scheduler is the turn's single scheduler.
 */
export type SubagentRuntimeConfig = {
  providerId: ProviderId;
  model: string;
  runtime: ProviderRuntimeConfig;
  sessionId?: string;
  templates: SubagentTemplate[];
  store: SubagentConversationStore;
  scheduler: SubagentScheduler;
  /** 缺省表示 Agent 工具不接受 model/thinking 覆盖。 */
  modelOptions?: SubagentModelOptions;
  /** 缺省表示不上报运行态（无头/测试场景）。 */
  activity?: SubagentActivitySink;
};

export function createSubagentTools(params: {
  providerId: ProviderId;
  model: string;
  runtime: ProviderRuntimeConfig;
  runtimePlatform?: RuntimePlatform;
  workdir: string;
  resolveHomeDir?: () => Promise<string>;
  sessionId?: string;
  templates: SubagentTemplate[];
  store: SubagentConversationStore;
  scheduler: SubagentScheduler;
  /** 缺省表示 Agent 工具不接受 model/thinking 覆盖。 */
  modelOptions?: SubagentModelOptions;
  /** 缺省表示不上报运行态（无头/测试场景）。 */
  activity?: SubagentActivitySink;
  baseTools: Tool[];
  executeToolCall: (toolCall: ToolCall, signal?: AbortSignal) => Promise<ToolResultMessage>;
  metadataByName: Map<string, BuiltinToolMetadata>;
  additionalRoots?: readonly AdditionalProjectRoot[];
  createSubagentToolRegistry?: (workdir: string) => Promise<SubagentToolRegistry>;
  worktreeIpc?: SubagentWorktreeIpc;
  /** 父对话检查点上下文;仅用于 worktree apply 合并回父工作区前捕获前像,
   * 不下发给子代理自身的工具注册表(子代理 workdir 是临时目录)。 */
  checkpoint?: { conversationId: string; turnId: string };
  /** Plan mode:一切子代理强制 readonly,worktree 请求按参数错误拒绝。 */
  forceReadonly?: boolean;
}): BuiltinToolBundle {
  const store = params.store;
  const templates = params.templates;
  const messageBusEnabled = Boolean(store.conversationId);
  const worktreeIpc = params.worktreeIpc ?? tauriSubagentWorktreeIpc;
  const readonlyTools = selectReadOnlyTools({
    tools: params.baseTools,
    metadataByName: params.metadataByName,
    // Plan mode 承诺"本轮不可能发生变更";只读子代理据此也不得继承
    // isReadOnly:false 的 MCP 业务工具(平时放行是为了调研便利)。
    strictReadOnly: params.forceReadonly,
  });
  const enqueueWorktreeApply = createSequentialQueue();
  const agentRunQueues = new Map<string, ReturnType<typeof createSequentialQueue>>();
  const enqueueAgentRun = <T>(agentId: string, run: () => Promise<T>) => {
    let enqueue = agentRunQueues.get(agentId);
    if (!enqueue) {
      enqueue = createSequentialQueue();
      agentRunQueues.set(agentId, enqueue);
    }
    return enqueue(run);
  };

  // The roster/template blocks below reflect store state at registry-build
  // time; the registry builder awaits store.ready() before calling this.
  const rosterEntries = buildRosterEntries(store.listIdentities(), store.latestRunsByAgent());
  const templateEntries = buildTemplateEntries(templates);

  const toolAgent: Tool = {
    name: AGENT_TOOL_NAME,
    description: [
      "Delegate one or more independent jobs to persistent, isolated subagents and return their final reports.",
      ...(params.forceReadonly
        ? [
            "PLAN MODE: every subagent is readonly this turn — mode=worktree is rejected. Delegate research/review only; file changes happen after the plan is approved.",
          ]
        : []),
      "Pass one entry per job in `agents`; independent entries run in parallel up to `concurrency`. Use sequential Agent calls only when a later job needs an earlier job's output.",
      "Each agent has a stable `id` inside this conversation. Reuse the same id to resume that agent's private context; use a new id only for a genuinely new persona.",
      "Creation fields (name, role, identity, template) apply only when an id is first created; sending different values for an existing id is an error. For an existing id, send only id and the new prompt.",
      "mode=readonly (default for new agents) gives inspect-only tools — use it for research, review, and discussion. mode=worktree gives file+shell tools inside an isolated git worktree — use it only when file changes are expected or explicitly requested. A resumed agent keeps its previous mode unless you set mode.",
      "apply_policy controls merge-back from a worktree: none (default) never applies, auto applies the patch automatically, explicit applies only when every changed file matches allowed_output_paths.",
      "retain_worktree=true keeps a safely-cleanable worktree for review. Worktrees with unapplied changes or failed agents are always retained.",
      ...(params.modelOptions?.pinned
        ? [
            `The user pinned every subagent to ${params.modelOptions.pinned.label} in settings: do not send model or thinking, they are rejected.`,
          ]
        : params.modelOptions && params.modelOptions.models.length > 0
          ? [
              `model and thinking are per-agent overrides on the parent conversation's provider — omit both to inherit the parent's setup. Spend a cheaper/faster model on mechanical jobs and a stronger one on hard reasoning. Available models: ${params.modelOptions.models.join(", ")}.`,
            ]
          : []),
      "Subagents cannot call Agent recursively. Worktree mode must not modify global LiveAgent settings, MCP server configuration, cron tasks, or user-level skills.",
      "Subagents communicate through SendMessage (to=parent is parent-private; to=* is a shared broadcast); do not use workspace files as a message channel.",
      "Include the new user request and any parent-conversation context each subagent needs in that agent's prompt. The parent conversation is not copied automatically.",
      "Invalid calls start no agents and return a structured error listing the roster and enabled templates — fix every issue and retry with one corrected call.",
      "Existing agents that may be resumed by id:",
      formatRoster(rosterEntries),
      "Enabled AGENTS templates (reference by template=<id>):",
      formatTemplates(templateEntries),
    ].join("\n"),
    parameters: AGENT_PARAMETERS,
  };

  async function executeAgentToolCall(
    toolCall: ToolCall,
    signal?: AbortSignal,
    context?: BuiltinToolExecutionContext,
  ): Promise<ToolResultMessage> {
    if (toolCall.name !== AGENT_TOOL_NAME) {
      return toolErrorResult(toolCall, `Unknown tool: ${toolCall.name}`);
    }
    if (signal?.aborted) {
      return toolErrorResult(toolCall, "Cancelled");
    }

    try {
      await store.ready();
    } catch (error) {
      return toolErrorResult(
        toolCall,
        normalizeErrorMessage(error, "Agent could not load the subagent roster."),
      );
    }

    const rejectBatch = (issues: SubagentIssue[]) => {
      const roster = buildRosterEntries(store.listIdentities(), store.latestRunsByAgent());
      const templateList = buildTemplateEntries(templates);
      return toolErrorResult(
        toolCall,
        renderBatchRejectionText({ issues, roster, templates: templateList }),
        buildRejectedBatchDetails({ issues, roster, templates: templateList }),
      );
    };

    const identities = new Map(
      store.listIdentities().map((identity) => [identity.agentId, identity]),
    );
    const parsed = parseSubagentBatch(toolCall.arguments, {
      identities,
      templates,
      forceReadonly: params.forceReadonly,
      modelOptions: params.modelOptions
        ? {
            models: params.modelOptions.models,
            thinkingLevelsFor: params.modelOptions.thinkingLevelsFor,
            parentModel: params.model,
            pinnedLabel: params.modelOptions.pinned?.label,
          }
        : undefined,
    });
    if (!parsed.ok) {
      return rejectBatch(parsed.issues);
    }
    const { agents, issues: pathIssues } = await resolveOutputPaths({
      agents: parsed.batch.agents,
      workdir: params.workdir,
      resolveHomeDir: params.resolveHomeDir,
    });
    if (pathIssues.length > 0) {
      return rejectBatch(pathIssues);
    }

    const concurrency = parsed.batch.concurrency;
    const scheduler = context?.subagentScheduler ?? params.scheduler;
    const startedAt = Date.now();

    const env: SubagentRunEnvironment = {
      providerId: params.providerId,
      model: params.model,
      runtime: params.runtime,
      runtimePlatform: params.runtimePlatform,
      workdir: params.workdir,
      additionalRoots: params.additionalRoots?.map((root) => ({
        ...root,
        // Keep this boundary defensive even when createSubagentTools is used
        // without the higher-level builtin registry builder.
        access: "read" as const,
      })),
      sessionId: params.sessionId,
      messageBusEnabled,
      store,
      scheduler,
      worktree: worktreeIpc,
      createChildToolRegistry: params.createSubagentToolRegistry,
      readonlyTools,
      readonlyExecuteToolCall: params.executeToolCall,
      withMessageTools: messageBusEnabled
        ? (agent, tools, execute) => {
            const bundle = createSendMessageTools({
              store,
              senderId: agent.id,
              senderName: agent.name,
              currentRunId: agent.runId,
            });
            const messageToolNames = new Set(bundle.tools.map((tool) => tool.name));
            return {
              tools: [...tools, ...bundle.tools],
              execute: (childToolCall, childSignal) =>
                messageToolNames.has(childToolCall.name)
                  ? bundle.executeToolCall(childToolCall, childSignal)
                  : execute(childToolCall, childSignal),
            };
          }
        : undefined,
      enqueueWorktreeApply,
      checkpoint: params.checkpoint,
      onStatus: context?.emitToolStatus,
    };

    const reports = await runWithConcurrency(
      agents,
      concurrency,
      async (resolved, index): Promise<SubagentReportDetails> => {
        const identityPreview =
          resolved.existingIdentity ??
          createSubagentIdentity({
            parentConversationId: store.conversationId,
            toolCallId: toolCall.id,
            spec: resolved.spec,
            template: resolved.template,
            now: Date.now(),
          });
        const cardToolCall = buildSubagentCardToolCall({
          parentToolCallId: toolCall.id,
          spec: resolved.spec,
          identity: identityPreview,
          index,
          total: agents.length,
          concurrency,
        });
        context?.emitToolCall?.(cardToolCall);
        context?.emitToolExecutionStart?.(cardToolCall);

        // runId 在这里生成一次并贯穿全程：executeSubagentRun、失败路径的报告、
        // 运行态镜像、停止句柄必须指向同一个 id。
        const runId = buildSubagentRunId(toolCall.id, resolved.spec.id, index);
        // 三级优先：用户钉选 > 模型自选（仅未钉选时可用）> 继承父会话。
        const pinned = params.modelOptions?.pinned;
        const agentProviderId = pinned?.providerId ?? params.providerId;
        const agentModel = pinned?.model ?? resolved.spec.model ?? params.model;
        // 只在真有覆盖时重建 runtime——createProviderRuntimeConfig 会重算
        // modelConfig，无覆盖时直接复用父 runtime 可以少一次目录查找。
        const agentRuntime = pinned
          ? pinned.runtime
          : params.modelOptions && (resolved.spec.model || resolved.spec.reasoning)
            ? params.modelOptions.createRuntime(agentModel, resolved.spec.reasoning)
            : params.runtime;
        // per-agent 取消：级联父回合的 signal，同时给「只停这一个」留出句柄。
        const agentAbort = new AbortController();
        const abortAgent = () => {
          agentAbort.abort();
        };
        if (signal) {
          if (signal.aborted) abortAgent();
          else signal.addEventListener("abort", abortAgent, { once: true });
        }
        const agentSignal = agentAbort.signal;
        const activity = params.activity;
        const agentStartedAt = Date.now();
        activity?.start({
          runId,
          conversationId: store.conversationId,
          agentId: resolved.spec.id,
          name: identityPreview.name,
          role: identityPreview.role,
          prompt: resolved.spec.prompt,
          mode: resolved.spec.mode,
          providerId: agentProviderId,
          model: agentModel,
          reasoning: agentRuntime.reasoning,
          startedAt: agentStartedAt,
          stop: abortAgent,
        });

        const finish = (report: SubagentReportDetails) => {
          activity?.finish(runId, {
            status: report.status,
            error: report.error,
            endedAt: Date.now(),
          });
          context?.emitToolResult?.(
            cardToolCall,
            buildSubagentCardResult({
              parentToolCallId: toolCall.id,
              cardToolCall,
              report,
              index,
              total: agents.length,
              concurrency,
            }),
          );
          return report;
        };

        try {
          const report = await enqueueAgentRun(resolved.spec.id, () =>
            scheduler.runSubagent(
              () =>
                executeSubagentRun(env, {
                  spec: resolved.spec,
                  existingIdentity: resolved.existingIdentity,
                  template: resolved.template,
                  parentToolCallId: toolCall.id,
                  index,
                  total: agents.length,
                  signal: agentSignal,
                  runId,
                  providerId: agentProviderId,
                  model: agentModel,
                  runtime: agentRuntime,
                  onProgress: activity
                    ? (patch) => activity.update(runId, patch)
                    : undefined,
                }),
              agentSignal,
            ),
          );
          return finish(report);
        } catch (error) {
          // Scheduler-level rejection (aborted while queued) or an unexpected
          // escape from the run state machine.
          const cancelled =
            agentSignal.aborted || (error instanceof Error && error.message === "Cancelled");
          return finish({
            id: resolved.spec.id,
            runId,
            name: identityPreview.name,
            role: identityPreview.role,
            prompt: resolved.spec.prompt,
            templateId: resolved.spec.templateId,
            mode: resolved.spec.mode,
            status: cancelled ? "cancelled" : "failed",
            summary: "",
            durationMs: Date.now() - agentStartedAt,
            rounds: 0,
            toolCalls: 0,
            error: cancelled
              ? "Cancelled"
              : normalizeErrorMessage(error, "Delegated subagent failed"),
          });
        } finally {
          signal?.removeEventListener("abort", abortAgent);
        }
      },
    );

    const details: SubagentBatchDetails = {
      kind: "subagent_batch",
      status: "ok",
      agentCount: reports.length,
      concurrency,
      totalDurationMs: Date.now() - startedAt,
      mode: reports.every((report) => report.mode === "readonly")
        ? "readonly"
        : reports.every((report) => report.mode === "worktree")
          ? "worktree"
          : "mixed",
      agents: reports,
    };

    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: "text", text: renderBatchResultText(details) }],
      details,
      isError: reports.some((report) => report.status !== "completed"),
      timestamp: Date.now(),
    };
  }

  return {
    groupId: "subagent",
    tools: [toolAgent],
    executeToolCall: executeAgentToolCall,
    metadataByName: createBuiltinMetadataMap([
      [
        AGENT_TOOL_NAME,
        {
          groupId: "subagent",
          kind: "subagent_batch",
          isReadOnly: false,
          displayCategory: "system",
        },
      ],
    ]),
  };
}
