// Memory settings panel: entry list/filters, quota display, create/edit/
// accept/delete/wipe, plus mounting the settings drawer (which owns the
// organizer history modal).
//
// MIRROR NOTICE: every file in pages/settings/memory except platform.tsx
// exists byte-for-byte in both frontends (crates/agent-gui/src and
// crates/agent-gateway/web/src). Keep changes in sync on both ends; platform
// differences belong in ./platform, never here.

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useLocale } from "../../../i18n";
import type { MemoryMeta } from "../../../lib/memory/api";
import { MEMORY_TYPES, type MemoryType } from "../../../lib/memory/schema";
import type { AppSettings } from "../../../lib/settings";
import { MemorySettingsDrawer } from "./MemorySettingsDrawer";
import {
  entryKey,
  entryTitle,
  fallbackScopeQuotas,
  formatTime,
  type MemoryModelOption,
  type MemoryTab,
  matchesFilter,
  memoryScopeLabel,
  memoryTypeLabel,
  projectLabel,
  quotaLevel,
  quotaPillClass,
  quotaStatusClass,
  quotaStatusLabelKey,
  selectedTitle,
  strongestQuotaLevel,
} from "./panelModel";
import {
  AlertTriangle,
  BookOpen,
  Brain,
  Button,
  buildModelOptions,
  Check,
  ChevronDown,
  Folder,
  Globe2,
  Input,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
} from "./platform";
import { type MemoryCreateDraft, useMemoryPanelData } from "./useMemoryPanelData";

const EMPTY_CREATE_DRAFT: MemoryCreateDraft = {
  slug: "",
  scope: "global",
  memoryType: "user",
  description: "",
  body: "",
};

