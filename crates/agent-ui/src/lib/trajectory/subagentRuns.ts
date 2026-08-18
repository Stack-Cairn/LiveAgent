/**
 * 子代理运行 → 轨迹 SUBTOOL 行的数据源。
 *
 * 子代理的完整轨迹独立持久化在 `subagentRun` 表里，不进主会话事件流——否则一次
 * 8 路并行委托会把中继窗口占满。主事件流只在 `tool_end` 上记 runId，展开时由宿主
 * 预取运行并交给布局层。
 *
 * 这里直接解析原始消息数组而不复用 `buildUiMessages`：只需要工具调用的骨架，
 * 走完整的 UI 消息折叠既慢又把宿主类型拖进共享层。
 */

import type { TrajectoryStatus, TrajectorySubagentRun } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 把后端的运行状态字符串归一到轨迹状态；未知值按运行中处理。 */
export function normalizeSubagentStatus(value: unknown): TrajectoryStatus {
  switch (value) {
    case "complete":
    case "completed":
    case "succeeded":
      return "complete";
    case "error":
    case "failed":
      return "error";
    case "cancelled":
    case "canceled":
    case "aborted":
      return "aborted";
    default:
      return "running";
  }
}

type ExtractedTool = {
  callId: string;
  name: string;
  isError: boolean;
  /** toolCall 所在 assistant 消息的时间戳；消息缺时间时保持 null。 */
  startedAt: number | null;
  /** toolResult 消息的时间戳；结果未回（仍在跑/被中断）时保持 null。 */
  endedAt: number | null;
};

type ExtractedStep = {
  step: number;
  startedAt: number | null;
  endedAt: number | null;
  tools: ExtractedTool[];
};

/**
 * 从子代理的原始消息数组抽出逐 step 的工具骨架。
 *
 * @param messages - `messages_json` 解析后的数组，内容不受信任。
 * @returns 按 assistant 消息切分的 step 列表。
 */
export function extractSubagentSteps(messages: unknown): ExtractedStep[] {
  if (!Array.isArray(messages)) return [];
  const steps: ExtractedStep[] = [];
  const toolIndex = new Map<string, ExtractedTool>();

  for (const message of messages) {
    if (!isRecord(message)) continue;
    const timestamp = finiteOrNull(message.timestamp);

    if (message.role === "assistant") {
      const tools: ExtractedTool[] = [];
      const content = Array.isArray(message.content) ? message.content : [];
      for (const block of content) {
        if (!isRecord(block) || block.type !== "toolCall") continue;
        const callId = typeof block.id === "string" ? block.id : "";
        const name = typeof block.name === "string" ? block.name : "";
        if (callId === "" || name === "") continue;
        // 工具的起点用 assistant 消息自身的时间戳；它是布局层能拿到的最接近
        // 「这次调用何时发起」的真实信号，不再与整段 step 共用同一跨度。
        const tool: ExtractedTool = {
          callId,
          name,
          isError: false,
          startedAt: timestamp,
          endedAt: null,
        };
        tools.push(tool);
        toolIndex.set(callId, tool);
      }
      steps.push({
        step: steps.length + 1,
        startedAt: timestamp,
        endedAt: timestamp,
        tools,
      });
      continue;
    }

    if (message.role === "toolResult") {
      const callId = typeof message.toolCallId === "string" ? message.toolCallId : "";
      const tool = toolIndex.get(callId);
      if (tool !== undefined) {
        tool.isError = message.isError === true;
        if (timestamp !== null) tool.endedAt = timestamp;
      }
      // 工具结果的时间戳比 assistant 消息更接近这一步的真实结束点。
      const owner = steps.at(-1);
      if (owner !== undefined && timestamp !== null) owner.endedAt = timestamp;
    }
  }

  return steps;
}

/**
 * 组装一次子代理运行的轨迹视图。
 *
 * @param params - 运行元数据与其原始消息数组。
 * @returns 布局层可直接展开成 SUBTOOL 行的运行。
 */
export function buildTrajectorySubagentRun(params: {
  runId: string;
  agentId: string;
  name?: string;
  mode?: string;
  status: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
  messages: unknown;
}): TrajectorySubagentRun {
  return {
    runId: params.runId,
    agentId: params.agentId,
    ...(params.name === undefined ? {} : { name: params.name }),
    ...(params.mode === undefined ? {} : { mode: params.mode }),
    status: normalizeSubagentStatus(params.status),
    startedAt: finiteOrNull(params.startedAt),
    endedAt: finiteOrNull(params.endedAt),
    steps: extractSubagentSteps(params.messages),
  };
}

/**
 * 合并一次运行的多个分段消息。
 *
 * @param segments - 后端返回的分段，含 `messagesJson`。
 * @returns 按分段顺序拼接的消息数组；解析失败的分段被跳过。
 */
export function concatSubagentSegmentMessages(segments: unknown): unknown[] {
  if (!Array.isArray(segments)) return [];
  const out: unknown[] = [];
  for (const segment of segments) {
    if (!isRecord(segment)) continue;
    const raw = segment.messagesJson ?? segment.messages_json;
    if (typeof raw !== "string" || raw.trim() === "") continue;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) out.push(...parsed);
    } catch {
      // 单个分段损坏只丢该段，其余照常展开。
    }
  }
  return out;
}
