// Shared types for the ManagedProcess background-tasks panel. Records are
// camelCase mirrors of the desktop registry's snapshot; each platform
// backend (./backend.ts, per-end) normalizes its transport payload to these.

export type ManagedProcessRecord = {
  id: string;
  label: string;
  command: string;
  cwd: string;
  shell: string;
  pid: number;
  logPath: string;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  running: boolean;
  isolated: boolean;
  restored: boolean;
};

export type ManagedProcessState = {
  ready: boolean;
  agentOnline: boolean;
  revision: number;
  processes: ManagedProcessRecord[];
};

export type ManagedProcessLog = {
  content: string;
  logPath: string;
  truncated: boolean;
};

export type ManagedProcessBackend = {
  fetchState(): Promise<ManagedProcessState>;
  /** Returns the refreshed state when the transport carries one, else null. */
  stop(id: string): Promise<ManagedProcessState | null>;
  /** Clears one finished record, or every finished record when id is omitted. */
  clear(id?: string): Promise<ManagedProcessState | null>;
  readLog(id: string, maxBytes?: number): Promise<ManagedProcessLog>;
  subscribe(onState: (state: ManagedProcessState) => void): () => void;
};
