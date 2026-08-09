// Desktop (Tauri) transport for the ManagedProcess store: direct invoke
// calls plus change events emitted by the Rust registry notifier. This file
// is the per-platform adapter — the web frontend ships its own copy speaking
// the gateway process.* protocol.

import type {
  ManagedProcessBackend,
  ManagedProcessRecord,
  ManagedProcessState,
} from "@liveagent/ui/lib/managed-process/types";
import { invoke } from "../tauriBridge";
import { listen } from "../tauriBridge";

const MANAGED_PROCESS_CHANGED_EVENT = "managed-process:changed";

type RawManagedProcessRecord = {
  id: string;
  label?: string | null;
  command: string;
  cwd: string;
  shell: string;
  pid: number;
  log_path: string;
  started_at: number;
  finished_at?: number | null;
  exit_code?: number | null;
  running: boolean;
  isolated?: boolean;
  restored?: boolean;
};

type RawManagedProcessSnapshot = {
  revision: number;
  processes: RawManagedProcessRecord[];
};

type RawManagedProcessLogResponse = {
  id: string;
  log_path: string;
  content: string;
  truncated: boolean;
  bytes: number;
};

function normalizeRecord(raw: RawManagedProcessRecord): ManagedProcessRecord {
  return {
    id: raw.id,
    label: raw.label ?? "",
    command: raw.command,
    cwd: raw.cwd,
    shell: raw.shell,
    pid: raw.pid,
    logPath: raw.log_path,
    startedAt: raw.started_at,
    finishedAt: raw.finished_at ?? null,
    exitCode: raw.exit_code ?? null,
    running: raw.running,
    isolated: raw.isolated === true,
    restored: raw.restored === true,
  };
}

function normalizeSnapshot(raw: RawManagedProcessSnapshot): ManagedProcessState {
  return {
    ready: true,
    // The desktop frontend runs in the same process tree as the registry.
    agentOnline: true,
    revision: raw.revision,
    processes: (raw.processes ?? []).map(normalizeRecord),
  };
}

export const backend: ManagedProcessBackend = {
  async fetchState(): Promise<ManagedProcessState> {
    return normalizeSnapshot(await invoke<RawManagedProcessSnapshot>("managed_process_snapshot"));
  },

  async stop(id: string): Promise<ManagedProcessState | null> {
    // The stop response carries a single record; the refreshed snapshot
    // arrives through the change event the stop triggers.
    await invoke("managed_process_stop", { process_id: id });
    return null;
  },

  async clear(id?: string): Promise<ManagedProcessState | null> {
    return normalizeSnapshot(
      await invoke<RawManagedProcessSnapshot>("managed_process_clear", {
        process_id: id ?? null,
      }),
    );
  },

  async readLog(id: string, maxBytes?: number) {
    const response = await invoke<RawManagedProcessLogResponse>("managed_process_read_log", {
      process_id: id,
      max_bytes: maxBytes ?? null,
    });
    return {
      content: response.content,
      logPath: response.log_path,
      truncated: response.truncated,
    };
  },

  subscribe(onState: (state: ManagedProcessState) => void): () => void {
    const unlisten = listen<RawManagedProcessSnapshot>(MANAGED_PROCESS_CHANGED_EVENT, (event) => {
      onState(normalizeSnapshot(event.payload));
    });
    return () => {
      void unlisten.then((dispose) => dispose());
    };
  },
};
