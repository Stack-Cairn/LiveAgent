import type { WorkspaceProject } from "@liveagent/app/lib/settings";
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
      <div className="flex gap-3 rounded-xl border border-border/60 bg-muted/20 p-4">
        <Shield className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-xs leading-5 text-muted-foreground">
          {t("chat.workspaceSettingsPrimaryHint")}
        </p>
      </div>
    </section>
  );
}
