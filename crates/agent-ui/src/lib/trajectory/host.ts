/**
 * 基于 `invoke` 的轨迹宿主实现，两端共用。
 *
 * 桌面端的 `invoke` 是真实 Tauri 调用，WebUI 的 `invoke` 由 shim 路由到 Gateway
 * 请求。轨迹只读，两端语义完全一致，所以实现只需要一份——差异全在注入的 invoke。
 */

import type { TrajectoryEventsWindowPayload, TrajectoryHost } from "../../contracts/trajectory";
import type { ChatFileLink } from "../chat/chatFileLinks";
import { buildTrajectorySubagentRun, concatSubagentSegmentMessages } from "./subagentRuns";
import type { TrajectorySection, TrajectorySectionSlot, TrajectorySubagentRun } from "./types";

/** 宿主注入的命令通道；与 Tauri `invoke` 同形。 */
export type TrajectoryInvoke = <T = unknown>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

const TRAJECTORY_WINDOW_SEGMENTS = 8;
const SUBAGENT_RUN_BATCH_SIZE = 128;

function finiteInteger(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

type RawSection = { sectionId?: unknown; slot?: unknown; content?: unknown };
type RawRun = {
  id?: unknown;
  agentId?: unknown;
  mode?: unknown;
  status?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
};
type RawRunState = { run?: RawRun; segments?: unknown };

function normalizeSections(value: unknown): TrajectorySection[] {
  if (!Array.isArray(value)) return [];
  const out: TrajectorySection[] = [];
  for (const entry of value as RawSection[]) {
    if (typeof entry?.sectionId !== "string" || typeof entry.content !== "string") continue;
    out.push({
      sectionId: entry.sectionId,
      slot: (typeof entry.slot === "string" ? entry.slot : "base") as TrajectorySectionSlot,
      content: entry.content,
    });
  }
  return out;
}

/**
 * 构造轨迹宿主。
 *
 * @param invoke - 命令通道。
 * @param options - 可选能力：打开工作区文件。
 * @returns 只读的轨迹宿主。
 */
export function createInvokeTrajectoryHost(
  invoke: TrajectoryInvoke,
  options?: {
    openFileLink?: (link: ChatFileLink) => void;
    subscribeRefresh?: (listener: () => void) => () => void;
  },
): TrajectoryHost {
  return {
    loadWindow: async (
      conversationId,
      beforeSegmentIndex,
    ): Promise<TrajectoryEventsWindowPayload> => {
      const response = await invoke<{
        eventsJson?: unknown;
        events_json?: unknown;
        truncated?: unknown;
        oldestSegmentIndex?: unknown;
        oldest_segment_index?: unknown;
        returnedSegmentCount?: unknown;
        returned_segment_count?: unknown;
        totalSegmentCount?: unknown;
        total_segment_count?: unknown;
        hasMoreBefore?: unknown;
        has_more_before?: unknown;
      }>("trajectory_get_window", {
        conversationId,
        maxSegments: TRAJECTORY_WINDOW_SEGMENTS,
        ...(beforeSegmentIndex === undefined ? {} : { beforeSegmentIndex }),
      });
      return {
        eventsJson:
          typeof response?.eventsJson === "string"
            ? response.eventsJson
            : typeof response?.events_json === "string"
              ? response.events_json
              : "[]",
        truncated: response?.truncated === true,
        oldestSegmentIndex: finiteInteger(
          response?.oldestSegmentIndex ?? response?.oldest_segment_index,
        ),
        returnedSegmentCount: finiteInteger(
          response?.returnedSegmentCount ?? response?.returned_segment_count,
        ),
        totalSegmentCount: finiteInteger(
          response?.totalSegmentCount ?? response?.total_segment_count,
        ),
        hasMoreBefore: response?.hasMoreBefore === true || response?.has_more_before === true,
      };
    },

    loadSections: async (conversationId, sectionIds) => {
      if (sectionIds.length === 0) return [];
      const response = await invoke("trajectory_get_sections", {
        conversationId,
        sectionIds: [...sectionIds],
      });
      return normalizeSections(response);
    },

    loadSubagentRuns: async (conversationId, runIds): Promise<readonly TrajectorySubagentRun[]> => {
      const uniqueIds = [...new Set(runIds.map((id) => id.trim()).filter((id) => id !== ""))];
      if (uniqueIds.length === 0) return [];
      const byId = new Map<string, TrajectorySubagentRun>();
      try {
        for (let offset = 0; offset < uniqueIds.length; offset += SUBAGENT_RUN_BATCH_SIZE) {
          const batch = uniqueIds.slice(offset, offset + SUBAGENT_RUN_BATCH_SIZE);
          const response = await invoke<{
            runsJson?: unknown;
            subagent_runs_json?: unknown;
          }>("trajectory_get_subagent_runs", { conversationId, runIds: batch });
          const raw =
            typeof response?.runsJson === "string"
              ? response.runsJson
              : typeof response?.subagent_runs_json === "string"
                ? response.subagent_runs_json
                : "[]";
          const states = JSON.parse(raw) as unknown;
          if (!Array.isArray(states)) continue;
          for (const state of states as RawRunState[]) {
            const run = state?.run;
            if (run === undefined || typeof run.id !== "string" || run.id === "") continue;
            const runId = run.id;
            byId.set(
              runId,
              buildTrajectorySubagentRun({
                runId,
                agentId: typeof run.agentId === "string" ? run.agentId : runId,
                ...(typeof run.mode === "string" ? { mode: run.mode } : {}),
                status: run.status,
                startedAt: run.startedAt,
                endedAt: run.endedAt,
                messages: concatSubagentSegmentMessages(state.segments),
              }),
            );
          }
        }
      } catch (error) {
        console.warn("[trajectory] subagent runs unavailable on this host", error);
        // Let the view release its requested-id guard so a transient transport failure can retry.
        throw error;
      }
      return uniqueIds.flatMap((runId) => {
        const run = byId.get(runId);
        return run === undefined ? [] : [run];
      });
    },

    ...(options?.subscribeRefresh === undefined
      ? {}
      : { subscribeRefresh: options.subscribeRefresh }),
    ...(options?.openFileLink === undefined ? {} : { openFileLink: options.openFileLink }),
  };
}
