import { Dialog } from "@base-ui/react/dialog";
import { useDirectoryPicker } from "@liveagent/adapters/directoryPicker";
import {
  type AppSettings,
  DEFAULT_WORKSPACE_PROJECT_ID,
  type WorkspaceProject,
  type WorkspaceResourceSettingsMode,
  workspaceProjectPathKey,
} from "@liveagent/app/lib/settings";
import { getMcpTransportMeta } from "@liveagent/ui/components/resources/McpTransportMeta";
import { ResourceSelectionCard } from "@liveagent/ui/components/resources/ResourceSelectionCard";
import { ResourceTabsList } from "@liveagent/ui/components/resources/ResourceTabsList";
import { Badge } from "@liveagent/ui/components/ui/badge";
import { Input } from "@liveagent/ui/components/ui/input";
import { Tabs } from "@liveagent/ui/components/ui/tabs";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useModalMotion } from "@liveagent/ui/lib/shared/modalMotion";
import { cn } from "@liveagent/ui/lib/shared/utils";
import {
  type ClawHubCategorySlug,
  classifyClawHubSkill,
} from "@liveagent/ui/lib/skills/clawHubCategories";
import { isAlwaysEnabledSkillName, type SkillSummary } from "@liveagent/ui/lib/skills/index";
import { useEffect, useMemo, useState } from "react";
import {
  STORE_CATEGORY_ICONS,
  StoreCategoryChips,
  type StoreCategoryValue,
} from "../../pages/skills-hub/SkillCategoryControls";
import {
  AlertCircle,
  Blend,
  Cable,
  Folder,
  FolderTree,
  Loader2,
  Plus,
  Search,
  Settings,
  Shield,
  Trash2,
  X,
} from "../IconSet";
import { Button } from "../ui/button";

type ProjectSettingsPanel = "general" | "directories" | "resources";
type ResourceTab = "skills" | "mcp";

export type WorkspaceProjectRootAccess = "read" | "write";
export type WorkspaceProjectRootState = "active" | "missing" | "changed" | "pending-approval";

export type WorkspaceProjectRootGrant = {
  id: string;
  alias: string;
  displayPath: string;
  access: WorkspaceProjectRootAccess;
  state: WorkspaceProjectRootState;
};

export type WorkspaceProjectRootDraft = Pick<
  WorkspaceProjectRootGrant,
  "id" | "alias" | "displayPath" | "access"
>;

/**
 * Host-provided adapter for local root grants. The UI deliberately does not
 * persist filesystem permissions through normal settings sync.
 */
export type WorkspaceProjectRootClient = {
  list: (project: WorkspaceProject) => Promise<readonly WorkspaceProjectRootGrant[]>;
  save: (
    project: WorkspaceProject,
    roots: readonly WorkspaceProjectRootDraft[],
  ) => Promise<readonly WorkspaceProjectRootGrant[]>;
};

type ResourceSettingsDraft = {
  mode: WorkspaceResourceSettingsMode;
  skillNames: string[];
  mcpServerIds: string[];
};

function classifySkill(skill: Pick<SkillSummary, "name" | "description">): ClawHubCategorySlug[] {
  if (isAlwaysEnabledSkillName(skill.name)) return ["other"];
  return classifyClawHubSkill({
    slug: skill.name,
    displayName: skill.name,
    summary: skill.description,
    topics: [],
  });
}

function rootAliasFromPath(path: string, existingAliases: ReadonlySet<string>): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  const basename = parts.at(-1) ?? "reference";
  const stem =
    basename
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "reference";
  const safeStem = /^[a-z]/.test(stem) ? stem : `root-${stem}`;
  const base = ["workspace", "skill", "uploads", "external"].includes(safeStem)
    ? `root-${safeStem}`
    : safeStem;
  let alias = base.slice(0, 32);
  let suffix = 2;
  while (existingAliases.has(alias)) {
    const suffixText = `-${suffix}`;
    alias = `${base.slice(0, 32 - suffixText.length)}${suffixText}`;
    suffix += 1;
  }
  return alias;
}

