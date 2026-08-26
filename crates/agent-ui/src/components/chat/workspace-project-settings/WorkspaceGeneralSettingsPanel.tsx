import type { WorkspaceProject } from "@liveagent/app/lib/settings";
import { Badge } from "@liveagent/ui/components/ui/badge";
import { CopyButton } from "@liveagent/ui/components/ui/copy-button";
import { Input } from "@liveagent/ui/components/ui/input";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { Shield } from "../../IconSet";

export function WorkspaceGeneralSettingsPanel(props: {
  project: WorkspaceProject;
  projectKindLabel: string;
  projectName: string;
  canRenameProject: boolean;
  projectNameInvalid: boolean;
  saving: boolean;
  onProjectNameChange: (name: string) => void;
}) {
  const {
    project,
    projectKindLabel,
    projectName,
    canRenameProject,
    projectNameInvalid,
    saving,
    onProjectNameChange,
  } = props;
  const { t } = useLocale();

  return (
    <section className="mx-auto max-w-[640px] space-y-4 p-6 max-[720px]:p-4">
      <h3 className="text-base font-semibold">{t("chat.workspaceSettingsGeneral")}</h3>

      <div className="overflow-hidden rounded-xl border border-border/60">
        <div className="flex items-center justify-between gap-6 px-4 py-3 max-[560px]:flex-col max-[560px]:items-stretch max-[560px]:gap-2">
          <label htmlFor="workspace-project-name" className="shrink-0 text-[13px] font-medium">
            {t("chat.workspaceSettingsProjectName")}
          </label>
          <div className="w-[300px] max-w-full max-[560px]:w-full">
            <Input
              id="workspace-project-name"
              value={projectName}
              onChange={(event) => onProjectNameChange(event.currentTarget.value)}
              disabled={!canRenameProject || saving}
              aria-invalid={projectNameInvalid || undefined}
              aria-describedby={
                projectNameInvalid || !canRenameProject
                  ? "workspace-project-name-description"
                  : undefined
              }
              className={cn(
                "h-9 text-sm",
                projectNameInvalid && "border-destructive focus-visible:ring-destructive/20",
              )}
            />
            {/* 仅在出错或只读时展示辅助文字，正常状态保持安静。 */}
            {projectNameInvalid || !canRenameProject ? (
              <p
                id="workspace-project-name-description"
                className={cn(
                  "mt-1.5 text-[11px] leading-4 text-muted-foreground",
                  projectNameInvalid && "text-destructive",
                )}
              >
                {projectNameInvalid
                  ? t("chat.workspaceSettingsProjectNameRequired")
                  : t("chat.workspaceSettingsProjectNameReadonly")}
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex items-center justify-between gap-6 border-t border-border/50 px-4 py-3">
          <span className="text-[13px] font-medium">{t("chat.workspaceSettingsProjectType")}</span>
          <Badge variant="muted">{projectKindLabel}</Badge>
        </div>

        <div className="flex items-center justify-between gap-6 border-t border-border/50 px-4 py-3 max-[560px]:flex-col max-[560px]:items-stretch max-[560px]:gap-1.5">
          <span className="shrink-0 text-[13px] font-medium">
            {t("chat.workspaceSettingsPrimaryDirectory")}
          </span>
          <div className="flex min-w-0 items-center gap-0.5">
            <span
              className="min-w-0 truncate font-mono text-xs text-muted-foreground"
              title={project.path}
            >
              {project.path}
            </span>
            <CopyButton
              value={project.path}
              label={t("chat.copy")}
              copiedLabel={t("chat.markdown.copied")}
            />
          </div>
        </div>
      </div>

      <p className="flex items-start gap-2 px-1 text-xs leading-5 text-muted-foreground">
        <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {t("chat.workspaceSettingsPrimaryHint")}
      </p>
    </section>
  );
}
