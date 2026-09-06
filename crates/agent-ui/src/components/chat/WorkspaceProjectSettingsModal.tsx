import { useDirectoryPicker } from "@liveagent/adapters/directoryPicker";
import {
  type AppSettings,
  DEFAULT_WORKSPACE_PROJECT_ID,
  type ProjectPromptStrategy,
  type WorkspaceProject,
  type WorkspaceResourceSettingsMode,
  workspaceProjectPathKey,
} from "@liveagent/app/lib/settings";
import type {
  WorkspaceProjectRootAccess,
  WorkspaceProjectRootClient,
  WorkspaceProjectRootGrant,
} from "@liveagent/ui/contracts/workspaceProjectRoots";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { isAlwaysEnabledSkillName, type SkillSummary } from "@liveagent/ui/lib/skills/index";
import { useEffect, useMemo, useState } from "react";
import type { StoreCategoryValue } from "../../pages/skills-hub/SkillCategoryControls";
import { Blend, BookOpen, FolderTree, Loader2, Settings } from "../IconSet";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { ProjectPromptSettingsPanel } from "./ProjectPromptEditorModal";
import { WorkspaceDirectorySettingsPanel } from "./workspace-project-settings/WorkspaceDirectorySettingsPanel";
import { WorkspaceGeneralSettingsPanel } from "./workspace-project-settings/WorkspaceGeneralSettingsPanel";
import {
  WorkspaceResourceSettingsPanel,
  type WorkspaceResourceTab,
} from "./workspace-project-settings/WorkspaceResourceSettingsPanel";
import {
  classifyWorkspaceSkill,
  rootAliasFromPath,
} from "./workspace-project-settings/workspaceProjectSettingsUtils";

type ProjectSettingsPanel = "general" | "directories" | "resources" | "prompt";

export type {
  WorkspaceProjectRootAccess,
  WorkspaceProjectRootClient,
  WorkspaceProjectRootDraft,
  WorkspaceProjectRootGrant,
  WorkspaceProjectRootState,
} from "@liveagent/ui/contracts/workspaceProjectRoots";

type ResourceSettingsDraft = {
  mode: WorkspaceResourceSettingsMode;
  skillNames: string[];
  mcpServerIds: string[];
  projectPrompt: string;
  projectPromptStrategy: ProjectPromptStrategy;
};

