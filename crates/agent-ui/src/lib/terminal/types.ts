import type { SshLocalForwardEvent } from "./sshLocalForwardTypes";

export type TerminalSession = {
  id: string;
  projectPathKey: string;
  cwd: string;
  shell: string;
  title: string;
  kind: "local" | "ssh";
  ssh?: TerminalSshMetadata | null;
  pid?: number | null;
  cols: number;
  rows: number;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number | null;
  exitCode?: number | null;
  running: boolean;
};

export type TerminalSshMetadata = {
  hostId: string;
  hostName: string;
  username: string;
  host: string;
  port: number;
  authType: string;
  status: "connected" | "reconnecting" | "disconnected" | string;
  reconnectAttempt: number;
  reconnectMaxAttempts: number;
  sftpEnabled: boolean;
};

export type TerminalSshPrompt = {
  id: string;
  kind: "hostKey" | "auth" | string;
  hostId: string;
  hostName: string;
  host: string;
  port: number;
  message: string;
  fingerprintSha256?: string;
  keyType?: string;
  answerEcho?: boolean;
};

export type TerminalSnapshot = {
  session: TerminalSession;
  output: string;
  outputBytes?: Uint8Array;
  truncated: boolean;
  outputStartOffset?: number;
  outputEndOffset?: number;
};

export type TerminalSshCreateResult = {
  snapshot?: TerminalSnapshot;
  prompt?: TerminalSshPrompt;
};

export type TerminalSshLatency = {
  sessionId: string;
  latencyMs: number;
};

export type TerminalShellOption = {
  id: string;
  label: string;
  command: string;
};

export type TerminalShellOptions = {
  options: TerminalShellOption[];
  defaultShell: string;
};

export type SshTerminalTabKind = "bash" | "sftp";

export type SshTerminalTab = {
  id: string;
  sessionId: string;
  projectPathKey: string;
  kind: SshTerminalTabKind;
  createdAt: number;
  updatedAt: number;
};

export type SshTerminalTabsSnapshot = {
  projectPathKey: string;
  tabs: SshTerminalTab[];
  revision: number;
};

export type TerminalEvent = {
  kind: string;
  sessionId?: string;
  projectPathKey: string;
  session?: TerminalSession;
  outputStartOffset?: number;
  outputEndOffset?: number;
  sshTabs?: SshTerminalTabsSnapshot;
  sshLocalForward?: SshLocalForwardEvent;
};

export type TerminalStreamChunk = {
  sessionId: string;
  projectPathKey: string;
  bytes: Uint8Array;
  startOffset: number;
  endOffset: number;
};

export type TerminalStreamSnapshot = {
  session: TerminalSession;
  bytes: Uint8Array;
  truncated: boolean;
  outputStartOffset: number;
  outputEndOffset: number;
};

export type TerminalStreamInputState = {
  paused: boolean;
  queuedBytes: number;
  highWaterBytes: number;
  reason?: "slow" | "offline" | "closed";
};

export type TerminalStreamHandle = {
  snapshot: TerminalStreamSnapshot;
  write(data: Uint8Array): boolean;
  resize(cols: number, rows: number): void;
  dispose(): void;
  subscribeOutput(listener: (chunk: TerminalStreamChunk) => void): () => void;
  subscribeInputState(listener: (state: TerminalStreamInputState) => void): () => void;
};

export type TerminalStreamClient = {
  attach(session: TerminalSession, options?: { maxBytes?: number }): Promise<TerminalStreamHandle>;
};

export type TerminalClient = {
  shellOptions(): Promise<TerminalShellOptions>;
  list(projectPathKey?: string): Promise<TerminalSession[]>;
  create(params: {
    cwd: string;
    projectPathKey: string;
    shell?: string;
    title?: string;
    cols?: number;
    rows?: number;
  }): Promise<TerminalSnapshot>;
  createSsh(params: {
    cwd: string;
    projectPathKey: string;
    hostId: string;
    title?: string;
    cols?: number;
    rows?: number;
    sftpEnabled?: boolean;
  }): Promise<TerminalSshCreateResult>;
  answerSshPrompt(params: {
    promptId: string;
    answer?: string;
    trustHostKey?: boolean;
  }): Promise<TerminalSshCreateResult>;
  cancelSshPrompt(promptId: string): Promise<void>;
  sshReconnect(sessionId: string, projectPathKey?: string): Promise<TerminalSession>;
  sshLatency(sessionId: string, projectPathKey?: string): Promise<TerminalSshLatency>;
  listSshTerminalTabs(projectPathKey: string): Promise<SshTerminalTabsSnapshot>;
  openSshTerminalTab(params: {
    sessionId: string;
    kind: SshTerminalTabKind;
  }): Promise<SshTerminalTabsSnapshot>;
  closeSshTerminalTab(tabId: string): Promise<SshTerminalTabsSnapshot>;
  rename(sessionId: string, title: string, projectPathKey?: string): Promise<TerminalSession>;
  close(sessionId: string, projectPathKey?: string): Promise<TerminalSession>;
  closeProject(projectPathKey: string): Promise<TerminalSession[]>;
  subscribe(listener: (event: TerminalEvent) => void): () => void;
  stream: TerminalStreamClient;
};
