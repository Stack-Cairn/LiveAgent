import {
  type AppSettings,
  type ProjectPromptStrategy,
  type WorkspaceProject,
  workspaceProjectPathKey,
} from "@liveagent/app/lib/settings";
import { BookOpen, Check, Loader2 } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { Textarea } from "@liveagent/ui/components/ui/textarea";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useState } from "react";

export type ProjectPromptDraft = {
  projectPrompt: string;
  projectPromptStrategy: ProjectPromptStrategy;
};

export function ProjectPromptSettingsPanel(props: {
  projectPrompt: string;
  strategy: ProjectPromptStrategy;
  onProjectPromptChange: (value: string) => void;
  onStrategyChange: (value: ProjectPromptStrategy) => void;
  className?: string;
}) {
  const { projectPrompt, strategy, onProjectPromptChange, onStrategyChange, className } = props;
  const { t } = useLocale();

  return (
    <section className={cn("flex min-h-full flex-col p-6 max-[720px]:p-4", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h3 className="text-base font-semibold">{t("chat.projectPromptTitle")}</h3>
        <fieldset className="flex h-8 shrink-0 items-center gap-0.5 rounded-lg border border-border/60 bg-muted/40 p-0.5">
          <legend className="sr-only">{t("chat.projectPromptStrategy")}</legend>
          {(["append", "replace"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={strategy === value}
              className={cn(
                "rounded-md px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
                strategy === value && "bg-background text-foreground shadow-sm",
              )}
              onClick={() => onStrategyChange(value)}
            >
              {t(value === "append" ? "chat.projectPromptAppend" : "chat.projectPromptReplace")}
            </button>
          ))}
        </fieldset>
      </div>
      {/* 只解释当前选中的组合策略，随切换实时更新。 */}
      <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
        {t(
          strategy === "append" ? "chat.projectPromptAppendHint" : "chat.projectPromptReplaceHint",
        )}
      </p>

      <Textarea
        value={projectPrompt}
        placeholder={t("chat.projectPromptPlaceholder")}
        aria-label={t("chat.projectPromptTitle")}
        className="mt-3 min-h-52 flex-1 resize-none overflow-y-auto rounded-xl p-4 font-mono text-[13px] leading-6"
        onChange={(event) => onProjectPromptChange(event.currentTarget.value)}
      />

      <div className="mt-2 flex items-baseline justify-between gap-3 px-1 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate">
          {projectPrompt ? null : t("chat.projectPromptContentHint")}
        </span>
        <span className="shrink-0 tabular-nums">
          {projectPrompt.length.toLocaleString()} {t("settings.agentsCharacters")}
        </span>
      </div>
    </section>
  );
}

export function ProjectPromptEditorModal(props: {
  project: WorkspaceProject;
  settings: AppSettings;
  onSave: (draft: ProjectPromptDraft) => void | Promise<void>;
  onClose: () => void;
}) {
  const { project, settings, onSave, onClose } = props;
  const { t } = useLocale();
  const pathKey = workspaceProjectPathKey(project.path);
  const saved = settings.system.workspaceResourceSettings[pathKey];
  const [projectPrompt, setProjectPrompt] = useState(saved?.projectPrompt ?? "");
  const [strategy, setStrategy] = useState<ProjectPromptStrategy>(
    saved?.projectPromptStrategy ?? "append",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        projectPrompt: projectPrompt.trim(),
        projectPromptStrategy: strategy,
      });
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent
        className="flex max-h-[90dvh] max-w-3xl flex-col p-0"
        closeDisabled={saving}
        closeLabel={t("window.close")}
        layout="fullscreen-mobile"
        showCloseButton
      >
        <DialogHeader className="flex-row items-center gap-3.5 px-6 py-5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-violet-500/20 bg-violet-500/10 text-violet-600 dark:text-violet-300">
            <BookOpen className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate">{t("chat.projectPromptTitle")}</DialogTitle>
            <p className="mt-0.5 truncate text-xs text-muted-foreground" title={project.path}>
              {project.name} · {project.path}
            </p>
          </div>
        </DialogHeader>

        <DialogBody className="flex flex-col p-0">
          <ProjectPromptSettingsPanel
            projectPrompt={projectPrompt}
            strategy={strategy}
            onProjectPromptChange={setProjectPrompt}
            onStrategyChange={setStrategy}
            className="px-6 py-5"
          />

          {error ? <p className="px-6 pb-4 text-xs text-destructive">{error}</p> : null}
        </DialogBody>

        <DialogFooter className="px-6">
          <DialogActions>
            <Button variant="outline" onClick={onClose} disabled={saving}>
              {t("chat.cancel")}
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving}>
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              {t("workspaceEditor.save")}
            </Button>
          </DialogActions>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
