import { useState } from "react";
import { createPortal } from "react-dom";
import { BookOpen, Eye, FileText, Pencil, Plus, Trash2, X } from "../../components/icons";

import { Button } from "../../components/ui/button";
import { useLocale } from "../../i18n";
import { type AgentPromptTemplate, updateAgents } from "../../lib/settings";
import { createUuid } from "../../lib/shared/id";
import { useModalMotion } from "../../lib/shared/modalMotion";
import { AgentPromptTemplateModal } from "./AgentPromptTemplateModal";
import { AgentActivationSwitch, ConfirmDeletePopover } from "./shared";
import type { SettingsSectionProps } from "./types";

export function AgentsSection(props: SettingsSectionProps) {
  const { settings, setSettings } = props;
  const { t } = useLocale();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<AgentPromptTemplate | null>(null);
  const [viewingTemplate, setViewingTemplate] = useState<AgentPromptTemplate | null>(null);

  function openAdd() {
    setEditingTemplate(null);
    setModalOpen(true);
  }

  function openEdit(template: AgentPromptTemplate) {
    setEditingTemplate(template);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditingTemplate(null);
  }

  function handleSave(data: Omit<AgentPromptTemplate, "id" | "enabled">) {
    setSettings((prev) => {
      if (editingTemplate) {
        return updateAgents(
          prev,
          prev.agents.map((template) =>
            template.id === editingTemplate.id ? { ...template, ...data } : template,
          ),
        );
      }

      const newTemplate: AgentPromptTemplate = {
        id: createUuid(),
        ...data,
        enabled: false,
      };
      return updateAgents(prev, [...prev.agents, newTemplate]);
    });
  }

  function handleDelete(id: string) {
    setSettings((prev) =>
      updateAgents(
        prev,
        prev.agents.filter((template) => template.id !== id),
      ),
    );
  }

  function handleToggleEnabled(id: string) {
    setSettings((prev) =>
      updateAgents(
        prev,
        prev.agents.map((template) => {
          if (template.id === id) {
            return { ...template, enabled: !template.enabled };
          }
          return template.enabled ? { ...template, enabled: false } : template;
        }),
      ),
    );
  }

  const templates = settings.agents;
  const enabledCount = templates.filter((template) => template.enabled).length;

  return (
    <>
      <div className="space-y-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-500/10">
              <BookOpen className="h-[18px] w-[18px] text-sky-500" />
            </div>
            <div>
              <h3 className="text-sm font-semibold">{t("settings.agentsTitle")}</h3>
              <p className="text-xs text-muted-foreground">{t("settings.agentsDesc")}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {templates.length > 0 ? (
              <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground">
                <span className="tabular-nums font-medium text-foreground">{templates.length}</span>
                {t("settings.agentsCount")}
                {enabledCount > 0 ? (
                  <>
                    <span className="text-border">|</span>
                    <span className="flex items-center gap-1">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      <span className="tabular-nums font-medium text-emerald-600 dark:text-emerald-400">
                        {enabledCount}
                      </span>
                      {t("settings.agentsActive")}
                    </span>
                  </>
                ) : null}
              </div>
            ) : null}
            <Button variant="outline" size="sm" className="gap-1.5" onClick={openAdd}>
              <Plus className="h-3.5 w-3.5" />
              {t("settings.agentsAdd")}
            </Button>
          </div>
        </div>

        {templates.length === 0 ? (
          <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-border/60 bg-muted/20 py-14 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-sky-500/10">
              <BookOpen className="h-6 w-6 text-sky-400" />
            </div>
            <div className="space-y-1.5">
              <p className="text-sm font-medium text-foreground">
                {t("settings.agentsNoTemplates")}
              </p>
              <p className="mx-auto max-w-xs text-xs leading-relaxed text-muted-foreground">
                {t("settings.agentsNoTemplatesHint")}
              </p>
            </div>
            <Button size="sm" className="mt-1 gap-1.5" onClick={openAdd}>
              <Plus className="h-3.5 w-3.5" />
              {t("settings.agentsAdd")}
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {templates.map((template) => {
              return (
                <div
                  key={template.id}
                  className={`group rounded-xl border transition-all ${
                    template.enabled
                      ? "border-sky-500/30 bg-sky-500/[0.03] shadow-sm shadow-sky-500/5"
                      : "border-border/60 bg-card hover:border-border"
                  }`}
                >
                  <div className="flex items-center gap-3 px-4 py-3">
                    <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-500">
                      <BookOpen className="h-4 w-4" />
                      {template.enabled ? (
                        <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-card bg-emerald-500" />
                      ) : null}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {template.name}
                        </span>
                        {template.enabled ? (
                          <span className="shrink-0 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-emerald-600 dark:text-emerald-400">
                            {t("settings.agentsActiveLabel")}
                          </span>
                        ) : null}
                      </div>
                      {template.description ? (
                        <p
                          className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground"
                          title={template.description}
                        >
                          {template.description}
                        </p>
                      ) : null}
                    </div>

                    <div className="flex items-center gap-1.5">
                      <AgentActivationSwitch
                        checked={template.enabled}
                        title={template.enabled ? t("settings.disable") : t("settings.enable")}
                        onToggle={() => handleToggleEnabled(template.id)}
                      />
                      <div className="settings-hover-actions ml-1 flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-foreground"
                          onClick={() => setViewingTemplate(template)}
                          title={t("settings.agentsShowPrompt")}
                          aria-label={t("settings.agentsShowPrompt")}
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-foreground"
                          onClick={() => openEdit(template)}
                          title={t("settings.edit")}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <ConfirmDeletePopover
                          name={template.name}
                          onConfirm={() => handleDelete(template.id)}
                        >
                          {(open) => (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-destructive"
                              onClick={open}
                              title={t("settings.delete")}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </ConfirmDeletePopover>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {modalOpen ? (
        <AgentPromptTemplateModal
          initialData={editingTemplate ?? undefined}
          onSave={handleSave}
          onClose={closeModal}
        />
      ) : null}

      {viewingTemplate ? (
        <AgentPromptViewModal template={viewingTemplate} onClose={() => setViewingTemplate(null)} />
      ) : null}
    </>
  );
}

type AgentPromptViewModalProps = {
  template: AgentPromptTemplate;
  onClose: () => void;
};

function AgentPromptViewModal({ template, onClose }: AgentPromptViewModalProps) {
  const { t } = useLocale();
  const { modalState, requestClose } = useModalMotion(onClose);

  return createPortal(
    <div
      className="settings-modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4"
      data-state={modalState}
      role="dialog"
      aria-modal="true"
      aria-labelledby="agent-prompt-view-title"
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
            <Eye className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div id="agent-prompt-view-title" className="truncate text-base font-semibold">
              {template.name}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {t("settings.agentsShowPrompt")}
            </div>
          </div>
          <span
            className={`hidden shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium sm:inline-flex ${
              template.enabled
                ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "border-black/[0.06] bg-black/[0.04] text-muted-foreground dark:border-white/10 dark:bg-white/[0.06]"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${template.enabled ? "bg-emerald-500" : "bg-muted-foreground/50"}`}
            />
            {template.enabled ? t("settings.agentsActiveLabel") : t("settings.agentsInactiveLabel")}
          </span>
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
          <div className="grid min-h-0 gap-4 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
            <aside className="rounded-2xl border border-black/[0.06] bg-white/[0.68] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)] dark:border-white/[0.08] dark:bg-white/[0.04] dark:shadow-none">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-black/[0.05] bg-white/80 text-muted-foreground dark:border-white/[0.08] dark:bg-white/[0.06] dark:text-foreground/70">
                  <BookOpen className="h-4 w-4" />
                </div>
                <h3 className="text-sm font-semibold">{t("settings.agentsTemplateDetails")}</h3>
              </div>

              <p className="mt-4 text-xs leading-5 text-muted-foreground">
                {template.description || t("settings.agentsNoDescription")}
              </p>

              <div className="mt-6 space-y-3 border-t border-black/[0.06] pt-4 text-xs dark:border-white/[0.08]">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">{t("settings.agentsStatus")}</span>
                  <span
                    className={`inline-flex items-center gap-1.5 font-medium ${
                      template.enabled
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-muted-foreground"
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${template.enabled ? "bg-emerald-500" : "bg-muted-foreground/50"}`}
                    />
                    {template.enabled
                      ? t("settings.agentsActiveLabel")
                      : t("settings.agentsInactiveLabel")}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">{t("settings.agentsCharacters")}</span>
                  <span className="font-medium tabular-nums text-foreground">
                    {template.prompt.length.toLocaleString()}
                  </span>
                </div>
              </div>
            </aside>

            <section className="flex flex-col overflow-hidden rounded-2xl border border-black/[0.06] bg-white/[0.68] shadow-[inset_0_1px_0_rgba(255,255,255,0.55)] md:min-h-[420px] dark:border-white/[0.08] dark:bg-white/[0.04] dark:shadow-none">
              <div className="flex items-center justify-between gap-3 border-b border-black/[0.05] bg-black/[0.03] px-4 py-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-black/[0.05] bg-white/80 text-muted-foreground dark:border-white/[0.08] dark:bg-white/[0.06] dark:text-foreground/70">
                    <FileText className="h-4 w-4" />
                  </div>
                  <span className="text-xs font-semibold">{t("settings.agentsPrompt")}</span>
                </div>
                <span className="rounded-full border border-black/[0.05] bg-white/[0.72] px-2.5 py-1 text-[11px] tabular-nums text-muted-foreground dark:border-white/[0.08] dark:bg-white/[0.05]">
                  {template.prompt.length.toLocaleString()} {t("settings.agentsCharacters")}
                </span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto bg-white/50 p-5 dark:bg-black/20">
                <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-6 text-foreground/90">
                  {template.prompt}
                </pre>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
