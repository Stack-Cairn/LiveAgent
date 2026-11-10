import { type SubagentView, subagentViewStatus } from "@liveagent/ui/contracts/subagentPane";
import { usageTotal } from "../kbrain/subagentEvents";
import type { SubagentEntry } from "./kbrainSubagentStore";

function parseArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const views = new WeakMap<SubagentEntry, SubagentView>();

/** The card and pane view of a stored subagent; one object per entry snapshot. */
export function kbrainSubagentView(entry: SubagentEntry): SubagentView {
  const cached = views.get(entry);
  if (cached) return cached;
  const { subagent } = entry;
  const status = subagentViewStatus(subagent.status);
  const started = Date.parse(subagent.started_at ?? "");
  const ended = Date.parse(subagent.ended_at ?? "");
  const durationMs =
    typeof subagent.duration_ms === "number" && subagent.duration_ms > 0
      ? subagent.duration_ms
      : Number.isFinite(started) && Number.isFinite(ended)
        ? Math.max(0, ended - started)
        : undefined;
  const tokens = usageTotal(subagent.usage);
  const view: SubagentView = {
    id: subagent.id,
    description: subagent.description?.trim() || subagent.id,
    status,
    ...(subagent.model?.model ? { model: subagent.model.model } : {}),
    ...(Number.isFinite(started) ? { startedAtMs: started } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(tokens > 0 ? { tokens } : {}),
    toolCount: Math.max(subagent.tool_count ?? 0, entry.liveToolCount),
    ...(subagent.background ? { background: true } : {}),
    ...(status === "running" && subagent.external ? { external: true } : {}),
    ...(status === "running" && entry.latestTool
      ? {
          latestTool: {
            name: entry.latestTool.name,
            arguments: parseArguments(entry.latestTool.arguments),
          },
        }
      : {}),
    ...(subagent.error ? { error: subagent.error } : {}),
  };
  views.set(entry, view);
  return view;
}