export function WorkspaceProjectSettingsModal(props: {
  project: WorkspaceProject;
  settings: AppSettings;
  skills: SkillSummary[];
  onSave: (draft: ResourceSettingsDraft) => void | Promise<void>;
  onRenameProject?: (name: string) => void | Promise<void>;
  onClose: () => void;
  rootClient?: WorkspaceProjectRootClient;
  rootClientUnavailableDescription?: string;
}) {
  const {
    project,
    settings,
    skills,
    onSave,
    onRenameProject,
    onClose,
    rootClient,
    rootClientUnavailableDescription,
  } = props;
  const { t } = useLocale();
  const { suspendsParentModal, pickDirectory, directoryPickerElement } = useDirectoryPicker();
  const [dialogOpen, setDialogOpen] = useState(true);
  const requestClose = () => setDialogOpen(false);
  const pathKey = workspaceProjectPathKey(project.path);
  const saved = settings.system.workspaceResourceSettings[pathKey];
  const globalSkillNames = useMemo(
    () => new Set(settings.skills.selected),
    [settings.skills.selected],
  );
  const globalMcpIds = useMemo(
    () =>
      new Set(settings.mcp.servers.filter((server) => server.enabled).map((server) => server.id)),
    [settings.mcp.servers],
  );
  const [activePanel, setActivePanel] = useState<ProjectSettingsPanel>("general");
  const [projectName, setProjectName] = useState(project.name);
  const [mode, setMode] = useState<WorkspaceResourceSettingsMode>(saved?.mode ?? "inherit");
  const [skillNames, setSkillNames] = useState<Set<string>>(
    () => new Set(saved?.mode === "custom" ? saved.skillNames : globalSkillNames),
  );
  const [mcpServerIds, setMcpServerIds] = useState<Set<string>>(
    () => new Set(saved?.mode === "custom" ? saved.mcpServerIds : globalMcpIds),
  );
  const [projectPrompt, setProjectPrompt] = useState(saved?.projectPrompt ?? "");
  const [projectPromptStrategy, setProjectPromptStrategy] = useState<ProjectPromptStrategy>(
    saved?.projectPromptStrategy ?? "append",
  );
  const [tab, setTab] = useState<WorkspaceResourceTab>("skills");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<StoreCategoryValue>("all");
  const [roots, setRoots] = useState<WorkspaceProjectRootGrant[]>([]);
  const [rootsLoading, setRootsLoading] = useState(Boolean(rootClient));
  const [rootsLoaded, setRootsLoaded] = useState(!rootClient);
  const [rootsDirty, setRootsDirty] = useState(false);
  const [rootError, setRootError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [directoryPickerActive, setDirectoryPickerActive] = useState(false);

  const canRenameProject = project.id !== DEFAULT_WORKSPACE_PROJECT_ID && Boolean(onRenameProject);
  const normalizedProjectName = projectName.trim();
  const projectNameInvalid = canRenameProject && normalizedProjectName.length === 0;

  useEffect(() => {
    if (!rootClient) return;
    let cancelled = false;
    setRootsLoading(true);
    setRootsLoaded(false);
    setRootError(null);
    void rootClient
      .list(project)
      .then((result) => {
        if (!cancelled) {
          setRoots([...result]);
          setRootsLoaded(true);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setRootError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setRootsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project, rootClient]);

  const listedSkills = useMemo(() => {
    const rows: Array<{
      skill: Pick<SkillSummary, "name" | "description">;
      missing: boolean;
    }> = skills.map((skill) => ({ skill, missing: false }));
    if (mode !== "custom") return rows;
    const installedNames = new Set(skills.map((skill) => skill.name));
    for (const name of skillNames) {
      if (installedNames.has(name) || isAlwaysEnabledSkillName(name)) continue;
      rows.push({
        skill: { name, description: t("chat.workspaceResourcesMissingSkill") },
        missing: true,
      });
    }
    return rows;
  }, [mode, skillNames, skills, t]);

  const filteredSkills = useMemo(() => {
    const text = query.trim().toLowerCase();
    return listedSkills.filter(({ skill }) => {
      if (text && !`${skill.name}\n${skill.description}`.toLowerCase().includes(text)) return false;
      return category === "all" || classifyWorkspaceSkill(skill).includes(category);
    });
  }, [category, listedSkills, query]);

  const skillCategoryCounts = useMemo(() => {
    const counts = new Map<StoreCategoryValue, number>();
    counts.set("all", listedSkills.length);
    for (const { skill } of listedSkills) {
      for (const value of classifyWorkspaceSkill(skill)) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
    return counts;
  }, [listedSkills]);

  const filteredMcp = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return settings.mcp.servers;
    return settings.mcp.servers.filter((server) =>
      `${server.id}\n${server.transport}\n${server.command}\n${server.url}`
        .toLowerCase()
        .includes(text),
    );
  }, [query, settings.mcp.servers]);

  const selectMode = (next: WorkspaceResourceSettingsMode) => {
    if (next === "custom" && mode !== "custom") {
      setSkillNames(new Set(globalSkillNames));
      setMcpServerIds(new Set(globalMcpIds));
    }
    setMode(next);
  };

  const addDirectory = async () => {
    if (!rootClient) return;
    setRootError(null);
    const suspendSettingsModal = suspendsParentModal;
    try {
      if (suspendSettingsModal) {
        setDirectoryPickerActive(true);
      }
      const path = await pickDirectory(project.path);
      if (!path) return;
      if (roots.some((root) => root.displayPath === path)) {
        setRootError(t("chat.workspaceSettingsDirectoryDuplicate"));
        return;
      }
      const alias = rootAliasFromPath(path, new Set(roots.map((root) => root.alias)));
      setRoots((current) => [
        ...current,
        {
          id: `draft-${Date.now()}-${current.length}`,
          alias,
          displayPath: path,
          access: "read",
          state: "pending-approval",
        },
      ]);
      setRootsDirty(true);
    } catch (error) {
      setRootError(error instanceof Error ? error.message : String(error));
    } finally {
      if (suspendSettingsModal) setDirectoryPickerActive(false);
    }
  };

  const handleSave = async () => {
    if (saving || !dialogOpen) return;
    if (projectNameInvalid) {
      setActivePanel("general");
      return;
    }
    setSaving(true);
    setRootError(null);
    try {
      if (rootClient && rootsDirty && rootsLoaded) {
        await rootClient.save(
          project,
          roots.map(({ id, alias, displayPath, access }) => ({
            id,
            alias: alias.trim(),
            displayPath,
            access,
          })),
        );
      }
      if (canRenameProject && normalizedProjectName !== project.name) {
        await onRenameProject?.(normalizedProjectName);
      }
      await onSave({
        mode,
        skillNames: [...skillNames],
        mcpServerIds: [...mcpServerIds],
        projectPrompt: projectPrompt.trim(),
        projectPromptStrategy,
      });
      requestClose();
    } catch (error) {
      setRootError(error instanceof Error ? error.message : String(error));
      setSaving(false);
    }
  };

  const visibleSkillSelection = mode === "inherit" ? globalSkillNames : skillNames;
  const visibleMcpSelection = mode === "inherit" ? globalMcpIds : mcpServerIds;
  const projectKindLabel = t(
    `chat.workspaceSettingsKind${project.kind[0].toUpperCase()}${project.kind.slice(1)}`,
  );
  const navigation = [
    {
      id: "general" as const,
      icon: Settings,
      label: t("chat.workspaceSettingsGeneral"),
    },
    {
      id: "directories" as const,
      icon: FolderTree,
      label: t("chat.workspaceSettingsDirectories"),
    },
    {
      id: "resources" as const,
      icon: Blend,
      label: t("chat.workspaceSettingsResources"),
    },
    {
      id: "prompt" as const,
      icon: BookOpen,
      label: t("chat.projectPromptTitle"),
    },
  ];

  if (directoryPickerActive) {
    return <>{directoryPickerElement}</>;
  }

  return (
    <Dialog
      open={dialogOpen}
      onOpenChange={(open) => {
        if (!open && !saving) requestClose();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="flex h-[min(650px,calc(100dvh-2rem))] max-w-[940px] flex-col p-0"
        closeDisabled={saving}
        closeLabel={t("window.close")}
        layout="fullscreen-mobile"
        showCloseButton
      >
        <DialogHeader>
          <DialogTitle id="workspace-project-settings-title" className="truncate">
            {t("chat.workspaceSettingsTitle")}
          </DialogTitle>
          {/* The path is already shown (and copyable) on the 通用配置 panel, so the
              header only needs to say which workspace this is. */}
          <DialogDescription
            className="truncate text-xs"
            title={normalizedProjectName || project.name}
          >
            {normalizedProjectName || project.name}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex overflow-hidden p-0 max-[720px]:flex-col">
          <nav
            className="flex w-[188px] shrink-0 flex-col gap-1 border-r bg-muted/30 p-2.5 max-[720px]:w-full max-[720px]:flex-row max-[720px]:overflow-x-auto max-[720px]:border-b max-[720px]:border-r-0 max-[720px]:px-2.5 max-[720px]:py-2"
            aria-label={t("chat.workspaceSettingsNavigation")}
          >
            {navigation.map(({ id, icon: Icon, label }) => (
              <button
                key={id}
                type="button"
                className={cn(
                  "flex h-8 items-center gap-2 rounded-lg px-3 text-left text-sm font-medium transition-colors max-[720px]:min-w-max max-[720px]:flex-1 max-[720px]:justify-center max-[720px]:px-2 max-[720px]:text-xs",
                  activePanel === id
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
                onClick={() => setActivePanel(id)}
                aria-current={activePanel === id ? "page" : undefined}
              >
                <Icon className="h-4 w-4 shrink-0 max-[720px]:h-3.5 max-[720px]:w-3.5" />
                {label}
              </button>
            ))}
          </nav>

          <main className="min-h-0 flex-1 overflow-y-auto">
            {activePanel === "general" ? (
              <WorkspaceGeneralSettingsPanel
                project={project}
                projectKindLabel={projectKindLabel}
                projectName={projectName}
                canRenameProject={canRenameProject}
                projectNameInvalid={projectNameInvalid}
                saving={saving}
                onProjectNameChange={setProjectName}
              />
            ) : null}

            {activePanel === "directories" ? (
              <WorkspaceDirectorySettingsPanel
                project={project}
                rootClient={rootClient}
                unavailableDescription={rootClientUnavailableDescription}
                roots={roots}
                loading={rootsLoading}
                loaded={rootsLoaded}
                error={rootError}
                onAdd={() => void addDirectory()}
                onAliasChange={(id, alias) => {
                  setRoots((current) =>
                    current.map((item) => (item.id === id ? { ...item, alias } : item)),
                  );
                  setRootsDirty(true);
                }}
                onAccessChange={(id, access: WorkspaceProjectRootAccess) => {
                  setRoots((current) =>
                    current.map((item) => (item.id === id ? { ...item, access } : item)),
                  );
                  setRootsDirty(true);
                }}
                onRemove={(id) => {
                  setRoots((current) => current.filter((item) => item.id !== id));
                  setRootsDirty(true);
                }}
              />
            ) : null}

            {activePanel === "resources" ? (
              <WorkspaceResourceSettingsPanel
                settings={settings}
                mode={mode}
                tab={tab}
                query={query}
                category={category}
                filteredSkills={filteredSkills}
                filteredMcp={filteredMcp}
                skillCategoryCounts={skillCategoryCounts}
                visibleSkillSelection={visibleSkillSelection}
                visibleMcpSelection={visibleMcpSelection}
                skillNames={skillNames}
                mcpServerIds={mcpServerIds}
                onModeChange={selectMode}
                onTabChange={(nextTab) => {
                  setTab(nextTab);
                  setQuery("");
                }}
                onQueryChange={setQuery}
                onCategoryChange={setCategory}
                onSkillNamesChange={setSkillNames}
                onMcpServerIdsChange={setMcpServerIds}
              />
            ) : null}

            {activePanel === "prompt" ? (
              <ProjectPromptSettingsPanel
                projectPrompt={projectPrompt}
                strategy={projectPromptStrategy}
                onProjectPromptChange={setProjectPrompt}
                onStrategyChange={setProjectPromptStrategy}
              />
            ) : null}
          </main>
        </DialogBody>

        <DialogFooter className="bg-muted/20 min-[821px]:justify-between">
          <div
            className={cn(
              "min-w-0 flex-1 truncate text-xs text-muted-foreground max-[520px]:hidden",
              rootError && "text-destructive",
            )}
          >
            {rootError
              ? rootError
              : activePanel === "resources" && mode === "custom"
                ? t("chat.workspaceResourcesSelected")
                    .replace("{skills}", String(skillNames.size))
                    .replace("{mcp}", String(mcpServerIds.size))
                : null}
          </div>
          <DialogActions>
            <DialogClose
              disabled={saving}
              render={<Button type="button" variant="outline" className="h-8" />}
            >
              {t("chat.cancel")}
            </DialogClose>
            <Button
              onClick={() => void handleSave()}
              disabled={saving || !dialogOpen || projectNameInvalid}
              className="h-8"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t("workspaceEditor.save")}
            </Button>
          </DialogActions>
        </DialogFooter>
      </DialogContent>
      {directoryPickerElement}
    </Dialog>
  );
}
