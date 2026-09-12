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
import { Eye, Plus, SquarePen, Trash2 } from "@liveagent/ui/components/IconSet";
import { SettingsSection } from "@liveagent/ui/components/settings/SettingsLayout";
import { Badge } from "@liveagent/ui/components/ui/badge";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { EmptyState } from "@liveagent/ui/components/ui/empty-state";
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
  const viewingProjectPromptSettings = viewingProject
    ? resolveEffectivePromptSettings(settings, viewingProject.path)
    : null;

  return (
    <>
      <div className="settings-agents-section space-y-7">
        <SettingsSection
          title={t("settings.agentsGlobalTab")}
          description={t("settings.agentsGlobalConfigHint")}
          actions={
            <>
              <div className="flex items-center gap-1.5">
                <Badge variant="muted" size="compact" className="h-5 px-2 tabular-nums">
                  {templates.length} {t("settings.agentsCount")}
                </Badge>
                {enabledCount > 0 ? (
                  <Badge variant="muted" size="compact" className="h-5 px-2 tabular-nums">
                    {enabledCount} {t("settings.agentsActive")}
                  </Badge>
                ) : null}
              </div>
              <Button size="sm" className="gap-1.5" onClick={openAdd}>
                <Plus className="size-3.5" />
                {t("settings.agentsAdd")}
              </Button>
            </>
          }
        >
          {templates.length === 0 ? (
            <EmptyState variant="settings">
              <div className="space-y-1.5">
                <p className="text-sm font-medium text-foreground">
                  {t("settings.agentsNoTemplates")}
                </p>
                <p className="mx-auto max-w-xs text-xs leading-relaxed text-muted-foreground">
                  {t("settings.agentsNoTemplatesHint")}
                </p>
              </div>
            </EmptyState>
          ) : (
            <div className="space-y-2">
              {templates.map((template) => {
                return (
                  <div key={template.id} className={cn("group rounded-xl bg-settings-tile")}>
                    <div className="settings-card-row flex items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setViewingTemplate(template)}
                            className="cursor-pointer truncate text-left text-sm font-medium hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {template.name}
                          </button>
                          {template.enabled ? (
                            <Badge size="compact" variant="muted">
                              {t("settings.agentsGlobalDefault")}
                            </Badge>
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
                        <div className={cn("ml-1 flex items-center gap-0.5")}>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-muted-foreground hover:text-foreground"
                            onClick={() => setViewingTemplate(template)}
                            title={t("settings.agentsShowPrompt")}
                            aria-label={t("settings.agentsShowPrompt")}
                          >
                            <Eye className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-muted-foreground hover:text-foreground"
                            onClick={() => openEdit(template)}
                            title={t("settings.edit")}
                          >
                            <SquarePen className="size-3.5" />
                          </Button>
                          <ConfirmDeletePopover
                            name={template.name}
                            onConfirm={() => handleDelete(template.id)}
                          >
                            {(open) => (
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="text-muted-foreground hover:text-destructive"
                                onClick={open}
                                title={t("settings.delete")}
                              >
                                <Trash2 className="size-3.5" />
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
        </SettingsSection>

        <SettingsSection
          title={t("settings.agentsProjectsTab")}
          description={t("chat.projectPromptStrategyHint")}
          actions={
            <Badge variant="muted" size="compact" className="h-5 px-2 tabular-nums">
              {configuredProjectCount}/{projects.length}
            </Badge>
          }
        >
          {projects.length === 0 ? (
            <EmptyState variant="settings">
              <div className="space-y-1.5">
                <p className="text-sm font-medium">{t("settings.agentsNoProjects")}</p>
                <p className="mx-auto max-w-xs text-xs leading-relaxed text-muted-foreground">
                  {t("settings.agentsNoProjectsHint")}
                </p>
              </div>
            </EmptyState>
          ) : (
            <div className="space-y-2">
              {projects.map((project) => {
                const entry =
                  settings.system.workspaceResourceSettings[workspaceProjectPathKey(project.path)];
                const configured = Boolean(entry?.projectPrompt.trim());
                return (
                  <div key={project.id} className={cn("group rounded-xl bg-settings-tile")}>
                    <div className="settings-card-row flex items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-foreground">
                            {project.name}
                          </span>
                          <span
                            className={cn(
                              "shrink-0 rounded-full px-1.5 py-0.5 text-tiny font-medium leading-none",
                              "bg-muted text-muted-foreground",
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
                          <span
                            className={cn(
                              "shrink-0 rounded-full border border-border/60 bg-muted/40 px-2 py-1",
                              "text-tiny font-medium text-muted-foreground",
                            )}
                          >
                            {t(
                              entry?.projectPromptStrategy === "replace"
                                ? "settings.agentsProjectReplace"
                                : "settings.agentsProjectAppend",
                            )}
                          </span>
                        ) : null}
                        <div className={cn("ml-1 flex items-center gap-0.5")}>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-muted-foreground hover:text-foreground"
                            disabled={!configured}
                            onClick={() => setViewingProject(project)}
                            title={t("settings.agentsShowPrompt")}
                            aria-label={t("settings.agentsShowPrompt")}
                          >
                            <Eye className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-muted-foreground hover:text-foreground"
                            onClick={() => setEditingProject(project)}
                            title={t("settings.agentsProjectEdit")}
                            aria-label={t("settings.agentsProjectEdit")}
                          >
                            <SquarePen className="size-3.5" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </SettingsSection>
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

      {viewingProject &&
      viewingProjectEntry?.projectPrompt.trim() &&
      viewingProjectPromptSettings ? (
        <AgentPromptViewModal
          template={{
            id: viewingProject.id,
            name: viewingProject.name,
            description: viewingProject.path,
            prompt: viewingProjectPromptSettings.prompt,
            enabled: true,
          }}
          subtitle={t("chat.projectPromptTitle")}
          hidePromptHeader
          promptSegments={[
            ...(viewingProjectPromptSettings.projectPromptStrategy === "append" &&
            viewingProjectPromptSettings.globalPrompt
              ? [
                  {
                    label: t("chat.globalPromptTitle"),
                    prompt: viewingProjectPromptSettings.globalPrompt,
                    tone: "global" as const,
                  },
                ]
              : []),
            {
              label: t("chat.projectPromptTitle"),
              prompt: viewingProjectPromptSettings.projectPrompt,
              tone: "project" as const,
            },
          ]}
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
  hidePromptHeader?: boolean;
  promptSegments?: Array<{
    label: string;
    prompt: string;
    tone: "global" | "project";
  }>;
  detailsTitle?: string;
  statusTitle?: string;
  statusLabel?: string;
  statusTone?: "emerald" | "muted" | "violet";
  onClose: () => void;
};

function AgentPromptViewModal({
  template,
  subtitle,
  promptSegments,
  statusTitle,
  statusLabel,
  onClose,
}: AgentPromptViewModalProps) {
  const { t } = useLocale();
  const resolvedStatusLabel =
    statusLabel ??
    (template.enabled ? t("settings.agentsActiveLabel") : t("settings.agentsInactiveLabel"));
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex h-[min(44rem,calc(100dvh-2rem))] max-w-2xl flex-col"
        closeLabel={t("settings.cancel")}
        showCloseButton
      >
        <DialogHeader>
          <DialogTitle>{template.name}</DialogTitle>
          <DialogDescription>{subtitle ?? t("settings.agentsShowPrompt")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {template.description ? (
            <p className="break-words text-sm leading-relaxed text-muted-foreground">
              {template.description}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {statusTitle ?? t("settings.agentsStatus")} · {resolvedStatusLabel}
            </span>
            <span>
              {template.prompt.length.toLocaleString()} {t("settings.agentsCharacters")}
            </span>
          </div>
          {promptSegments ? (
            promptSegments.map((segment) => (
              <section key={segment.tone} className="space-y-2">
                <h3 className="text-xs font-medium">{segment.label}</h3>
                <pre className="whitespace-pre-wrap break-words rounded-xl bg-settings-tile p-4 font-mono text-sm leading-6">
                  {segment.prompt}
                </pre>
              </section>
            ))
          ) : (
            <pre className="whitespace-pre-wrap break-words rounded-xl bg-settings-tile p-4 font-mono text-sm leading-6">
              {template.prompt}
            </pre>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
