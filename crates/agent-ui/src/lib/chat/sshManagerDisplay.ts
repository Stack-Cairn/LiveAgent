/**
 * How K-brain's SSHManager calls read in the transcript: a short title naming the
 * action and the host ("exec on web: uname -a", "upload app.tar to web"), and a
 * readable result (exec output split into stdout/stderr blocks, SFTP transfers as a
 * status line). Result formats follow K-brain internal/sshmgr/tool.go and sftp.go.
 */

import {
  collapseWhitespace,
  conciseCommand,
  truncateColumns,
  truncatePathStart,
} from "@liveagent/ui/lib/chat/conciseText";

export const SSH_MANAGER_TOOL_NAMES: ReadonlySet<string> = new Set(["SSHManager", "SshManager"]);

export function isSshManagerToolName(name: string) {
  return SSH_MANAGER_TOOL_NAMES.has(name);
}

/**
 * Host ids are opaque (UUIDs), so titles look the configured name up here. The host
 * app refreshes it from its SSH settings while it renders; an unknown id shows as is.
 */
const hostNames = new Map<string, string>();

export function rememberSshHostNames(hosts: ReadonlyArray<{ id: string; name?: string }>) {
  hostNames.clear();
  for (const host of hosts) {
    const name = typeof host.name === "string" ? host.name.trim() : "";
    if (host.id && name) hostNames.set(host.id, name);
  }
}

export function sshHostLabel(hostId: string) {
  return hostNames.get(hostId) ?? hostId;
}

function str(args: Record<string, unknown>, key: string) {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

function baseName(path: string) {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) || trimmed : trimmed;
}

export type SshManagerTitle = { text: string; full: string };

/** The title after the "SSH" verb, or null when the call has no recognizable action. */
export function summarizeSshManagerCall(args: Record<string, unknown>): SshManagerTitle | null {
  const action = str(args, "action");
  if (!action) return null;
  const hostId = str(args, "host_id");
  const host = hostId ? sshHostLabel(hostId) : "";
  const on = host ? ` on ${host}` : "";
  const path = str(args, "path");
  const short = (text: string, full = text) => ({
    text: truncateColumns(collapseWhitespace(text)),
    full: collapseWhitespace(full),
  });
  const onPath = (verb: string) =>
    path
      ? short(`${verb} ${truncatePathStart(path)}${on}`, `${verb} ${path}${on}`)
      : short(`${verb}${on}`);

  switch (action) {
    case "exec": {
      const command = str(args, "command");
      const prefix = host ? `exec on ${host}` : "exec";
      if (!command) return short(prefix);
      return {
        text: `${truncateColumns(prefix, 24)}: ${conciseCommand(command)}`,
        full: `${prefix}: ${command}`,
      };
    }
    case "list_hosts":
      return short("list hosts");
    case "list_sessions":
      return short(`list sessions${on}`);
    case "create_session":
      return short(host ? `connect to ${host}` : "connect");
    case "read_session":
      return short(`read session${on}`);
    case "send_input":
      return short(host ? `send input to ${host}` : "send input");
    case "resize_session":
      return short(`resize session${on}`);
    case "close_session":
      return short(`close session${on}`);
    case "sftp_list":
      return onPath("list");
    case "sftp_stat":
      return onPath("stat");
    case "sftp_read_text":
      return onPath("read");
    case "sftp_write_text":
      return onPath("write");
    case "sftp_mkdir":
      return onPath("mkdir");
    case "sftp_delete":
      return onPath("delete");
    case "sftp_rename": {
      const from = str(args, "from_path");
      const to = str(args, "to_path");
      return short(
        `rename ${baseName(from) || from} to ${baseName(to) || to}${on}`,
        `rename ${from} to ${to}${on}`,
      );
    }
    case "sftp_upload": {
      const local = str(args, "local_path");
      const remote = str(args, "remote_path");
      const target = host || "remote";
      return short(
        `upload ${baseName(local) || "file"} to ${target}`,
        `upload ${local} to ${target}:${remote}`,
      );
    }
    case "sftp_download": {
      const local = str(args, "local_path");
      const remote = str(args, "remote_path");
      const source = host || "remote";
      return short(
        `download ${baseName(remote) || "file"} from ${source}`,
        `download ${source}:${remote} to ${local}`,
      );
    }
    case "sftp_transfer_status":
      return short("check transfer");
    case "sftp_cancel_transfer":
      return short("cancel transfer");
    default:
      return short(`${action}${on}`);
  }
}

export type SshExecResult = {
  exitCode: string;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  sessionId?: string;
};

const EXEC_STREAM_EMPTY = "(empty)";

/**
 * Parses SSHManager exec output:
 *
 *   session_id: …            (and the other session_* lines)
 *   exit_code: 0
 *   timed_out: false
 *
 *   stdout:
 *   <text>
 *
 *   stderr:
 *   <text>
 *
 * The stderr marker is taken as the last "\n\nstderr:\n" so stdout may contain it.
 */
export function parseSshExecResult(text: string): SshExecResult | null {
  const exitMatch = /^exit_code: (.+)$/m.exec(text);
  const timedOutMatch = /^timed_out: (true|false)$/m.exec(text);
  const stdoutStart = text.indexOf("\n\nstdout:\n");
  const stderrStart = text.lastIndexOf("\n\nstderr:\n");
  if (!exitMatch || !timedOutMatch || stdoutStart < 0 || stderrStart < stdoutStart) return null;
  const clean = (value: string) => (value === EXEC_STREAM_EMPTY ? "" : value);
  const sessionId = /^session_id: (.+)$/m.exec(text)?.[1]?.trim();
  return {
    exitCode: exitMatch[1].trim(),
    timedOut: timedOutMatch[1] === "true",
    stdout: clean(text.slice(stdoutStart + "\n\nstdout:\n".length, stderrStart)),
    stderr: clean(text.slice(stderrStart + "\n\nstderr:\n".length).replace(/\n$/, "")),
    ...(sessionId ? { sessionId } : {}),
  };
}

export type SshTransferState = {
  id: string;
  direction: string;
  status: string;
  sourcePath: string;
  targetPath: string;
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
  error?: string;
};

function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Parses an SFTP upload/download/status result: `{"transfer": {...}}`. */
export function parseSshTransferResult(text: string): SshTransferState | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const transfer =
    parsed && typeof parsed === "object" ? (parsed as { transfer?: unknown }).transfer : null;
  if (!transfer || typeof transfer !== "object" || Array.isArray(transfer)) return null;
  const record = transfer as Record<string, unknown>;
  const text_ = (key: string) => (typeof record[key] === "string" ? (record[key] as string) : "");
  if (!text_("id") || !text_("status")) return null;
  const error = text_("error");
  return {
    id: text_("id"),
    direction: text_("direction"),
    status: text_("status"),
    sourcePath: text_("sourcePath"),
    targetPath: text_("targetPath"),
    bytesDone: num(record.bytesDone),
    bytesTotal: num(record.bytesTotal),
    filesDone: num(record.filesDone),
    filesTotal: num(record.filesTotal),
    ...(error ? { error } : {}),
  };
}

export function formatTransferBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** Whether an SSHManager result has a structured view (exec output or an SFTP transfer). */
export function hasSshManagerResultView(toolName: string, text: string, isError?: boolean) {
  if (isError || !isSshManagerToolName(toolName)) return false;
  return parseSshExecResult(text) !== null || parseSshTransferResult(text) !== null;
}
