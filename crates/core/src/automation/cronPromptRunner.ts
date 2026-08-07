// 定时任务(Auto Prompt)的执行引擎。
//
// 队列归 Rust:claim 是原子的 pending→leased 迁移,所以并发 claim(多次
// poke、多个前端)不会把同一个任务跑两遍,completion 对租约状态机幂等。
// 这里只做「拿到已 claim 的任务,跑完,回报结论」。
//
// 与旧版(前端 CronPromptRunner 组件)的关键差别:执行不再依赖有没有人开着
// 界面。引擎自带 reconcile 定时器,定时任务在无 UI 时照常运行;前端的 poke
// 只是把「刚排进队列」这件事立刻告诉引擎,省掉一个轮询周期的延迟。

import type { Context } from "@earendil-works/pi-ai";
import { emitWireEvent } from "../events";
import { assistantMessageToText, createProviderRuntimeConfig } from "../providers/llm";
import { runAssistantWithTools } from "../chat/runner/agentRunner";
import { createStreamDebugLogger } from "../debug/agentDebug";
import { resolveRuntimePlatform } from "../runtimePlatform";
import {
  type AppSettings,
  DEFAULT_CHAT_RUNTIME_CONTROLS,
  getActiveAgentPrompt,
  isAgentDevMode,
  type ReasoningLevel,
} from "../settings";
import { loadPersistedSettingsWithDefaults } from "../settings/storage";
import {
  buildSkillsSystemPrompt,
  discoverSkills,
  isAlwaysEnabledSkillName,
  type SkillSummary,
} from "../skills";
import { buildBuiltinToolRegistry } from "../tools/builtinRegistry";
import { createFileToolState } from "../tools/fileToolState";
import type { SkillAccessPolicy } from "../tools/skillAccessPolicy";
import { appendSystemPrompt } from "../turns/chatPageRuntime";
import { backend } from "./backend";
import type { CompletePromptRunInput, PromptRunRequest } from "./types";

/** 引擎自转的对账周期:漏掉的 pending 最迟这么久后被捡起来。 */
export const PROMPT_RUN_RECONCILE_INTERVAL_MS = 15_000;
/** Abort slightly before the Rust lease expires so our completion wins the race. */
const LEASE_SAFETY_MARGIN_MS = 2_000;
const COMPLETION_RETRY_DELAYS_MS = [1_000, 5_000, 15_000];

function buildCronSystemPrompt(taskName: string) {
  const lines = ["You are running a scheduled Auto Prompt task in LiveAgent."];
  const normalizedTaskName = taskName.trim();
  if (normalizedTaskName) {
    lines.push(`Task: ${normalizedTaskName}`);
  }
  lines.push(
    "Return only the final conclusion for this run.",
    "Do not include raw JSON, tool calls, hidden reasoning, or intermediate execution logs.",
  );
  return lines.join("\n");
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

const CRON_REASONING_LEVELS: ReasoningLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * Per-task thinking level from the queue row; empty/unknown values (e.g.
 * tasks saved before the field existed) fall back to the runtime default so
 * legacy tasks keep their pre-existing behavior.
 */
function resolveCronReasoning(value: string | undefined): ReasoningLevel {
  return value && (CRON_REASONING_LEVELS as string[]).includes(value)
    ? (value as ReasoningLevel)
    : DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning;
}

async function executeCronPromptRun(
  settings: AppSettings,
  request: PromptRunRequest,
  signal: AbortSignal,
) {
  // The request carries the workdir resolved at queue time (task pin or the
  // global workdir); rows queued before that field existed fall back to the
  // current global workdir.
  const workdir = (request.workdir ?? "").trim() || settings.system.workdir.trim();
  if (!workdir) {
    throw new Error("Tool mode requires a project directory from the chat sidebar.");
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
  const activeAgentPrompt = getActiveAgentPrompt(settings);
  const runtimePlatform = await resolveRuntimePlatform();
  const builtinRegistry = await buildBuiltinToolRegistry({
    workdir,
    providerId: provider.type,
    runtimePlatform,
    fileState: createFileToolState(),
    skillsEnabled: skillsContext.enabled,
    skillsRootDir: skillsContext.rootDir,
    skillAccessPolicy: skillsContext.accessPolicy,
    runtimeScope: "cron_auto_prompt",
    currentChatModel: {
      customProviderId: request.providerId,
      model: request.model,
    },
    getMcpSettings: () => settings.mcp,
    mcpLoadFailureMode: "throw",
  });

  let systemPrompt = buildCronSystemPrompt(request.taskName);
  if (activeAgentPrompt) {
    systemPrompt = appendSystemPrompt(systemPrompt, activeAgentPrompt);
  }
  if (skillsContext.prompt) {
    systemPrompt = appendSystemPrompt(systemPrompt, skillsContext.prompt);
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
      ...createProviderRuntimeConfig(provider, request.model, {
        ...DEFAULT_CHAT_RUNTIME_CONTROLS,
        reasoning: resolveCronReasoning(request.reasoning),
      }),
      // 后台定时任务恒开提示词缓存：与前台会话共享同一前缀，命中率远高于按
      // 供应商开关逐个判断。
      promptCachingEnabled: true,
    },
    runtimePlatform,
    context,
    workdir,
    sessionId: request.executionId,
    tools: builtinRegistry.tools,
    executeToolCall: (toolCall, toolSignal) =>
      builtinRegistry.executeToolCall(toolCall, toolSignal),
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

async function completeWithRetry(input: CompletePromptRunInput) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await backend.completePromptRun(input);
      return;
    } catch (error) {
      if (attempt >= COMPLETION_RETRY_DELAYS_MS.length) {
        // The Rust lease sweeper records the run as expired; nothing is lost
        // silently, but the conclusion text is dropped.
        console.warn("Cron Auto Prompt completion failed permanently", error);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, COMPLETION_RETRY_DELAYS_MS[attempt]));
    }
  }
}

