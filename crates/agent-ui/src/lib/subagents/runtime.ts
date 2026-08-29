/**
 * Live subagent run mirror.
 *
 * 协议层（./protocol）只描述**终态报告**：它随 tool_result 落进 transcript，
 * 因此没有 "running" 这个状态。可用户最需要看见的恰恰是运行中的那一段——子代理
 * 在跑第几轮、正在执行什么工具、用的哪个模型和思考档位，以及「我能不能把它停
 * 掉」。这份镜像补的就是那段空档。
 *
 * 与 managed-process 那套镜像的关键区别：托管进程的权威态在 Rust 注册表里，
 * 所以那边需要 backend 契约 + 快照对账 + 丢帧重拉。子代理运行时完全活在
 * webview 的同一个 JS realm 内（AbortController 就在隔壁模块），没有传输层可
 * 丢帧，于是这里是纯内存的、由宿主直接 feed 的单向镜像：宿主
 * （crates/agent-gui 的子代理运行层）调 start/update/finish，UI 只读。
 *
 * 宿主缺席时（gateway-webui 等不跑子代理的场景）本模块保持空表，UI 自然隐藏，
 * 不需要任何平台适配器。
 */

import { useSyncExternalStore } from "react";
import type { SubagentProtocolMode, SubagentProtocolStatus } from "./protocol";

/**
 * 运行阶段。区分 provisioning 与 running 是有意的：worktree 供给要跑好几条
 * git 命令，是历史上最容易让人误判成「卡死」的一段，必须能单独看见。
 */
export type SubagentRuntimePhase = "queued" | "provisioning" | "running" | "settling" | "finished";

export type SubagentRuntimeRun = {
  runId: string;
  conversationId: string;
  agentId: string;
  name: string;
  role?: string;
  prompt: string;
  mode: SubagentProtocolMode;
  providerId: string;
  model: string;
  /** 思考档位；undefined = 沿用该模型默认档位，"off" = 显式关闭。 */
  reasoning?: string;
  phase: SubagentRuntimePhase;
  /** 当前活动行（「第 N 轮：模型生成中...」/「正在执行：xxx」/worktree 阶段提示）。 */
  statusText?: string;
  rounds: number;
  toolCalls: number;
  startedAt: number;
  endedAt?: number;
  status?: SubagentProtocolStatus;
  error?: string;
  /** 用户已按过停止；停止请求发出到运行真正收敛之间会停留在这个中间态。 */
  stopRequested: boolean;
  /** 宿主是否登记了停止句柄。没有句柄就不该渲染可点的停止按钮。 */
  stoppable: boolean;
};

export type SubagentRuntimeStartInput = {
  runId: string;
  conversationId: string;
  agentId: string;
  name: string;
  role?: string;
  prompt: string;
  mode: SubagentProtocolMode;
  providerId: string;
  model: string;
  reasoning?: string;
  startedAt: number;
  /** 停止句柄（通常是 per-agent AbortController.abort 的绑定）。 */
  stop?: () => void;
};

export type SubagentRuntimePatch = {
  phase?: SubagentRuntimePhase;
  /** null 显式清空活动行；undefined 表示不改。 */
  statusText?: string | null;
  rounds?: number;
  toolCalls?: number;
  model?: string;
  reasoning?: string;
};

export type SubagentRuntimeFinishInput = {
  status: SubagentProtocolStatus;
  error?: string;
  endedAt: number;
};

/**
 * 终态记录保留上限。保留终态是刻意的——用户按了停止之后需要看到「确实停了」，
 * 而不是那一行凭空消失。超限时丢最旧的终态，运行中的永不丢。
 */
const MAX_FINISHED_RUNS = 24;

const runs = new Map<string, SubagentRuntimeRun>();
const stoppers = new Map<string, () => void>();
const listeners = new Set<() => void>();

let snapshot: readonly SubagentRuntimeRun[] = [];

function isFinished(run: SubagentRuntimeRun) {
  return run.phase === "finished";
}

/**
 * 排序：运行中优先，其次按开始时间倒序。运行中的条目必须稳定待在顶部，否则
 * 一个刚结束的兄弟代理会把用户正在观察的那一行挤走。
 */
function rebuildSnapshot() {
  snapshot = [...runs.values()].sort((left, right) => {
    const leftFinished = isFinished(left);
    const rightFinished = isFinished(right);
    if (leftFinished !== rightFinished) return leftFinished ? 1 : -1;
    return right.startedAt - left.startedAt;
  });
}

function emit() {
  rebuildSnapshot();
  for (const listener of listeners) {
    listener();
  }
}

function pruneFinished() {
  const finished = [...runs.values()].filter(isFinished);
  if (finished.length <= MAX_FINISHED_RUNS) return;
  finished
    .sort((left, right) => (left.endedAt ?? left.startedAt) - (right.endedAt ?? right.startedAt))
    .slice(0, finished.length - MAX_FINISHED_RUNS)
    .forEach((run) => {
      runs.delete(run.runId);
      stoppers.delete(run.runId);
    });
}

