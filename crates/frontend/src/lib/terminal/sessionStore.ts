import { workspaceProjectPathKey } from "../settings";
import type { TerminalEvent, TerminalSession } from "./types";

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

  if (event.kind !== "output") {
    return sortTerminalSessions([...current, session]);
  }

  return sortTerminalSessions(current);
}
