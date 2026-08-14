import { Dialog } from "@base-ui/react/dialog";
import { useDirectoryPicker } from "@liveagent/adapters/directoryPicker";
import {
  type AppSettings,
  DEFAULT_WORKSPACE_PROJECT_ID,
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
import { useModalMotion } from "@liveagent/ui/lib/shared/modalMotion";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { isAlwaysEnabledSkillName, type SkillSummary } from "@liveagent/ui/lib/skills/index";
import { useEffect, useMemo, useState } from "react";
import type { StoreCategoryValue } from "../../pages/skills-hub/SkillCategoryControls";
import { Blend, FolderTree, Loader2, Settings, X } from "../IconSet";
import { Button } from "../ui/button";
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

type ProjectSettingsPanel = "general" | "directories" | "resources";

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
  const { isClosing, modalState, requestClose } = useModalMotion(onClose);
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
    if (saving || isClosing) return;
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
      });
      requestClose();
    } catch (error) {
      setRootError(error instanceof Error ? error.message : String(error));
      setSaving(false);
    }
  };

  const visibleSkillSelection = mode === "inherit" ? globalSkillNames : skillNames;
  const visibleMcpSelection = mode === "inherit" ? globalMcpIds : mcpServerIds;
  const selectableSkills = listedSkills.filter(
    ({ skill }) => !isAlwaysEnabledSkillName(skill.name),
  );
  const visibleSelectedSkillCount =
    settings.skills.enabled && mode !== "off"
      ? selectableSkills.filter(({ skill }) => visibleSkillSelection.has(skill.name)).length
      : 0;
  const visibleSelectedMcpCount =
    mode !== "off"
      ? settings.mcp.servers.filter(
          (server) => server.enabled && visibleMcpSelection.has(server.id),
        ).length
      : 0;
  const projectKindLabel = t(
    `chat.workspaceSettingsKind${project.kind[0].toUpperCase()}${project.kind.slice(1)}`,
  );
  const navigation = [
    { id: "general" as const, icon: Settings, label: t("chat.workspaceSettingsGeneral") },
    {
      id: "directories" as const,
      icon: FolderTree,
      label: t("chat.workspaceSettingsDirectories"),
    },
    { id: "resources" as const, icon: Blend, label: t("chat.workspaceSettingsResources") },
  ];

  if (directoryPickerActive) {
    return <>{directoryPickerElement}</>;
  }

  return (
    <Dialog.Root
      open={!isClosing}
      onOpenChange={(open) => {
        if (!open && !saving) requestClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[120] bg-black/60 backdrop-blur-sm" />
        <Dialog.Viewport
          className="settings-modal-overlay fixed inset-0 z-[120] flex items-center justify-center p-4 max-[720px]:p-0"
          data-state={modalState}
        >
          <Dialog.Popup className="settings-modal-panel relative z-10 flex h-[650px] max-h-[calc(100dvh-2rem)] w-full max-w-[940px] flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl outline-none max-[720px]:h-[100dvh] max-[720px]:max-h-[100dvh] max-[720px]:max-w-none max-[720px]:rounded-none max-[720px]:border-0">
            <header className="settings-modal-header flex shrink-0 items-center justify-between gap-4 border-b px-5 py-4 max-[720px]:px-3.5 max-[720px]:py-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/35 text-foreground">
                  <FolderTree className="h-4.5 w-4.5" />
                </div>
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <Dialog.Title
                      id="workspace-project-settings-title"
                      className="truncate text-sm font-semibold"
                    >
                      {t("chat.workspaceSettingsTitle")}
                    </Dialog.Title>
                    <span className="max-w-[240px] truncate rounded-full border bg-muted/60 px-2.5 py-0.5 text-[11px] text-muted-foreground">
                      {normalizedProjectName || project.name}
                    </span>
                  </div>
                  <div
                    className="mt-0.5 max-w-[620px] truncate text-[11px] text-muted-foreground"
                    title={project.path}
                  >
                    {project.path}
                  </div>
                </div>
              </div>
              <Dialog.Close
                disabled={saving}
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 shrink-0 text-muted-foreground hover:text-foreground"
                    title={t("window.close")}
                    aria-label={t("window.close")}
                  />
                }
              >
                <X className="h-4 w-4" />
              </Dialog.Close>
            </header>

            <div className="flex min-h-0 flex-1 max-[720px]:flex-col">
              <nav
                className="flex w-[188px] shrink-0 flex-col gap-1 border-r bg-muted/30 p-2.5 max-[720px]:w-full max-[720px]:flex-row max-[720px]:overflow-x-auto max-[720px]:border-b max-[720px]:border-r-0 max-[720px]:px-2.5 max-[720px]:py-2"
                aria-label={t("chat.workspaceSettingsNavigation")}
              >
                {navigation.map(({ id, icon: Icon, label }) => (
                  <button
                    key={id}
                    type="button"
                    className={cn(
                      "flex h-10 items-center gap-2 rounded-lg px-3 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground max-[720px]:min-w-max max-[720px]:flex-1 max-[720px]:justify-center max-[720px]:px-2 max-[720px]:text-xs",
                      activePanel === id && "bg-primary/10 font-medium text-primary",
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
                    listedSkills={listedSkills}
                    filteredSkills={filteredSkills}
                    filteredMcp={filteredMcp}
                    skillCategoryCounts={skillCategoryCounts}
                    visibleSkillSelection={visibleSkillSelection}
                    visibleMcpSelection={visibleMcpSelection}
                    skillNames={skillNames}
                    mcpServerIds={mcpServerIds}
                    visibleSelectedSkillCount={visibleSelectedSkillCount}
                    visibleSelectedMcpCount={visibleSelectedMcpCount}
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
              </main>
            </div>

            <footer className="settings-modal-footer flex shrink-0 items-center justify-between gap-3 border-t bg-muted/20 px-5 py-3.5 max-[720px]:px-3.5 max-[720px]:pb-[calc(0.75rem+env(safe-area-inset-bottom))] max-[720px]:pt-3">
              <div
                className={cn(
                  "min-w-0 truncate text-xs text-muted-foreground max-[520px]:hidden",
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
              <div className="ml-auto flex gap-2 max-[520px]:w-full">
                <Dialog.Close
                  disabled={saving}
                  render={<Button type="button" variant="outline" className="max-[520px]:flex-1" />}
                >
                  {t("chat.cancel")}
                </Dialog.Close>
                <Button
                  onClick={() => void handleSave()}
                  disabled={saving || isClosing || projectNameInvalid}
                  className="min-w-20 max-[520px]:flex-1"
                >
                  {saving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    t("workspaceEditor.save")
                  )}
                </Button>
              </div>
            </footer>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
      {directoryPickerElement}
    </Dialog.Root>
  );
}
