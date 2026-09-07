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
    <section className="space-y-4 p-6 max-[720px]:p-4">
      <h3 className="text-sm font-semibold">{t("chat.workspaceSettingsGeneral")}</h3>

      <div className="overflow-hidden rounded-xl border border-border/60">
        <div className="flex items-center justify-between gap-3 px-3 py-2.5 max-[560px]:flex-col max-[560px]:items-stretch max-[560px]:gap-2">
          <label htmlFor="workspace-project-name" className="shrink-0 text-sm font-medium">
            {t("chat.workspaceSettingsProjectName")}
          </label>
          <div className="w-[280px] max-w-full max-[560px]:w-full">
            <Input
              id="workspace-project-name"
              value={projectName}
              onChange={(event) => onProjectNameChange(event.currentTarget.value)}
              disabled={!canRenameProject || saving}
              aria-invalid={projectNameInvalid || undefined}
              aria-describedby={
                projectNameInvalid ? "workspace-project-name-description" : undefined
              }
              className={cn(
                "h-8 shadow-none",
                projectNameInvalid && "border-destructive focus-visible:ring-destructive/20",
              )}
            />
            {/* 只在校验失败时出声。只读状态由 disabled 的输入框自己表达，再写一行
                字既冗余，又会把这一行撑得比同卡片里的其它行高。 */}
            {projectNameInvalid ? (
              <p
                id="workspace-project-name-description"
                className="mt-1.5 text-xs leading-5 text-destructive"
              >
                {t("chat.workspaceSettingsProjectNameRequired")}
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border/40 px-3 py-2.5">
          <span className="text-sm font-medium">{t("chat.workspaceSettingsProjectType")}</span>
          <Badge variant="muted">{projectKindLabel}</Badge>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border/40 px-3 py-2.5 max-[560px]:flex-col max-[560px]:items-stretch max-[560px]:gap-1.5">
          <span className="shrink-0 text-sm font-medium">
            {t("chat.workspaceSettingsPrimaryDirectory")}
          </span>
          <div className="flex min-w-0 items-center gap-1.5">
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

      <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
        <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {t("chat.workspaceSettingsPrimaryHint")}
      </p>
    </section>
  );
}