const abortControllers = new Map<string, AbortController>();

async function runClaimed(request: PromptRunRequest) {
  const controller = new AbortController();
  abortControllers.set(request.executionId, controller);
  const startedAt = Date.now();
  const abortDelay = Math.max(1, request.leaseExpiresAt - Date.now() - LEASE_SAFETY_MARGIN_MS);
  const abortTimer = setTimeout(() => controller.abort(), abortDelay);

  emitWireEvent({
    type: "cron_prompt_started",
    execution_id: request.executionId,
    task_id: request.taskId,
    task_name: request.taskName,
  });

  let success = false;
  let output = "";
  try {
    const { settings } = await loadPersistedSettingsWithDefaults();
    output = await executeCronPromptRun(settings, request, controller.signal);
    success = true;
  } catch (error) {
    output = error instanceof Error ? error.message : String(error ?? "");
  } finally {
    clearTimeout(abortTimer);
    abortControllers.delete(request.executionId);
  }

  const durationMs = Math.max(0, Date.now() - startedAt);
  if (controller.signal.aborted && !success) {
    // The lease sweeper on the Rust side records the timeout; a late
    // completion would be answered with AlreadyFinished anyway.
    return;
  }
  await completeWithRetry({
    executionId: request.executionId,
    success,
    durationMs,
    output: output.trim(),
  });
  emitWireEvent({
    type: "cron_prompt_ended",
    execution_id: request.executionId,
    task_id: request.taskId,
    task_name: request.taskName,
    success,
    duration_ms: durationMs,
    output: output.trim(),
  });
}

let claimInFlight: Promise<void> | null = null;

async function claimAndRun() {
  let claimed: PromptRunRequest[] = [];
  try {
    claimed = await backend.claimPromptRuns();
  } catch (error) {
    console.warn("Cron Auto Prompt claim failed", error);
    return;
  }
  for (const request of claimed) {
    void runClaimed(request).catch((error) => {
      console.error(`[cron] run failed for ${request.executionId}:`, error);
    });
  }
}

/**
 * 认领并执行当前所有待跑的定时任务。同步去重:一次 claim 在飞时再次 poke
 * 是空操作 —— claim 本身在 Rust 侧原子,这道只是省掉多余往返。
 */
export function pokeCronPromptRuns(): { accepted: boolean } {
  if (!claimInFlight) {
    claimInFlight = claimAndRun().finally(() => {
      claimInFlight = null;
    });
  }
  return { accepted: true };
}

let reconcileTimer: ReturnType<typeof setInterval> | null = null;

/** 引擎启动时装上对账定时器:定时任务不再依赖有没有前端开着。 */
export function startCronPromptRunner(): void {
  if (reconcileTimer) return;
  reconcileTimer = setInterval(() => {
    pokeCronPromptRuns();
  }, PROMPT_RUN_RECONCILE_INTERVAL_MS);
  // 进程退出不必等这个定时器。
  reconcileTimer.unref?.();
  pokeCronPromptRuns();
}
