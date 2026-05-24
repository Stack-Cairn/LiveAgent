import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Context } from "@mariozechner/pi-ai";

import { createStreamDebugLogger } from "../../lib/debug/agentDebug";
import { runAssistantWithTools } from "../../lib/chat/runner/agentRunner";
import { assistantMessageToText } from "../../lib/providers/llm";
import {
  buildSkillsSystemPrompt,
  discoverSkills,
  isAlwaysEnabledSkillName,
  type SkillSummary,
} from "../../lib/skills";
import {
  DEFAULT_CHAT_RUNTIME_CONTROLS,
  findProviderModelConfig,
  isAgentExecutionMode,
  isAgentDevMode,
  type AppSettings,
} from "../../lib/settings";
import { buildBuiltinToolRegistry } from "../../lib/tools/builtinRegistry";
import { createFileToolState } from "../../lib/tools/fileToolState";
import type { SkillAccessPolicy } from "../../lib/tools/skillAccessPolicy";
import { appendSystemPrompt } from "../../pages/chat/chatPageRuntime";

type CronPromptRunnerProps = {
  settings: AppSettings;
};

type CronPromptRunRequest = {
  executionId: string;
  taskId: string;
  taskName: string;
  prompt: string;
  providerId: string;
  model: string;
  startedAt: number;
};

type CronCompletePromptRunInput = {
  executionId: string;
  taskId: string;
  success: boolean;
  durationMs: number;
  output: string;
};

type CronPromptRunCompletionResult = {
  status: "completed" | "already_finished";
};

type CronPromptRunExpiredEvent = {
  executionId: string;
  taskId: string;
};

const CRON_PENDING_EVENT = "cron:auto-prompt-pending";
const CRON_EXPIRED_EVENT = "cron:auto-prompt-expired";
const CRON_COMPLETION_STORAGE_KEY = "liveagent.cron-prompt-completions.v1";
const CRON_PROMPT_TIMEOUT_MS = 5 * 60_000;
const CRON_PROMPT_TIMEOUT_EARLY_ABORT_MS = 1_000;
const runningExecutionIds = new Set<string>();
const runningTaskIds = new Set<string>();
const executionAbortControllers = new Map<string, AbortController>();
const executionTimeoutHandles = new Map<string, number>();
const localTimedOutExecutionIds = new Set<string>();
const serverExpiredExecutionIds = new Set<string>();
let completionFlushChain: Promise<void> = Promise.resolve();

function buildPromptTimeoutMessage() {
  return "Auto Prompt run timed out before the front-end completed it.";
}

function buildCronSystemPrompt(taskName: string) {
  const normalizedTaskName = taskName.trim();
  if (!normalizedTaskName) {
    return [
      "You are running a scheduled Auto Prompt task in LiveAgent.",
      "Return only the final conclusion for this run.",
      "Do not include raw JSON, tool calls, hidden reasoning, or intermediate execution logs.",
    ].join("\n");
  }

  return [
    "You are running a scheduled Auto Prompt task in LiveAgent.",
    `Task: ${normalizedTaskName}`,
    "Return only the final conclusion for this run.",
    "Do not include raw JSON, tool calls, hidden reasoning, or intermediate execution logs.",
  ].join("\n");
}

function getActiveAgentPrompt(settings: AppSettings) {
  return (
    settings.agents.find((template) => template.enabled && template.prompt.trim())?.prompt.trim() ??
    ""
  );
}

function resolveEnabledMcpServers(settings: AppSettings) {
  const selectableMcpServers = settings.mcp.servers.filter(
    (server) => server.enabled && server.id.trim(),
  );
  return {
    selectableMcpServers,
    enabledMcpServerIds: selectableMcpServers.map((server) => server.id),
  };
}

async function buildCronSkillsContext(settings: AppSettings) {
  const selectedSkillNames = settings.skills.selected.filter(
    (name) => !isAlwaysEnabledSkillName(name),
  );
  if (!settings.skills.enabled || selectedSkillNames.length === 0) {
    return {
      enabled: false,
      prompt: "",
      rootDir: "",
      accessPolicy: undefined as SkillAccessPolicy | undefined,
    };
  }

  const discovery = await discoverSkills({ force: true });
  const skillByName = new Map(discovery.skills.map((skill) => [skill.name, skill]));
  const missing = selectedSkillNames.filter((name) => !skillByName.has(name));
  if (missing.length > 0) {
    throw new Error(`找不到以下 Skills：${missing.join(", ")}（请先重新扫描固定 Skills 目录）`);
  }

  const selectedSkills = selectedSkillNames
    .map((name) => skillByName.get(name))
    .filter((skill): skill is SkillSummary => Boolean(skill));

  return {
    enabled: true,
    prompt: buildSkillsSystemPrompt({
      rootDir: discovery.rootDir,
      selected: selectedSkills,
    }),
    rootDir: discovery.rootDir,
    accessPolicy: {
      allowedSkillNames: selectedSkills.map((skill) => skill.name),
      allowedSkillBaseDirs: selectedSkills.map((skill) => skill.baseDir),
      allowSkillInventory: true,
      allowSkillManagement: false,
      allowSkillMutation: true,
    },
  };
}

