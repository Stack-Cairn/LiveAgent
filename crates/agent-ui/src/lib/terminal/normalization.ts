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
} from "./types";

export type TerminalCreateParams = {
  cwd: string;
  projectPathKey: string;
  shell?: string;
  title?: string;
  cols?: number;
  rows?: number;
};

export type TerminalSshCreateParams = TerminalCreateParams & {
  hostId: string;
  sftpEnabled?: boolean;
};

export type TerminalSshPromptAnswerParams = {
  promptId: string;
  answer?: string;
  trustHostKey?: boolean;
};

export type RawTerminalSshMetadata = Partial<TerminalSshMetadata> & {
  host_id?: string;
  host_name?: string;
  auth_type?: string;
  reconnect_attempt?: number;
  reconnect_max_attempts?: number;
  sftp_enabled?: boolean;
};

export type RawTerminalSession = Partial<TerminalSession> & {
  project_path_key?: string;
  created_at?: number;
  updated_at?: number;
  finished_at?: number | null;
  exit_code?: number | null;
  kind?: string;
  ssh?: RawTerminalSshMetadata | null;
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
  snapshot?: TerminalSnapshot;
  prompt?: TerminalSshPrompt;
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

export type RawTerminalSshLatency = Partial<TerminalSshLatency> & {
  session_id?: string;
  latency_ms?: number;
  session?: Pick<RawTerminalSession, "id">;
};

export type RawTerminalShellOption = Partial<TerminalShellOption>;

export type RawTerminalShellOptionsResponse = {
  options?: RawTerminalShellOption[];
  shellOptions?: RawTerminalShellOption[];
  shell_options?: RawTerminalShellOption[];
  defaultShell?: string;
  default_shell?: string;
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

export type RawTerminalEvent<RawSshLocalForward = unknown> = {
  kind?: string;
  sessionId?: string;
  session_id?: string;
  projectPathKey?: string;
  project_path_key?: string;
  session?: RawTerminalSession;
  sshTabs?: RawSshTerminalTabsSnapshot | null;
  ssh_tabs?: RawSshTerminalTabsSnapshot | null;
  sshLocalForward?: RawSshLocalForward | null;
  ssh_local_forward?: RawSshLocalForward | null;
  data?: string | null;
  outputStartOffset?: number;
  output_start_offset?: number;
  outputEndOffset?: number;
  output_end_offset?: number;
};

export type NormalizeTerminalBytes = (value: unknown, fallbackText?: string) => Uint8Array;

export function buildTerminalCreatePayload(params: TerminalCreateParams) {
  return {
    cwd: params.cwd,
    project_path_key: params.projectPathKey,
    shell: params.shell,
    title: params.title,
    cols: params.cols,
    rows: params.rows,
  };
}

export function buildTerminalSshCreatePayload(params: TerminalSshCreateParams) {
  return {
    cwd: params.cwd,
    project_path_key: params.projectPathKey,
    ssh_host_id: params.hostId,
    title: params.title,
    cols: params.cols,
    rows: params.rows,
    sftp_enabled: params.sftpEnabled ?? false,
  };
}

export function buildTerminalSshPromptAnswerPayload(params: TerminalSshPromptAnswerParams) {
  return {
    prompt_id: params.promptId,
    prompt_answer: params.answer,
    trust_host_key: params.trustHostKey,
  };
}

export function normalizeTerminalByteContainer(
  value: unknown,
  decodeString: (value: string) => Uint8Array,
): Uint8Array {
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
    return decodeString(value);
  }
  return new Uint8Array();
}

export function normalizeTerminalSession(input: RawTerminalSession): TerminalSession {
  const kind = input.kind === "ssh" ? "ssh" : "local";
  return {
    id: input.id ?? "",
    projectPathKey: input.projectPathKey ?? input.project_path_key ?? "",
    cwd: input.cwd ?? "",
    shell: input.shell ?? "",
    title: input.title ?? "Terminal",
    kind,
    ssh: input.ssh ? normalizeTerminalSshMetadata(input.ssh) : null,
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

export function normalizeUnknownTerminalSession(input: unknown): TerminalSession {
  const record = (input ?? {}) as Record<string, unknown>;
  const rawSsh = (record.ssh ?? null) as Record<string, unknown> | null;
  const session = normalizeTerminalSession({
    id: String(record.id ?? ""),
    projectPathKey: String(record.projectPathKey ?? record.project_path_key ?? ""),
    cwd: String(record.cwd ?? ""),
    shell: String(record.shell ?? ""),
    title: String(record.title ?? "Terminal"),
    kind: record.kind === "ssh" ? "ssh" : "local",
    ssh: rawSsh
      ? {
          hostId: String(rawSsh.hostId ?? rawSsh.host_id ?? ""),
          hostName: String(rawSsh.hostName ?? rawSsh.host_name ?? ""),
          username: String(rawSsh.username ?? ""),
          host: String(rawSsh.host ?? ""),
          port: Number(rawSsh.port ?? 22),
          authType: String(rawSsh.authType ?? rawSsh.auth_type ?? ""),
          status: String(rawSsh.status ?? "connected"),
          reconnectAttempt: Number(rawSsh.reconnectAttempt ?? rawSsh.reconnect_attempt ?? 0),
          reconnectMaxAttempts: Number(
            rawSsh.reconnectMaxAttempts ?? rawSsh.reconnect_max_attempts ?? 3,
          ),
          sftpEnabled: Boolean(rawSsh.sftpEnabled ?? rawSsh.sftp_enabled ?? false),
        }
      : null,
    pid: record.pid === null || record.pid === undefined ? null : Number(record.pid),
    cols: Number(record.cols ?? 80),
    rows: Number(record.rows ?? 24),
    createdAt: Number(record.createdAt ?? record.created_at ?? 0),
    updatedAt: Number(record.updatedAt ?? record.updated_at ?? 0),
    finishedAt:
      record.finishedAt === null || record.finished_at === null
        ? null
        : Number(record.finishedAt ?? record.finished_at ?? 0) || null,
    exitCode:
      record.exitCode === null || record.exit_code === null
        ? null
        : Number(record.exitCode ?? record.exit_code ?? 0) || null,
    running: record.running === true,
  });
  return {
    ...session,
    pid: record.pid === null || record.pid === undefined ? null : Number(record.pid),
  };
}

export function normalizeTerminalSshMetadata(input: RawTerminalSshMetadata): TerminalSshMetadata {
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

export function normalizeTerminalSshPrompt(
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

export function normalizeTerminalSshLatency(input: RawTerminalSshLatency): TerminalSshLatency {
  const latencyMs = Number(input.latencyMs ?? input.latency_ms ?? 0);
  if (!Number.isFinite(latencyMs) || latencyMs <= 0) {
    throw new Error("SSH latency response did not include latency");
  }
  return {
    sessionId: input.sessionId ?? input.session_id ?? input.session?.id ?? "",
    latencyMs: Math.round(latencyMs),
  };
}

export function normalizeTerminalShellOptions(
  input: RawTerminalShellOptionsResponse,
): TerminalShellOptions {
  const options = (input.options ?? input.shellOptions ?? input.shell_options ?? [])
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
  return {
    id: input.id ?? "",
    sessionId: input.sessionId ?? input.session_id ?? "",
    projectPathKey: input.projectPathKey ?? input.project_path_key ?? "",
    kind: input.kind === "sftp" ? "sftp" : "bash",
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

export function normalizeTerminalSnapshot(
  input: RawTerminalSnapshot,
  normalizeBytes: NormalizeTerminalBytes,
): TerminalSnapshot {
  if (!input.session) {
    throw new Error("Terminal response did not include a session");
  }
  return {
    session: normalizeTerminalSession(input.session),
    output: input.output ?? "",
    outputBytes: normalizeBytes(input.outputBytes ?? input.output_bytes, input.output),
    truncated: input.truncated === true,
    outputStartOffset: normalizeOptionalOffset(
      input.outputStartOffset ?? input.output_start_offset,
    ),
    outputEndOffset: normalizeOptionalOffset(input.outputEndOffset ?? input.output_end_offset),
  };
}

export function normalizeTerminalSshCreateResult(
  input: RawTerminalSnapshot,
  normalizeBytes: NormalizeTerminalBytes,
): TerminalSshCreateResult {
  return {
    snapshot:
      input.snapshot ??
      (input.session ? normalizeTerminalSnapshot(input, normalizeBytes) : undefined),
    prompt: input.prompt ?? normalizeTerminalSshPrompt(input.sshPrompt ?? input.ssh_prompt),
  };
}

export function normalizeTerminalEvent<RawSshLocalForward>(
  input: RawTerminalEvent<RawSshLocalForward>,
  normalizeSshLocalForward?: (
    input: RawSshLocalForward,
  ) => NonNullable<TerminalEvent["sshLocalForward"]>,
): TerminalEvent | null {
  const hasSshTabs = Boolean(input.sshTabs || input.ssh_tabs);
  const rawSshLocalForward = input.sshLocalForward ?? input.ssh_local_forward;
  if (!input.session && !hasSshTabs && !rawSshLocalForward) return null;
  const session = input.session ? normalizeTerminalSession(input.session) : undefined;
  const sshTabs = hasSshTabs
    ? normalizeSshTerminalTabsSnapshot(input.sshTabs ?? input.ssh_tabs)
    : undefined;
  const sshLocalForward =
    rawSshLocalForward && normalizeSshLocalForward
      ? normalizeSshLocalForward(rawSshLocalForward)
      : undefined;
  return {
    kind: input.kind ?? "",
    sessionId: input.sessionId ?? input.session_id ?? session?.id,
    projectPathKey:
      input.projectPathKey ??
      input.project_path_key ??
      session?.projectPathKey ??
      sshTabs?.projectPathKey ??
      "",
    session,
    outputStartOffset: normalizeOptionalOffset(
      input.outputStartOffset ?? input.output_start_offset,
    ),
    outputEndOffset: normalizeOptionalOffset(input.outputEndOffset ?? input.output_end_offset),
    sshTabs,
    sshLocalForward,
  };
}

export function normalizeOptionalOffset(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}
