/**
 * recorder 的 Tauri 落盘端口与 Gateway 下发端口。
 *
 * 落盘失败一律吞掉：轨迹是诊断视图，宁可缺一段记录也不该影响对话。
 */

import type { TrajectoryEvent, TrajectorySection } from "@liveagent/ui/lib/trajectory/types";
import { invoke } from "../../shims/tauriCore";
import type { TrajectoryRecorderPorts } from "./recorder";

export type TrajectoryPublish = (events: readonly TrajectoryEvent[]) => void;

/**
 * 构造桌面端 recorder 端口。
 *
 * @param publish - 实时下发回调；未连接 Gateway 时可缺省。
 * @returns 落盘与下发端口。
 */
export function createTauriTrajectoryPorts(publish?: TrajectoryPublish): TrajectoryRecorderPorts {
  return {
    persist: (conversationId, segmentIndex, eventsJson) =>
      invoke("trajectory_append_events", { conversationId, segmentIndex, eventsJson }),
    persistSections: (conversationId, sections: readonly TrajectorySection[]) =>
      invoke("trajectory_put_sections", { conversationId, sections }),
    ...(publish === undefined ? {} : { publish }),
  };
}
/** Resolve the next turn from persisted messages and the highest trajectory turn. */
export async function resolvePersistedTrajectoryTurnNumber(
  conversationId: string,
  currentUserPersisted: boolean,
): Promise<number> {
  const value = await invoke<number>("trajectory_resolve_turn_number", {
    conversationId,
    currentUserPersisted,
  });
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : 1;
}
