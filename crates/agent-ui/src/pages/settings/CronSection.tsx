import { useDirectoryPicker } from "@liveagent/adapters/directoryPicker";
import { isAgentExecutionMode, workspaceProjectPathKey } from "@liveagent/app/lib/settings";
import type { SettingsSectionProps } from "@liveagent/app/pages/settings/types";
import {
  AlertTriangle,
  Clock3,
  Eye,
  Plus,
  SquarePen,
  Trash2,
} from "@liveagent/ui/components/IconSet";
import { SettingsSection } from "@liveagent/ui/components/settings/SettingsLayout";
import { SettingsNotice } from "@liveagent/ui/components/settings/SettingsNotice";
import { Badge } from "@liveagent/ui/components/ui/badge";
import { Button } from "@liveagent/ui/components/ui/button";
import { EmptyState } from "@liveagent/ui/components/ui/empty-state";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  applyCronOps,
  type CronTask,
  type CronTaskType,
  useAutomation,
} from "@liveagent/ui/lib/automation/index";
import { buildModelOptions } from "@liveagent/ui/lib/models/modelOptions";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { type CronTaskFormData, CronTaskModal } from "@liveagent/ui/pages/settings/CronTaskModal";
import { CronTaskViewModal } from "@liveagent/ui/pages/settings/CronTaskViewModal";
import { AgentActivationSwitch, ConfirmDeletePopover } from "@liveagent/ui/pages/settings/shared";
import { useMemo, useState } from "react";

const TASK_TYPE_LABEL: Record<CronTaskType, string> = {
  bash: "settings.cronTypeBash",
  http: "settings.cronTypeHttp",
  prompt: "settings.cronTypePrompt",
};

type ModalState =
  | { open: false }
  | { open: true; mode: "add" | "edit"; task?: CronTask }
  | { open: true; mode: "view"; taskId: string };

function isCronTaskExhausted(task: CronTask) {
  return task.remainingExecutions === 0;
}

function formatRemainingExecutionsLabel(t: (key: string) => string, task: CronTask) {
  return task.remainingExecutions == null
    ? t("settings.cronRemainingExecutionsUnlimited")
    : `${task.remainingExecutions} ${t("settings.cronRemainingExecutionsUnit")}`;
}

