// K-brain 工具结果的运行信息：命令退出码、是否超时、工具自身耗时（tool.result 与
// 历史 tool_calls[] 上可选的 exit_code / timed_out / duration_ms）。只用于展示。
// 接入层把它放在 ToolResultMessage.details 的 TOOL_RUN_INFO_DETAILS_KEY 下。

export const TOOL_RUN_INFO_DETAILS_KEY = "kbrainRun";

/** 带运行信息的命令类工具；其他工具的 duration_ms 不展示，也不写进 details。 */
export const TOOL_RUN_INFO_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Bash",
  "bash",
  "ManagedProcess",
  "ProcessWait",
  "ProcessStop",
]);

export type ToolRunInfo = {
  exitCode?: number;
  timedOut?: boolean;
  durationMs?: number;
};

/** K-brain 的蛇形字段转成运行信息；三项都没有时返回 undefined。 */
export function toolRunInfoFromKBrain(raw: unknown): ToolRunInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const info: ToolRunInfo = {};
  if (typeof record.exit_code === "number" && Number.isInteger(record.exit_code)) {
    info.exitCode = record.exit_code;
  }
  if (record.timed_out === true) info.timedOut = true;
  if (
    typeof record.duration_ms === "number" &&
    Number.isFinite(record.duration_ms) &&
    record.duration_ms >= 0
  ) {
    info.durationMs = record.duration_ms;
  }
  return Object.keys(info).length > 0 ? info : undefined;
}

/** 命令类工具的结果 details 附上运行信息；不是命令类工具或没有运行信息时原样返回。 */
export function withToolRunInfo(
  toolName: string | undefined,
  details: unknown,
  raw: unknown,
): unknown {
  if (!toolName || !TOOL_RUN_INFO_TOOL_NAMES.has(toolName)) return details;
  const info = toolRunInfoFromKBrain(raw);
  if (!info) return details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    return { ...(details as Record<string, unknown>), [TOOL_RUN_INFO_DETAILS_KEY]: info };
  }
  return { [TOOL_RUN_INFO_DETAILS_KEY]: info };
}

export function readToolRunInfo(details: unknown): ToolRunInfo | null {
  if (!details || typeof details !== "object") return null;
  const value = (details as Record<string, unknown>)[TOOL_RUN_INFO_DETAILS_KEY];
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const info: ToolRunInfo = {};
  if (typeof record.exitCode === "number" && Number.isInteger(record.exitCode)) {
    info.exitCode = record.exitCode;
  }
  if (record.timedOut === true) info.timedOut = true;
  if (typeof record.durationMs === "number" && Number.isFinite(record.durationMs)) {
    info.durationMs = Math.max(0, record.durationMs);
  }
  return Object.keys(info).length > 0 ? info : null;
}

/** 工具耗时：不足 1 秒显示毫秒，1 分钟内保留一位小数，更长按分秒。 */
export function formatToolRunDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  const totalSeconds = Math.round(durationMs / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours > 0 ? `${hours}h` : "", `${minutes}m`, `${seconds}s`].filter(Boolean).join("");
}

export type ToolRunInfoLabels = {
  /** 含 {code} 占位，如 "exit {code}"。 */
  exitCode: string;
  timedOut: string;
};

const DEFAULT_TOOL_RUN_INFO_LABELS: ToolRunInfoLabels = {
  exitCode: "exit {code}",
  timedOut: "timed out",
};

/** 命令卡标题行右侧的短摘要，如 "exit 1 · 2.3s"、"timed out · 30.0s"。 */
export function formatToolRunInfo(
  info: ToolRunInfo | null,
  labels: ToolRunInfoLabels = DEFAULT_TOOL_RUN_INFO_LABELS,
): string {
  if (!info) return "";
  const parts: string[] = [];
  if (info.timedOut) parts.push(labels.timedOut);
  else if (info.exitCode !== undefined) {
    parts.push(labels.exitCode.replace("{code}", String(info.exitCode)));
  }
  if (info.durationMs !== undefined) parts.push(formatToolRunDuration(info.durationMs));
  return parts.join(" · ");
}
