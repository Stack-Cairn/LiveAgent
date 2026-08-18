// Data hooks for the memory settings panel: list/read/mutate/wipe for the
// panel itself and organize-run list/read for the history modal. Organize-run
// status polling runs ONLY while some run is pending/running — idle panels
// never poll.
//
// Shared implementation owned by @liveagent/ui. Platform-specific capabilities
// remain in their host adapter modules.

import { useEffect, useState } from "react";
import {
  formatMemoryError,
  type MemoryMeta,
  type MemoryOrganizeRun,
  type MemoryOrganizeRunStatus,
  type MemoryPathsInfo,
  type MemoryReadResponse,
  memoryAccept,
  memoryDelete,
  memoryList,
  memoryOrganizeRunList,
  memoryOrganizeRunRead,
  memoryPathsInfo,
  memoryRead,
  memoryUpdate,
  memoryWipeAll,
  memoryWrite,
} from "../../../lib/memory/api";
import { PANEL_RUN_POLL_INTERVAL_MS } from "../../../lib/memory/config";
import type { MemoryType } from "../../../lib/memory/schema";
import {
  entryKey,
  isOrganizerRunActive,
  type MemoryQuota,
  selectedEntryWorkdir,
} from "./panelModel";

export type MemoryCreateDraft = {
  slug: string;
  scope: "global" | "project";
  memoryType: MemoryType;
  description: string;
  body: string;
};

export type MemoryEditDraft = {
  description: string;
  body: string;
  appendBody: string;
};