export function CronSection(props: SettingsSectionProps) {
  const { settings } = props;
  const { t } = useLocale();
  const [modal, setModal] = useState<ModalState>({ open: false });
  const [actionError, setActionError] = useState<string | null>(null);
  const { pickDirectory, directoryPickerElement } = useDirectoryPicker();
  const { cron } = useAutomation();
  const tasks = cron.tasks;
  const autoPromptSupported = isAgentExecutionMode(settings.system.executionMode);
  const modelOptions = useMemo(
    () =>
      buildModelOptions(settings).map((option) => ({
        value: option.value,
        label: option.label,
        providerName: option.providerName,
        providerId: option.providerId,
        providerType: option.providerType,
      })),
    [settings],
  );
  // Archived/hidden workspaces are not offered for pinning; a task already
  // pinned to one keeps its path (the modal shows it as unavailable).
  const workspaceOptions = useMemo(() => {
    const excludedPathKeys = new Set(
      [
        ...settings.system.archivedWorkspaceProjectPaths,
        ...settings.system.hiddenWorkspaceProjectPaths,
      ].map(workspaceProjectPathKey),
    );
    return settings.system.workspaceProjects
      .filter((project) => !excludedPathKeys.has(workspaceProjectPathKey(project.path)))
      .map((project) => ({ path: project.path, name: project.name || project.path }));
  }, [settings]);

  function runOps(run: () => Promise<unknown>) {
    setActionError(null);
    void run().catch((error) => {
      setActionError(error instanceof Error ? error.message : String(error));
    });
  }

  async function handleAdd(data: CronTaskFormData) {
    setActionError(null);
    await applyCronOps([{ op: "create", item: { ...data, enabled: true } }]);
    setModal({ open: false });
  }

  async function handleEdit(data: CronTaskFormData) {
    if (!modal.open || modal.mode !== "edit" || !modal.task) return;
    setActionError(null);
    await applyCronOps([{ op: "update", id: modal.task.id, patch: { ...data } }]);
    setModal({ open: false });
  }

  function handleDelete(id: string) {
    runOps(() => applyCronOps([{ op: "delete", id }]));
  }

  async function pickWorkdirDirectory(initialWorkdir: string): Promise<string | null> {
    return await pickDirectory(initialWorkdir);
  }

  function handleToggle(task: CronTask) {
    if (isCronTaskExhausted(task)) return;
    runOps(() => applyCronOps([{ op: "update", id: task.id, patch: { enabled: !task.enabled } }]));
  }

  const enabledCount = tasks.filter((task) => task.enabled).length;

  return (
    <div className="space-y-5">
      <SettingsSection
        description={t("settings.cronDesc")}
        actions={
          tasks.length > 0 ? (
            <>
              <div
                className={cn(
                  "flex shrink-0 items-center gap-2",
                  "whitespace-nowrap rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground",
                )}
              >
                <span className="tabular-nums font-medium text-foreground">{tasks.length}</span>
                {t("settings.cronCount")}
                <span className="text-border">|</span>
                <span className="flex items-center gap-1">
                  <span className="tabular-nums font-medium text-foreground">{enabledCount}</span>
                </span>
              </div>

              <Button
                size="sm"
                className="gap-1.5"
                onClick={() => setModal({ open: true, mode: "add" })}
              >
                <Plus className="size-3.5" />
                {t("settings.cronAdd")}
              </Button>
            </>
          ) : undefined
        }
      />

      {!autoPromptSupported ? (
        <div
          className={cn(
            "rounded-xl border border-amber-500/20 bg-amber-500/[0.05] px-4 py-3",
            "text-xs leading-relaxed text-amber-700 dark:text-amber-300",
          )}
        >
          {t("settings.cronPromptAgentModeOnlyHint")}
        </div>
      ) : null}

      {actionError ? (
        <SettingsNotice variant="action-error">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{actionError}</span>
        </SettingsNotice>
      ) : null}

      {/* Task List */}
      {tasks.length === 0 ? (
        <EmptyState variant="settings" className="min-h-56 justify-center gap-4 px-6 py-8">
          <div className="space-y-2">
            <h2 className="text-sm font-medium text-foreground">{t("settings.cronEmpty")}</h2>
            <p className="text-sm text-muted-foreground">{t("settings.cronEmptyDesc")}</p>
          </div>
          <Button size="sm" onClick={() => setModal({ open: true, mode: "add" })} className="gap-2">
            <Plus className="size-4" />
            {t("settings.cronAdd")}
          </Button>
        </EmptyState>
      ) : (
        <div className="space-y-2">
          {tasks.map((task) => {
            const exhausted = isCronTaskExhausted(task);
            const switchTitle = exhausted
              ? t("settings.cronRemainingExecutionsEditRequired")
              : task.enabled
                ? t("settings.cronDisable")
                : t("settings.cronEnable");

            return (
              <div key={task.id} className={cn("group rounded-xl bg-settings-tile")}>
                <div className="settings-card-row flex items-center gap-3 px-4 py-3">
                  {/* Content */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setModal({ open: true, mode: "view", taskId: task.id })}
                        className="truncate text-left text-sm font-medium text-foreground cursor-pointer hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {task.name}
                      </button>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {t(TASK_TYPE_LABEL[task.type])}
                      </span>
                      {task.lastError ? (
                        <Badge size="compact" variant="destructive" title={task.lastError}>
                          <AlertTriangle className="size-2.5" />
                          {t("settings.cronScheduleError")}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {task.description}
                    </p>
                  </div>

                  {/* Cron Expression - fixed width for alignment */}
                  <div
                    className={cn(
                      "hidden shrink-0 items-center justify-center gap-1.5",
                      "px-2.5 py-1 text-xs text-muted-foreground md:flex",
                    )}
                  >
                    <Clock3 className="size-3 shrink-0" />
                    <span className="font-mono">{task.cron}</span>
                  </div>
                  <div
                    className={cn(
                      "hidden w-74px shrink-0 items-center justify-center gap-1 rounded-full",
                      "px-2 py-1 text-xs font-medium md:flex",
                      exhausted
                        ? "bg-destructive/10 text-destructive"
                        : task.remainingExecutions == null
                          ? "bg-muted text-muted-foreground"
                          : "bg-muted text-muted-foreground",
                    )}
                    title={formatRemainingExecutionsLabel(t, task)}
                  >
                    <span className="tabular-nums">
                      {task.remainingExecutions == null ? "∞" : task.remainingExecutions}
                    </span>
                    {task.remainingExecutions == null ? null : (
                      <span>{t("settings.cronRemainingExecutionsUnitShort")}</span>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      type="button"
                      onClick={() => setModal({ open: true, mode: "view", taskId: task.id })}
                      aria-label={t("settings.cronView")}
                    >
                      <Eye className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      type="button"
                      onClick={() => setModal({ open: true, mode: "edit", task })}
                      aria-label={t("settings.cronEdit")}
                    >
                      <SquarePen className="size-3.5" />
                    </Button>
                    <ConfirmDeletePopover name={task.name} onConfirm={() => handleDelete(task.id)}>
                      {(open) => (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          type="button"
                          onClick={open}
                          aria-label={t("settings.cronDelete")}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      )}
                    </ConfirmDeletePopover>
                  </div>

                  {/* Enable/Disable Switch */}
                  <span className="inline-flex" title={switchTitle}>
                    <AgentActivationSwitch
                      checked={task.enabled}
                      disabled={exhausted}
                      title={switchTitle}
                      onToggle={() => handleToggle(task)}
                    />
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Edit/Add Modal */}
      {modal.open && modal.mode !== "view" ? (
        <CronTaskModal
          mode={modal.mode}
          initialData={modal.task}
          modelOptions={modelOptions}
          providers={settings.customProviders}
          workspaceOptions={workspaceOptions}
          executionMode={settings.system.executionMode}
          onPickWorkdir={pickWorkdirDirectory}
          onSave={modal.mode === "add" ? handleAdd : handleEdit}
          onClose={() => setModal({ open: false })}
        />
      ) : null}

      {/* View Modal */}
      {modal.open && modal.mode === "view" ? (
        <CronTaskViewModal taskId={modal.taskId} onClose={() => setModal({ open: false })} />
      ) : null}
      {directoryPickerElement}
    </div>
  );
}
