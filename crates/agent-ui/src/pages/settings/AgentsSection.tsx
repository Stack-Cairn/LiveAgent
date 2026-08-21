import {
  type AgentPromptTemplate,
  resolveEffectivePromptSettings,
  updateAgents,
  updateWorkspacePromptSettings,
  type WorkspaceProject,
  workspaceProjectPathKey,
} from "@liveagent/app/lib/settings/index";
import type { SettingsSectionProps } from "@liveagent/app/pages/settings/types";
import { ProjectPromptEditorModal } from "@liveagent/ui/components/chat/ProjectPromptEditorModal";
import {
  BookOpen,
  Eye,
  FileText,
  FolderTree,
  Pencil,
  Plus,
  Trash2,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { useLocale } from "@liveagent/ui/i18n/index";
import { createUuid } from "@liveagent/ui/lib/shared/id";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { AgentPromptTemplateModal } from "@liveagent/ui/pages/settings/AgentPromptTemplateModal";
import { AgentActivationSwitch, ConfirmDeletePopover } from "@liveagent/ui/pages/settings/shared";
import { useState } from "react";

export function AgentsSection(props: SettingsSectionProps) {
  const { settings, setSettings } = props;
  const { t } = useLocale();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<AgentPromptTemplate | null>(null);
  const [viewingTemplate, setViewingTemplate] = useState<AgentPromptTemplate | null>(null);
  const [viewingProject, setViewingProject] = useState<WorkspaceProject | null>(null);
  const [editingProject, setEditingProject] = useState<WorkspaceProject | null>(null);

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
  const projects = settings.system.workspaceProjects;
  const configuredProjectCount = projects.filter((project) => {
    const entry = settings.system.workspaceResourceSettings[workspaceProjectPathKey(project.path)];
    return Boolean(entry?.projectPrompt.trim());
  }).length;
  const viewingProjectEntry = viewingProject
    ? settings.system.workspaceResourceSettings[workspaceProjectPathKey(viewingProject.path)]
    : undefined;
  const viewingProjectEffectivePrompt = viewingProject
    ? resolveEffectivePromptSettings(settings, viewingProject.path).prompt
    : "";

  return (
    <>
      <div className="settings-agents-section space-y-5">
        <div className="settings-section-heading-row flex items-center justify-between gap-4">
          <div className="settings-section-title-group flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-500/10">
              <BookOpen className="h-[18px] w-[18px] text-sky-500" />
            </div>
            <div>
              <h3 className="text-sm font-semibold">{t("settings.agentsTitle")}</h3>
              <p className="text-xs text-muted-foreground">{t("settings.agentsDesc")}</p>
            </div>
          </div>

          <div className="settings-section-actions flex items-center gap-2">
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

        <section className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h4 className="text-sm font-semibold">{t("settings.agentsGlobalTab")}</h4>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("settings.agentsGlobalConfigHint")}
              </p>
            </div>
            <span className="shrink-0 rounded-full border border-sky-500/20 bg-sky-500/[0.06] px-2.5 py-1 text-xs text-sky-600 dark:text-sky-300">
              {enabledCount} {t("settings.agentsActive")}
            </span>
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
                    className={cn(
                      "group rounded-xl border transition-all",
                      template.enabled
                        ? "border-sky-500/30 bg-sky-500/[0.03] shadow-sm shadow-sky-500/5"
                        : "border-border/60 bg-card hover:border-border",
                    )}
                  >
                    <div className="settings-card-row flex items-center gap-3 px-4 py-3">
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
                              {t("settings.agentsGlobalDefault")}
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

                      <div className="settings-card-actions flex items-center gap-1.5">
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
        </section>

        <section className="space-y-3 border-t border-border/60 pt-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h4 className="text-sm font-semibold">{t("settings.agentsProjectsTab")}</h4>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("chat.projectPromptStrategyHint")}
              </p>
            </div>
            <span className="shrink-0 rounded-full border border-violet-500/20 bg-violet-500/[0.06] px-2.5 py-1 text-xs text-violet-600 dark:text-violet-300">
              {configuredProjectCount}/{projects.length}
            </span>
          </div>

          {projects.length === 0 ? (
            <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-border/60 bg-muted/20 py-14 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-500/10">
                <FolderTree className="h-6 w-6 text-violet-400" />
              </div>
              <div className="space-y-1.5">
                <p className="text-sm font-medium">{t("settings.agentsNoProjects")}</p>
                <p className="mx-auto max-w-xs text-xs leading-relaxed text-muted-foreground">
                  {t("settings.agentsNoProjectsHint")}
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {projects.map((project) => {
                const entry =
                  settings.system.workspaceResourceSettings[workspaceProjectPathKey(project.path)];
                const configured = Boolean(entry?.projectPrompt.trim());
                return (
                  <div
                    key={project.id}
                    className={cn(
                      "group rounded-xl border transition-all",
                      configured
                        ? "border-violet-500/30 bg-violet-500/[0.03] shadow-sm shadow-violet-500/5"
                        : "border-border/60 bg-card hover:border-border",
                    )}
                  >
                    <div className="settings-card-row flex items-center gap-3 px-4 py-3">
                      <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-300">
                        <FolderTree className="h-4 w-4" />
                        {configured ? (
                          <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-card bg-violet-500" />
                        ) : null}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-foreground">
                            {project.name}
                          </span>
                          <span
                            className={cn(
                              "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none",
                              configured
                                ? "bg-violet-500/10 text-violet-600 dark:text-violet-300"
                                : "bg-muted text-muted-foreground",
                            )}
                          >
                            {t(
                              configured
                                ? "settings.agentsProjectConfigured"
                                : "settings.agentsProjectUnconfigured",
                            )}
                          </span>
                        </div>
                        <p
                          className="mt-1 truncate text-xs leading-relaxed text-muted-foreground"
                          title={project.path}
                        >
                          {project.path}
                        </p>
                      </div>

                      <div className="settings-card-actions flex items-center gap-1.5">
                        {configured ? (
                          <span className="shrink-0 rounded-full border border-border/60 bg-muted/40 px-2 py-1 text-[10px] font-medium text-muted-foreground">
                            {t(
                              entry?.projectPromptStrategy === "replace"
                                ? "settings.agentsProjectReplace"
                                : "settings.agentsProjectAppend",
                            )}
                          </span>
                        ) : null}
                        <div className="settings-hover-actions ml-1 flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-foreground"
                            disabled={!configured}
                            onClick={() => setViewingProject(project)}
                            title={t("settings.agentsShowPrompt")}
                            aria-label={t("settings.agentsShowPrompt")}
                          >
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-foreground"
                            onClick={() => setEditingProject(project)}
                            title={t("settings.agentsProjectEdit")}
                            aria-label={t("settings.agentsProjectEdit")}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
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

      {viewingProject && viewingProjectEntry?.projectPrompt.trim() ? (
        <AgentPromptViewModal
          template={{
            id: viewingProject.id,
            name: viewingProject.name,
            description: viewingProject.path,
            prompt: viewingProjectEffectivePrompt,
            enabled: true,
          }}
          subtitle={t("chat.projectPromptTitle")}
          promptTitle={t("chat.projectPromptEffectivePreview")}
          detailsTitle={t("settings.agentsProjectsTab")}
          statusTitle={t("chat.projectPromptStrategy")}
          statusLabel={t(
            viewingProjectEntry.projectPromptStrategy === "replace"
              ? "settings.agentsProjectReplace"
              : "settings.agentsProjectAppend",
          )}
          statusTone="violet"
          onClose={() => setViewingProject(null)}
        />
      ) : null}

      {editingProject ? (
        <ProjectPromptEditorModal
          project={editingProject}
          settings={settings}
          onClose={() => setEditingProject(null)}
          onSave={(draft) => {
            setSettings((prev) => updateWorkspacePromptSettings(prev, editingProject.path, draft));
          }}
        />
      ) : null}
    </>
  );
}

type AgentPromptViewModalProps = {
  template: AgentPromptTemplate;
  subtitle?: string;
  promptTitle?: string;
  detailsTitle?: string;
  statusTitle?: string;
  statusLabel?: string;
  statusTone?: "emerald" | "muted" | "violet";
  onClose: () => void;
};

function AgentPromptViewModal({
  template,
  subtitle,
  promptTitle,
  detailsTitle,
  statusTitle,
  statusLabel,
  statusTone,
  onClose,
}: AgentPromptViewModalProps) {
  const { t } = useLocale();
  const tone = statusTone ?? (template.enabled ? "emerald" : "muted");
  const resolvedStatusLabel =
    statusLabel ??
    (template.enabled ? t("settings.agentsActiveLabel") : t("settings.agentsInactiveLabel"));
  const statusBadgeClass =
    tone === "emerald"
      ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      : tone === "violet"
        ? "border-violet-500/20 bg-violet-500/10 text-violet-600 dark:text-violet-300"
        : "border-border/60 bg-muted/40 text-muted-foreground";
  const statusTextClass =
    tone === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "violet"
        ? "text-violet-600 dark:text-violet-300"
        : "text-muted-foreground";
  const statusDotClass =
    tone === "emerald"
      ? "bg-emerald-500"
      : tone === "violet"
        ? "bg-violet-500"
        : "bg-muted-foreground/50";

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex max-h-[90dvh] max-w-4xl flex-col p-0"
        closeLabel={t("settings.cancel")}
        showCloseButton
      >
        <DialogHeader className="flex-row items-center gap-3.5 px-6 py-5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-border/60 bg-muted/50 text-muted-foreground shadow-xs">
            <Eye className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate">{template.name}</DialogTitle>
            <DialogDescription className="mt-0.5 text-xs">
              {subtitle ?? t("settings.agentsShowPrompt")}
            </DialogDescription>
          </div>
          <span
            className={cn(
              "hidden shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium sm:inline-flex",
              statusBadgeClass,
            )}
          >
            <span className={cn("h-1.5 w-1.5 rounded-full", statusDotClass)} />
            {resolvedStatusLabel}
          </span>
        </DialogHeader>

        <DialogBody className="px-6 py-5">
          <div className="grid min-h-0 gap-4 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
            <aside className="min-w-0 overflow-hidden rounded-2xl border border-border/60 bg-card p-5 shadow-xs">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/40 text-muted-foreground">
                  <BookOpen className="h-4 w-4" />
                </div>
                <h3 className="text-sm font-semibold">
                  {detailsTitle ?? t("settings.agentsTemplateDetails")}
                </h3>
              </div>

              <p className="mt-4 min-w-0 break-words text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
                {template.description || t("settings.agentsNoDescription")}
              </p>

              <div className="mt-6 space-y-3 border-t border-border/60 pt-4 text-xs">
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
                  <span className="min-w-0 leading-5 text-muted-foreground">
                    {statusTitle ?? t("settings.agentsStatus")}
                  </span>
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap pt-0.5 font-medium",
                      statusTextClass,
                    )}
                  >
                    <span className={cn("h-1.5 w-1.5 rounded-full", statusDotClass)} />
                    {resolvedStatusLabel}
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

            <section className="flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-card shadow-xs md:min-h-[420px]">
              <div className="flex items-center justify-between gap-3 border-b border-border/60 bg-muted/30 px-4 py-3">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-border/60 bg-muted/40 text-muted-foreground">
                    <FileText className="h-4 w-4" />
                  </div>
                  <span className="text-xs font-semibold">
                    {promptTitle ?? t("settings.agentsPrompt")}
                  </span>
                </div>
                <span className="rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-xs tabular-nums text-muted-foreground">
                  {template.prompt.length.toLocaleString()} {t("settings.agentsCharacters")}
                </span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto bg-muted/20 p-5">
                <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-6 text-foreground/90">
                  {template.prompt}
                </pre>
              </div>
            </section>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
