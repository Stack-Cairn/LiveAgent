import type { ComposerGoalBarState } from "@liveagent/ui/components/chat/ComposerGoalBar";
import type { GoalManageResponse } from "../gatewaySocketShared";

/** WebUI 目标栏使用的会话目标状态；来源是 goal.manage 响应或运行中推送的 goal_updated 事件。 */
export type WebGoalState = {
  goal: string;
  status: string;
  round: number;
  maxRounds: number;
  reason: string;
  /** RFC3339；未知时为空串。 */
  startedAt: string;
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function goalStateFromResponse(response: GoalManageResponse): WebGoalState {
  return {
    goal: text(response.goal),
    status: text(response.status),
    round: count(response.round),
    maxRounds: count(response.maxRounds),
    reason: text(response.reason),
    startedAt: text(response.startedAt),
  };
}

/**
 * 解析运行中推送的目标事件：`{type:"goal_updated", goal:<K-brain GoalState>, conversation_id}`。
 * 桌面桥接与直连网关发同一形状；内层 GoalState 的 conversation_id 是 K-brain 会话 id，
 * 这里一律按外层（WebUI 的对话 id）归属。不是目标事件时返回 null。
 */
export function goalStateFromChatEvent(
  event: unknown,
): { conversationId: string; state: WebGoalState } | null {
  if (!event || typeof event !== "object") return null;
  const record = event as { type?: unknown; conversation_id?: unknown; goal?: unknown };
  if (record.type !== "goal_updated") return null;
  const conversationId = text(record.conversation_id).trim();
  const goal = record.goal;
  if (!conversationId || !goal || typeof goal !== "object" || Array.isArray(goal)) return null;
  const raw = goal as Record<string, unknown>;
  return {
    conversationId,
    state: {
      goal: text(raw.goal),
      status: text(raw.status),
      round: count(raw.round),
      maxRounds: count(raw.max_rounds),
      reason: text(raw.reason),
      startedAt: text(raw.started_at),
    },
  };
}

/** 与 GUI 目标栏一致：只有 active/continuing/paused 且有正文时显示，达成、清除或无目标时隐藏。 */
export function goalBarState(state: WebGoalState | undefined): ComposerGoalBarState | null {
  if (!state?.goal) return null;
  if (state.status !== "active" && state.status !== "continuing" && state.status !== "paused") {
    return null;
  }
  const startedAt = state.startedAt ? Date.parse(state.startedAt) : Number.NaN;
  return {
    goal: state.goal,
    status: state.status,
    round: state.round,
    maxRounds: state.maxRounds,
    reason: state.reason || undefined,
    startedAt: Number.isFinite(startedAt) ? startedAt : undefined,
  };
}

type GoalListener = (conversationId: string) => void;

const states = new Map<string, WebGoalState>();
const revisions = new Map<string, number>();
const listeners = new Set<GoalListener>();

export function publishGoalState(conversationId: string, state: WebGoalState): void {
  const key = conversationId.trim();
  if (!key) return;
  states.set(key, state);
  revisions.set(key, (revisions.get(key) ?? 0) + 1);
  for (const listener of listeners) listener(key);
}

export function readGoalState(conversationId: string | undefined): WebGoalState | undefined {
  const key = conversationId?.trim();
  return key ? states.get(key) : undefined;
}

/**
 * 每次 publish 加一。读取目标前记下修订号，返回时修订号已变说明期间有更新的
 * 推送或操作结果，旧的读取结果应丢弃。
 */
export function readGoalRevision(conversationId: string): number {
  return revisions.get(conversationId.trim()) ?? 0;
}

export function subscribeGoalState(listener: GoalListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 运行中推送的目标事件写入目标栏状态；返回是否是目标事件。事件本身照常交给对话流。 */
export function absorbGoalChatEvent(event: unknown): boolean {
  const parsed = goalStateFromChatEvent(event);
  if (!parsed) return false;
  publishGoalState(parsed.conversationId, parsed.state);
  return true;
}

/** 指令目录里有 goal 动作指令时，运行端才接受 /goal resume（直连 K-brain 的网关会把它滤掉）。 */
export function catalogSupportsGoalResume(
  commands: readonly { name: string; kind: string }[],
): boolean {
  return commands.some((command) => command.name === "goal" && command.kind === "action");
}
