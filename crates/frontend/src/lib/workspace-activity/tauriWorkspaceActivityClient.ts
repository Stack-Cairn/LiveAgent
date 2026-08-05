// Desktop adapter for WorkspaceActivityClient (GUI-only, not mirrored).
//
// Bridges the Tauri `workspace:activity` event stream to per-workdir
// listeners and aggregates the set of subscribed workdirs into the
// declarative `workspace_watch_set` command (the Rust side replaces the
// local desired-watch set wholesale on every call). Module-level singleton
// with reference-counted listener lifecycle, mirroring the tauriTunnelClient
// pattern in ChatPage.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { WorkspaceActivity, WorkspaceActivityClient } from "./types";

type WorkspaceActivityListener = Parameters<WorkspaceActivityClient["subscribe"]>[1];

const listenersByWorkdir = new Map<string, Set<WorkspaceActivityListener>>();
let unlistenPromise: Promise<() => void> | null = null;

function normalizeActivity(payload: unknown): WorkspaceActivity | null {
  const raw = (payload ?? {}) as Partial<WorkspaceActivity>;
  if (typeof raw.workdir !== "string" || !raw.workdir) return null;
  return {
    workdir: raw.workdir,
    revision: typeof raw.revision === "number" ? raw.revision : 0,
    fs: raw.fs === true,
    git: raw.git === true,
    changedPaths: Array.isArray(raw.changedPaths)
      ? raw.changedPaths.filter((path): path is string => typeof path === "string")
      : [],
    truncated: raw.truncated === true,
  };
}

// Replaces the backend's local watch set with the current subscription keys.
// Best-effort: a failed sync is healed by the next subscribe/unsubscribe.
function syncWatchSet() {
  void invoke("workspace_watch_set", { workdirs: [...listenersByWorkdir.keys()] }).catch(() => {});
}

function ensureEventListener() {
  if (unlistenPromise) return;
  unlistenPromise = listen<unknown>("workspace:activity", (event) => {
    const activity = normalizeActivity(event.payload);
    if (!activity) return;
    const subscribers = listenersByWorkdir.get(activity.workdir);
    if (!subscribers) return;
    for (const subscriber of [...subscribers]) {
      subscriber(activity);
    }
  });
}

export const tauriWorkspaceActivityClient: WorkspaceActivityClient = {
  subscribe(workdir, listener) {
    const normalized = workdir.trim();
    if (!normalized) {
      return () => {};
    }
    let subscribers = listenersByWorkdir.get(normalized);
    if (!subscribers) {
      subscribers = new Set();
      listenersByWorkdir.set(normalized, subscribers);
      syncWatchSet();
    }
    subscribers.add(listener);
    ensureEventListener();
    return () => {
      const current = listenersByWorkdir.get(normalized);
      if (!current?.delete(listener)) return;
      if (current.size > 0) return;
      listenersByWorkdir.delete(normalized);
      syncWatchSet();
      if (listenersByWorkdir.size === 0 && unlistenPromise) {
        const pending = unlistenPromise;
        unlistenPromise = null;
        void pending.then((unlisten) => unlisten()).catch(() => {});
      }
    };
  },
};
