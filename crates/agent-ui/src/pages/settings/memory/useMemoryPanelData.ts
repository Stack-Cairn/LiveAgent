// Data hooks for the memory settings panel: list/read/mutate/wipe for the
// panel itself.
//
// Shared implementation owned by @liveagent/ui.

import { useEffect, useState } from "react";
import {
  formatMemoryError,
  type MemoryMeta,
  type MemoryPathsInfo,
  type MemoryReadResponse,
  memoryAccept,
  memoryDelete,
  memoryList,
  memoryPathsInfo,
  memoryRead,
  memoryUpdate,
  memoryWipeAll,
  memoryWrite,
} from "../../../lib/memory/api";
import type { MemoryType } from "../../../lib/memory/schema";
import { isUnsupportedResourceError } from "../../../lib/resourceHost";
import { entryKey, type MemoryQuota, selectedEntryWorkdir } from "./panelModel";

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

export function useMemoryPanelData(input: {
  workdir?: string;
  t: (key: string) => string;
  backendManaged?: boolean;
}) {
  const { workdir, t, backendManaged: hostBackendManaged = false } = input;
  const [entries, setEntries] = useState<MemoryMeta[]>([]);
  const [quota, setQuota] = useState<MemoryQuota | null>(null);
  const [selected, setSelected] = useState<MemoryReadResponse | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<MemoryMeta | null>(null);
  const [pathsInfo, setPathsInfo] = useState<MemoryPathsInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [backendManaged, setBackendManaged] = useState(hostBackendManaged);
  const [editDraft, setEditDraft] = useState<MemoryEditDraft>({
    description: "",
    body: "",
    appendBody: "",
  });

  async function reload(keepEntry?: string | null) {
    if (backendManaged) return false;
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
          return await openEntry(found);
        } else {
          setSelected(null);
          setSelectedEntry(null);
        }
      }
      return true;
    } catch (err) {
      if (isUnsupportedResourceError(err)) setBackendManaged(true);
      setError(formatMemoryError(err));
      return false;
    } finally {
      setLoading(false);
    }
  }

  async function openEntry(entry: MemoryMeta) {
    if (backendManaged) return false;
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
      return true;
    } catch (err) {
      if (isUnsupportedResourceError(err)) setBackendManaged(true);
      setError(formatMemoryError(err));
      return false;
    }
  }

  /** Returns true when the entry was created (so the caller can reset its form). */
  async function createEntry(draft: MemoryCreateDraft) {
    if (backendManaged) return false;
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
      return await reload(result.slug);
    } catch (err) {
      if (isUnsupportedResourceError(err)) setBackendManaged(true);
      setError(formatMemoryError(err));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function saveSelected() {
    if (backendManaged || !selected) return;
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
      if (isUnsupportedResourceError(err)) setBackendManaged(true);
      setError(formatMemoryError(err));
    } finally {
      setSaving(false);
    }
  }

  async function acceptSelected() {
    if (backendManaged || !selected) return;
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
      if (isUnsupportedResourceError(err)) setBackendManaged(true);
      setError(formatMemoryError(err));
    } finally {
      setSaving(false);
    }
  }

  async function deleteSelected() {
    if (backendManaged || !selected) return;
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
      if (isUnsupportedResourceError(err)) setBackendManaged(true);
      setError(formatMemoryError(err));
    } finally {
      setSaving(false);
    }
  }

  async function wipeAll() {
    if (backendManaged || saving) return;
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
      if (isUnsupportedResourceError(err)) setBackendManaged(true);
      setError(formatMemoryError(err));
    } finally {
      setSaving(false);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload identity changes every render; workdir and host capability are the triggers
  useEffect(() => {
    setSelected(null);
    setSelectedEntry(null);
    if (backendManaged) {
      setLoading(false);
      return;
    }
    void reload(null);
  }, [backendManaged, workdir]);

  return {
    entries,
    quota,
    selected,
    selectedEntry,
    pathsInfo,
    loading,
    error,
    saving,
    backendManaged,
    editDraft,
    setEditDraft,
    reload,
    openEntry,
    createEntry,
    saveSelected,
    acceptSelected,
    deleteSelected,
    wipeAll,
  };
}
