import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocale } from "../../i18n";
import type { WorkspaceProject } from "../../lib/settings";
import { useModalMotion } from "../../lib/shared/modalMotion";
import {
  isWorkspacePromptImportFileName,
  mergeImportedWorkspacePrompt,
  normalizeImportedWorkspacePromptContent,
  type WorkspacePromptConfig,
  workspacePromptConfigFromProject,
  workspacePromptImportAcceptAttribute,
} from "../../lib/workspace-prompt/config";
import { Check, Loader2, Settings2, Upload, X } from "../icons";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

type ImportStatus =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "success"; fileName: string; truncated: boolean; appended: boolean }
  | { kind: "error"; messageKey: string };

type WorkspaceSettingsModalProps = {
  project: WorkspaceProject;
  onSave: (project: WorkspaceProject, config: WorkspacePromptConfig) => void;
  onClose: () => void;
};

function PromptToggle(props: { checked: boolean; title: string; onToggle: () => void }) {
  const { checked, title, onToggle } = props;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      aria-label={title}
      onClick={onToggle}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/30 ${
        checked ? "bg-sky-500" : "bg-muted-foreground/20 hover:bg-muted-foreground/30"
      }`}
    >
      <span
        className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
          checked ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </button>
  );
}

export function WorkspaceSettingsModal({ project, onSave, onClose }: WorkspaceSettingsModalProps) {
  const { t } = useLocale();
  const [config, setConfig] = useState<WorkspacePromptConfig>(() =>
    workspacePromptConfigFromProject(project),
  );
  const [importStatus, setImportStatus] = useState<ImportStatus>({ kind: "idle" });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { isClosing, modalState, requestClose } = useModalMotion(onClose);

  function handleSave() {
    onSave(project, {
      prompt: config.prompt.trim(),
      includeGlobalPrompt: config.includeGlobalPrompt,
      // Preserve any previously enabled auto-pickup for backward compatibility;
      // the UI now imports file content into the workspace prompt instead.
      includeProjectInstructions: config.includeProjectInstructions,
    });
    requestClose();
  }

  function handleImportClick() {
    if (importStatus.kind === "reading") return;
    fileInputRef.current?.click();
  }

  function handleImportFileSelected(file: File | undefined) {
    if (!file) return;
    if (!isWorkspacePromptImportFileName(file.name)) {
      setImportStatus({ kind: "error", messageKey: "chat.workspaceSettingsImportUnsupported" });
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setImportStatus({ kind: "reading" });
    const reader = new FileReader();
    reader.onload = () => {
      const raw = typeof reader.result === "string" ? reader.result : "";
      const normalized = normalizeImportedWorkspacePromptContent(raw);
      if (!normalized.ok) {
        setImportStatus({ kind: "error", messageKey: "chat.workspaceSettingsImportEmpty" });
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }

      setConfig((prev) => {
        const appended = prev.prompt.trim().length > 0;
        const nextPrompt = mergeImportedWorkspacePrompt(prev.prompt, normalized.content);
        setImportStatus({
          kind: "success",
          fileName: file.name,
          truncated: normalized.truncated,
          appended,
        });
        return { ...prev, prompt: nextPrompt };
      });
      if (fileInputRef.current) fileInputRef.current.value = "";
    };
    reader.onerror = () => {
      setImportStatus({ kind: "error", messageKey: "chat.workspaceSettingsImportFailed" });
      if (fileInputRef.current) fileInputRef.current.value = "";
    };
    reader.readAsText(file);
  }

  const importStatusNode =
    importStatus.kind === "reading" ? (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t("chat.workspaceSettingsImportReading")}
      </span>
    ) : importStatus.kind === "success" ? (
      <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
        <Check className="h-3 w-3" />
        {t(
          importStatus.appended
            ? "chat.workspaceSettingsImportAppended"
            : "chat.workspaceSettingsImportSuccess",
        ).replace("{file}", importStatus.fileName)}
        {importStatus.truncated ? ` ${t("chat.workspaceSettingsImportTruncated")}` : null}
      </span>
    ) : importStatus.kind === "error" ? (
      <span className="text-xs text-rose-600 dark:text-rose-400">{t(importStatus.messageKey)}</span>
    ) : null;

  return createPortal(
    <div
      className="settings-modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4"
      data-state={modalState}
      role="dialog"
      aria-modal="true"
      aria-labelledby="workspace-settings-title"
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default bg-black/25 backdrop-blur-md dark:bg-black/50"
        onClick={requestClose}
        aria-label={t("settings.cancel")}
      />

      <div className="settings-modal-panel relative z-10 flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-[28px] border border-black/[0.07] bg-white/[0.93] shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_32px_80px_-24px_rgba(0,0,0,0.35)] backdrop-blur-2xl backdrop-saturate-150 dark:border-white/10 dark:bg-background/[0.93] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_32px_80px_-24px_rgba(0,0,0,0.7)]">
        <div className="settings-modal-header relative flex items-center gap-3.5 border-b border-black/[0.06] px-6 py-5 dark:border-white/[0.08]">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-black/[0.06] bg-white/80 text-foreground/70 shadow-sm dark:border-white/10 dark:bg-white/[0.07] dark:text-foreground/80">
            <Settings2 className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div id="workspace-settings-title" className="truncate text-base font-semibold">
              {t("chat.workspaceSettings")}
            </div>
            <div className="mt-0.5 truncate text-xs leading-relaxed text-muted-foreground">
              {project.name} · {project.path}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0 rounded-full border border-black/[0.06] bg-black/[0.04] text-muted-foreground hover:bg-black/[0.08] hover:text-foreground dark:border-white/10 dark:bg-white/[0.06] dark:hover:bg-white/[0.12]"
            onClick={requestClose}
            aria-label={t("settings.cancel")}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="settings-modal-body relative min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <section className="flex min-h-0 flex-col rounded-2xl border border-black/[0.06] bg-white/[0.68] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)] dark:border-white/[0.08] dark:bg-white/[0.04] dark:shadow-none">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Label htmlFor="workspace-settings-prompt" className="text-sm font-semibold">
                  {t("chat.workspaceSettingsPromptLabel")}
                </Label>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {t("chat.workspaceSettingsPromptHint")}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 shrink-0 rounded-lg px-3 text-xs"
                onClick={handleImportClick}
                disabled={importStatus.kind === "reading" || isClosing}
              >
                {importStatus.kind === "reading" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                {t("chat.workspaceSettingsImportButton")}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept={workspacePromptImportAcceptAttribute()}
                className="hidden"
                onChange={(e) => handleImportFileSelected(e.currentTarget.files?.[0])}
              />
            </div>
            <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
              {t("chat.workspaceSettingsImportHint")}
            </p>
            <Textarea
              id="workspace-settings-prompt"
              value={config.prompt}
              placeholder={t("chat.workspaceSettingsPromptPlaceholder")}
              className="h-[200px] min-h-[200px] resize-none overflow-y-auto overscroll-contain rounded-xl border-black/[0.08] bg-white/[0.72] p-4 font-mono text-[13px] leading-6 dark:border-white/10 dark:bg-black/25"
              onChange={(e) => setConfig({ ...config, prompt: e.currentTarget.value })}
            />
            {importStatusNode ? <div className="mt-2 text-xs">{importStatusNode}</div> : null}
          </section>

          <section className="flex items-start justify-between gap-4 rounded-2xl border border-black/[0.06] bg-white/[0.68] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)] dark:border-white/[0.08] dark:bg-white/[0.04] dark:shadow-none">
            <div className="min-w-0">
              <div className="text-sm font-semibold">
                {t("chat.workspaceSettingsIncludeGlobal")}
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {t("chat.workspaceSettingsIncludeGlobalDesc")}
              </p>
            </div>
            <PromptToggle
              checked={config.includeGlobalPrompt}
              title={t("chat.workspaceSettingsIncludeGlobal")}
              onToggle={() =>
                setConfig({ ...config, includeGlobalPrompt: !config.includeGlobalPrompt })
              }
            />
          </section>
        </div>

        <div className="settings-modal-footer relative flex justify-end border-t border-black/[0.06] px-6 py-4 dark:border-white/[0.08]">
          <div className="settings-modal-actions flex w-full items-center justify-end sm:w-auto">
            <Button
              className="flex-1 rounded-xl px-5 shadow-sm sm:flex-none"
              onClick={handleSave}
              disabled={isClosing}
            >
              <Check className="h-3.5 w-3.5" />
              {t("settings.save")}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
