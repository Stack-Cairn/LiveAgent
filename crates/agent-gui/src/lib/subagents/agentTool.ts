import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import type { RuntimePlatform } from "../runtimePlatform";
import type { ProviderId } from "../settings";
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
import type { SubagentBatchDetails, SubagentReportDetails } from "./protocol";
import {
  buildRosterEntries,
  buildTemplateEntries,
  createSubagentIdentity,
  formatRoster,
  formatTemplates,
} from "./roster";
import {
  buildSubagentRunId,
  executeSubagentRun,
  type SubagentProviderRuntime,
  type SubagentRunEnvironment,
} from "./run";
import type { SubagentScheduler } from "./scheduler";
import { createSendMessageTools } from "./sendMessageTool";
import type { SubagentConversationStore } from "./store";
import {
  AGENT_TOOL_NAME,
  MAX_AGENTS,
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

const READONLY_AGENT_PARAMETERS = Type.Object(
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
            Type.Literal("readonly", {
              description:
                "This parent conversation is read-only, so delegated agents must use readonly mode.",
            }),
          ),
          resume: Type.Optional(
            Type.Boolean({
              description:
                "Defaults to true. Set false to start a fresh private context for the same stable id.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      {
        minItems: 1,
        maxItems: MAX_AGENTS,
        description: "One entry per delegated read-only job. Independent entries run in parallel.",
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
  runtime: SubagentProviderRuntime;
  sessionId?: string;
  templates: SubagentTemplate[];
  store: SubagentConversationStore;
  scheduler: SubagentScheduler;
  readonlyOnly?: boolean;
};

export function createSubagentTools(params: {
  providerId: ProviderId;
  model: string;
  runtime: SubagentProviderRuntime;
  runtimePlatform?: RuntimePlatform;
  workdir: string;
  resolveHomeDir?: () => Promise<string>;
  sessionId?: string;
  templates: SubagentTemplate[];
  store: SubagentConversationStore;
  scheduler: SubagentScheduler;
  baseTools: Tool[];
  executeToolCall: (toolCall: ToolCall, signal?: AbortSignal) => Promise<ToolResultMessage>;
  metadataByName: Map<string, BuiltinToolMetadata>;
  createSubagentToolRegistry?: (workdir: string) => Promise<SubagentToolRegistry>;
  worktreeIpc?: SubagentWorktreeIpc;
  readonlyOnly?: boolean;
}): BuiltinToolBundle {
  const store = params.store;
  const templates = params.templates;
  const messageBusEnabled = Boolean(store.conversationId);
  const worktreeIpc = params.worktreeIpc ?? tauriSubagentWorktreeIpc;
  const readonlyTools = params.readonlyOnly
    ? params.baseTools.filter(
        (tool) => params.metadataByName.get(tool.name)?.isReadOnly === true,
      )
    : selectReadOnlyTools({
        tools: params.baseTools,
        metadataByName: params.metadataByName,
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
      "Pass one entry per job in `agents`; independent entries run in parallel up to `concurrency`. Use sequential Agent calls only when a later job needs an earlier job's output.",
      "Each agent has a stable `id` inside this conversation. Reuse the same id to resume that agent's private context; use a new id only for a genuinely new persona.",
      "Creation fields (name, role, identity, template) apply only when an id is first created; sending different values for an existing id is an error. For an existing id, send only id and the new prompt.",
      params.readonlyOnly
        ? "This parent conversation is read-only. Every delegated agent must use mode=readonly; worktree mode and merge-back fields are unavailable. Explicitly set mode=readonly when resuming an agent that previously used worktree mode."
        : "mode=readonly (default for new agents) gives inspect-only tools — use it for research, review, and discussion. mode=worktree gives file+shell tools inside an isolated git worktree — use it only when file changes are expected or explicitly requested. A resumed agent keeps its previous mode unless you set mode.",
      params.readonlyOnly
        ? "Delegated agents can inspect and report, but cannot modify workspace files, settings, memory, tasks, or external systems."
        : "apply_policy controls merge-back from a worktree: none (default) never applies, auto applies the patch automatically, explicit applies only when every changed file matches allowed_output_paths.",
      params.readonlyOnly
        ? null
        : "retain_worktree=true keeps a safely-cleanable worktree for review. Worktrees with unapplied changes or failed agents are always retained.",
      "Subagents cannot call Agent recursively. Worktree mode must not modify global LiveAgent settings, MCP server configuration, cron tasks, or user-level skills.",
      "Subagents communicate through SendMessage (to=parent is parent-private; to=* is a shared broadcast); do not use workspace files as a message channel.",
      "Include the new user request and any parent-conversation context each subagent needs in that agent's prompt. The parent conversation is not copied automatically.",
      "Invalid calls start no agents and return a structured error listing the roster and enabled templates — fix every issue and retry with one corrected call.",
      "Existing agents that may be resumed by id:",
      formatRoster(rosterEntries),
      "Enabled AGENTS templates (reference by template=<id>):",
      formatTemplates(templateEntries),
    ]
      .filter((line): line is string => typeof line === "string")
      .join("\n"),
    parameters: params.readonlyOnly ? READONLY_AGENT_PARAMETERS : AGENT_PARAMETERS,
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
    const parsed = parseSubagentBatch(toolCall.arguments, { identities, templates });
    if (!parsed.ok) {
      return rejectBatch(parsed.issues);
    }
    if (params.readonlyOnly) {
      const permissionIssues = parsed.batch.agents
        .filter((agent) => agent.spec.mode !== "readonly")
        .map((agent) =>
          issue(
            "permission_denied",
            "The parent conversation is read-only; delegated agents must explicitly use mode=readonly.",
            agent.spec.id,
          ),
        );
      if (permissionIssues.length > 0) {
        return rejectBatch(permissionIssues);
      }
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
        const finish = (report: SubagentReportDetails) => {
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
                  signal,
                }),
              signal,
            ),
          );
          return finish(report);
        } catch (error) {
          // Scheduler-level rejection (aborted while queued) or an unexpected
          // escape from the run state machine.
          const cancelled =
            signal?.aborted || (error instanceof Error && error.message === "Cancelled");
          return finish({
            id: resolved.spec.id,
            runId: buildSubagentRunId(toolCall.id, resolved.spec.id, index),
            name: identityPreview.name,
            role: identityPreview.role,
            prompt: resolved.spec.prompt,
            templateId: resolved.spec.templateId,
            mode: resolved.spec.mode,
            status: cancelled ? "cancelled" : "failed",
            summary: "",
            durationMs: Date.now() - startedAt,
            rounds: 0,
            toolCalls: 0,
            error: cancelled
              ? "Cancelled"
              : normalizeErrorMessage(error, "Delegated subagent failed"),
          });
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
