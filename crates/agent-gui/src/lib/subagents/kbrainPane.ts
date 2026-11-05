import { isTerminalSubagentStatus } from "../kbrain/subagentEvents";
import type { KBrainSubagent } from "../kbrain/types";

/**
 * The subagent side pane of one conversation: open subagent tabs and the one in
 * front. `active: null` shows the directory of every subagent instead.
 */
export type SubagentPaneState = {
  open: boolean;
  tabs: readonly string[];
  active: string | null;
};

/** More tabs than this drop the oldest one that is not in front. */
export const MAX_SUBAGENT_TABS = 8;
/** Ended subagents the directory lists per page. */
export const SUBAGENT_DIRECTORY_PAGE_SIZE = 20;

export const CLOSED_SUBAGENT_PANE: SubagentPaneState = { open: false, tabs: [], active: null };

export function openSubagentTab(state: SubagentPaneState, id: string): SubagentPaneState {
  let tabs = state.tabs.includes(id) ? [...state.tabs] : [...state.tabs, id];
  while (tabs.length > MAX_SUBAGENT_TABS) {
    const drop = tabs.findIndex((tab) => tab !== id);
    tabs = tabs.filter((_, index) => index !== drop);
  }
  return { open: true, tabs, active: id };
}

export function closeSubagentTab(state: SubagentPaneState, id: string): SubagentPaneState {
  const index = state.tabs.indexOf(id);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab !== id);
  if (tabs.length === 0)
    return { ...state, tabs, active: null, open: state.open && state.active === null };
  if (state.active !== id) return { ...state, tabs };
  return { ...state, tabs, active: tabs[Math.min(index, tabs.length - 1)] ?? null };
}

export function showSubagentDirectory(state: SubagentPaneState): SubagentPaneState {
  return { ...state, open: true, active: null };
}

export function closeSubagentPane(state: SubagentPaneState): SubagentPaneState {
  return state.open ? { ...state, open: false } : state;
}

/** Drops tabs whose subagent the conversation no longer has. */
export function pruneSubagentTabs(
  state: SubagentPaneState,
  known: ReadonlySet<string>,
): SubagentPaneState {
  const tabs = state.tabs.filter((tab) => known.has(tab));
  if (tabs.length === state.tabs.length) return state;
  const active = state.active && known.has(state.active) ? state.active : null;
  return { ...state, tabs, active };
}

function time(value: string | undefined) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The directory: running subagents first (newest started first), then ended ones
 * (latest ended first), the ended list cut to `pages` pages.
 */
export function subagentDirectory(subagents: readonly KBrainSubagent[], pages = 1) {
  const running = subagents
    .filter((subagent) => !isTerminalSubagentStatus(subagent.status))
    .sort((a, b) => time(b.started_at) - time(a.started_at));
  const ended = subagents
    .filter((subagent) => isTerminalSubagentStatus(subagent.status))
    .sort(
      (a, b) =>
        time(b.ended_at ?? b.updated_at ?? b.started_at) -
        time(a.ended_at ?? a.updated_at ?? a.started_at),
    );
  const visible = Math.max(1, pages) * SUBAGENT_DIRECTORY_PAGE_SIZE;
  return {
    running,
    ended: ended.slice(0, visible),
    endedTotal: ended.length,
    hasMoreEnded: ended.length > visible,
  };
}
