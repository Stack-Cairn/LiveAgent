// Memory settings drawer: organizer model/schedule/scope/mode, extraction
// summary model, Run Now, quota-ladder banner and the wipe-all danger zone.
//
// MIRROR NOTICE: every file in pages/settings/memory except platform.tsx
// exists byte-for-byte in both frontends (crates/agent-gui/src and
// crates/agent-gateway/web/src). Keep changes in sync on both ends; platform
// differences belong in ./platform, never here.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  formatMemoryError,
  type MemoryQuotaSummaryResponse,
  memoryOrganizeRunCreate,
  memoryQuotaSummary,
} from "../../../lib/memory/api";
import { deriveQuotaLadder } from "../../../lib/memory/organizer/quota";
import {
  type AppSettings,
  computeNextMemoryOrganizerRunAt,
  type MemoryOrganizerFrequency,
  type MemoryOrganizerMode,
  type MemoryOrganizerScope,
  updateMemorySettings,
} from "../../../lib/settings";
import { OrganizerHistoryModal } from "./OrganizerHistoryModal";
import {
  formatTime,
  MEMORY_ORGANIZER_FREQUENCIES,
  MEMORY_ORGANIZER_MODES,
  MEMORY_ORGANIZER_SCOPES,
  MEMORY_ORGANIZER_WEEKDAYS,
  type MemoryModelOption,
  memoryScopeLabel,
} from "./panelModel";
import {
  AgentActivationSwitch,
  AlertTriangle,
  Button,
  canRunOrganizerLocally,
  DrawerSelect,
  History,
  ModelPicker,
  parseModelValue,
  pokeMemoryOrganizer,
  RefreshCw,
  Trash2,
  toModelValue,
  X,
} from "./platform";

const MEMORY_ORGANIZER_TIME_DEBOUNCE_MS = 400;

function memoryModelValue(model: AppSettings["memory"]["organizerModel"]) {
  return model ? toModelValue(model.customProviderId, model.model) : "";
}