export function useMemoryPanelData(input: { workdir?: string; t: (key: string) => string }) {
  const { workdir, t } = input;
  const [entries, setEntries] = useState<MemoryMeta[]>([]);
  const [quota, setQuota] = useState<MemoryQuota | null>(null);
  const [selected, setSelected] = useState<MemoryReadResponse | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<MemoryMeta | null>(null);
  const [pathsInfo, setPathsInfo] = useState<MemoryPathsInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [organizerWatchRunId, setOrganizerWatchRunId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<MemoryEditDraft>({
    description: "",
    body: "",
    appendBody: "",
  });

  async function reload(keepEntry?: string | null) {
    setLoading(true);
    setError(null);
    try {
      const [list, info] = await Promise.all([
        memoryList({ workdir, includeAllProjects: true, includeDaily: true, limit: 1000 }),
        memoryPathsInfo(),
      ]);
      setEntries(list.entries);
      setQuota(list.quota);
      setPathsInfo(info);
      const keepKey =
        keepEntry === undefined ? (selectedEntry ? entryKey(selectedEntry) : null) : keepEntry;
      if (keepKey) {
        const found =
          list.entries.find((entry) => entryKey(entry) === keepKey) ??
          list.entries.find((entry) => entry.slug === keepKey);
        if (found) {
          await openEntry(found);
        } else {
          setSelected(null);
          setSelectedEntry(null);
        }
      }
      return true;
    } catch (err) {
      setError(formatMemoryError(err));
      return false;
    } finally {
      setLoading(false);
    }
  }

  async function openEntry(entry: MemoryMeta) {
    setError(null);
    try {
      const read = await memoryRead({
        slug: entry.slug,
        scope: entry.scope,
        workdir: selectedEntryWorkdir(entry, workdir),
        workdirHash: entry.scope === "project" ? entry.workdirHash : undefined,
      });
      setSelected(read);
      setSelectedEntry(entry);
      setEditDraft({
        description: read.description,
        body: read.body,
        appendBody: "",
      });
    } catch (err) {
      setError(formatMemoryError(err));
    }
  }

  /** Returns true when the entry was created (so the caller can reset its form). */
  async function createEntry(draft: MemoryCreateDraft) {
    setSaving(true);
    setError(null);
    try {
      if (draft.scope === "project" && !workdir) {
        throw new Error(t("settings.memoryProjectRequiresWorkdir"));
      }
      const result = await memoryWrite({
        slug: draft.slug,
        scope: draft.scope,
        workdir,
        memoryType: draft.memoryType,
        description: draft.description,
        body: draft.body,
        actor: "user",
      });
      await reload(result.slug);
      return true;
    } catch (err) {
      setError(formatMemoryError(err));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function saveSelected() {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      const isDaily = selected.memoryType === "daily";
      const result = await memoryUpdate({
        slug: selected.slug,
        scope: selected.scope,
        workdir: selectedEntryWorkdir(selectedEntry, workdir),
        workdirHash: selectedEntry?.scope === "project" ? selectedEntry.workdirHash : undefined,
        description: isDaily ? undefined : editDraft.description,
        body: isDaily ? editDraft.appendBody : editDraft.body,
        mode: isDaily ? "append" : "replace",
        actor: "user",
      });
      setEditDraft((prev) => ({ ...prev, appendBody: "" }));
      await reload(selectedEntry ? entryKey(selectedEntry) : result.slug);
    } catch (err) {
      setError(formatMemoryError(err));
    } finally {
      setSaving(false);
    }
  }

  async function acceptSelected() {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      await memoryAccept({
        slug: selected.slug,
        scope: selected.scope,
        workdir: selectedEntryWorkdir(selectedEntry, workdir),
        workdirHash: selectedEntry?.scope === "project" ? selectedEntry.workdirHash : undefined,
      });
      await reload(selectedEntry ? entryKey(selectedEntry) : selected.slug);
    } catch (err) {
      setError(formatMemoryError(err));
    } finally {
      setSaving(false);
    }
  }

  async function deleteSelected() {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      await memoryDelete({
        slug: selected.slug,
        scope: selected.scope,
        workdir: selectedEntryWorkdir(selectedEntry, workdir),
        workdirHash: selectedEntry?.scope === "project" ? selectedEntry.workdirHash : undefined,
        actor: "user",
      });
      setSelected(null);
      setSelectedEntry(null);
      await reload();
    } catch (err) {
      setError(formatMemoryError(err));
    } finally {
      setSaving(false);
    }
  }

  async function wipeAll() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const info = await memoryWipeAll();
      setPathsInfo(info);
      setEntries([]);
      setQuota((prev) =>
        prev
          ? {
              ...prev,
              used: 0,
              scopeQuotas: prev.scopeQuotas?.map((item) => ({ ...item, used: 0 })),
            }
          : prev,
      );
      setSelected(null);
      setSelectedEntry(null);
    } catch (err) {
      setError(formatMemoryError(err));
    } finally {
      setSaving(false);
    }
  }

  // Watch a queued organizer run: poll while it is pending/running, then do a
  // single reload once it settles. No run being watched ⇒ no polling at all.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload identity changes every render; the watched run id is the trigger
  useEffect(() => {
    if (!organizerWatchRunId) return;
    const watchedRunId = organizerWatchRunId;
    let cancelled = false;

    async function pollRun() {
      try {
        const run = await memoryOrganizeRunRead({ runId: watchedRunId });
        if (cancelled || (run && isOrganizerRunActive(run))) return;
        setOrganizerWatchRunId(null);
        await reload();
      } catch (err) {
        if (cancelled) return;
        setOrganizerWatchRunId(null);
        setError(formatMemoryError(err));
      }
    }

    const interval = window.setInterval(() => void pollRun(), PANEL_RUN_POLL_INTERVAL_MS);
    void pollRun();
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [organizerWatchRunId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload identity changes every render; workdir is the trigger
  useEffect(() => {
    setSelected(null);
    setSelectedEntry(null);
    void reload(null);
  }, [workdir]);

  return {
    entries,
    quota,
    selected,
    selectedEntry,
    pathsInfo,
    loading,
    error,
    saving,
    editDraft,
    setEditDraft,
    reload,
    openEntry,
    createEntry,
    saveSelected,
    acceptSelected,
    deleteSelected,
    wipeAll,
    watchOrganizerRun: setOrganizerWatchRunId,
  };
}

export function useOrganizeRunHistory(input: { statusFilter: "all" | MemoryOrganizeRunStatus }) {
  const { statusFilter } = input;
  const [runs, setRuns] = useState<MemoryOrganizeRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<MemoryOrganizeRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload(
    selectRunId?: string,
    options?: { quiet?: boolean; keepSelection?: boolean },
  ) {
    const quiet = options?.quiet === true;
    if (!quiet) {
      setLoading(true);
      setError(null);
    }
    try {
      const response = await memoryOrganizeRunList({
        status: statusFilter === "all" ? undefined : statusFilter,
        limit: 80,
      });
      setRuns(response.runs);
      const nextId =
        selectRunId ||
        (options?.keepSelection === false ? undefined : selectedRun?.runId) ||
        response.runs[0]?.runId;
      const next = nextId ? await memoryOrganizeRunRead({ runId: nextId }) : null;
      setSelectedRun(next ?? response.runs[0] ?? null);
    } catch (err) {
      setError(formatMemoryError(err));
    } finally {
      if (!quiet) {
        setLoading(false);
      }
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload identity changes every render; statusFilter is the trigger
  useEffect(() => {
    void reload();
  }, [statusFilter]);

  const hasActiveRun = runs.some(isOrganizerRunActive) || isOrganizerRunActive(selectedRun);

  // Poll ONLY while a run is pending/running; a fully settled history never
  // schedules an interval.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload identity changes every render; the poll keys are the triggers
  useEffect(() => {
    if (!hasActiveRun) return;
    const interval = window.setInterval(() => {
      void reload(selectedRun?.runId, { quiet: true });
    }, PANEL_RUN_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [hasActiveRun, selectedRun?.runId, statusFilter]);

  return {
    runs,
    selectedRun,
    setSelectedRun,
    loading,
    error,
    setError,
    reload,
  };
}