async function executeCronPromptRun(
  settings: AppSettings,
  request: CronPromptRunRequest,
  signal?: AbortSignal,
) {
  if (!isAgentExecutionMode(settings.system.executionMode)) {
    throw new Error(
      "Auto Prompt requires System -> Execution Mode to be Agent Mode or Agent Dev Mode.",
    );
  }

  const workdir = settings.system.workdir.trim();
  if (!workdir) {
    throw new Error("Tool mode requires a working directory configured in Settings -> System.");
  }

  if (!request.prompt.trim()) {
    throw new Error("Auto Prompt task has no prompt content.");
  }

  const provider = settings.customProviders.find((item) => item.id === request.providerId);
  if (!provider) {
    throw new Error(`Auto Prompt provider is missing or has been removed: ${request.providerId}`);
  }

  const providerLabel = provider.name.trim() || provider.id;
  if (!provider.baseUrl.trim()) {
    throw new Error(`Auto Prompt provider base URL is empty: ${providerLabel}`);
  }
  if (!provider.apiKey.trim()) {
    throw new Error(`Auto Prompt provider API key is empty: ${providerLabel}`);
  }

  const skillsContext = await buildCronSkillsContext(settings);
  const skillsPrompt = skillsContext.prompt;
  const activeAgentPrompt = getActiveAgentPrompt(settings);
  const { selectableMcpServers, enabledMcpServerIds } = resolveEnabledMcpServers(settings);
  const builtinRegistry = await buildBuiltinToolRegistry({
    workdir,
    providerId: provider.type,
    fileState: createFileToolState(),
    skillsEnabled: skillsContext.enabled,
    skillsRootDir: skillsContext.rootDir,
    skillAccessPolicy: skillsContext.accessPolicy,
    runtimeScope: "cron_auto_prompt",
    currentChatModel: {
      customProviderId: request.providerId,
      model: request.model,
    },
    selectedSystemToolIds: settings.system.selectedSystemTools,
    mcpSettings: settings.mcp,
    enabledMcpServerIds,
    selectableMcpServers,
    mcpLoadFailureMode: "throw",
  });

  let systemPrompt = buildCronSystemPrompt(request.taskName);
  if (activeAgentPrompt) {
    systemPrompt = appendSystemPrompt(systemPrompt, activeAgentPrompt);
  }
  if (skillsPrompt) {
    systemPrompt = appendSystemPrompt(systemPrompt, skillsPrompt);
  }

  const context: Context = {
    systemPrompt,
    messages: [
      {
        role: "user",
        content: request.prompt.trim(),
        timestamp: request.startedAt || Date.now(),
      },
    ],
    tools: builtinRegistry.tools,
  };

  const debugLogger = createStreamDebugLogger({
    enabled: isAgentDevMode(settings.system.executionMode),
    conversationId: `cron-prompt-${request.executionId}`,
    executionMode: settings.system.executionMode,
    streamKind: "cron_auto_prompt",
    providerId: provider.type,
    model: request.model,
  });

  const result = await runAssistantWithTools({
    providerId: provider.type,
    model: request.model,
    runtime: {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      requestFormat: provider.requestFormat,
      reasoning: DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning,
      promptCachingEnabled: true,
      nativeWebSearchEnabled: DEFAULT_CHAT_RUNTIME_CONTROLS.nativeWebSearchEnabled,
      modelConfig: findProviderModelConfig(provider, request.model),
    },
    context,
    workdir,
    sessionId: request.executionId,
    tools: builtinRegistry.tools,
    executeToolCall: (toolCall, signal) => builtinRegistry.executeToolCall(toolCall, signal),
    onTextDelta() {},
    onToolStatus() {},
    signal,
    debugLogger,
  });

  const conclusion = assistantMessageToText(result.assistant).trim();
  if (!conclusion) {
    throw new Error("Auto Prompt request returned an empty conclusion.");
  }
  return conclusion;
}

async function completeCronPromptRun(input: CronCompletePromptRunInput) {
  return invoke<CronPromptRunCompletionResult>("cron_complete_prompt_run", { input });
}

