import { useState } from "react";
import { createPortal } from "react-dom";
import { BookOpen, Check, FileText, ScrollText, X } from "../../components/icons";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Textarea } from "../../components/ui/textarea";
import { useLocale } from "../../i18n";
import type { AgentPromptTemplate } from "../../lib/settings";
import { useModalMotion } from "../../lib/shared/modalMotion";

type AgentPromptTemplateModalProps = {
  initialData?: AgentPromptTemplate;
  onSave: (data: Omit<AgentPromptTemplate, "id" | "enabled">) => void;
  onClose: () => void;
};

export function AgentPromptTemplateModal({
  initialData,
  onSave,
  onClose,
}: AgentPromptTemplateModalProps) {
  const { t } = useLocale();
  const [name, setName] = useState(initialData?.name ?? "");
  const [description, setDescription] = useState(initialData?.description ?? "");
  const [prompt, setPrompt] = useState(initialData?.prompt ?? "");
  const { isClosing, modalState, requestClose } = useModalMotion(onClose);

  const isEditing = Boolean(initialData);

  function handleSave() {
    const trimmedName = name.trim();
    const trimmedPrompt = prompt.trim();
    if (!trimmedName || !trimmedPrompt) return;

    onSave({
      name: trimmedName,
      description: description.trim(),
      prompt: trimmedPrompt,
    });
    requestClose();
  }

  return createPortal(
    <div
      className="settings-modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4"
      data-state={modalState}
      role="dialog"
      aria-modal="true"
      aria-labelledby="agent-prompt-editor-title"
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default bg-black/25 backdrop-blur-md dark:bg-black/50"
        onClick={requestClose}
        aria-label={t("settings.cancel")}
      />

      <div className="settings-modal-panel relative z-10 flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-[28px] border border-black/[0.07] bg-white/[0.93] shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_32px_80px_-24px_rgba(0,0,0,0.35)] backdrop-blur-2xl backdrop-saturate-150 dark:border-white/10 dark:bg-background/[0.93] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_32px_80px_-24px_rgba(0,0,0,0.7)]">
        <div className="settings-modal-header relative flex items-center gap-3.5 border-b border-black/[0.06] px-6 py-5 dark:border-white/[0.08]">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-black/[0.06] bg-white/80 text-foreground/70 shadow-sm dark:border-white/10 dark:bg-white/[0.07] dark:text-foreground/80">
            <ScrollText className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div id="agent-prompt-editor-title" className="truncate text-base font-semibold">
              {isEditing ? t("settings.agentsEdit") : t("settings.agentsAdd")}
            </div>
            <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {t("settings.agentsDesc")}
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

        <div className="settings-modal-body relative min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="grid items-stretch gap-4 md:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)]">
            <section className="flex min-h-0 flex-col rounded-2xl border border-black/[0.06] bg-white/[0.68] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)] dark:border-white/[0.08] dark:bg-white/[0.04] dark:shadow-none">
              <div className="mb-5 flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-black/[0.05] bg-white/80 text-muted-foreground dark:border-white/[0.08] dark:bg-white/[0.06] dark:text-foreground/70">
                  <BookOpen className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold">{t("settings.agentsTemplateDetails")}</h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {t("settings.agentsTemplateDetailsHint")}
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="agent-template-name" className="text-xs font-semibold">
                  {t("settings.agentsName")}
                  <span className="ml-1 text-muted-foreground/70">*</span>
                </Label>
                <Input
                  id="agent-template-name"
                  value={name}
                  placeholder={t("settings.agentsNamePlaceholder")}
                  className="h-10 rounded-xl border-black/[0.08] bg-white/80 px-3.5 dark:border-white/10 dark:bg-white/[0.05]"
                  onChange={(e) => setName(e.currentTarget.value)}
                />
              </div>

              <div className="mt-5 flex min-h-0 flex-1 flex-col gap-2">
                <Label htmlFor="agent-template-description" className="text-xs font-semibold">
                  {t("settings.agentsDescription")}
                </Label>
                <Textarea
                  id="agent-template-description"
                  value={description}
                  placeholder={t("settings.agentsDescriptionPlaceholder")}
                  className="h-32 min-h-[128px] flex-1 resize-none overflow-y-auto overscroll-contain rounded-xl border-black/[0.08] bg-white/80 px-3.5 py-3 leading-relaxed md:h-auto md:min-h-0 dark:border-white/10 dark:bg-white/[0.05]"
                  onChange={(e) => setDescription(e.currentTarget.value)}
                />
              </div>
            </section>

            <section className="flex min-h-0 flex-col rounded-2xl border border-black/[0.06] bg-white/[0.68] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)] md:min-h-[438px] dark:border-white/[0.08] dark:bg-white/[0.04] dark:shadow-none">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-black/[0.05] bg-white/80 text-muted-foreground dark:border-white/[0.08] dark:bg-white/[0.06] dark:text-foreground/70">
                    <FileText className="h-4 w-4" />
                  </div>
                  <div>
                    <Label htmlFor="agent-template-prompt" className="text-sm font-semibold">
                      {t("settings.agentsPrompt")}
                      <span className="ml-1 text-muted-foreground/70">*</span>
                    </Label>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {t("settings.agentsPromptHint")}
                    </p>
                  </div>
                </div>
                <span className="shrink-0 rounded-full border border-black/[0.05] bg-white/[0.72] px-2.5 py-1 text-[11px] tabular-nums text-muted-foreground dark:border-white/[0.08] dark:bg-white/[0.05]">
                  {prompt.length.toLocaleString()} {t("settings.agentsCharacters")}
                </span>
              </div>
              <Textarea
                id="agent-template-prompt"
                value={prompt}
                placeholder={t("settings.agentsPromptPlaceholder")}
                className="h-[320px] min-h-[320px] flex-1 resize-none overflow-y-auto overscroll-contain rounded-xl border-black/[0.08] bg-white/[0.72] p-4 font-mono text-[13px] leading-6 md:h-auto md:min-h-0 dark:border-white/10 dark:bg-black/25"
                onChange={(e) => setPrompt(e.currentTarget.value)}
              />
            </section>
          </div>
        </div>

        <div className="settings-modal-footer relative flex justify-end border-t border-black/[0.06] px-6 py-4 dark:border-white/[0.08]">
          <div className="settings-modal-actions flex w-full items-center justify-end sm:w-auto">
            <Button
              className="flex-1 rounded-xl px-5 shadow-sm sm:flex-none"
              onClick={handleSave}
              disabled={!name.trim() || !prompt.trim() || isClosing}
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
