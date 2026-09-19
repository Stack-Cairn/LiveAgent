import { GlassPanel } from "@liveagent/ui/components/hub/HubChrome";
import { AlertTriangle, BookOpen, RefreshCw } from "@liveagent/ui/components/IconSet";
import { RefreshButton } from "@liveagent/ui/components/ui/button";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import type { ClawHubCategorySlug } from "@liveagent/ui/lib/skills/clawHubCategories";
import { isAlwaysEnabledSkillName, type SkillSummary } from "@liveagent/ui/lib/skills/index";
import { InstalledSkillCard } from "./InstalledSkillCard";
import { StoreCategoryChips, type StoreCategoryValue } from "./SkillCategoryControls";
import { SkillsContentLoadingState } from "./SkillsLoading";
import { SKILL_LIST_GRID_CLASS } from "./skillCardLayout";

export type InstalledSkillListItem = {
  skill: SkillSummary;
  categories: ClawHubCategorySlug[];
};

type InstalledSkillsViewProps = {
  items: readonly InstalledSkillListItem[];
  loading: boolean;
  initialContentPending: boolean;
  bulkMode: boolean;
  hasSkills: boolean;
  loadError: string | null;
  skillsEnabled: boolean;
  rootDir: string;
  category: StoreCategoryValue;
  categoryCounts: ReadonlyMap<StoreCategoryValue, number>;
  onSelectCategory: (category: StoreCategoryValue) => void;
  searchQuery: string;
  filter: string;
  selected: ReadonlySet<string>;
  bulkSelection: ReadonlySet<string>;
  deletingSkillName: string | null;
  onRescan: () => void;
  onToggle: (name: string, on: boolean) => void;
  onEnterBulkMode: (name: string) => void;
  onToggleBulkSelection: (name: string) => void;
  onBulkCardClick: (name: string, shiftKey: boolean) => void;
  onOpenPreview: (skill: SkillSummary) => void;
  onDelete: (skill: SkillSummary) => void;
};

export function InstalledSkillsView({
  items,
  loading,
  initialContentPending,
  bulkMode,
  hasSkills,
  loadError,
  skillsEnabled,
  rootDir,
  category,
  categoryCounts,
  onSelectCategory,
  searchQuery,
  filter,
  selected,
  bulkSelection,
  deletingSkillName,
  onRescan,
  onToggle,
  onEnterBulkMode,
  onToggleBulkSelection,
  onBulkCardClick,
  onOpenPreview,
  onDelete,
}: InstalledSkillsViewProps) {
  const { t } = useLocale();

  return (
    <div
      aria-busy={loading || initialContentPending}
      className={cn(
        "h-full min-h-0 overflow-y-auto px-0.5 pr-1 [overflow-anchor:none]",
        bulkMode ? "pb-safe-bottom-10rem sm:pb-24" : "pb-4",
      )}
    >
      <div className="flex flex-col gap-3">
        {hasSkills || loading ? (
          <StoreCategoryChips
            value={category}
            counts={categoryCounts}
            onChange={onSelectCategory}
            className="sticky top-0 z-30 -mx-0.5 bg-background/95 px-0.5 backdrop-blur supports-[backdrop-filter]:bg-background/90"
          />
        ) : null}

        {loadError ? (
          <GlassPanel tone="error">
            <div className="flex items-center gap-2">
              <AlertTriangle className="size-4 shrink-0 text-destructive" />
              <span className="text-xs text-destructive">{loadError}</span>
            </div>
          </GlassPanel>
        ) : null}

        {!skillsEnabled ? (
          <GlassPanel tone="muted">
            <div className="flex items-center gap-2">
              <BookOpen className="size-4 shrink-0 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">
                {t("settings.skillsDisabledHint")}
              </span>
            </div>
          </GlassPanel>
        ) : null}

        {!loading && !hasSkills && !loadError ? (
          <GlassPanel>
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <div className="flex size-12 items-center justify-center rounded-full bg-muted/60">
                <BookOpen className="size-5 text-muted-foreground" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">
                  {t("settings.skillsNotFound")}
                </p>
                <p className="text-xs text-muted-foreground">{t("settings.skillsNotFoundHint")}</p>
              </div>
              <RefreshButton
                aria-busy={loading}
                variant="outline"
                size="sm"
                className="mt-1 gap-1.5 rounded-full"
                onClick={onRescan}
              >
                <RefreshCw data-refresh-icon className="size-3.5" />
                {t("settings.skillsRescan")}
              </RefreshButton>
            </div>
          </GlassPanel>
        ) : null}

        {loading && !hasSkills ? (
          <SkillsContentLoadingState
            title={t("settings.skillsScanning")}
            description={t("settings.skillsHubScanning")}
          />
        ) : initialContentPending ? (
          <SkillsContentLoadingState
            title={t("settings.skillsHubPreparing")}
            description={t("settings.skillsHubPreparingDesc")}
          />
        ) : null}

        {items.length > 0 ? (
          <div className={SKILL_LIST_GRID_CLASS}>
            {items.map(({ skill, categories }) => {
              const alwaysEnabled = isAlwaysEnabledSkillName(skill.name);
              return (
                <div key={`${skill.name}-${rootDir}`} className="min-w-0">
                  <InstalledSkillCard
                    skill={skill}
                    primaryCategory={categories[0] ?? "other"}
                    alwaysEnabled={alwaysEnabled}
                    checked={alwaysEnabled || selected.has(skill.name)}
                    skillsEnabled={skillsEnabled}
                    bulkMode={bulkMode}
                    bulkSelected={bulkSelection.has(skill.name)}
                    deleting={deletingSkillName === skill.name}
                    deleteDisabled={deletingSkillName !== null}
                    searchQuery={searchQuery}
                    onToggle={onToggle}
                    onEnterBulkMode={onEnterBulkMode}
                    onToggleBulkSelection={onToggleBulkSelection}
                    onBulkCardClick={onBulkCardClick}
                    onOpenPreview={onOpenPreview}
                    onDelete={onDelete}
                    onSelectCategory={onSelectCategory}
                  />
                </div>
              );
            })}
          </div>
        ) : null}

        {(filter.trim() || category !== "all") && items.length === 0 && hasSkills ? (
          <GlassPanel tone="muted">
            <p className="py-2 text-center text-sm text-muted-foreground">
              {filter.trim()
                ? t("settings.skillsNoMatch").replace("{filter}", filter)
                : t("settings.skillsStoreEmptyTitle")}
            </p>
          </GlassPanel>
        ) : null}
      </div>
    </div>
  );
}
