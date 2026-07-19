import type { Context } from "@earendil-works/pi-ai";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import type { CompletePromptRunInput, PromptRunRequest } from "../../lib/automation";
import { backend } from "../../lib/automation/backend";
import { runAssistantWithTools } from "../../lib/chat/runner/agentRunner";
import { createStreamDebugLogger } from "../../lib/debug/agentDebug";
import { assistantMessageToText } from "../../lib/providers/llm";
import { resolveRuntimePlatform } from "../../lib/runtimePlatform";
import {
  type AppSettings,
  DEFAULT_CHAT_RUNTIME_CONTROLS,
  findProviderModelConfig,
  isAgentDevMode,
  isAgentExecutionMode,
  type ReasoningLevel,
} from "../../lib/settings";
import {
  buildSkillsSystemPrompt,
  discoverSkills,
  isAlwaysEnabledSkillName,
  type SkillSummary,
} from "../../lib/skills";
import { buildBuiltinToolRegistry } from "../../lib/tools/builtinRegistry";
import { createFileToolState } from "../../lib/tools/fileToolState";
import type { SkillAccessPolicy } from "../../lib/tools/skillAccessPolicy";
import { appendSystemPrompt } from "../../pages/chat";
import {
  createCompletePromptRunInput,
  PROMPT_RUN_RECONCILE_INTERVAL_MS,
} from "./promptRunProtocol";

const PROMPT_PENDING_EVENT = "automation:prompt-pending";
const PROMPT_EXPIRED_EVENT = "automation:prompt-expired";
/** Abort slightly before the Rust lease expires so our completion wins the race. */
const LEASE_SAFETY_MARGIN_MS = 2_000;
const COMPLETION_RETRY_DELAYS_MS = [1_000, 5_000, 15_000];

type CronPromptRunnerProps = {
  settings: AppSettings;
};

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

function getActiveAgentPrompt(settings: AppSettings) {
  return (
    settings.agents.find((template) => template.enabled && template.prompt.trim())?.prompt.trim() ??
    ""
  );
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
  if (!isAgentExecutionMode(settings.system.executionMode)) {
    throw new Error(
      "Auto Prompt requires System -> Execution Mode to be Agent Mode or Agent Dev Mode.",
    );
  }

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
    selectedSystemToolIds: settings.system.selectedSystemTools,
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
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      customHeaders: provider.customHeaders,
      requestFormat: provider.requestFormat,
      reasoning: resolveCronReasoning(request.reasoning),
      promptCachingEnabled: true,
      nativeWebSearchEnabled: DEFAULT_CHAT_RUNTIME_CONTROLS.nativeWebSearchEnabled,
      useSystemProxy: provider.useSystemProxy,
      modelConfig: findProviderModelConfig(provider, request.model),
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
      await new Promise((resolve) =>
        window.setTimeout(resolve, COMPLETION_RETRY_DELAYS_MS[attempt]),
      );
    }
  }
}

/**
 * Executes prompt-type cron runs. The Rust store owns the queue: claiming is
 * an atomic pending->leased transition, so concurrent claims (StrictMode
 * double-mount, multiple polls) can never double-run a task, and completions
 * are idempotent against the lease state machine.
 */
export function CronPromptRunner({ settings }: CronPromptRunnerProps) {
  const settingsRef = useRef(settings);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    let disposed = false;
    const abortControllers = new Map<string, AbortController>();

    async function runClaimed(request: PromptRunRequest) {
      const controller = new AbortController();
      abortControllers.set(request.executionId, controller);
      const startedAt = Date.now();
      const abortDelay = Math.max(1, request.leaseExpiresAt - Date.now() - LEASE_SAFETY_MARGIN_MS);
      const abortTimer = window.setTimeout(() => controller.abort(), abortDelay);

      let success = false;
      let output = "";
      try {
        output = await executeCronPromptRun(settingsRef.current, request, controller.signal);
        success = true;
      } catch (error) {
        output = error instanceof Error ? error.message : String(error ?? "");
      } finally {
        window.clearTimeout(abortTimer);
        abortControllers.delete(request.executionId);
      }

      if (controller.signal.aborted && !success) {
        // The lease sweeper on the Rust side records the timeout; a late
        // completion would be answered with AlreadyFinished anyway.
        return;
      }
      await completeWithRetry(
        createCompletePromptRunInput(
          request.executionId,
          success,
          Math.max(0, Date.now() - startedAt),
          output.trim(),
        ),
      );
    }

    async function claimAndRun() {
      let claimed: PromptRunRequest[] = [];
      try {
        claimed = await backend.claimPromptRuns();
      } catch (error) {
        console.warn("Cron Auto Prompt claim failed", error);
        return;
      }
      if (disposed) {
        // Claimed after unmount (StrictMode remount window): hand the runs
        // back so the surviving runner instance picks them up.
        for (const request of claimed) {
          void backend.releasePromptRun(request.executionId).catch(() => undefined);
        }
        return;
      }
      for (const request of claimed) {
        void runClaimed(request);
      }
    }

    let claimInFlight: Promise<void> | null = null;
    function requestClaim() {
      if (disposed || claimInFlight) return;
      claimInFlight = claimAndRun().finally(() => {
        claimInFlight = null;
      });
    }

    const unlistenPending = listen(PROMPT_PENDING_EVENT, () => {
      requestClaim();
    });
    const unlistenExpired = listen<{ executionId: string }>(PROMPT_EXPIRED_EVENT, (event) => {
      abortControllers.get(event.payload?.executionId ?? "")?.abort();
    });
    const reconcileTimer = window.setInterval(requestClaim, PROMPT_RUN_RECONCILE_INTERVAL_MS);
    requestClaim();

    return () => {
      disposed = true;
      window.clearInterval(reconcileTimer);
      void unlistenPending.then((unlisten) => unlisten());
      void unlistenExpired.then((unlisten) => unlisten());
      for (const controller of abortControllers.values()) {
        controller.abort();
      }
    };
  }, []);

  return null;
}