export function getSubagentRuntimeRuns(): readonly SubagentRuntimeRun[] {
  return snapshot;
}

export function subscribeSubagentRuntimeRuns(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 宿主：登记一个新运行。同 runId 重复调用视为覆盖（重试/恢复场景）。 */
export function startSubagentRuntimeRun(input: SubagentRuntimeStartInput) {
  const runId = input.runId.trim();
  if (!runId) return;
  const { stop, ...rest } = input;
  if (stop) stoppers.set(runId, stop);
  else stoppers.delete(runId);
  runs.set(runId, {
    ...rest,
    runId,
    phase: "queued",
    rounds: 0,
    toolCalls: 0,
    stopRequested: false,
    stoppable: Boolean(stop),
  });
  pruneFinished();
  emit();
}

/** 宿主：推进运行态。未登记的 runId 静默忽略（终态被裁剪后仍可能有迟到的 patch）。 */
export function updateSubagentRuntimeRun(runId: string, patch: SubagentRuntimePatch) {
  const existing = runs.get(runId.trim());
  if (!existing) return;
  // 终态之后不再接受推进：settle 阶段的迟到回调不该把已经结束的行拉回运行中。
  if (isFinished(existing)) return;
  const next: SubagentRuntimeRun = { ...existing };
  if (patch.phase !== undefined) next.phase = patch.phase;
  if (patch.statusText !== undefined) {
    if (patch.statusText === null) delete next.statusText;
    else next.statusText = patch.statusText;
  }
  if (patch.rounds !== undefined) next.rounds = Math.max(existing.rounds, patch.rounds);
  if (patch.toolCalls !== undefined) next.toolCalls = Math.max(existing.toolCalls, patch.toolCalls);
  if (patch.model !== undefined) next.model = patch.model;
  if (patch.reasoning !== undefined) next.reasoning = patch.reasoning;
  runs.set(next.runId, next);
  emit();
}

/** 宿主：收敛为终态。停止句柄同时释放，避免持有已结束运行的 AbortController。 */
export function finishSubagentRuntimeRun(runId: string, outcome: SubagentRuntimeFinishInput) {
  const id = runId.trim();
  const existing = runs.get(id);
  stoppers.delete(id);
  if (!existing) return;
  const next: SubagentRuntimeRun = {
    ...existing,
    phase: "finished",
    status: outcome.status,
    endedAt: outcome.endedAt,
    stoppable: false,
  };
  if (outcome.error) next.error = outcome.error;
  else delete next.error;
  delete next.statusText;
  runs.set(id, next);
  pruneFinished();
  emit();
}

/**
 * UI 动作：请求停止单个子代理。只翻 stopRequested 并调句柄——真正的收敛由宿主
 * 的 finish 回调完成。这里不乐观改 phase：如果句柄因为某种原因没生效，用户应
 * 该继续看到它在跑，而不是看到一个假的「已结束」。
 */
export function stopSubagentRuntimeRun(runId: string) {
  const id = runId.trim();
  const existing = runs.get(id);
  if (!existing || isFinished(existing) || existing.stopRequested) return;
  runs.set(id, { ...existing, stopRequested: true });
  emit();
  const stop = stoppers.get(id);
  if (!stop) return;
  try {
    stop();
  } catch {
    // 停止句柄自身抛错不该把面板打挂；运行要么已经在收敛，要么会由回合级取消兜住。
  }
}

/** UI 动作：清掉已结束的条目。 */
export function clearFinishedSubagentRuntimeRuns() {
  let changed = false;
  for (const run of [...runs.values()]) {
    if (!isFinished(run)) continue;
    runs.delete(run.runId);
    stoppers.delete(run.runId);
    changed = true;
  }
  if (changed) emit();
}

/**
 * 宿主：丢弃某个会话的全部条目（会话切换/删除）。运行中的条目也一并丢——镜像
 * 不是权威态，宿主那边的取消由会话生命周期自己负责。
 */
export function dropSubagentRuntimeRunsForConversation(conversationId: string) {
  const id = conversationId.trim();
  if (!id) return;
  let changed = false;
  for (const run of [...runs.values()]) {
    if (run.conversationId !== id) continue;
    runs.delete(run.runId);
    stoppers.delete(run.runId);
    changed = true;
  }
  if (changed) emit();
}

/** 测试用：清空全部状态。 */
export function resetSubagentRuntimeRuns() {
  runs.clear();
  stoppers.clear();
  emit();
}

export function useSubagentRuntimeRuns(): readonly SubagentRuntimeRun[] {
  return useSyncExternalStore(
    subscribeSubagentRuntimeRuns,
    getSubagentRuntimeRuns,
    getSubagentRuntimeRuns,
  );
}
