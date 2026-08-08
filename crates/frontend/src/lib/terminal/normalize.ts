import type {
  SshTerminalTab,
  SshTerminalTabsSnapshot,
  TerminalEvent,
  TerminalSession,
  TerminalShellOption,
  TerminalShellOptions,
  TerminalSnapshot,
  TerminalSshCreateResult,
  TerminalSshLatency,
  TerminalSshMetadata,
  TerminalSshPrompt,
  TerminalStreamChunk,
  TerminalStreamSnapshot,
} from "./types";

export type RawTerminalSession = Partial<TerminalSession> & {
  project_path_key?: string;
  created_at?: number;
  updated_at?: number;
  finished_at?: number | null;
  exit_code?: number | null;
  kind?: string;
  ssh?: RawTerminalSshMetadata | null;
};

export type RawTerminalSshMetadata = Partial<TerminalSshMetadata> & {
  host_id?: string;
  host_name?: string;
  auth_type?: string;
  reconnect_attempt?: number;
  reconnect_max_attempts?: number;
  sftp_enabled?: boolean;
};

export type RawTerminalSshPrompt = Partial<TerminalSshPrompt> & {
  host_id?: string;
  host_name?: string;
  fingerprint_sha256?: string;
  key_type?: string;
  answer_echo?: boolean;
};

export type RawTerminalSnapshot = {
  session?: RawTerminalSession;
  output?: string;
  outputBytes?: unknown;
  output_bytes?: unknown;
  truncated?: boolean;
  outputStartOffset?: number;
  output_start_offset?: number;
  outputEndOffset?: number;
  output_end_offset?: number;
  sshPrompt?: RawTerminalSshPrompt | null;
  ssh_prompt?: RawTerminalSshPrompt | null;
};

export type RawTerminalStreamSnapshot = {
  session?: RawTerminalSession;
  bytes?: unknown;
  truncated?: boolean;
  outputStartOffset?: number;
  output_start_offset?: number;
  outputEndOffset?: number;
  output_end_offset?: number;
};

export type RawTerminalStreamEvent = {
  kind?: string;
  sessionId?: string;
  session_id?: string;
  projectPathKey?: string;
  project_path_key?: string;
  startOffset?: number;
  start_offset?: number;
  endOffset?: number;
  end_offset?: number;
  bytes?: unknown;
};

export type RawTerminalSshLatency = Partial<TerminalSshLatency> & {
  session_id?: string;
  latency_ms?: number;
};

export type RawTerminalListResponse = {
  sessions?: RawTerminalSession[];
};

export type RawSshTerminalTab = Partial<SshTerminalTab> & {
  session_id?: string;
  project_path_key?: string;
  created_at?: number;
  updated_at?: number;
};

export type RawSshTerminalTabsSnapshot = Partial<SshTerminalTabsSnapshot> & {
  project_path_key?: string;
  tabs?: RawSshTerminalTab[];
};

export type RawTerminalShellOption = Partial<TerminalShellOption>;

export type RawTerminalShellOptionsResponse = {
  options?: RawTerminalShellOption[];
  defaultShell?: string;
  default_shell?: string;
};

export type RawTerminalEvent = {
  kind?: string;
  sessionId?: string;
  session_id?: string;
  projectPathKey?: string;
  project_path_key?: string;
  session?: RawTerminalSession;
  sshTabs?: RawSshTerminalTabsSnapshot | null;
  ssh_tabs?: RawSshTerminalTabsSnapshot | null;
  data?: string | null;
  outputStartOffset?: number;
  output_start_offset?: number;
  outputEndOffset?: number;
  output_end_offset?: number;
};