export function MemorySettingsDrawer(props: {
  modelOptions: MemoryModelOption[];
  settings: AppSettings;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
  workdir?: string;
  saving: boolean;
  t: (key: string) => string;
  onClose: () => void;
  onRequestWipe: () => void | Promise<void>;
  onOrganizerRunQueued?: (runId: string) => void;
  onMemoryChanged?: () => void;
}) {
  const {
    modelOptions,
    settings,
    setSettings,
    workdir,
    saving,
    t,
    onClose,
    onRequestWipe,
    onOrganizerRunQueued,
    onMemoryChanged,
  } = props;
  const [historyOpen, setHistoryOpen] = useState(false);
  const [organizerFeedback, setOrganizerFeedback] = useState<string | null>(null);
  const [organizerSubmitting, setOrganizerSubmitting] = useState(false);
  const [drawerWipeConfirmOpen, setDrawerWipeConfirmOpen] = useState(false);
  const [quotaSummary, setQuotaSummary] = useState<MemoryQuotaSummaryResponse | null>(null);
  const memoryOrganizerModel = memoryModelValue(settings.memory.organizerModel);
  const conversationSummaryModel = memoryModelValue(settings.memory.summaryModel);
  const committedTimeLocal = settings.memory.organizerSchedule.timeLocal;
  const [timeLocalDraft, setTimeLocalDraft] = useState(committedTimeLocal);
  const committedTimeLocalRef = useRef(committedTimeLocal);
  const timeLocalDraftRef = useRef(timeLocalDraft);
  const canEnableOrganizer = memoryOrganizerModel.trim().length > 0;
  const organizerTimingDisabled =
    !settings.memory.organizerEnabled || settings.memory.organizerSchedule.frequency === "none";
  const quotaLadder = useMemo(() => deriveQuotaLadder(quotaSummary), [quotaSummary]);

  useEffect(() => {
    let cancelled = false;
    void memoryQuotaSummary({ workdir })
      .then((summary) => {
        if (!cancelled) setQuotaSummary(summary);
      })
      .catch(() => {
        // The banner is best-effort; a failed summary just renders nothing.
      });
    return () => {
      cancelled = true;
    };
  }, [workdir]);

  useEffect(() => {
    committedTimeLocalRef.current = committedTimeLocal;
    setTimeLocalDraft(committedTimeLocal);
  }, [committedTimeLocal]);

  useEffect(() => {
    timeLocalDraftRef.current = timeLocalDraft;
  }, [timeLocalDraft]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: updateOrganizerSchedule identity changes every render; the drafts are the triggers
  useEffect(() => {
    if (timeLocalDraft === committedTimeLocal) return;
    const timeout = window.setTimeout(() => {
      updateOrganizerSchedule({ timeLocal: timeLocalDraft });
    }, MEMORY_ORGANIZER_TIME_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [timeLocalDraft, committedTimeLocal]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: flush the pending draft exactly once on unmount
  useEffect(() => {
    return () => {
      const draft = timeLocalDraftRef.current;
      if (draft !== committedTimeLocalRef.current) {
        updateOrganizerSchedule({ timeLocal: draft });
      }
    };
  }, []);

  useEffect(() => {
    if (
      (!canEnableOrganizer || settings.memory.organizerSchedule.frequency === "none") &&
      settings.memory.organizerEnabled
    ) {
      setSettings((prev) =>
        updateMemorySettings(prev, {
          organizerEnabled: false,
          organizerNextRunAt: undefined,
        }),
      );
    }
  }, [
    canEnableOrganizer,
    setSettings,
    settings.memory.organizerEnabled,
    settings.memory.organizerSchedule.frequency,
  ]);

  // The two model selects share the picker but not the empty-value wording:
  // clearing the organizer model turns the organizer off, while clearing the
  // summary model means extraction follows the conversation's chat model.
  function renderModelSelect(
    value: string,
    onChange: (value: string) => void,
    ariaLabel: string,
    noneLabel: string,
  ) {
    return (
      <ModelPicker
        value={value}
        onChange={onChange}
        options={modelOptions}
        placeholder={noneLabel}
        noneLabel={noneLabel}
        ariaLabel={ariaLabel}
        triggerClassName="h-9 rounded-lg border-foreground/[0.08] bg-white/55 text-[13px] hover:border-foreground/[0.14] hover:bg-white/75 dark:bg-white/[0.04] dark:hover:bg-white/[0.06]"
      />
    );
  }

  function handleOrganizerModelChange(value: string) {
    const selected = parseModelValue(value) ?? undefined;
    setSettings((prev) => updateMemorySettings(prev, { organizerModel: selected }));
    if (!selected) {
      setSettings((prev) =>
        updateMemorySettings(prev, {
          organizerEnabled: false,
          organizerNextRunAt: undefined,
        }),
      );
    }
  }

  function handleSummaryModelChange(value: string) {
    setSettings((prev) =>
      updateMemorySettings(prev, {
        summaryModel: parseModelValue(value) ?? undefined,
      }),
    );
  }

  function handleOrganizerToggle() {
    if (!canEnableOrganizer) return;
    setSettings((prev) => {
      const enabled =
        !prev.memory.organizerEnabled || prev.memory.organizerSchedule.frequency === "none";
      const organizerSchedule =
        enabled && prev.memory.organizerSchedule.frequency === "none"
          ? { ...prev.memory.organizerSchedule, frequency: "daily" as MemoryOrganizerFrequency }
          : prev.memory.organizerSchedule;
      return updateMemorySettings(prev, {
        organizerEnabled: enabled,
        organizerSchedule,
        organizerNextRunAt: enabled
          ? computeNextMemoryOrganizerRunAt(organizerSchedule)
          : undefined,
      });
    });
  }

  function updateOrganizerSchedule(patch: Partial<AppSettings["memory"]["organizerSchedule"]>) {
    setSettings((prev) => {
      const organizerSchedule = {
        ...prev.memory.organizerSchedule,
        ...patch,
      };
      const enabledByFrequency = patch.frequency === "daily" || patch.frequency === "weekly";
      const organizerEnabled =
        organizerSchedule.frequency !== "none" &&
        Boolean(prev.memory.organizerModel) &&
        (prev.memory.organizerEnabled || enabledByFrequency);
      return updateMemorySettings(prev, {
        organizerSchedule,
        organizerEnabled,
        organizerNextRunAt: organizerEnabled
          ? computeNextMemoryOrganizerRunAt(organizerSchedule)
          : undefined,
      });
    });
  }

  function flushOrganizerTimeLocal() {
    if (timeLocalDraft !== settings.memory.organizerSchedule.timeLocal) {
      updateOrganizerSchedule({ timeLocal: timeLocalDraft });
    }
  }

  async function handleRunNow() {
    setOrganizerFeedback(null);
    if (!settings.memory.organizerModel) {
      setOrganizerFeedback(t("settings.memoryOrganizerNoModel"));
      return;
    }
    setOrganizerSubmitting(true);
    try {
      const response = await memoryOrganizeRunCreate({
        trigger: "manual",
        model: settings.memory.organizerModel,
        scope: settings.memory.organizerScope,
        mode: settings.memory.organizerMode,
      });
      const runId = response.run?.runId ?? response.activeRun?.runId;
      if (runId) {
        onOrganizerRunQueued?.(runId);
      }
      if (response.alreadyRunning) {
        setOrganizerFeedback(t("settings.memoryOrganizerAlreadyRunning"));
        setHistoryOpen(true);
        return;
      }
      const runnerPoked = canRunOrganizerLocally ? pokeMemoryOrganizer() : false;
      setOrganizerFeedback(
        t(runnerPoked ? "settings.memoryOrganizerQueued" : "settings.memoryOrganizerQueuedRemote"),
      );
      setHistoryOpen(true);
    } catch (err) {
      setOrganizerFeedback(formatMemoryError(err));
    } finally {
      setOrganizerSubmitting(false);
    }
  }

  return createPortal(
    <div
      className="skills-drawer-backdrop fixed inset-0 z-50 flex justify-end bg-foreground/[0.04] backdrop-blur-md dark:bg-background/30"
      role="dialog"
      aria-modal="true"
      aria-labelledby="memory-settings-drawer-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <aside className="skills-drawer-panel relative flex h-full w-full flex-col overflow-hidden border-l border-foreground/[0.06] bg-background/65 shadow-[-30px_0_70px_-32px_rgba(15,23,42,0.28)] backdrop-blur-2xl sm:max-w-[420px] dark:border-foreground/[0.08] dark:bg-background/55">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent dark:via-white/10"
        />
        <div className="relative flex items-center gap-3 border-b border-foreground/[0.06] px-6 py-[18px]">
          <div className="min-w-0 flex-1">
            <div
              id="memory-settings-drawer-title"
              className="text-[15px] font-semibold leading-tight tracking-tight text-foreground/95"
            >
              {t("settings.memorySettingsTitle")}
            </div>
            <div className="mt-1 text-[11.5px] leading-snug text-muted-foreground/80">
              {t("settings.memorySettingsLocalOnly")}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-foreground/[0.05] text-muted-foreground/80 transition-colors hover:bg-foreground/[0.1] hover:text-foreground"
            title={t("settings.memorySettingsClose")}
            aria-label={t("settings.memorySettingsClose")}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="relative min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <div className="space-y-6">
            {quotaLadder.level !== "normal" &&
            quotaLadder.bannerKey &&
            quotaLadder.tightestScope ? (
              <div
                className={`flex items-start gap-2 rounded-2xl border px-4 py-3 text-[11.5px] leading-relaxed ${
                  quotaLadder.level === "critical" || quotaLadder.level === "exhausted"
                    ? "border-red-500/25 bg-red-500/[0.06] text-red-700 dark:text-red-300"
                    : "border-amber-500/25 bg-amber-500/[0.06] text-amber-700 dark:text-amber-300"
                }`}
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  {t(quotaLadder.bannerKey)
                    .replace("{scope}", memoryScopeLabel(quotaLadder.tightestScope.scope, t))
                    .replace("{used}", String(quotaLadder.tightestScope.used))
                    .replace("{limit}", String(quotaLadder.tightestScope.limit))}
                </span>
              </div>
            ) : null}

            <section className="space-y-2">
              <div className="px-1 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-muted-foreground/65">
                {t("settings.memoryDriverModels")}
              </div>
              <div className="rounded-2xl border border-foreground/[0.06] bg-white/55 p-4 shadow-[0_1px_0_rgba(255,255,255,0.7)_inset,0_6px_16px_-12px_rgba(15,23,42,0.08)] backdrop-blur-md dark:bg-white/[0.035] dark:shadow-[0_1px_0_rgba(255,255,255,0.04)_inset]">
                <label className="block space-y-1.5">
                  <span className="text-[11.5px] text-muted-foreground/90">
                    {t("settings.memoryOrganizerModel")}
                  </span>
                  {renderModelSelect(
                    memoryOrganizerModel,
                    handleOrganizerModelChange,
                    t("settings.memoryOrganizerModel"),
                    t("settings.memoryModelNone"),
                  )}
                </label>
                <div className="my-3 h-px bg-foreground/[0.05]" />
                <label className="block space-y-1.5">
                  <span className="text-[11.5px] text-muted-foreground/90">
                    {t("settings.memorySummaryModel")}
                  </span>
                  {renderModelSelect(
                    conversationSummaryModel,
                    handleSummaryModelChange,
                    t("settings.memorySummaryModel"),
                    t("settings.memorySummaryModelFollow"),
                  )}
                </label>
                {modelOptions.length === 0 ? (
                  <div className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.05] px-3 py-2 text-[11.5px] text-amber-700 dark:text-amber-300">
                    {t("settings.memoryModelEmpty")}
                  </div>
                ) : null}
              </div>
            </section>

            <section className="space-y-2">
              <div className="flex items-center justify-between gap-2 px-1">
                <div className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-muted-foreground/65">
                  {t("settings.memoryOrganizerTitle")}
                </div>
                <AgentActivationSwitch
                  checked={settings.memory.organizerEnabled}
                  title={t("settings.memoryOrganizerToggle")}
                  disabled={!canEnableOrganizer}
                  onToggle={handleOrganizerToggle}
                />
              </div>
              <div className="rounded-2xl border border-foreground/[0.06] bg-white/55 p-4 shadow-[0_1px_0_rgba(255,255,255,0.7)_inset,0_6px_16px_-12px_rgba(15,23,42,0.08)] backdrop-blur-md dark:bg-white/[0.035] dark:shadow-[0_1px_0_rgba(255,255,255,0.04)_inset]">
                <div className="space-y-3">
                  <div className="grid grid-cols-[1fr_108px] gap-2.5">
                    <label className="block space-y-1.5">
                      <span className="text-[11.5px] text-muted-foreground/90">
                        {t("settings.memoryOrganizerSchedule")}
                      </span>
                      <DrawerSelect
                        value={settings.memory.organizerSchedule.frequency}
                        disabled={!canEnableOrganizer}
                        onValueChange={(next) =>
                          updateOrganizerSchedule({
                            frequency: next as MemoryOrganizerFrequency,
                          })
                        }
                        ariaLabel={t("settings.memoryOrganizerSchedule")}
                        options={MEMORY_ORGANIZER_FREQUENCIES.map((item) => ({
                          value: item.value,
                          label: t(item.labelKey),
                        }))}
                      />
                    </label>
                    <label className="block space-y-1.5">
                      <span className="text-[11.5px] text-muted-foreground/90">
                        {t("settings.memoryOrganizerTime")}
                      </span>
                      <input
                        type="time"
                        aria-label={t("settings.memoryOrganizerTime")}
                        value={timeLocalDraft}
                        disabled={organizerTimingDisabled}
                        onChange={(event) => setTimeLocalDraft(event.currentTarget.value)}
                        onBlur={flushOrganizerTimeLocal}
                        className={[
                          "h-9 w-full rounded-lg border border-foreground/[0.08] bg-white/55 px-3 text-[13px] leading-none text-foreground/90",
                          "outline-none transition-[background-color,border-color] focus:border-foreground/[0.18] focus:bg-white/80",
                          "focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0",
                          "disabled:cursor-not-allowed disabled:opacity-50",
                          "dark:bg-white/[0.04] dark:focus:bg-white/[0.08]",
                        ].join(" ")}
                      />
                    </label>
                  </div>
                  {settings.memory.organizerSchedule.frequency === "weekly" ? (
                    <label className="block space-y-1.5">
                      <span className="text-[11.5px] text-muted-foreground/90">
                        {t("settings.memoryOrganizerWeekday")}
                      </span>
                      <DrawerSelect
                        value={String(settings.memory.organizerSchedule.weekday ?? 1)}
                        disabled={organizerTimingDisabled}
                        onValueChange={(next) => updateOrganizerSchedule({ weekday: Number(next) })}
                        ariaLabel={t("settings.memoryOrganizerWeekday")}
                        options={MEMORY_ORGANIZER_WEEKDAYS.map((key, index) => ({
                          value: String(index),
                          label: t(key),
                        }))}
                      />
                    </label>
                  ) : null}
                  <div className="grid grid-cols-2 gap-2.5">
                    <label className="block space-y-1.5">
                      <span className="text-[11.5px] text-muted-foreground/90">
                        {t("settings.memoryOrganizerScope")}
                      </span>
                      <DrawerSelect
                        value={settings.memory.organizerScope}
                        onValueChange={(next) => {
                          const organizerScope = next as MemoryOrganizerScope;
                          setSettings((prev) => updateMemorySettings(prev, { organizerScope }));
                        }}
                        ariaLabel={t("settings.memoryOrganizerScope")}
                        options={MEMORY_ORGANIZER_SCOPES.map((item) => ({
                          value: item.value,
                          label: t(item.labelKey),
                        }))}
                      />
                    </label>
                    <label className="block space-y-1.5">
                      <span className="text-[11.5px] text-muted-foreground/90">
                        {t("settings.memoryOrganizerMode")}
                      </span>
                      <DrawerSelect
                        value={settings.memory.organizerMode}
                        onValueChange={(next) => {
                          const organizerMode = next as MemoryOrganizerMode;
                          setSettings((prev) => updateMemorySettings(prev, { organizerMode }));
                        }}
                        ariaLabel={t("settings.memoryOrganizerMode")}
                        options={MEMORY_ORGANIZER_MODES.map((item) => ({
                          value: item.value,
                          label: t(item.labelKey),
                        }))}
                      />
                    </label>
                  </div>
                  {settings.memory.organizerEnabled && settings.memory.organizerNextRunAt ? (
                    <div className="flex items-center gap-2 rounded-xl border border-foreground/[0.05] bg-foreground/[0.025] px-3 py-2 text-[11.5px] text-muted-foreground">
                      <span className="relative inline-flex h-1.5 w-1.5 shrink-0">
                        <span className="absolute inset-0 animate-ping rounded-full bg-emerald-500/40" />
                        <span className="relative inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      </span>
                      <span className="font-medium text-foreground/75">
                        {t("settings.memoryOrganizerNextRun")}
                      </span>
                      <span className="ml-auto font-mono text-foreground/70">
                        {formatTime(settings.memory.organizerNextRunAt)}
                      </span>
                    </div>
                  ) : null}
                  {organizerFeedback ? (
                    <div className="whitespace-pre-wrap rounded-xl border border-foreground/[0.05] bg-foreground/[0.025] px-3 py-2 text-[11.5px] text-muted-foreground">
                      {organizerFeedback}
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="flex gap-2 px-0.5 pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="flex-1 border border-foreground/[0.07] bg-white/45 backdrop-blur hover:bg-white/70 dark:bg-white/[0.035] dark:hover:bg-white/[0.07]"
                  onClick={() => setHistoryOpen(true)}
                >
                  <History className="h-3.5 w-3.5" />
                  {t("settings.memoryOrganizerHistory")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="flex-1 shadow-[0_1px_2px_rgba(15,23,42,0.08),0_4px_10px_-6px_rgba(15,23,42,0.18)]"
                  disabled={!settings.memory.organizerModel || organizerSubmitting}
                  onClick={handleRunNow}
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${organizerSubmitting ? "animate-spin" : ""}`}
                  />
                  {t("settings.memoryOrganizerRunNow")}
                </Button>
              </div>
            </section>

            <section className="space-y-2">
              <div className="flex items-center gap-1.5 px-1 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-destructive/75">
                <AlertTriangle className="h-3 w-3" />
                {t("settings.memorySettingsDangerZone")}
              </div>
              <div className="rounded-2xl border border-destructive/15 bg-destructive/[0.025] p-4 backdrop-blur-md">
                <div className="text-[11.5px] leading-relaxed text-muted-foreground">
                  {t("settings.memorySettingsWipeDescription")}
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  className="mt-3 w-full"
                  onClick={() => setDrawerWipeConfirmOpen(true)}
                  disabled={saving}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("settings.memoryWipeAll")}
                </Button>
              </div>
            </section>
          </div>
        </div>
      </aside>
      {historyOpen ? (
        <OrganizerHistoryModal
          t={t}
          workdir={workdir}
          onClose={() => setHistoryOpen(false)}
          onMemoryChanged={onMemoryChanged}
        />
      ) : null}
      {drawerWipeConfirmOpen ? (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="memory-drawer-wipe-confirm-title"
        >
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setDrawerWipeConfirmOpen(false)}
          />
          <div className="relative z-10 w-full max-w-md overflow-hidden rounded-xl border bg-background shadow-2xl">
            <div className="flex items-start gap-3 border-b px-5 py-4">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-destructive/10">
                <AlertTriangle className="h-4 w-4 text-destructive" />
              </div>
              <div className="min-w-0 flex-1">
                <div id="memory-drawer-wipe-confirm-title" className="text-sm font-semibold">
                  {t("settings.memoryWipeConfirmTitle")}
                </div>
                <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {t("settings.memoryWipeConfirmDescription")}
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDrawerWipeConfirmOpen(false)}
                disabled={saving}
              >
                {t("settings.memoryCancel")}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  setDrawerWipeConfirmOpen(false);
                  void onRequestWipe();
                }}
                disabled={saving}
              >
                {t("settings.memoryWipeAll")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
