import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Blend, Cable, Search, X } from "@liveagent/app/components/icons";
import {
  type AppSettings,
  type WorkspaceProject,
  type WorkspaceResourceSettingsMode,
  workspaceProjectPathKey,
} from "@liveagent/app/lib/settings";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { isAlwaysEnabledSkillName, type SkillSummary } from "@liveagent/ui/lib/skills/index";
import {
  CLAWHUB_CATEGORY_SLUGS,
  type ClawHubCategorySlug,
  classifyClawHubSkill,
} from "@liveagent/ui/lib/skills/clawHubCategories";
import { ResourceActivationSwitch } from "../resources/ResourceActivationSwitch";
import { Button } from "../ui/button";

type ResourceTab = "skills" | "mcp";
type SkillCategory = "all" | ClawHubCategorySlug;

function classifySkill(skill: Pick<SkillSummary, "name" | "description">): ClawHubCategorySlug[] {
  if (isAlwaysEnabledSkillName(skill.name)) return ["other"];
  return classifyClawHubSkill({
    slug: skill.name,
    displayName: skill.name,
    summary: skill.description,
    topics: [],
  });
}

export function WorkspaceResourceSettingsDrawer(props: {
  project: WorkspaceProject;
  settings: AppSettings;
  skills: SkillSummary[];
  onSave: (draft: {
    mode: WorkspaceResourceSettingsMode;
    skillNames: string[];
    mcpServerIds: string[];
  }) => void;
  onClose: () => void;
}) {
  const { project, settings, skills, onSave, onClose } = props;
  const { t } = useLocale();
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
  const [mode, setMode] = useState<WorkspaceResourceSettingsMode>(saved?.mode ?? "inherit");
  const [skillNames, setSkillNames] = useState<Set<string>>(
    () => new Set(saved?.mode === "custom" ? saved.skillNames : globalSkillNames),
  );
  const [mcpServerIds, setMcpServerIds] = useState<Set<string>>(
    () => new Set(saved?.mode === "custom" ? saved.mcpServerIds : globalMcpIds),
  );
  const [tab, setTab] = useState<ResourceTab>("skills");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<SkillCategory>("all");

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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const selectMode = (next: WorkspaceResourceSettingsMode) => {
    if (next === "custom" && mode !== "custom") {
      setSkillNames(new Set(globalSkillNames));
      setMcpServerIds(new Set(globalMcpIds));
    }
    setMode(next);
  };

  const filteredSkills = useMemo(() => {
    const text = query.trim().toLowerCase();
    return listedSkills.filter(({ skill }) => {
      if (text && !`${skill.name}\n${skill.description}`.toLowerCase().includes(text)) return false;
      return category === "all" || classifySkill(skill).includes(category);
    });
  }, [category, listedSkills, query]);

  const filteredMcp = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return settings.mcp.servers;
    return settings.mcp.servers.filter((server) =>
      `${server.id}\n${server.transport}\n${server.command}\n${server.url}`
        .toLowerCase()
        .includes(text),
    );
  }, [query, settings.mcp.servers]);

  const readonly = mode !== "custom";
  const visibleSkillSelection = mode === "inherit" ? globalSkillNames : skillNames;
  const visibleMcpSelection = mode === "inherit" ? globalMcpIds : mcpServerIds;

  return createPortal(
    <div className="fixed inset-0 z-[120] flex justify-end" role="dialog" aria-modal="true">
      <button
        type="button"
        className="skills-drawer-backdrop-enter absolute inset-0 bg-black/35 backdrop-blur-[2px]"
        aria-label={t("window.close")}
        onClick={onClose}
      />
      <aside className="skills-drawer-panel-enter relative flex h-full w-full max-w-[720px] flex-col border-l border-border/60 bg-background shadow-2xl">
        <header className="flex items-start gap-3 border-b border-border/60 px-5 py-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/35">
            <Blend className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold">{t("chat.workspaceResourcesTitle")}</h2>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">{project.name}</div>
            <div className="truncate text-[11px] text-muted-foreground/75" title={project.path}>
              {project.path}
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} title={t("window.close")}>
            <X className="h-4 w-4" />
          </Button>
        </header>

        <div className="border-b border-border/60 px-5 py-4">
          <div className="grid grid-cols-3 gap-1 rounded-lg border border-border/50 bg-muted/25 p-1">
            {(["inherit", "custom", "off"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => selectMode(value)}
                className={cn(
                  "h-9 rounded-md px-3 text-xs font-medium transition-colors",
                  mode === value
                    ? "bg-background text-foreground shadow-sm ring-1 ring-border/60"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t(`chat.workspaceResourcesMode${value[0].toUpperCase()}${value.slice(1)}`)}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            {mode === "inherit"
              ? t("chat.workspaceResourcesInheritHint")
              : mode === "off"
                ? t("chat.workspaceResourcesOffHint")
                : t("chat.workspaceResourcesCustomHint")}
          </p>
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border border-border/50 bg-muted/20 p-1">
              {(["skills", "mcp"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    setTab(value);
                    setQuery("");
                  }}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium",
                    tab === value
                      ? "bg-background shadow-sm ring-1 ring-border/60"
                      : "text-muted-foreground",
                  )}
                >
                  {value === "skills" ? (
                    <Blend className="h-3.5 w-3.5" />
                  ) : (
                    <Cable className="h-3.5 w-3.5" />
                  )}
                  {value === "skills" ? "Skills" : "MCP"}
                </button>
              ))}
            </div>
            <div className="relative min-w-[12rem] flex-1">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder={t("chat.workspaceResourcesSearch")}
                className="h-10 w-full rounded-lg border border-border/60 bg-background pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-foreground/10"
              />
            </div>
          </div>

          {tab === "skills" ? (
            <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1">
              {(["all", ...CLAWHUB_CATEGORY_SLUGS] as SkillCategory[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setCategory(value)}
                  className={cn(
                    "h-7 shrink-0 rounded-md border px-2.5 text-[11px]",
                    category === value
                      ? "border-foreground/20 bg-foreground/[0.07] text-foreground"
                      : "border-border/50 text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(`settings.skillsStoreCategory${value[0].toUpperCase()}${value.slice(1)}`)}
                </button>
              ))}
            </div>
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
                    return (
                      <div
                        key={skill.name}
                        className="flex items-center gap-3 rounded-lg border border-border/55 bg-background px-3.5 py-3"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{skill.name}</div>
                          <div
                            className={cn(
                              "mt-0.5 line-clamp-2 text-xs text-muted-foreground",
                              missing && "text-amber-600 dark:text-amber-300",
                            )}
                          >
                            {skill.description}
                          </div>
                        </div>
                        <ResourceActivationSwitch
                          checked={checked}
                          disabled={readonly || alwaysEnabled || !settings.skills.enabled}
                          label={skill.name}
                          onCheckedChange={(next) => {
                            const value = new Set(skillNames);
                            if (next) value.add(skill.name);
                            else value.delete(skill.name);
                            setSkillNames(value);
                          }}
                        />
                      </div>
                    );
                  })
                : filteredMcp.map((server) => {
                    const checked =
                      mode !== "off" && visibleMcpSelection.has(server.id) && server.enabled;
                    return (
                      <div
                        key={server.id}
                        className="flex items-center gap-3 rounded-lg border border-border/55 bg-background px-3.5 py-3"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium">{server.id}</span>
                            <span className="rounded border border-border/50 px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                              {server.transport}
                            </span>
                          </div>
                          <div className="mt-0.5 truncate text-xs text-muted-foreground">
                            {server.command || server.url || t("mcpHub.statusEmptyDesc")}
                          </div>
                        </div>
                        <ResourceActivationSwitch
                          checked={checked}
                          disabled={readonly || !server.enabled}
                          label={server.id}
                          onCheckedChange={(next) => {
                            const value = new Set(mcpServerIds);
                            if (next) value.add(server.id);
                            else value.delete(server.id);
                            setMcpServerIds(value);
                          }}
                        />
                      </div>
                    );
                  })}
            </div>
          </div>
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-border/60 px-5 py-4">
          <div className="text-xs text-muted-foreground">
            {mode === "custom"
              ? t("chat.workspaceResourcesSelected")
                  .replace("{skills}", String(skillNames.size))
                  .replace("{mcp}", String(mcpServerIds.size))
              : null}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              {t("chat.cancel")}
            </Button>
            <Button
              onClick={() =>
                onSave({
                  mode,
                  skillNames: [...skillNames],
                  mcpServerIds: [...mcpServerIds],
                })
              }
            >
              {t("workspaceEditor.save")}
            </Button>
          </div>
        </footer>
      </aside>
    </div>,
    document.body,
  );
}