export function normalizeSession(input: RawTerminalSession): TerminalSession {
  const projectPathKey = input.projectPathKey ?? input.project_path_key ?? "";
  const kind = input.kind === "ssh" ? "ssh" : "local";
  return {
    id: input.id ?? "",
    projectPathKey,
    cwd: input.cwd ?? "",
    shell: input.shell ?? "",
    title: input.title ?? "Terminal",
    kind,
    ssh: input.ssh ? normalizeSshMetadata(input.ssh) : null,
    pid: kind === "ssh" ? null : (input.pid ?? null),
    cols: Number(input.cols ?? 80),
    rows: Number(input.rows ?? 24),
    createdAt: Number(input.createdAt ?? input.created_at ?? 0),
    updatedAt: Number(input.updatedAt ?? input.updated_at ?? 0),
    finishedAt: input.finishedAt ?? input.finished_at ?? null,
    exitCode: input.exitCode ?? input.exit_code ?? null,
    running: input.running === true,
  };
}

export function normalizeSshMetadata(input: RawTerminalSshMetadata): TerminalSshMetadata {
  return {
    hostId: input.hostId ?? input.host_id ?? "",
    hostName: input.hostName ?? input.host_name ?? "",
    username: input.username ?? "",
    host: input.host ?? "",
    port: Number(input.port ?? 22),
    authType: input.authType ?? input.auth_type ?? "",
    status: input.status ?? "connected",
    reconnectAttempt: Number(input.reconnectAttempt ?? input.reconnect_attempt ?? 0),
    reconnectMaxAttempts: Number(input.reconnectMaxAttempts ?? input.reconnect_max_attempts ?? 3),
    sftpEnabled: input.sftpEnabled ?? input.sftp_enabled ?? false,
  };
}

export function normalizeSshPrompt(
  input: RawTerminalSshPrompt | null | undefined,
): TerminalSshPrompt | undefined {
  if (!input) return undefined;
  const id = input.id?.trim() ?? "";
  if (!id) return undefined;
  return {
    id,
    kind: input.kind ?? "hostKey",
    hostId: input.hostId ?? input.host_id ?? "",
    hostName: input.hostName ?? input.host_name ?? "",
    host: input.host ?? "",
    port: Number(input.port ?? 22),
    message: input.message ?? "",
    fingerprintSha256: input.fingerprintSha256 ?? input.fingerprint_sha256 ?? undefined,
    keyType: input.keyType ?? input.key_type ?? undefined,
    answerEcho: input.answerEcho ?? input.answer_echo ?? false,
  };
}
export function normalizeSnapshot(input: RawTerminalSnapshot): TerminalSnapshot {
  if (!input.session) {
    throw new Error("Terminal response did not include a session");
  }
  const outputStartOffset = normalizeOptionalOffset(
    input.outputStartOffset ?? input.output_start_offset,
  );
  const outputEndOffset = normalizeOptionalOffset(input.outputEndOffset ?? input.output_end_offset);
  return {
    session: normalizeSession(input.session),
    output: input.output ?? "",
    outputBytes: normalizeBytes(input.outputBytes ?? input.output_bytes),
    truncated: input.truncated === true,
    outputStartOffset,
    outputEndOffset,
  };
}

export function normalizeStreamSnapshot(input: RawTerminalStreamSnapshot): TerminalStreamSnapshot {
  if (!input.session) {
    throw new Error("Terminal stream attach did not include a session");
  }
  return {
    session: normalizeSession(input.session),
    bytes: normalizeBytes(input.bytes),
    truncated: input.truncated === true,
    outputStartOffset:
      normalizeOptionalOffset(input.outputStartOffset ?? input.output_start_offset) ?? 0,
    outputEndOffset: normalizeOptionalOffset(input.outputEndOffset ?? input.output_end_offset) ?? 0,
  };
}

export function normalizeSshCreateResult(input: RawTerminalSnapshot): TerminalSshCreateResult {
  const prompt = normalizeSshPrompt(input.sshPrompt ?? input.ssh_prompt);
  return {
    snapshot: input.session ? normalizeSnapshot(input) : undefined,
    prompt,
  };
}

