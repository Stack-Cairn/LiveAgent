import { workspaceProjectPathKey } from "@liveagent/app/lib/settings";
import type { TerminalEvent, TerminalSession } from "@liveagent/ui/lib/terminal/types";

export function sortTerminalSessions(sessions: readonly TerminalSession[]) {
  return [...sessions].sort((a, b) => {
    const leftProject = workspaceProjectPathKey(a.projectPathKey || a.cwd);
    const rightProject = workspaceProjectPathKey(b.projectPathKey || b.cwd);
    return leftProject.localeCompare(rightProject) || a.createdAt - b.createdAt;
  });
}

export function terminalSessionBelongsToProject(session: TerminalSession, projectPathKey: string) {
  const wantedProjectKey = workspaceProjectPathKey(projectPathKey);
  if (!wantedProjectKey) return false;
  const sessionProjectKey = workspaceProjectPathKey(session.projectPathKey || session.cwd);
  return sessionProjectKey === wantedProjectKey;
}

export function replaceTerminalSessionsForProject(
  current: readonly TerminalSession[],
  projectPathKey: string,
  projectSessions: readonly TerminalSession[],
) {
  const key = workspaceProjectPathKey(projectPathKey);
  if (!key) {
    return sortTerminalSessions(current);
  }
  return sortTerminalSessions([
    ...current.filter((session) => !terminalSessionBelongsToProject(session, key)),
    ...projectSessions.filter((session) => terminalSessionBelongsToProject(session, key)),
  ]);
}

export function applyTerminalEventToSessions(
  current: readonly TerminalSession[],
  event: TerminalEvent,
) {
  if (event.kind === "closed") {
    return sortTerminalSessions(current.filter((session) => session.id !== event.sessionId));
  }

  const session = event.session;
  if (!session?.id) {
    return sortTerminalSessions(current);
  }

  const index = current.findIndex((item) => item.id === session.id);
  if (index >= 0) {
    const next = [...current];
    next[index] = session;
    return sortTerminalSessions(next);
  }

  // 只有 created 才把未知会话加入列表。其他 kind(exit/resized/renamed/
  // reconnecting…)对未知 id 一律忽略:close 与 PTY reader 线程存在竞态,
  // 迟到的 exit 可能在 closed 之后送达,若照单追加会把刚关闭的会话复活成
  // 幽灵(dock 冒出 attach 必败的 tab)。
  if (event.kind === "created") {
    return sortTerminalSessions([...current, session]);
  }

  return sortTerminalSessions(current);
}
