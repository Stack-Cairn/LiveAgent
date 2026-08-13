import {
  type AppSettings,
  type WorkspaceProject,
  type WorkspaceResourceSettingsMode,
  workspaceProjectPathKey,
} from "@liveagent/app/lib/settings";
import { Blend, Cable, Search } from "@liveagent/ui/components/IconSet";
import { getMcpTransportMeta } from "@liveagent/ui/components/resources/McpTransportMeta";
import { ResourceSelectionCard } from "@liveagent/ui/components/resources/ResourceSelectionCard";
import { ResourceTabsList } from "@liveagent/ui/components/resources/ResourceTabsList";
import { Badge } from "@liveagent/ui/components/ui/badge";
import { Input } from "@liveagent/ui/components/ui/input";
import {
  Sheet,
  SheetClose,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "@liveagent/ui/components/ui/sheet";
import { Tabs } from "@liveagent/ui/components/ui/tabs";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  type ClawHubCategorySlug,
  classifyClawHubSkill,
} from "@liveagent/ui/lib/skills/clawHubCategories";
import { isAlwaysEnabledSkillName, type SkillSummary } from "@liveagent/ui/lib/skills/index";
import { useMemo, useState } from "react";
import {
  STORE_CATEGORY_ICONS,
  StoreCategoryChips,
  type StoreCategoryValue,
} from "../../pages/skills-hub/SkillCategoryControls";
import { Button } from "../ui/button";

type ResourceTab = "skills" | "mcp";

function isResourceTab(value: unknown): value is ResourceTab {
  return value === "skills" || value === "mcp";
}

function isWorkspaceResourceMode(value: unknown): value is WorkspaceResourceSettingsMode {
  return value === "inherit" || value === "custom" || value === "off";
}

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
  const [category, setCategory] = useState<StoreCategoryValue>("all");

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

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetPopup
        side="right"
        variant="inset"
        closeLabel={t("window.close")}
        className="w-full sm:max-w-[720px]"
      >
        <SheetHeader className="flex-row items-start gap-3 border-b border-border px-5 py-4 pr-14">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/35">
            <Blend className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <SheetTitle>{t("chat.workspaceResourcesTitle")}</SheetTitle>
            <SheetDescription className="mt-1 min-w-0">
              <span className="block truncate text-xs text-foreground/75">{project.name}</span>
              <span
                className="block truncate text-[11px] text-muted-foreground"
                title={project.path}
              >
                {project.path}
              </span>
            </SheetDescription>
          </div>
        </SheetHeader>

        <div className="shrink-0 border-b border-border/60 px-5 py-4">
          <Tabs
            value={mode}
            onValueChange={(value) => {
              if (isWorkspaceResourceMode(value)) selectMode(value);
            }}
          >
            <ResourceTabsList
              value={mode}
              items={(["inherit", "custom", "off"] as const).map((value) => ({
                value,
                label: t(`chat.workspaceResourcesMode${value[0].toUpperCase()}${value.slice(1)}`),
              }))}
              ariaLabel={t("chat.workspaceResourcesTitle")}
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

        <SheetPanel className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 py-4">
          <Tabs
            value={tab}
            onValueChange={(value) => {
              if (!isResourceTab(value)) return;
              setTab(value);
              setQuery("");
            }}
            className="flex min-h-0 flex-1 flex-col"
          >
            <div className="flex flex-wrap items-center gap-2">
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
                ariaLabel={t("chat.workspaceResourcesTitle")}
              />
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

            <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-0.5 pb-1 pr-1">
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
                        mode !== "off" && visibleMcpSelection.has(server.id) && server.enabled;
                      const { Icon: TransportIcon, label: transportLabel } = getMcpTransportMeta(
                        server.transport,
                      );
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
          </Tabs>
        </SheetPanel>

        <SheetFooter className="flex-row items-center justify-between gap-3 border-t border-border px-5 py-4">
          <div className="text-xs text-muted-foreground">
            {mode === "custom"
              ? t("chat.workspaceResourcesSelected")
                  .replace("{skills}", String(skillNames.size))
                  .replace("{mcp}", String(mcpServerIds.size))
              : null}
          </div>
          <div className="flex gap-2">
            <SheetClose render={<Button variant="outline" />}>{t("chat.cancel")}</SheetClose>
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
        </SheetFooter>
      </SheetPopup>
    </Sheet>
  );
}
