import type {
  TrajectoryEventsWindowPayload,
  TrajectoryHost,
} from "@liveagent/ui/contracts/trajectory";
import type { ChatFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import type { TrajectorySection, TrajectorySubagentRun } from "@liveagent/ui/lib/trajectory/types";
import { getKBrainSessionId } from "./mapping";
import { resolveKBrainClientOptions } from "./runtimeConnection";
import { fetchKBrain } from "./transport";
import type { KBrainClientOptions, KBrainEvent, KBrainUsage } from "./types";

export type KBrainTrajectoryWindow = TrajectoryEventsWindowPayload & {
  version: string;
  conversationId: string;
  rawEvents: KBrainEvent[];
  lastSeq: number;
  redacted: boolean;
};

function isBackendSessionId(value: string): boolean {
  return /^[0-9a-f]{8}$/i.test(value);
}

export type KBrainTrajectoryStats = {
  version: string;
  conversationId: string;
  eventCount: number;
  runCount: number;
  toolCallCount: number;
  errorCount: number;
  usage: KBrainUsage;
  runs: { runId: string; usage: KBrainUsage }[];
  firstEventAt: string | null;
  lastEventAt: string | null;
  lastSeq: number;
  truncated: boolean;
};

export function createKBrainTrajectoryHost(
  input: KBrainClientOptions & {
    openFileLink?: (link: ChatFileLink) => void;
    redactToolContent?: boolean;
  } = {},
): TrajectoryHost & {
  loadWindow: (
    conversationId: string,
    beforeSegmentIndex?: number,
  ) => Promise<KBrainTrajectoryWindow>;
  loadStats: (conversationId: string) => Promise<KBrainTrajectoryStats>;
} {
  async function request<T>(conversationId: string, suffix: string): Promise<T | undefined> {
    const options = resolveKBrainClientOptions(input);
    const baseUrl = options.baseUrl?.trim().replace(/\/+$/, "");
    if (!baseUrl) throw new Error("K-brain backend connection is not ready");
    const candidate = conversationId.trim();
    if (!candidate) throw new Error("K-brain trajectory requires a conversation ID");
    const mappedId = getKBrainSessionId(candidate, baseUrl);
    const id = mappedId ?? (isBackendSessionId(candidate) ? candidate : undefined);
    // Unsent local conversations have no backend journal yet; recheck on every refresh.
    if (!id) return undefined;
    const response = await fetchKBrain(
      `/v1/sessions/${encodeURIComponent(id)}/trajectory${suffix}`,
      {},
      input,
    );
    if (!response.ok) {
      const body = await response.text();
      let message = body;
      try {
        message = (JSON.parse(body) as { error?: string }).error ?? body;
      } catch {
        // Preserve non-JSON backend errors.
      }
      throw Object.assign(new Error(message || `Trajectory request failed (${response.status})`), {
        status: response.status,
      });
    }
    return (await response.json()) as T;
  }

  return {
    async loadWindow(conversationId, beforeSegmentIndex) {
      const query = new URLSearchParams({ max_segments: "8" });
      if (beforeSegmentIndex !== undefined) {
        if (!Number.isSafeInteger(beforeSegmentIndex) || beforeSegmentIndex < 0) {
          throw new Error("Invalid trajectory pagination cursor");
        }
        query.set("before_segment_index", String(beforeSegmentIndex));
      }
      if (input.redactToolContent) query.set("redact_tool_content", "true");
      const result = await request<KBrainTrajectoryWindow>(conversationId, `?${query}`);
      if (result === undefined) {
        return {
          version: "kbrain.agent.v1",
          conversationId: conversationId.trim(),
          eventsJson: "[]",
          rawEvents: [],
          oldestSegmentIndex: 0,
          returnedSegmentCount: 0,
          totalSegmentCount: 0,
          hasMoreBefore: false,
          truncated: false,
          lastSeq: 0,
          redacted: input.redactToolContent ?? false,
        };
      }
      if (
        result.version !== "kbrain.agent.v1" ||
        typeof result.eventsJson !== "string" ||
        !Array.isArray(result.rawEvents) ||
        !Number.isSafeInteger(result.oldestSegmentIndex) ||
        !Number.isSafeInteger(result.returnedSegmentCount) ||
        !Number.isSafeInteger(result.totalSegmentCount) ||
        typeof result.hasMoreBefore !== "boolean" ||
        typeof result.truncated !== "boolean"
      ) {
        throw new Error("Malformed K-brain trajectory window");
      }
      if (!Array.isArray(JSON.parse(result.eventsJson))) {
        throw new Error("Malformed K-brain trajectory events");
      }
      return result;
    },
    async loadStats(conversationId) {
      return (
        (await request<KBrainTrajectoryStats>(conversationId, "/stats")) ?? {
          version: "kbrain.agent.v1",
          conversationId: conversationId.trim(),
          eventCount: 0,
          runCount: 0,
          toolCallCount: 0,
          errorCount: 0,
          usage: {},
          runs: [],
          firstEventAt: null,
          lastEventAt: null,
          lastSeq: 0,
          truncated: false,
        }
      );
    },
    async loadSections(conversationId, sectionIds) {
      if (sectionIds.length === 0) return [];
      const query = new URLSearchParams();
      for (const id of new Set(sectionIds)) query.append("section_id", id);
      return (await request<TrajectorySection[]>(conversationId, `/sections?${query}`)) ?? [];
    },
    async loadSubagentRuns(conversationId, runIds) {
      const ids = [...new Set(runIds)];
      const result: TrajectorySubagentRun[] = [];
      for (let offset = 0; offset < ids.length; offset += 128) {
        const query = new URLSearchParams();
        for (const id of ids.slice(offset, offset + 128)) query.append("run_id", id);
        const runs = await request<TrajectorySubagentRun[]>(conversationId, `/subagents?${query}`);
        if (runs) result.push(...runs);
      }
      return result;
    },
    subscribeRefresh(listener) {
      const timer = globalThis.setInterval(listener, 2000);
      return () => globalThis.clearInterval(timer);
    },
    ...(input.openFileLink ? { openFileLink: input.openFileLink } : {}),
  };
}