export function normalizeSshLatency(input: RawTerminalSshLatency): TerminalSshLatency {
  const latencyMs = Number(input.latencyMs ?? input.latency_ms ?? 0);
  if (!Number.isFinite(latencyMs) || latencyMs <= 0) {
    throw new Error("SSH latency response did not include latency");
  }
  return {
    sessionId: input.sessionId ?? input.session_id ?? "",
    latencyMs: Math.round(latencyMs),
  };
}

export function normalizeShellOptions(
  input: RawTerminalShellOptionsResponse,
): TerminalShellOptions {
  const options = (input.options ?? [])
    .map((option) => ({
      id: option.id?.trim() ?? "",
      label: option.label?.trim() ?? "",
      command: option.command?.trim() ?? "",
    }))
    .filter((option) => option.id && option.label);
  return {
    options,
    defaultShell: input.defaultShell ?? input.default_shell ?? options[0]?.id ?? "default",
  };
}

export function normalizeSshTerminalTab(input: RawSshTerminalTab): SshTerminalTab {
  const kind = input.kind === "sftp" ? "sftp" : "bash";
  return {
    id: input.id ?? "",
    sessionId: input.sessionId ?? input.session_id ?? "",
    projectPathKey: input.projectPathKey ?? input.project_path_key ?? "",
    kind,
    createdAt: Number(input.createdAt ?? input.created_at ?? 0),
    updatedAt: Number(input.updatedAt ?? input.updated_at ?? 0),
  };
}

export function normalizeSshTerminalTabsSnapshot(
  input: RawSshTerminalTabsSnapshot | null | undefined,
): SshTerminalTabsSnapshot {
  return {
    projectPathKey: input?.projectPathKey ?? input?.project_path_key ?? "",
    tabs: (input?.tabs ?? []).map(normalizeSshTerminalTab).filter((tab) => tab.id && tab.sessionId),
    revision: Number(input?.revision ?? 0),
  };
}

export function normalizeEvent(input: RawTerminalEvent): TerminalEvent | null {
  const sshTabs = normalizeSshTerminalTabsSnapshot(input.sshTabs ?? input.ssh_tabs);
  if (!input.session && !input.sshTabs && !input.ssh_tabs) return null;
  const session = input.session ? normalizeSession(input.session) : undefined;
  const outputStartOffset = normalizeOptionalOffset(
    input.outputStartOffset ?? input.output_start_offset,
  );
  const outputEndOffset = normalizeOptionalOffset(input.outputEndOffset ?? input.output_end_offset);
  return {
    kind: input.kind ?? "",
    sessionId: input.sessionId ?? input.session_id ?? session?.id,
    projectPathKey:
      input.projectPathKey ??
      input.project_path_key ??
      session?.projectPathKey ??
      sshTabs.projectPathKey,
    session,
    outputStartOffset,
    outputEndOffset,
    sshTabs: input.sshTabs || input.ssh_tabs ? sshTabs : undefined,
  };
}

export function normalizeStreamEvent(input: RawTerminalStreamEvent): TerminalStreamChunk | null {
  const sessionId = (input.sessionId ?? input.session_id ?? "").trim();
  if (!sessionId) return null;
  const bytes = normalizeBytes(input.bytes);
  if (bytes.byteLength === 0) return null;
  return {
    sessionId,
    projectPathKey: input.projectPathKey ?? input.project_path_key ?? "",
    bytes,
    startOffset: normalizeOptionalOffset(input.startOffset ?? input.start_offset) ?? 0,
    endOffset: normalizeOptionalOffset(input.endOffset ?? input.end_offset) ?? 0,
  };
}

export function normalizeBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) {
    return Uint8Array.from(value.map((item) => Number(item) & 0xff));
  }
  if (typeof value === "string" && value.length > 0) {
    return new TextEncoder().encode(value);
  }
  return new Uint8Array();
}

export function normalizeOptionalOffset(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}
