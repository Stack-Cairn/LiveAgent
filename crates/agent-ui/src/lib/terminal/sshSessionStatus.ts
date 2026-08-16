import type { TerminalSession } from "./types";

export type SshSessionStatus = "connected" | "reconnecting" | "disconnected";

/**
 * SSH 会话连接状态的统一推导:后端 `ssh.status` 为准,但会话进程已停止时
 * 一律视为 disconnected(状态事件可能晚于进程退出)。未知状态按 disconnected
 * 保守处理。WorkspaceSshTerminalOverlay 与 SshTerminalPaneSurface 共用。
 */
export function sshSessionStatus(session: TerminalSession): SshSessionStatus {
  const status = session.ssh?.status ?? (session.running ? "connected" : "disconnected");
  if (status === "connected" && !session.running) return "disconnected";
  if (status === "connected" || status === "reconnecting") return status;
  return "disconnected";
}

/** SSH 会话的目标端点标签(user@host:port);非 SSH 会话退回 cwd。 */
export function sshSessionEndpointLabel(session: TerminalSession): string {
  const ssh = session.ssh;
  if (!ssh) return session.cwd || session.projectPathKey;
  const userPrefix = ssh.username.trim() ? `${ssh.username.trim()}@` : "";
  return `${userPrefix}${ssh.host}:${ssh.port}`;
}
