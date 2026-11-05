/**
 * What a host knows about one subagent, for its card in the parent transcript
 * and its row and header in the subagent side pane.
 */
export type SubagentView = {
  id: string;
  description: string;
  status: "running" | "done" | "error" | "cancelled";
  model?: string;
  /** Epoch ms it started, so a running card can count up. */
  startedAtMs?: number;
  /** Final duration once it ended. */
  durationMs?: number;
  /** Input plus output tokens of all its requests. */
  tokens?: number;
  toolCount?: number;
  background?: boolean;
  /** The child tool it started last, while it runs. */
  latestTool?: { name: string; arguments: Record<string, unknown> };
  error?: string;
};

/** The card's binding: the view, and the action that opens its transcript. */
export type SubagentCardBinding = {
  view: SubagentView;
  open: () => void;
};

/** Maps a K-brain status onto the four the UI shows. */
export function subagentViewStatus(status: string | undefined): SubagentView["status"] {
  switch (status) {
    case "done":
    case "completed":
      return "done";
    case "cancelled":
      return "cancelled";
    case "error":
    case "failed":
      return "error";
    default:
      return "running";
  }
}

export function subagentElapsedMs(view: SubagentView, now = Date.now()) {
  if (view.status !== "running") return view.durationMs;
  return view.startedAtMs === undefined ? undefined : Math.max(0, now - view.startedAtMs);
}

/** "8s", "2m 05s", "1h 03m". */
export function formatSubagentDuration(ms: number | undefined) {
  if (ms === undefined || !Number.isFinite(ms)) return "";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** "950", "1.2k", "12k", "1.2M". */
export function formatSubagentTokens(tokens: number | undefined) {
  if (!tokens || tokens <= 0) return "";
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}