function warnIfAlreadyFinishedCompletion(
  result: CronPromptRunCompletionResult,
  executionId: string,
) {
  if (result.status === "already_finished") {
    console.warn(
      "Cron Auto Prompt completion reached an already-finished run",
      executionId,
    );
  }
}

function normalizeExecutionId(value: string) {
  return value.trim();
}

function normalizeTaskId(value: string) {
  return value.trim();
}

function clearExecutionTimeout(executionId: string) {
  const timer = executionTimeoutHandles.get(executionId);
  if (typeof timer === "number") {
    window.clearTimeout(timer);
    executionTimeoutHandles.delete(executionId);
  }
}

function remainingPromptRunTimeoutMs(startedAt: number) {
  const normalizedStartedAt = Number.isFinite(startedAt) ? startedAt : Date.now();
  const elapsed = Math.max(0, Date.now() - normalizedStartedAt);
  if (elapsed >= CRON_PROMPT_TIMEOUT_MS) {
    return 1;
  }
  return CRON_PROMPT_TIMEOUT_MS - elapsed;
}

function abortPromptExecution(
  executionId: string,
  reason: "local_timeout" | "server_expired",
) {
  const normalizedExecutionId = normalizeExecutionId(executionId);
  if (!normalizedExecutionId) {
    return;
  }

  if (reason === "local_timeout") {
    localTimedOutExecutionIds.add(normalizedExecutionId);
  } else {
    serverExpiredExecutionIds.add(normalizedExecutionId);
  }

  clearExecutionTimeout(normalizedExecutionId);
  executionAbortControllers.get(normalizedExecutionId)?.abort();
}

function registerLocalPromptTimeout(
  executionId: string,
  startedAt: number,
  controller: AbortController,
) {
  const normalizedExecutionId = normalizeExecutionId(executionId);
  if (!normalizedExecutionId) {
    return;
  }

  executionAbortControllers.set(normalizedExecutionId, controller);
  const remainingMs = remainingPromptRunTimeoutMs(startedAt);
  const abortDelayMs = Math.max(1, remainingMs - CRON_PROMPT_TIMEOUT_EARLY_ABORT_MS);
  const timer = window.setTimeout(() => {
    abortPromptExecution(normalizedExecutionId, "local_timeout");
  }, abortDelayMs);
  executionTimeoutHandles.set(normalizedExecutionId, timer);
}

function normalizeQueuedCompletion(
  value: unknown,
): CronCompletePromptRunInput | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const executionId = typeof record.executionId === "string" ? record.executionId.trim() : "";
  const taskId = typeof record.taskId === "string" ? record.taskId.trim() : "";
  if (!executionId || !taskId) {
    return null;
  }

  return {
    executionId,
    taskId,
    success: record.success === true,
    durationMs:
      typeof record.durationMs === "number" && Number.isFinite(record.durationMs)
        ? Math.max(0, record.durationMs)
        : 0,
    output: typeof record.output === "string" ? record.output : "",
  };
}

