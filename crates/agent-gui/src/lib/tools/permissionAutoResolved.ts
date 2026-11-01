// K-brain 没有询问就放行的工具调用(permission.auto_resolved):只读操作或命中已记住
// 的规则。桌面端在这里按 toolCallId 记下来源,工具行据此显示小标记;同步给 WebUI 的
// 参数由 gatewayToolPreview 叠加同一标记。只存在内存里:标记只说明这一次运行发生了
// 什么,重新加载后不再显示。

import {
  normalizeToolPermissionAutoResolved,
  type ToolPermissionAutoResolved,
} from "@liveagent/ui/lib/chat/toolApprovalArgs";

// 一次会话里自动放行的调用可以很多;只保留最近的,旧的标记随之淡出。
const MAX_ENTRIES = 1000;

const byToolCallId = new Map<string, ToolPermissionAutoResolved>();
const listeners = new Set<() => void>();
let version = 0;

export function recordPermissionAutoResolved(toolCallId: string, value: unknown): boolean {
  const key = toolCallId.trim();
  const normalized = normalizeToolPermissionAutoResolved(value);
  if (!key || !normalized) return false;
  byToolCallId.delete(key);
  byToolCallId.set(key, normalized);
  while (byToolCallId.size > MAX_ENTRIES) {
    const oldest = byToolCallId.keys().next().value;
    if (oldest === undefined) break;
    byToolCallId.delete(oldest);
  }
  version += 1;
  for (const listener of listeners) listener();
  return true;
}

export function getPermissionAutoResolved(toolCallId: string): ToolPermissionAutoResolved | null {
  return byToolCallId.get(toolCallId.trim()) ?? null;
}

export function subscribePermissionAutoResolved(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPermissionAutoResolvedVersion(): number {
  return version;
}
