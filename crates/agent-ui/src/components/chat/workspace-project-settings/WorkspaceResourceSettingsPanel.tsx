import type { AppSettings, WorkspaceResourceSettingsMode } from "@liveagent/app/lib/settings";
import { getMcpTransportMeta } from "@liveagent/ui/components/resources/McpTransportMeta";
import { ResourceSelectionCard } from "@liveagent/ui/components/resources/ResourceSelectionCard";
import { ResourceTabsList } from "@liveagent/ui/components/resources/ResourceTabsList";
import { Badge } from "@liveagent/ui/components/ui/badge";
import { Input } from "@liveagent/ui/components/ui/input";
import { Tabs } from "@liveagent/ui/components/ui/tabs";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { isAlwaysEnabledSkillName, type SkillSummary } from "@liveagent/ui/lib/skills/index";
import type { ComponentType } from "react";
import {
  STORE_CATEGORY_ICONS,
  StoreCategoryChips,
  type StoreCategoryValue,
} from "../../../pages/skills-hub/SkillCategoryControls";
import { Ban, Blend, Cable, Globe2, Search, Settings2 } from "../../IconSet";
import { classifyWorkspaceSkill } from "./workspaceProjectSettingsUtils";

export type WorkspaceResourceTab = "skills" | "mcp";

const RESOURCE_MODES = [
  {
    value: "inherit",
    Icon: Globe2,
    labelKey: "chat.workspaceResourcesModeInherit",
    hintKey: "chat.workspaceResourcesInheritHint",
  },
  {
    value: "custom",
    Icon: Settings2,
    labelKey: "chat.workspaceResourcesModeCustom",
    hintKey: "chat.workspaceResourcesCustomHint",
  },
  {
    value: "off",
    Icon: Ban,
    labelKey: "chat.workspaceResourcesModeOff",
    hintKey: "chat.workspaceResourcesOffHint",
  },
] as const satisfies readonly {
  value: WorkspaceResourceSettingsMode;
  Icon: ComponentType<{ className?: string }>;
  labelKey: string;
  hintKey: string;
}[];

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
  filteredSkills: readonly ListedSkill[];
  filteredMcp: AppSettings["mcp"]["servers"];
  skillCategoryCounts: ReadonlyMap<StoreCategoryValue, number>;
  visibleSkillSelection: ReadonlySet<string>;
  visibleMcpSelection: ReadonlySet<string>;
  skillNames: ReadonlySet<string>;
  mcpServerIds: ReadonlySet<string>;
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
    filteredSkills,
    filteredMcp,
    skillCategoryCounts,
    visibleSkillSelection,
    visibleMcpSelection,
    skillNames,
    mcpServerIds,
    onModeChange,
    onTabChange,
    onQueryChange,
    onCategoryChange,
    onSkillNamesChange,
    onMcpServerIdsChange,
  } = props;
  const { t } = useLocale();
  const readonly = mode !== "custom";
  return (
    <section className="flex min-h-full flex-col">
      <div className="px-6 py-5 max-[720px]:px-4">
        <h3 className="text-sm font-semibold">{t("chat.workspaceSettingsResources")}</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {t("chat.workspaceSettingsResourcesDescription")}
        </p>
        {/* Mode cards, not tabs: these are three mutually exclusive settings,
            not three views. Picking "inherit" or "off" leaves the same list
            below, just read-only — so a nav control read wrong. Same shape as
            WorkspaceCloneModal's create-mode picker. */}
        <div
          className="mt-4 grid gap-2 sm:grid-cols-3"
          role="radiogroup"
          aria-label={t("chat.workspaceSettingsResources")}
        >
          {RESOURCE_MODES.map(({ value, Icon, labelKey, hintKey }) => {
            const isActive = mode === value;
            return (
              // biome-ignore lint/a11y/useSemanticElements: Mode cards carry an icon, a label and a hint; a native radio cannot render that as one focusable choice.
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={isActive}
                onClick={() => onModeChange(value)}
                className={cn(
                  "flex flex-col gap-1 rounded-lg p-2.5 text-left transition-colors focus-visible:outline-hidden",
                  isActive ? "bg-primary/[0.08]" : "bg-muted/40 hover:bg-muted/70",
                )}
              >
                <span className="flex items-center gap-2">
                  <Icon
                    className={cn(
                      "h-4 w-4 shrink-0 text-muted-foreground",
                      isActive && "text-primary",
                    )}
                  />
                  <span className="text-sm font-medium">{t(labelKey)}</span>
                </span>
                <span className="text-xs leading-relaxed text-muted-foreground">{t(hintKey)}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex min-h-[360px] flex-1 flex-col px-6 py-4 max-[720px]:px-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-60 max-w-full">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              onChange={(event) => onQueryChange(event.currentTarget.value)}
              placeholder={t("chat.workspaceResourcesSearch")}
              className="h-8 rounded-lg border-border bg-background pl-9 pr-3 text-sm shadow-none placeholder:text-muted-foreground"
            />
          </div>
          <Tabs
            value={tab}
            onValueChange={(value) => {
              if (value === "skills" || value === "mcp") onTabChange(value);
            }}
            className="ml-auto shrink-0"
          >
            <ResourceTabsList
              value={tab}
              items={[
                { value: "skills", label: "Skills", icon: Blend },
                { value: "mcp", label: "MCP", icon: Cable },
              ]}
              ariaLabel={t("chat.workspaceSettingsResources")}
            />
          </Tabs>
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
          <div className="space-y-1.5">
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