function readQueuedPromptCompletions() {
  try {
    const raw = window.localStorage.getItem(CRON_COMPLETION_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((value) => normalizeQueuedCompletion(value))
      .filter((value): value is CronCompletePromptRunInput => Boolean(value));
  } catch (error) {
    console.warn("Cron Auto Prompt completion queue read failed", error);
    return [];
  }
}

function writeQueuedPromptCompletions(queue: CronCompletePromptRunInput[]) {
  if (queue.length === 0) {
    window.localStorage.removeItem(CRON_COMPLETION_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(CRON_COMPLETION_STORAGE_KEY, JSON.stringify(queue));
}

function upsertQueuedPromptCompletion(input: CronCompletePromptRunInput) {
  const queue = readQueuedPromptCompletions();
  const existingIndex = queue.findIndex((item) => item.executionId === input.executionId);
  if (existingIndex >= 0) {
    queue[existingIndex] = input;
  } else {
    queue.push(input);
  }
  writeQueuedPromptCompletions(queue);
}

function getQueuedPromptCompletionIds() {
  return new Set(readQueuedPromptCompletions().map((item) => item.executionId));
}

async function flushQueuedPromptCompletionsInternal() {
  const queue = readQueuedPromptCompletions();
  if (queue.length === 0) {
    return;
  }

  const remaining: CronCompletePromptRunInput[] = [];
  for (let index = 0; index < queue.length; index += 1) {
    const entry = queue[index];
    try {
      const result = await completeCronPromptRun(entry);
      warnIfAlreadyFinishedCompletion(result, entry.executionId);
    } catch (error) {
      console.warn("Cron Auto Prompt completion queue flush failed", error);
      remaining.push(entry, ...queue.slice(index + 1));
      break;
    }
  }

  writeQueuedPromptCompletions(remaining);
}

function serializeCompletionQueueWork(work: () => Promise<void>) {
  completionFlushChain = completionFlushChain.catch(() => undefined).then(work);
  return completionFlushChain;
}

async function flushQueuedPromptCompletions() {
  await serializeCompletionQueueWork(async () => {
    await flushQueuedPromptCompletionsInternal();
  });
}

async function enqueueQueuedPromptCompletion(input: CronCompletePromptRunInput) {
  await serializeCompletionQueueWork(async () => {
    try {
      upsertQueuedPromptCompletion(input);
    } catch (error) {
      console.warn("Cron Auto Prompt completion queue persist failed", error);
      const result = await completeCronPromptRun(input);
      warnIfAlreadyFinishedCompletion(result, input.executionId);
      return;
    }

    await flushQueuedPromptCompletionsInternal();
  });
}

export function CronPromptRunner({ settings }: CronPromptRunnerProps) {
  const settingsRef = useRef(settings);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    async function takePendingRuns() {
      await flushQueuedPromptCompletions();

      let pendingRuns: CronPromptRunRequest[] = [];
      try {
        pendingRuns = await invoke<CronPromptRunRequest[]>("cron_take_pending_prompt_runs");
      } catch (error) {
        console.warn("Cron Auto Prompt pending take failed", error);
        return;
      }

      const queuedCompletionIds = getQueuedPromptCompletionIds();
      for (const request of pendingRuns) {
        const executionId = normalizeExecutionId(request.executionId);
        const taskId = normalizeTaskId(request.taskId);
        if (!executionId || !taskId) {
          continue;
        }
        if (queuedCompletionIds.has(executionId)) {
          continue;
        }
        if (runningTaskIds.has(taskId)) {
          continue;
        }
        void startRun(request);
      }
    }

    async function startRun(request: CronPromptRunRequest) {
      const executionId = normalizeExecutionId(request.executionId);
      const taskId = normalizeTaskId(request.taskId);
      if (
        !executionId ||
        !taskId ||
        runningExecutionIds.has(executionId) ||
        runningTaskIds.has(taskId)
      ) {
        return;
      }

      runningExecutionIds.add(executionId);
      runningTaskIds.add(taskId);
      localTimedOutExecutionIds.delete(executionId);
      serverExpiredExecutionIds.delete(executionId);
      const controller = new AbortController();
      registerLocalPromptTimeout(executionId, request.startedAt, controller);
      const startedAt = Date.now();
      let success = false;
      let output = "";

      try {
        output = await executeCronPromptRun(settingsRef.current, request, controller.signal);
        success = true;
      } catch (error) {
        output = error instanceof Error ? error.message : String(error ?? "");
      }

      const timedOutLocally = localTimedOutExecutionIds.has(executionId);
      const expiredByServer = serverExpiredExecutionIds.has(executionId);
      if (timedOutLocally || expiredByServer) {
        success = false;
        output = buildPromptTimeoutMessage();
      }

      try {
        if (!expiredByServer) {
          await enqueueQueuedPromptCompletion({
            executionId,
            taskId,
            success,
            durationMs: Math.max(0, Date.now() - startedAt),
            output: output.trim(),
          });
        }
      } catch (error) {
        console.warn("Cron Auto Prompt completion write-back failed", error);
      } finally {
        clearExecutionTimeout(executionId);
        executionAbortControllers.delete(executionId);
        localTimedOutExecutionIds.delete(executionId);
        serverExpiredExecutionIds.delete(executionId);
        runningExecutionIds.delete(executionId);
        runningTaskIds.delete(taskId);
        void takePendingRuns();
      }
    }

    void takePendingRuns();

    const unlistenPendingPromise = listen(CRON_PENDING_EVENT, () => {
      void takePendingRuns();
    });
    const unlistenExpiredPromise = listen<CronPromptRunExpiredEvent>(
      CRON_EXPIRED_EVENT,
      (event) => {
        const executionId = normalizeExecutionId(event.payload?.executionId ?? "");
        if (!executionId || !executionAbortControllers.has(executionId)) {
          return;
        }
        abortPromptExecution(executionId, "server_expired");
      },
    );

    return () => {
      void unlistenPendingPromise.then((unlisten) => unlisten());
      void unlistenExpiredPromise.then((unlisten) => unlisten());
    };
  }, []);

  return null;
}
