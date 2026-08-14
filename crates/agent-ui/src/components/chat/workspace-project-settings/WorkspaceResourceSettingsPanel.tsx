import type { AppSettings, WorkspaceResourceSettingsMode } from "@liveagent/app/lib/settings";
import { getMcpTransportMeta } from "@liveagent/ui/components/resources/McpTransportMeta";
import { ResourceSelectionCard } from "@liveagent/ui/components/resources/ResourceSelectionCard";
import { ResourceTabsList } from "@liveagent/ui/components/resources/ResourceTabsList";
import { Badge } from "@liveagent/ui/components/ui/badge";
import { Input } from "@liveagent/ui/components/ui/input";
import { Tabs } from "@liveagent/ui/components/ui/tabs";
import { useLocale } from "@liveagent/ui/i18n/index";
import { isAlwaysEnabledSkillName, type SkillSummary } from "@liveagent/ui/lib/skills/index";
import {
  STORE_CATEGORY_ICONS,
  StoreCategoryChips,
  type StoreCategoryValue,
} from "../../../pages/skills-hub/SkillCategoryControls";
import { Blend, Cable, Search } from "../../IconSet";
import { classifyWorkspaceSkill } from "./workspaceProjectSettingsUtils";

export type WorkspaceResourceTab = "skills" | "mcp";

type ListedSkill = {
  skill: Pick<SkillSummary, "name" | "description">;
  missing: boolean;
};

export function WorkspaceResourceSettingsPanel(props: {
  settings: AppSettings;
  mode: WorkspaceResourceSettingsMode;
  tab: WorkspaceResourceTab;
  query: string;
  category: StoreCategoryValue;
  listedSkills: readonly ListedSkill[];
  filteredSkills: readonly ListedSkill[];
  filteredMcp: AppSettings["mcp"]["servers"];
  skillCategoryCounts: ReadonlyMap<StoreCategoryValue, number>;
  visibleSkillSelection: ReadonlySet<string>;
  visibleMcpSelection: ReadonlySet<string>;
  skillNames: ReadonlySet<string>;
  mcpServerIds: ReadonlySet<string>;
  visibleSelectedSkillCount: number;
  visibleSelectedMcpCount: number;
  onModeChange: (mode: WorkspaceResourceSettingsMode) => void;
  onTabChange: (tab: WorkspaceResourceTab) => void;
  onQueryChange: (query: string) => void;
  onCategoryChange: (category: StoreCategoryValue) => void;
  onSkillNamesChange: (names: Set<string>) => void;
  onMcpServerIdsChange: (ids: Set<string>) => void;
}) {
  const {
    settings,
    mode,
    tab,
    query,
    category,
    listedSkills,
    filteredSkills,
    filteredMcp,
    skillCategoryCounts,
    visibleSkillSelection,
    visibleMcpSelection,
    skillNames,
    mcpServerIds,
    visibleSelectedSkillCount,
    visibleSelectedMcpCount,
    onModeChange,
    onTabChange,
    onQueryChange,
    onCategoryChange,
    onSkillNamesChange,
    onMcpServerIdsChange,
  } = props;
  const { t } = useLocale();
  const readonly = mode !== "custom";
  const selectableSkillCount = listedSkills.filter(
    ({ skill }) => !isAlwaysEnabledSkillName(skill.name),
  ).length;

  return (
    <section className="flex min-h-full flex-col">
      <div className="border-b border-border/60 px-6 py-5 max-[720px]:px-4">
        <h3 className="text-base font-semibold">{t("chat.workspaceSettingsResources")}</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {t("chat.workspaceSettingsResourcesDescription")}
        </p>
        <Tabs
          value={mode}
          onValueChange={(value) => {
            if (value === "inherit" || value === "custom" || value === "off") {
              onModeChange(value);
            }
          }}
          className="mt-4"
        >
          <ResourceTabsList
            value={mode}
            items={(["inherit", "custom", "off"] as const).map((value) => ({
              value,
              label: t(`chat.workspaceResourcesMode${value[0].toUpperCase()}${value.slice(1)}`),
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
              if (value === "skills" || value === "mcp") onTabChange(value);
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
                      ? `${visibleSelectedSkillCount}/${selectableSkillCount}`
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
              onChange={(event) => onQueryChange(event.currentTarget.value)}
              placeholder={t("chat.workspaceResourcesSearch")}
              className="h-10 rounded-full border-border bg-background pl-10 pr-4 text-sm shadow-none placeholder:text-muted-foreground"
            />
          </div>
        </div>

        {tab === "skills" ? (
          <StoreCategoryChips
            value={category}
            counts={skillCategoryCounts}
            onChange={onCategoryChange}
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
                  const categories = classifyWorkspaceSkill(skill);
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
                        onSkillNamesChange(value);
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
                        onMcpServerIdsChange(value);
                      }}
                    />
                  );
                })}
          </div>
        </div>
      </div>
    </section>
  );
}
