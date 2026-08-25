import type { WorkspaceProject } from "@liveagent/app/lib/settings";
import { Button } from "@liveagent/ui/components/ui/button";
import { Input } from "@liveagent/ui/components/ui/input";
import { Switch } from "@liveagent/ui/components/ui/switch";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  type CodeIndexJobSnapshot,
  type CodeIndexStatus,
  codeIndexJobCancel,
  codeIndexRebuild,
  codeIndexStatus,
  formatCodeIndexDbSize,
} from "@liveagent/ui/lib/codeIndex/api";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Shield } from "../../IconSet";

const JOB_POLL_INTERVAL_MS = 1500;

function jobIsActive(job: CodeIndexJobSnapshot | null | undefined): job is CodeIndexJobSnapshot {
  return Boolean(job && !job.finishedAt);
}

/** 代码索引状态区（docs/design/code-index.md §9）。开关是 modal 的 draft 状态，
 * enable/disable 在保存时生效；这里负责状态展示、job 轮询与重建/取消。 */
function CodeIndexSection(props: {
  project: WorkspaceProject;
  codeIndexEnabled: boolean;
  saving: boolean;
  onCodeIndexEnabledChange: (enabled: boolean) => void;
}) {
  const { project, codeIndexEnabled, saving, onCodeIndexEnabledChange } = props;
  const { t } = useLocale();
  const [status, setStatus] = useState<CodeIndexStatus | null>(null);
  // WebUI 等未接通 code_index_* 的宿主：状态查询抛错 → 展示桌面端提示。
  const [unavailable, setUnavailable] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await codeIndexStatus(project.path);
      setStatus(next);
      setUnavailable(false);
      return next;
    } catch {
      setUnavailable(true);
      return null;
    }
  }, [project.path]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const next = await refreshStatus();
      if (cancelled) return;
      if (jobIsActive(next?.activeJob)) {
        pollTimer.current = setTimeout(tick, JOB_POLL_INTERVAL_MS);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [refreshStatus]);

  const activeJob = jobIsActive(status?.activeJob) ? status?.activeJob : null;

  const handleRebuild = async () => {
    setActionError(null);
    try {
      await codeIndexRebuild(project.path);
      await refreshStatus();
      // 起轮询：重建 job 进行中。
      if (pollTimer.current) clearTimeout(pollTimer.current);
      const tick = async () => {
        const next = await refreshStatus();
        if (jobIsActive(next?.activeJob)) {
          pollTimer.current = setTimeout(tick, JOB_POLL_INTERVAL_MS);
        }
      };
      pollTimer.current = setTimeout(tick, JOB_POLL_INTERVAL_MS);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleCancelJob = async () => {
    if (!activeJob) return;
    setActionError(null);
    try {
      await codeIndexJobCancel(activeJob.jobId);
      await refreshStatus();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const statusLine = (() => {
    if (unavailable) return t("chat.workspaceSettingsCodeIndexDesktopOnly");
    if (activeJob) {
      if (activeJob.phase === "downloading-model") {
        return t("chat.workspaceSettingsCodeIndexPhaseDownloading");
      }
      if (activeJob.phase === "walking" || activeJob.phase === "queued") {
        return t("chat.workspaceSettingsCodeIndexPhaseWalking");
      }
      return t("chat.workspaceSettingsCodeIndexIndexing")
        .replace("{processed}", String(activeJob.processedFiles))
        .replace("{total}", String(activeJob.totalFiles));
    }
    if (status?.activeJob?.phase === "error" && status.activeJob.error) {
      return t("chat.workspaceSettingsCodeIndexError").replace("{error}", status.activeJob.error);
    }
    if (status?.indexed) {
      return t("chat.workspaceSettingsCodeIndexStats")
        .replace("{fileCount}", String(status.fileCount))
        .replace("{chunkCount}", String(status.chunkCount))
        .replace("{size}", formatCodeIndexDbSize(status.dbSizeBytes));
    }
    return t("chat.workspaceSettingsCodeIndexDisabledHint");
  })();

  return (
    <div className="overflow-hidden rounded-xl border border-border/60">
      <div className="flex items-start justify-between gap-4 border-b border-border/50 px-4 py-3.5">
        <div className="min-w-0">
          <div className="text-sm font-medium">{t("chat.workspaceSettingsCodeIndexTitle")}</div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t("chat.workspaceSettingsCodeIndexDescription")}
          </p>
        </div>
        <Switch
          checked={codeIndexEnabled}
          disabled={saving || unavailable}
          onCheckedChange={onCodeIndexEnabledChange}
          aria-label={t("chat.workspaceSettingsCodeIndexToggle")}
        />
      </div>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div
          className={cn(
            "flex min-w-0 items-center gap-2 text-xs leading-5 text-muted-foreground",
            actionError && "text-destructive",
          )}
        >
          {activeJob ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : null}
          <span className="min-w-0 break-words">{actionError ?? statusLine}</span>
        </div>
        {!unavailable && activeJob ? (
          <Button variant="outline" size="sm" onClick={handleCancelJob}>
            {t("chat.workspaceSettingsCodeIndexCancel")}
          </Button>
        ) : null}
        {!unavailable && !activeJob && status?.indexed ? (
          <Button variant="outline" size="sm" disabled={saving} onClick={handleRebuild}>
            {t("chat.workspaceSettingsCodeIndexRebuild")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function WorkspaceGeneralSettingsPanel(props: {
  project: WorkspaceProject;
  projectKindLabel: string;
  projectName: string;
  canRenameProject: boolean;
  projectNameInvalid: boolean;
  saving: boolean;
  onProjectNameChange: (name: string) => void;
  codeIndexEnabled: boolean;
  onCodeIndexEnabledChange: (enabled: boolean) => void;
}) {
  const {
    project,
    projectKindLabel,
    projectName,
    canRenameProject,
    projectNameInvalid,
    saving,
    onProjectNameChange,
    codeIndexEnabled,
    onCodeIndexEnabledChange,
  } = props;
  const { t } = useLocale();

  return (
    <section className="mx-auto max-w-[680px] space-y-6 p-6 max-[720px]:p-4">
      <div>
        <h3 className="text-base font-semibold">{t("chat.workspaceSettingsGeneral")}</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {t("chat.workspaceSettingsGeneralDescription")}
        </p>
      </div>
      <div className="overflow-hidden rounded-xl border border-border/60">
        <div className="grid grid-cols-[140px_minmax(0,1fr)] items-start gap-4 border-b border-border/50 px-4 py-3.5 max-[520px]:grid-cols-1 max-[520px]:gap-2">
          <div className="pt-2 text-xs font-medium text-muted-foreground max-[520px]:pt-0">
            {t("chat.workspaceSettingsProjectName")}
          </div>
          <div className="min-w-0">
            <Input
              value={projectName}
              onChange={(event) => onProjectNameChange(event.currentTarget.value)}
              disabled={!canRenameProject || saving}
              aria-invalid={projectNameInvalid || undefined}
              aria-describedby="workspace-project-name-description"
              className={cn(
                "h-9 text-sm font-medium",
                projectNameInvalid && "border-destructive focus-visible:ring-destructive/20",
              )}
            />
            <p
              id="workspace-project-name-description"
              className={cn(
                "mt-1.5 text-[11px] leading-4 text-muted-foreground",
                projectNameInvalid && "text-destructive",
              )}
            >
              {projectNameInvalid
                ? t("chat.workspaceSettingsProjectNameRequired")
                : canRenameProject
                  ? t("chat.workspaceSettingsProjectNameDescription")
                  : t("chat.workspaceSettingsProjectNameReadonly")}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4 border-b border-border/50 px-4 py-3.5 max-[520px]:grid-cols-1 max-[520px]:gap-1">
          <div className="text-xs font-medium text-muted-foreground">
            {t("chat.workspaceSettingsProjectType")}
          </div>
          <div className="text-sm">{projectKindLabel}</div>
        </div>
        <div className="grid grid-cols-[140px_minmax(0,1fr)] items-start gap-4 px-4 py-3.5 max-[520px]:grid-cols-1 max-[520px]:gap-1">
          <div className="text-xs font-medium text-muted-foreground">
            {t("chat.workspaceSettingsPrimaryDirectory")}
          </div>
          <div className="break-all font-mono text-xs leading-5">{project.path}</div>
        </div>
      </div>
      <CodeIndexSection
        project={project}
        codeIndexEnabled={codeIndexEnabled}
        saving={saving}
        onCodeIndexEnabledChange={onCodeIndexEnabledChange}
      />
      <div className="flex gap-3 rounded-xl border border-border/60 bg-muted/20 p-4">
        <Shield className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-xs leading-5 text-muted-foreground">
          {t("chat.workspaceSettingsPrimaryHint")}
        </p>
      </div>
    </section>
  );
}
