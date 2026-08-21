import {
  type AppSettings,
  type ProjectPromptStrategy,
  type WorkspaceProject,
  workspaceProjectPathKey,
} from "@liveagent/app/lib/settings";
import { BookOpen, Check, FileText, Layers, Loader2 } from "@liveagent/ui/components/IconSet";
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
}) {
  const { projectPrompt, strategy, onProjectPromptChange, onStrategyChange } = props;
  const { t } = useLocale();

  return (
    <>
      <section>
        <div className="mb-3 flex items-start gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
            <Layers className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">{t("chat.projectPromptStrategy")}</h3>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              {t("chat.projectPromptStrategyHint")}
            </p>
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {(["append", "replace"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={strategy === value}
              className={cn(
                "min-h-20 rounded-xl border px-4 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                strategy === value
                  ? "border-violet-500/40 bg-violet-500/[0.07]"
                  : "border-border/60 bg-card hover:border-border",
              )}
              onClick={() => onStrategyChange(value)}
            >
              <span className="flex items-center justify-between gap-3 text-sm font-medium">
                {t(value === "append" ? "chat.projectPromptAppend" : "chat.projectPromptReplace")}
                <span
                  className={cn(
                    "flex h-4 w-4 items-center justify-center rounded-full border",
                    strategy === value
                      ? "border-violet-500 bg-violet-500 text-white"
                      : "border-border",
                  )}
                >
                  {strategy === value ? <Check className="h-3 w-3" /> : null}
                </span>
              </span>
              <span className="mt-1.5 block text-xs leading-5 text-muted-foreground">
                {t(
                  value === "append"
                    ? "chat.projectPromptAppendHint"
                    : "chat.projectPromptReplaceHint",
                )}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-border/60 bg-card p-4 shadow-xs">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
              <FileText className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold">{t("chat.projectPromptContent")}</h3>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                {t("chat.projectPromptContentHint")}
              </p>
            </div>
          </div>
          <span className="shrink-0 rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-xs tabular-nums text-muted-foreground">
            {projectPrompt.length.toLocaleString()} {t("settings.agentsCharacters")}
          </span>
        </div>
        <Textarea
          value={projectPrompt}
          placeholder={t("chat.projectPromptPlaceholder")}
          className="h-64 min-h-64 resize-none overflow-y-auto p-4 font-mono text-[13px] leading-6"
          onChange={(event) => onProjectPromptChange(event.currentTarget.value)}
        />
      </section>
    </>
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

        <DialogBody className="space-y-5 overflow-y-auto px-6 py-5">
          <ProjectPromptSettingsPanel
            projectPrompt={projectPrompt}
            strategy={strategy}
            onProjectPromptChange={setProjectPrompt}
            onStrategyChange={setStrategy}
          />

          {error ? <p className="text-xs text-destructive">{error}</p> : null}
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
