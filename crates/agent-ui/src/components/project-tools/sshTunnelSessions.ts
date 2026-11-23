import { workspaceProjectPathKey } from "@liveagent/app/lib/settings";
import type { TerminalSession } from "@liveagent/ui/lib/terminal/types";

// How the SSH tunnel panel reads a terminal session: its project, labels and
// connection state.

export function sessionBelongsToProject(session: TerminalSession, projectPathKey: string) {
  const wantedProjectKey = workspaceProjectPathKey(projectPathKey);
  if (!wantedProjectKey) return false;
  const sessionProjectKey = workspaceProjectPathKey(session.projectPathKey || session.cwd);
  return sessionProjectKey === wantedProjectKey;
}

export function sessionTitle(session: TerminalSession, fallback: string) {
  return session.title || session.ssh?.hostName || fallback;
}

export function sessionEndpointLabel(session: TerminalSession) {
  const ssh = session.ssh;
  if (!ssh) return session.cwd || session.projectPathKey;
  const userPrefix = ssh.username.trim() ? `${ssh.username.trim()}@` : "";
  return `${userPrefix}${ssh.host}:${ssh.port}`;
}

export function sessionProjectLabel(session: TerminalSession) {
  return session.projectPathKey || session.cwd || "";
}

export function sshSessionStatus(session: TerminalSession) {
  const status = session.ssh?.status ?? (session.running ? "connected" : "disconnected");
  if (status === "connected" && !session.running) return "disconnected";
  return status;
}

export function sshSessionConnected(session: TerminalSession) {
  return sshSessionStatus(session) === "connected" && session.running;
}
