import type { KBrainGoalState } from "./types";

/**
 * 按 LiveAgent 对话 id 保存最近一次的 K-brain 目标状态。运行中的 goal.updated
 * 事件和目标栏的主动读取都写到这里，目标栏按对话订阅。
 */
const states = new Map<string, KBrainGoalState>();
const listeners = new Set<(conversationId: string) => void>();

export function publishGoalState(conversationId: string, state: KBrainGoalState) {
  const key = conversationId.trim();
  if (!key) return;
  states.set(key, state);
  for (const listener of listeners) listener(key);
}

export function readGoalState(conversationId: string): KBrainGoalState | undefined {
  return states.get(conversationId.trim());
}

export function subscribeGoalState(listener: (conversationId: string) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
