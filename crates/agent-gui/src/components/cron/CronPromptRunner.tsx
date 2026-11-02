import { listen } from "@liveagent/app/shims/tauriEvent";
import type { CompletePromptRunInput, PromptRunRequest } from "@liveagent/ui/lib/automation/index";
import { useEffect } from "react";
import { backend } from "../../lib/automation/backend";
import { isKBrainBackendEnabled, isTauriHost } from "../../lib/host";
import { getConfiguredKBrainConnection } from "../../lib/kbrain/runtimeConnection";
import { runKBrainTurn } from "../../lib/kbrain/turn";
import { assistantMessageToText } from "../../lib/providers/llm";
import type { AppSettings } from "../../lib/settings";
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

type CronPromptRunOptions = {
  baseUrl?: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
};

function buildCronSystemPrompt(taskName: string) {
  const lines = ["You are running a scheduled Auto Prompt task in LiveAgent."];
  const normalizedTaskName = taskName.trim();
  if (normalizedTaskName) lines.push(`Task: ${normalizedTaskName}`);
  lines.push(
    "Return only the final conclusion for this run.",
    "Do not include raw JSON, tool calls, hidden reasoning, or intermediate execution logs.",
  );
  return lines.join("\n");
}

/**
 * Runs one claimed prompt through the backend-owned K-brain session. The GUI
 * deliberately supplies no tools or skill context; the Rust scheduler owns
 * the lease and completion state machine.
 */
export async function executeCronPromptRun(
  request: PromptRunRequest,
  signal: AbortSignal,
  options: CronPromptRunOptions = {},
) {
  const workdir = request.workdir.trim();
  if (!workdir) throw new Error("Scheduled Auto Prompt has no working directory.");
  if (!request.providerId.trim() || !request.model.trim()) {
    throw new Error("Scheduled Auto Prompt has an incomplete backend model.");
  }
  const connection = getConfiguredKBrainConnection();
  const assistant = await runKBrainTurn({
    conversationId: request.executionId,
    sessionId: request.executionId,
    clientRequestId: request.executionId,
    cwd: workdir,
    model: { provider: request.providerId, model: request.model },
    prompt: request.prompt.trim(),
    context: {
      systemPrompt: buildCronSystemPrompt(request.taskName),
      messages: [
        {
          role: "user",
          content: request.prompt.trim(),
          timestamp: request.startedAt || Date.now(),
        },
      ],
    },
    signal,
    baseUrl: options.baseUrl ?? connection?.baseUrl,
    token: options.token ?? connection?.token,
    fetch: options.fetch,
    onTextDelta() {},
    onThinkingDelta() {},
    onToolCall() {},
    onToolResult() {},
    onPermissionRequest: async () => "reject",
  });

  if (signal.aborted || assistant.stopReason === "aborted") {
    throw new Error("Scheduled Auto Prompt was cancelled.");
  }
  if (assistant.stopReason !== "stop") {
    throw new Error(assistant.errorMessage || "K-brain scheduled run failed.");
  }
  const conclusion = assistantMessageToText(assistant).trim();
  if (!conclusion) throw new Error("Auto Prompt request returned an empty conclusion.");
  return conclusion;
}

async function completeWithRetry(input: CompletePromptRunInput) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await backend.completePromptRun(input);
      return;
    } catch (error) {
      if (attempt >= COMPLETION_RETRY_DELAYS_MS.length) {
        // The Rust lease sweeper records the run as expired; nothing is lost silently.
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
 * an atomic pending->leased transition, so concurrent claims cannot double-run
 * a task, and completions are idempotent against the lease state machine.
 */
export function CronPromptRunner(_props: CronPromptRunnerProps) {
  useEffect(() => {
    // Browser builds do not have the desktop automation host. In particular,
    // do not start a reconcile timer that repeatedly emits invoke warnings.
    if (
      !isTauriHost() ||
      (typeof isKBrainBackendEnabled === "function" && isKBrainBackendEnabled())
    )
      return;

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
        output = await executeCronPromptRun(request, controller.signal);
        success = true;
      } catch (error) {
        output = error instanceof Error ? error.message : String(error ?? "");
      } finally {
        window.clearTimeout(abortTimer);
        abortControllers.delete(request.executionId);
      }

      if (controller.signal.aborted && !success) return;
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
        for (const request of claimed) {
          void backend.releasePromptRun(request.executionId).catch(() => undefined);
        }
        return;
      }
      for (const request of claimed) void runClaimed(request);
    }

    let claimInFlight: Promise<void> | null = null;
    function requestClaim() {
      if (disposed || claimInFlight) return;
      claimInFlight = claimAndRun().finally(() => {
        claimInFlight = null;
      });
    }

    const unlistenPending = listen(PROMPT_PENDING_EVENT, requestClaim);
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
      for (const controller of abortControllers.values()) controller.abort();
    };
  }, []);

  return null;
}