export function MemoryPanel(props: {
  workdir?: string;
  settings: AppSettings;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
}) {
  const { t } = useLocale();
  const workdir = props.workdir?.trim() || undefined;
  const [tab, setTab] = useState<MemoryTab>("global");
  const [filter, setFilter] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [wipeConfirmOpen, setWipeConfirmOpen] = useState(false);
  const [settingsDrawerOpen, setSettingsDrawerOpen] = useState(false);
  const [draft, setDraft] = useState<MemoryCreateDraft>(EMPTY_CREATE_DRAFT);
  const {
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
    watchOrganizerRun,
  } = useMemoryPanelData({ workdir, t });

  const modelOptions = useMemo<MemoryModelOption[]>(
    () =>
      buildModelOptions(props.settings).map((option) => ({
        value: option.value,
        label: option.label,
        providerName: option.providerName,
        providerId: option.providerId,
        providerType: option.providerType,
      })),
    [props.settings],
  );

  const globalEntries = useMemo(() => {
    return entries
      .filter((entry) => entry.scope === "global" && entry.memoryType !== "daily")
      .filter((entry) => matchesFilter(entry, filter));
  }, [entries, filter]);

  const dailyEntries = useMemo(() => {
    return entries
      .filter((entry) => entry.memoryType === "daily")
      .filter((entry) => matchesFilter(entry, filter));
  }, [entries, filter]);

  const projectGroups = useMemo(() => {
    const groups = new Map<
      string,
      { key: string; label: string; latestUpdatedAt: number; entries: MemoryMeta[] }
    >();
    for (const entry of entries) {
      if (entry.scope !== "project" || entry.memoryType === "daily") continue;
      if (!matchesFilter(entry, filter)) continue;
      const key = entry.workdirHash || entry.workdirPath || "unknown";
      const label = projectLabel(entry, t);
      const group = groups.get(key) ?? {
        key,
        label,
        latestUpdatedAt: 0,
        entries: [],
      };
      group.latestUpdatedAt = Math.max(group.latestUpdatedAt, entry.updatedAt);
      group.entries.push(entry);
      groups.set(key, group);
    }
    return Array.from(groups.values())
      .map((group) => ({
        ...group,
        entries: group.entries.sort((a, b) =>
          b.updatedAt === a.updatedAt ? a.slug.localeCompare(b.slug) : b.updatedAt - a.updatedAt,
        ),
      }))
      .sort((a, b) =>
        b.latestUpdatedAt === a.latestUpdatedAt
          ? a.label.localeCompare(b.label)
          : b.latestUpdatedAt - a.latestUpdatedAt,
      );
  }, [entries, filter, t]);

  const projectEntryCount = entries.filter(
    (entry) => entry.scope === "project" && entry.memoryType !== "daily",
  ).length;
  const globalEntryCount = entries.filter(
    (entry) => entry.scope === "global" && entry.memoryType !== "daily",
  ).length;
  const dailyEntryCount = entries.filter((entry) => entry.memoryType === "daily").length;
  const unreviewedCount = entries.filter((entry) => entry.unreviewed).length;
  const quotaItems = useMemo(
    () => fallbackScopeQuotas(entries, quota, Boolean(workdir)),
    [entries, quota, workdir],
  );
  const quotaStatus = strongestQuotaLevel(quotaItems);

  async function handleCreateEntry() {
    const created = await createEntry(draft);
    if (created) {
      setShowCreate(false);
      setDraft(EMPTY_CREATE_DRAFT);
    }
  }

  function handleWipeAll() {
    setWipeConfirmOpen(false);
    void wipeAll();
  }

  const activeEntryKey = selectedEntry ? entryKey(selectedEntry) : null;

  function renderEntryButton(entry: MemoryMeta, nested = false) {
    const active = activeEntryKey === entryKey(entry);
    return (
      <button
        key={entryKey(entry)}
        type="button"
        onClick={() => openEntry(entry)}
        className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
          nested ? "ml-3 w-[calc(100%-0.75rem)]" : ""
        } ${
          active
            ? "border-primary/50 bg-primary/5 shadow-xs"
            : entry.unreviewed
              ? "border-amber-500/20 bg-amber-500/[0.05] hover:bg-amber-500/[0.08]"
              : "border-border/50 bg-background/70 hover:bg-muted/35"
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 truncate text-xs font-semibold">{entryTitle(entry)}</div>
          <div className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {memoryTypeLabel(entry.memoryType, t)}
          </div>
        </div>
        <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground/70">
          id: {entry.slug}
        </div>
      </button>
    );
  }

  function renderFlatEntries(items: MemoryMeta[], emptyKey: string) {
    if (items.length === 0) {
      return (
        <div className="rounded-lg border border-dashed border-border/60 px-4 py-8 text-center text-xs text-muted-foreground">
          {t(emptyKey)}
        </div>
      );
    }
    return <div className="space-y-1.5">{items.map((entry) => renderEntryButton(entry))}</div>;
  }

  return (
    <>
      <div className="settings-memory-panel flex min-h-0 flex-1 flex-col gap-4">
        <div className="settings-memory-summary-card shrink-0 rounded-xl border border-border/60 bg-card p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Brain className="h-4 w-4 text-muted-foreground" />
                {t("settings.memoryTitle")}
              </div>
              <div className="break-all text-xs text-muted-foreground">
                {pathsInfo?.root ?? "~/.liveagent/memory"}
              </div>
            </div>
            <div className="settings-memory-summary-actions flex flex-wrap items-center gap-2">
              {quotaItems.map((item) => {
                const level = quotaLevel(item);
                const label =
                  item.scope === "global"
                    ? t("settings.memoryQuotaGlobal")
                    : t("settings.memoryQuotaProject");
                return (
                  <div
                    key={`${item.scope}:${item.workdirHash}`}
                    className={`rounded-md border px-2.5 py-1.5 text-xs ${quotaPillClass(level)}`}
                  >
                    {label} {item.used} / {item.limit}
                  </div>
                );
              })}
              <div
                className={`rounded-md border px-2.5 py-1.5 text-xs ${quotaStatusClass(quotaStatus)}`}
              >
                {t(quotaStatusLabelKey(quotaStatus))}
              </div>
              <Button variant="outline" size="sm" onClick={() => reload()} disabled={loading}>
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
                {t("settings.memoryRefresh")}
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                title={t("settings.memoryOpenSettings")}
                aria-label={t("settings.memoryOpenSettings")}
                onClick={() => setSettingsDrawerOpen(true)}
              >
                <Settings2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          {unreviewedCount > 0 ? (
            <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              {unreviewedCount} {t("settings.memoryAwaitingReview")}
            </div>
          ) : null}
          {pathsInfo?.isInCloud ? (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t("settings.memoryCloudWarningPrefix")}{" "}
              {pathsInfo.cloudProvider ?? t("settings.memoryCloudSyncFolder")}
            </div>
          ) : null}
          {quotaStatus === "full" || quotaStatus === "danger" ? (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-xs text-red-700 dark:text-red-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t(
                quotaStatus === "full"
                  ? "settings.memoryQuotaFullMessage"
                  : "settings.memoryQuotaNearLimitMessage",
              )}
            </div>
          ) : quotaStatus === "warning" ? (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t("settings.memoryQuotaWarningMessage")}
            </div>
          ) : null}
          {error ? (
            <div className="mt-3 whitespace-pre-wrap rounded-lg border border-destructive/20 bg-destructive/[0.05] px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          ) : null}
        </div>

        <div className="settings-memory-layout grid min-h-0 flex-1 gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
          <section className="settings-memory-list-section flex min-h-0 flex-col rounded-xl border border-border/60 bg-card">
            <div className="shrink-0 space-y-3 border-b border-border/40 p-3">
              <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted/50 p-1">
                <button
                  type="button"
                  onClick={() => setTab("global")}
                  className={`flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium ${tab === "global" ? "bg-background shadow-xs" : "text-muted-foreground"}`}
                >
                  <Globe2 className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{t("settings.memoryCategoryGlobal")}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {globalEntryCount}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setTab("project")}
                  className={`flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium ${tab === "project" ? "bg-background shadow-xs" : "text-muted-foreground"}`}
                >
                  <Folder className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{t("settings.memoryCategoryProject")}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {projectEntryCount}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setTab("journal")}
                  className={`flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium ${tab === "journal" ? "bg-background shadow-xs" : "text-muted-foreground"}`}
                >
                  <BookOpen className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{t("settings.memoryCategoryJournal")}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {dailyEntryCount}
                  </span>
                </button>
              </div>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    className="pl-8 text-xs"
                    placeholder={t("settings.memorySearchPlaceholder")}
                  />
                </div>
                <Button
                  size="icon"
                  variant="outline"
                  title={t("settings.memoryNew")}
                  onClick={() => setShowCreate((value) => !value)}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="settings-memory-entry-list min-h-0 flex-1 overflow-auto p-2">
              {tab === "global" ? (
                renderFlatEntries(globalEntries, "settings.memoryNoGlobalEntries")
              ) : tab === "journal" ? (
                renderFlatEntries(dailyEntries, "settings.memoryNoJournalEntries")
              ) : projectGroups.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border/60 px-4 py-8 text-center text-xs text-muted-foreground">
                  {t("settings.memoryNoProjectEntries")}
                </div>
              ) : (
                <div className="space-y-2">
                  {projectGroups.map((group) => (
                    <details
                      key={group.key}
                      className="group rounded-lg border border-border/50 bg-muted/15"
                      open
                    >
                      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-left text-xs [&::-webkit-details-marker]:hidden">
                        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-0 -rotate-90" />
                        <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate font-medium" title={group.label}>
                          {group.label}
                        </span>
                        <span className="shrink-0 rounded bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {group.entries.length}
                        </span>
                      </summary>
                      <div className="space-y-1.5 border-t border-border/40 px-2 py-2">
                        {group.entries.map((entry) => renderEntryButton(entry, true))}
                      </div>
                    </details>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="settings-memory-detail-section flex min-h-0 flex-col rounded-xl border border-border/60 bg-card">
            {showCreate ? (
              <div className="shrink-0 border-b border-border/40 p-4">
                <div className="mb-3 text-sm font-semibold">{t("settings.memoryNew")}</div>
                <div className="grid gap-3 md:grid-cols-2">
                  <Input
                    value={draft.slug}
                    onChange={(event) =>
                      setDraft((prev) => ({ ...prev, slug: event.target.value }))
                    }
                    placeholder={t("settings.memorySlugPlaceholder")}
                  />
                  <select
                    value={draft.memoryType}
                    onChange={(event) =>
                      setDraft((prev) => ({
                        ...prev,
                        memoryType: event.target.value as MemoryType,
                      }))
                    }
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {MEMORY_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {memoryTypeLabel(type, t)}
                      </option>
                    ))}
                  </select>
                  <select
                    value={draft.scope}
                    onChange={(event) =>
                      setDraft((prev) => ({
                        ...prev,
                        scope: event.target.value as "global" | "project",
                      }))
                    }
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="global">{t("settings.memoryScopeGlobal")}</option>
                    <option value="project">{t("settings.memoryScopeProject")}</option>
                  </select>
                  <Input
                    value={draft.description}
                    onChange={(event) =>
                      setDraft((prev) => ({ ...prev, description: event.target.value }))
                    }
                    placeholder={t("settings.memoryDescriptionPlaceholder")}
                  />
                </div>
                <textarea
                  value={draft.body}
                  onChange={(event) => setDraft((prev) => ({ ...prev, body: event.target.value }))}
                  className="mt-3 min-h-28 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm"
                  placeholder={t("settings.memoryBodyPlaceholder")}
                />
                <div className="mt-3 flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setShowCreate(false)}>
                    {t("settings.memoryCancel")}
                  </Button>
                  <Button size="sm" onClick={handleCreateEntry} disabled={saving}>
                    {t("settings.memorySave")}
                  </Button>
                </div>
              </div>
            ) : null}

            {selected ? (
              <>
                <div className="shrink-0 border-b border-border/40 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="truncate text-sm font-semibold">
                          {selectedTitle(selected)}
                        </div>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {memoryScopeLabel(selected.scope, t)}
                        </span>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {memoryTypeLabel(selected.memoryType, t)}
                        </span>
                        {selected.meta.unreviewed ? (
                          <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
                            {t("settings.memoryUnreviewed")}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {t("settings.memoryUpdated")} {formatTime(selected.meta.updatedAt)}
                      </div>
                      <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground/70">
                        id: {selected.slug}
                      </div>
                      {selectedEntry?.scope === "project" ? (
                        <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground/70">
                          {selectedEntry.workdirPath || selectedEntry.workdirHash}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      {selected.meta.unreviewed && selected.memoryType !== "daily" ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={acceptSelected}
                          disabled={saving}
                        >
                          <Check className="h-3.5 w-3.5" />
                          {t("settings.memoryAccept")}
                        </Button>
                      ) : null}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={deleteSelected}
                        disabled={saving}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        {t("settings.memoryDelete")}
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="settings-memory-detail-body min-h-0 flex-1 overflow-auto p-4">
                  {selected.memoryType === "daily" ? (
                    <div className="space-y-3">
                      <textarea
                        value={editDraft.appendBody}
                        onChange={(event) =>
                          setEditDraft((prev) => ({ ...prev, appendBody: event.target.value }))
                        }
                        className="min-h-24 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm"
                        placeholder={t("settings.memoryAppendBlockPlaceholder")}
                      />
                      <div className="rounded-lg border border-border/50 bg-muted/20 p-3">
                        <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground">
                          {selected.body || t("settings.memoryEmptyBody")}
                        </pre>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <Input
                        value={editDraft.description}
                        onChange={(event) =>
                          setEditDraft((prev) => ({ ...prev, description: event.target.value }))
                        }
                        placeholder={t("settings.memoryDescriptionPlaceholder")}
                      />
                      <textarea
                        value={editDraft.body}
                        onChange={(event) =>
                          setEditDraft((prev) => ({ ...prev, body: event.target.value }))
                        }
                        className="min-h-[360px] w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed"
                      />
                    </div>
                  )}
                </div>

                <div className="shrink-0 border-t border-border/40 p-4">
                  <div className="flex justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setWipeConfirmOpen(true)}
                        disabled={saving}
                      >
                        {t("settings.memoryWipeAll")}
                      </Button>
                    </div>
                    <Button size="sm" onClick={saveSelected} disabled={saving}>
                      {t("settings.memorySave")}
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
                {t("settings.memorySelectEntry")}
              </div>
            )}
          </section>
        </div>
      </div>

      {settingsDrawerOpen ? (
        <MemorySettingsDrawer
          modelOptions={modelOptions}
          settings={props.settings}
          setSettings={props.setSettings}
          workdir={workdir}
          saving={saving}
          t={t}
          onClose={() => setSettingsDrawerOpen(false)}
          onRequestWipe={wipeAll}
          onOrganizerRunQueued={(runId) => watchOrganizerRun(runId)}
          onMemoryChanged={() => {
            void reload();
          }}
        />
      ) : null}

      {wipeConfirmOpen
        ? createPortal(
            <div
              className="fixed inset-0 z-50 flex items-center justify-center p-4"
              role="dialog"
              aria-modal="true"
              aria-labelledby="memory-wipe-confirm-title"
            >
              <div
                className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                onClick={() => setWipeConfirmOpen(false)}
              />
              <div className="relative z-10 w-full max-w-md overflow-hidden rounded-xl border bg-background shadow-2xl">
                <div className="flex items-start gap-3 border-b px-5 py-4">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-destructive/10">
                    <AlertTriangle className="h-4 w-4 text-destructive" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div id="memory-wipe-confirm-title" className="text-sm font-semibold">
                      {t("settings.memoryWipeConfirmTitle")}
                    </div>
                    <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {t("settings.memoryWipeConfirmDescription")}
                    </div>
                  </div>
                </div>
                <div className="flex justify-end gap-2 px-5 py-4">
                  <Button variant="outline" size="sm" onClick={() => setWipeConfirmOpen(false)}>
                    {t("settings.memoryCancel")}
                  </Button>
                  <Button variant="destructive" size="sm" onClick={handleWipeAll} disabled={saving}>
                    {t("settings.memoryWipeAll")}
                  </Button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