function rootStateTone(state: WorkspaceProjectRootState): string {
  if (state === "active")
    return "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (state === "pending-approval")
    return "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  return "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300";
}

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
  const [tab, setTab] = useState<ResourceTab>("skills");
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
      return category === "all" || classifySkill(skill).includes(category);
    });
  }, [category, listedSkills, query]);

  const skillCategoryCounts = useMemo(() => {
    const counts = new Map<StoreCategoryValue, number>();
    counts.set("all", listedSkills.length);
    for (const { skill } of listedSkills) {
      for (const value of classifySkill(skill)) {
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
        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve());
        });
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

  const readonly = mode !== "custom";
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

  return (
    <Dialog.Root
      open={!isClosing && !directoryPickerActive}
      onOpenChange={(open) => {
        if (!open && !saving && !directoryPickerActive) requestClose();
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
                  <section className="mx-auto max-w-[680px] space-y-6 p-6 max-[720px]:p-4">
                    <div>
                      <h3 className="text-base font-semibold">
                        {t("chat.workspaceSettingsGeneral")}
                      </h3>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        {t("chat.workspaceSettingsGeneralDescription")}
                      </p>
                    </div>
                    <div className="overflow-hidden rounded-xl border border-border/60">
                      <div className="grid grid-cols-[140px_minmax(0,1fr)] items-start gap-4 border-b border-border/50 px-4 py-3.5 max-[520px]:grid-cols-1 max-[520px]:gap-2">
                        <div className="pt-2 text-xs font-medium text-muted-foreground max-[520px]:pt-0">
                          {t("chat.workspaceSettingsProjectName")}
                        </div>
                        <div className="min-w-0">
                          <Input
                            value={projectName}
                            onChange={(event) => setProjectName(event.currentTarget.value)}
                            disabled={!canRenameProject || saving}
                            aria-invalid={projectNameInvalid || undefined}
                            aria-describedby="workspace-project-name-description"
                            className={cn(
                              "h-9 text-sm font-medium",
                              projectNameInvalid &&
                                "border-destructive focus-visible:ring-destructive/20",
                            )}
                          />
                          <p
                            id="workspace-project-name-description"
                            className={cn(
                              "mt-1.5 text-[11px] leading-4 text-muted-foreground",
                              projectNameInvalid && "text-destructive",
                            )}
                          >
                            {projectNameInvalid
                              ? t("chat.workspaceSettingsProjectNameRequired")
                              : canRenameProject
                                ? t("chat.workspaceSettingsProjectNameDescription")
                                : t("chat.workspaceSettingsProjectNameReadonly")}
                          </p>
                        </div>
                      </div>
                      <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4 border-b border-border/50 px-4 py-3.5 max-[520px]:grid-cols-1 max-[520px]:gap-1">
                        <div className="text-xs font-medium text-muted-foreground">
                          {t("chat.workspaceSettingsProjectType")}
                        </div>
                        <div className="text-sm">{projectKindLabel}</div>
                      </div>
                      <div className="grid grid-cols-[140px_minmax(0,1fr)] items-start gap-4 px-4 py-3.5 max-[520px]:grid-cols-1 max-[520px]:gap-1">
                        <div className="text-xs font-medium text-muted-foreground">
                          {t("chat.workspaceSettingsPrimaryDirectory")}
                        </div>
                        <div className="break-all font-mono text-xs leading-5">{project.path}</div>
                      </div>
                    </div>
                    <div className="flex gap-3 rounded-xl border border-border/60 bg-muted/20 p-4">
                      <Shield className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      <p className="text-xs leading-5 text-muted-foreground">
                        {t("chat.workspaceSettingsPrimaryHint")}
                      </p>
                    </div>
                  </section>
                ) : null}

                {activePanel === "directories" ? (
                  <section className="mx-auto max-w-[720px] space-y-4 p-6 max-[720px]:p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h3 className="text-base font-semibold">
                          {t("chat.workspaceSettingsDirectories")}
                        </h3>
                        <p className="mt-1 max-w-[560px] text-xs leading-5 text-muted-foreground">
                          {t("chat.workspaceSettingsDirectoriesDescription")}
                        </p>
                      </div>
                      {rootClient ? (
                        <Button
                          size="sm"
                          className="shrink-0 gap-1.5"
                          onClick={() => void addDirectory()}
                          disabled={!rootsLoaded || rootsLoading}
                        >
                          <Plus className="h-3.5 w-3.5" />
                          {t("chat.workspaceSettingsAddDirectory")}
                        </Button>
                      ) : null}
                    </div>

                    <div className="rounded-xl border border-primary/20 bg-primary/[0.035] px-3 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                          <Folder className="h-3.5 w-3.5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">
                              {t("chat.workspaceSettingsPrimaryDirectory")}
                            </span>
                            <span className="rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                              {t("chat.workspaceSettingsPrimaryBadge")}
                            </span>
                          </div>
                          <div
                            className="mt-0.5 truncate font-mono text-[11px] leading-5 text-muted-foreground"
                            title={project.path}
                          >
                            {project.path}
                          </div>
                        </div>
                      </div>
                    </div>

                    {!rootClient ? (
                      <div className="flex gap-3 rounded-xl border border-border/60 bg-muted/20 p-4">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                        <div>
                          <div className="text-sm font-medium">
                            {t("chat.workspaceSettingsDirectoriesUnavailable")}
                          </div>
                          <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            {rootClientUnavailableDescription ??
                              t("chat.workspaceSettingsDirectoriesDesktopOnly")}
                          </p>
                        </div>
                      </div>
                    ) : rootsLoading ? (
                      <div className="flex min-h-28 items-center justify-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t("chat.workspaceSettingsDirectoriesLoading")}
                      </div>
                    ) : roots.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-border/70 px-6 py-9 text-center">
                        <FolderTree className="mx-auto h-6 w-6 text-muted-foreground/70" />
                        <div className="mt-3 text-sm font-medium">
                          {t("chat.workspaceSettingsDirectoriesEmpty")}
                        </div>
                        <p className="mx-auto mt-1 max-w-[420px] text-xs leading-5 text-muted-foreground">
                          {t("chat.workspaceSettingsDirectoriesEmptyDescription")}
                        </p>
                      </div>
                    ) : (
                      <div className="divide-y divide-border/40 overflow-hidden rounded-xl border border-border/50 bg-background/60">
                        {roots.map((root) => (
                          <div
                            key={root.id}
                            className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-3 py-2.5 transition-colors hover:bg-muted/30 max-[560px]:grid-cols-1"
                          >
                            <div className="min-w-0">
                              <div className="flex min-w-0 items-center gap-2">
                                <input
                                  value={root.alias}
                                  onChange={(event) => {
                                    const alias = event.currentTarget.value;
                                    setRoots((current) =>
                                      current.map((item) =>
                                        item.id === root.id ? { ...item, alias } : item,
                                      ),
                                    );
                                    setRootsDirty(true);
                                  }}
                                  aria-label={t("chat.workspaceSettingsDirectoryAlias")}
                                  maxLength={32}
                                  pattern="[a-z][a-z0-9_-]{0,31}"
                                  disabled={!rootsLoaded}
                                  className="h-7 min-w-0 max-w-[180px] rounded-md border border-transparent bg-transparent px-1.5 text-sm font-medium outline-none transition-colors hover:border-border/60 focus:border-border/60 focus:ring-2 focus:ring-foreground/10"
                                />
                                <span
                                  className={cn(
                                    "shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
                                    rootStateTone(root.state),
                                  )}
                                >
                                  {t(
                                    `chat.workspaceSettingsDirectoryState${root.state
                                      .split("-")
                                      .map((part) => part[0].toUpperCase() + part.slice(1))
                                      .join("")}`,
                                  )}
                                </span>
                              </div>
                              <div
                                className="mt-0.5 truncate font-mono text-[11px] leading-4 text-muted-foreground"
                                title={root.displayPath}
                              >
                                {root.displayPath}
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center justify-end gap-1 max-[560px]:justify-between">
                              <label
                                className="sr-only"
                                htmlFor={`workspace-root-access-${root.id}`}
                              >
                                {t("chat.workspaceSettingsDirectoryAccess")}
                              </label>
                              <select
                                id={`workspace-root-access-${root.id}`}
                                value={root.access}
                                disabled={!rootsLoaded}
                                onChange={(event) => {
                                  const access = event.currentTarget
                                    .value as WorkspaceProjectRootAccess;
                                  setRoots((current) =>
                                    current.map((item) =>
                                      item.id === root.id ? { ...item, access } : item,
                                    ),
                                  );
                                  setRootsDirty(true);
                                }}
                                className="h-8 rounded-md border border-border/60 bg-background px-2.5 text-xs outline-none focus:ring-2 focus:ring-foreground/10"
                              >
                                <option value="read">
                                  {t("chat.workspaceSettingsDirectoryRead")}
                                </option>
                                <option value="write">
                                  {t("chat.workspaceSettingsDirectoryWrite")}
                                </option>
                              </select>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive"
                                title={t("chat.workspaceSettingsRemoveDirectory")}
                                disabled={!rootsLoaded}
                                onClick={() => {
                                  setRoots((current) =>
                                    current.filter((item) => item.id !== root.id),
                                  );
                                  setRootsDirty(true);
                                }}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {rootError ? (
                      <div className="flex gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-xs text-destructive">
                        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>{rootError}</span>
                      </div>
                    ) : null}
                  </section>
                ) : null}

                {activePanel === "resources" ? (
                  <section className="flex min-h-full flex-col">
                    <div className="border-b border-border/60 px-6 py-5 max-[720px]:px-4">
                      <h3 className="text-base font-semibold">
                        {t("chat.workspaceSettingsResources")}
                      </h3>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        {t("chat.workspaceSettingsResourcesDescription")}
                      </p>
                      <Tabs
                        value={mode}
                        onValueChange={(value) => {
                          if (value === "inherit" || value === "custom" || value === "off") {
                            selectMode(value);
                          }
                        }}
                        className="mt-4"
                      >
                        <ResourceTabsList
                          value={mode}
                          items={(["inherit", "custom", "off"] as const).map((value) => ({
                            value,
                            label: t(
                              `chat.workspaceResourcesMode${value[0].toUpperCase()}${value.slice(1)}`,
                            ),
                          }))}
                          ariaLabel={t("chat.workspaceSettingsResources")}
                          className="grid w-full grid-cols-3"
                          triggerClassName="w-full px-2 text-xs"
                        />
                      </Tabs>
                      <p className="mt-2 text-[11px] text-muted-foreground">
                        {mode === "inherit"
                          ? t("chat.workspaceResourcesInheritHint")
                          : mode === "off"
                            ? t("chat.workspaceResourcesOffHint")
                            : t("chat.workspaceResourcesCustomHint")}
                      </p>
                    </div>

                    <div className="flex min-h-[360px] flex-1 flex-col px-6 py-4 max-[720px]:px-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <Tabs
                          value={tab}
                          onValueChange={(value) => {
                            if (value !== "skills" && value !== "mcp") return;
                            setTab(value);
                            setQuery("");
                          }}
                        >
                          <ResourceTabsList
                            value={tab}
                            items={[
                              {
                                value: "skills",
                                label: "Skills",
                                icon: Blend,
                                countLabel:
                                  listedSkills.length > 0
                                    ? `${visibleSelectedSkillCount}/${selectableSkills.length}`
                                    : null,
                              },
                              {
                                value: "mcp",
                                label: "MCP",
                                icon: Cable,
                                countLabel:
                                  settings.mcp.servers.length > 0
                                    ? `${visibleSelectedMcpCount}/${settings.mcp.servers.length}`
                                    : null,
                              },
                            ]}
                            ariaLabel={t("chat.workspaceSettingsResources")}
                          />
                        </Tabs>
                        <div className="relative min-w-[12rem] flex-1">
                          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                          <Input
                            type="search"
                            value={query}
                            onChange={(event) => setQuery(event.currentTarget.value)}
                            placeholder={t("chat.workspaceResourcesSearch")}
                            className="h-10 rounded-full border-border bg-background pl-10 pr-4 text-sm shadow-none placeholder:text-muted-foreground"
                          />
                        </div>
                      </div>

                      {tab === "skills" ? (
                        <StoreCategoryChips
                          value={category}
                          counts={skillCategoryCounts}
                          onChange={setCategory}
                          className="mt-3"
                        />
                      ) : null}

                      <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
                        <div className="space-y-2">
                          {tab === "skills"
                            ? filteredSkills.map(({ skill, missing }) => {
                                const alwaysEnabled = isAlwaysEnabledSkillName(skill.name);
                                const checked =
                                  settings.skills.enabled &&
                                  mode !== "off" &&
                                  (alwaysEnabled || visibleSkillSelection.has(skill.name));
                                const categories = classifySkill(skill);
                                const SkillIcon = STORE_CATEGORY_ICONS[categories[0] ?? "other"];
                                return (
                                  <ResourceSelectionCard
                                    key={skill.name}
                                    title={skill.name}
                                    description={skill.description}
                                    icon={SkillIcon}
                                    checked={checked}
                                    disabled={readonly || alwaysEnabled || !settings.skills.enabled}
                                    warning={missing}
                                    metadata={
                                      alwaysEnabled ? (
                                        <Badge variant="muted" className="h-5 px-1.5 text-[10px]">
                                          {t("settings.skillsAlwaysOn")}
                                        </Badge>
                                      ) : null
                                    }
                                    onCheckedChange={(next) => {
                                      const value = new Set(skillNames);
                                      if (next) value.add(skill.name);
                                      else value.delete(skill.name);
                                      setSkillNames(value);
                                    }}
                                  />
                                );
                              })
                            : filteredMcp.map((server) => {
                                const checked =
                                  mode !== "off" &&
                                  visibleMcpSelection.has(server.id) &&
                                  server.enabled;
                                const { Icon: TransportIcon, label: transportLabel } =
                                  getMcpTransportMeta(server.transport);
                                return (
                                  <ResourceSelectionCard
                                    key={server.id}
                                    title={server.id}
                                    description={
                                      server.description ||
                                      server.command ||
                                      server.url ||
                                      t("mcpHub.statusEmptyDesc")
                                    }
                                    icon={TransportIcon}
                                    checked={checked}
                                    disabled={readonly || !server.enabled}
                                    metadata={
                                      <Badge
                                        variant="muted"
                                        className="h-5 px-1.5 text-[10px] uppercase tracking-wide"
                                      >
                                        {transportLabel}
                                      </Badge>
                                    }
                                    onCheckedChange={(next) => {
                                      const value = new Set(mcpServerIds);
                                      if (next) value.add(server.id);
                                      else value.delete(server.id);
                                      setMcpServerIds(value);
                                    }}
                                  />
                                );
                              })}
                        </div>
                      </div>
                    </div>
                  </section>
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
