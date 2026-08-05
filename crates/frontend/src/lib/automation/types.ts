// Wire types for the automation domain (cron tasks + conversation hooks).
// Mirrors src-tauri/src/services/automation/types.rs — the Rust side is the
// single source of truth; both frontends consume these shapes verbatim.

export type CronTaskType = "bash" | "http" | "prompt";

export type HookType = "command" | "http";

export type HookEvent =
  | "agent_start"
  | "turn_start"
  | "message_start"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_end"
  | "turn_end"
  | "agent_end";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export const HOOK_EVENTS: HookEvent[] = [
  "agent_start",
  "turn_start",
  "message_start",
  "message_end",
  "tool_execution_start",
  "tool_execution_end",
  "turn_end",
  "agent_end",
];

export const HTTP_METHODS: HttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

/// Header values are replaced with this sentinel in snapshots that leave the
/// desktop; sending it back in a patch keeps the stored secret unchanged.
export const MASKED_HEADER_VALUE = "__liveagent-masked__";

/**
 * Per-task execution timeout (seconds) applied to bash scripts, each http
 * request and the prompt run lease. Bounds mirror the Rust validator
 * (`MIN/MAX_CRON_TIMEOUT_SECONDS`); the max matches the shell runner's hard
 * ten-minute cap. Snapshots from desktops older than this field omit it —
 * resolve absent values to the default for display.
 */
export const DEFAULT_CRON_TIMEOUT_SECONDS = 300;
export const MIN_CRON_TIMEOUT_SECONDS = 1;
export const MAX_CRON_TIMEOUT_SECONDS = 600;

export function canHttpMethodHaveBody(method: HttpMethod): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

export type HttpRequestSpec = {
  id: string;
  url: string;
  method: HttpMethod;
  headers?: Record<string, string>;
  body?: unknown;
};

export type SelectedModelRef = {
  customProviderId: string;
  model: string;
};

export type CronTask = {
  id: string;
  name: string;
  description: string;
  cron: string;
  enabled: boolean;
  remainingExecutions?: number;
  /** Execution timeout in seconds; absent (pre-field snapshot) = 300. */
  timeoutSeconds?: number;
  type: CronTaskType;
  script?: string;
  requests?: HttpRequestSpec[];
  prompt?: string;
  selectedModel?: SelectedModelRef;
  /** Thinking level for prompt tasks; absent/empty = runtime default. */
  reasoning?: string;
  /** Workspace path pinned for this task; absent/empty = follow the globally
   * active workspace. Never set on http tasks. */
  workdir?: string;
  lastError?: string;
};

export type HookDef = {
  id: string;
  name: string;
  description: string;
  event: HookEvent;
  enabled: boolean;
  type: HookType;
  script?: string;
  requests?: HttpRequestSpec[];
  timeoutMs?: number;
};

export type CronSnapshot = {
  revision: number;
  tasks: CronTask[];
};

export type HooksSnapshot = {
  revision: number;
  hooks: HookDef[];
};

export type AutomationSnapshot = {
  cron: CronSnapshot;
  hooks: HooksSnapshot;
};

export type CronRunState = "pending" | "leased" | "done" | "expired";

export type CronRunNowResponse = {
  startedAt: number;
};

export type CronRunRecord = {
  id: string;
  taskId: string;
  state: CronRunState;
  success: boolean;
  startedAt: number;
  finishedAt?: number;
  durationMs: number;
  exitCode?: number;
  output: string;
};

export const MANUAL_CRON_RUN_POLL_INTERVAL_MS = 1_000;
export const MANUAL_CRON_RUN_TIMEOUT_MS = 6 * 60_000;

const CONCURRENT_RUN_SKIP_PREFIX = "Skipped: previous run is still in progress.";

export function findManualCronRun(
  runs: CronRunRecord[],
  startedAt: number,
): CronRunRecord | undefined {
  return runs.reduce<CronRunRecord | undefined>((match, run) => {
    if (run.startedAt < startedAt || run.output.startsWith(CONCURRENT_RUN_SKIP_PREFIX)) {
      return match;
    }
    if (!match || run.startedAt < match.startedAt) {
      return run;
    }
    return match;
  }, undefined);
}

export function isManualCronRunFinished(runs: CronRunRecord[], startedAt: number): boolean {
  const run = findManualCronRun(runs, startedAt);
  return run?.state === "done" || run?.state === "expired";
}

export type PromptRunRequest = {
  executionId: string;
  taskId: string;
  taskName: string;
  prompt: string;
  providerId: string;
  model: string;
  startedAt: number;
  leaseExpiresAt: number;
  counted: boolean;
  /** Resolved at queue time (task pin or global workdir). Empty on rows
   * queued before this field existed; the runner falls back to the global
   * workdir then. */
  workdir: string;
  /** Task thinking level; empty means the runner's default. */
  reasoning: string;
};

export type CompletePromptRunInput = {
  executionId: string;
  success: boolean;
  durationMs: number;
  output: string;
};

export type PromptCompletionResponse = {
  status: "completed" | "already_finished";
};

export type AutomationOp =
  | { op: "create"; item: Record<string, unknown> }
  | { op: "update"; id: string; patch: Record<string, unknown> }
  | { op: "delete"; id: string }
  | { op: "reorder"; ids: string[] };

export type AutomationApplyInput = {
  baseRevision: number;
  ops: AutomationOp[];
};

export type ApplyStatus = "ok" | "conflict";

export type CronApplyResponse = {
  status: ApplyStatus;
  cron: CronSnapshot;
};

export type HooksApplyResponse = {
  status: ApplyStatus;
  hooks: HooksSnapshot;
};

export const HOOK_EVENT_TRANSLATION_KEYS: Record<HookEvent, string> = {
  agent_start: "settings.hooksEventAgentStart",
  turn_start: "settings.hooksEventTurnStart",
  message_start: "settings.hooksEventMessageStart",
  message_end: "settings.hooksEventMessageEnd",
  tool_execution_start: "settings.hooksEventToolExecutionStart",
  tool_execution_end: "settings.hooksEventToolExecutionEnd",
  turn_end: "settings.hooksEventTurnEnd",
  agent_end: "settings.hooksEventAgentEnd",
};

export const HOOK_EVENT_DESCRIPTION_TRANSLATION_KEYS: Record<HookEvent, string> = {
  agent_start: "settings.hooksEventAgentStartDesc",
  turn_start: "settings.hooksEventTurnStartDesc",
  message_start: "settings.hooksEventMessageStartDesc",
  message_end: "settings.hooksEventMessageEndDesc",
  tool_execution_start: "settings.hooksEventToolExecutionStartDesc",
  tool_execution_end: "settings.hooksEventToolExecutionEndDesc",
  turn_end: "settings.hooksEventTurnEndDesc",
  agent_end: "settings.hooksEventAgentEndDesc",
};
