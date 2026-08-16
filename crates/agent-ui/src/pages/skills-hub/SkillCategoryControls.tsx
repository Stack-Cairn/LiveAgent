import {
  Activity,
  BookOpen,
  Brain,
  Globe,
  House,
  Layers,
  ListChecks,
  MessageCircle,
  Package,
  Palette,
  Plug,
  Shield,
  Wallet,
  Wrench,
  Zap,
} from "@liveagent/ui/components/IconSet";
import { Badge } from "@liveagent/ui/components/ui/badge";
import { Button } from "@liveagent/ui/components/ui/button";
import { SearchHighlight } from "@liveagent/ui/components/ui/search-highlight";
import { Tabs, TabsList, TabsTrigger } from "@liveagent/ui/components/ui/tabs";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import {
  CLAWHUB_CATEGORY_SLUGS,
  type ClawHubCategorySlug,
  classifyClawHubSkill,
} from "@liveagent/ui/lib/skills/clawHubCategories";
import type { SkillSummary } from "@liveagent/ui/lib/skills/index";

export type StoreCategoryValue = "all" | ClawHubCategorySlug;

// 图标与 ClawHub 官网分类侧边栏一一对应（layers/plug/zap/globe/wrench/…）。
export const STORE_CATEGORY_ICONS: Record<StoreCategoryValue, typeof Layers> = {
  all: Layers,
  integrations: Plug,
  automation: Zap,
  research: Globe,
  development: Wrench,
  productivity: ListChecks,
  communication: MessageCircle,
  creative: Palette,
  knowledge: BookOpen,
  agents: Brain,
  operations: Activity,
  security: Shield,
  finance: Wallet,
  lifestyle: House,
  other: Package,
};

const STORE_CATEGORY_OPTIONS: readonly StoreCategoryValue[] = ["all", ...CLAWHUB_CATEGORY_SLUGS];

function storeCategoryLabelKey(value: StoreCategoryValue): string {
  return `settings.skillsStoreCategory${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

// 已安装技能没有 ClawHub 的 topics 字段，用名称+描述做启发式分类。
export function classifyInstalledSkill(skill: SkillSummary): ClawHubCategorySlug[] {
  return classifyClawHubSkill({
    slug: skill.name,
    displayName: skill.name,
    summary: skill.description,
    topics: [],
  });
}

export function StoreCategoryChips(props: {
  value: StoreCategoryValue;
  counts: ReadonlyMap<StoreCategoryValue, number>;
  onChange: (value: StoreCategoryValue) => void;
  className?: string;
  appearance?: "quiet" | "outlined";
  showIcons?: boolean;
}) {
  const { t } = useLocale();
  const appearance = props.appearance ?? "quiet";
  const showIcons = props.showIcons ?? true;
  return (
    <div className={cn("hub-panel-enter", props.className)}>
      <Tabs
        value={props.value}
        onValueChange={(value) => {
          if (STORE_CATEGORY_OPTIONS.includes(value as StoreCategoryValue)) {
            props.onChange(value as StoreCategoryValue);
          }
        }}
        className="max-w-full"
      >
        <TabsList
          aria-label={t("settings.skillsStoreCategoryAll")}
          className="flex h-auto max-w-full flex-nowrap justify-start gap-1 overflow-x-auto rounded-none bg-transparent p-0 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {STORE_CATEGORY_OPTIONS.map((value) => {
            const CategoryIcon = STORE_CATEGORY_ICONS[value];
            const count = props.counts.get(value) ?? 0;
            return (
              <TabsTrigger
                key={value}
                value={value}
                aria-label={`${t(storeCategoryLabelKey(value))}: ${count}`}
                className={cn(
                  "group h-7 shrink-0 gap-1 rounded-md px-2 text-[11.5px] font-medium text-muted-foreground shadow-none hover:text-foreground data-[active]:text-foreground data-[active]:shadow-none",
                  appearance === "outlined"
                    ? "border border-border/70 bg-background hover:border-foreground/20 hover:bg-muted/50 data-[active]:border-foreground/25 data-[active]:bg-muted data-[active]:shadow-xs"
                    : "border border-transparent hover:bg-muted/60 data-[active]:bg-muted",
                )}
              >
                {showIcons ? <CategoryIcon className="h-3.5 w-3.5" /> : null}
                <span>{t(storeCategoryLabelKey(value))}</span>
                <Badge
                  variant="muted"
                  className="h-4 min-w-4 rounded-full px-1 text-[9.5px] font-semibold tabular-nums group-data-[active]:bg-foreground/[0.08] group-data-[active]:text-foreground"
                >
                  {count}
                </Badge>
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>
    </div>
  );
}

export function InstalledSkillCategoryChip(props: {
  category: ClawHubCategorySlug;
  onSelect: (category: ClawHubCategorySlug) => void;
}) {
  const { t } = useLocale();
  const CategoryIcon = STORE_CATEGORY_ICONS[props.category];
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={(event) => {
        event.stopPropagation();
        props.onSelect(props.category);
      }}
      onKeyDown={(event) => event.stopPropagation()}
      className="h-6 shrink-0 gap-1 px-1.5 text-[10px] font-medium text-muted-foreground hover:text-foreground"
    >
      <CategoryIcon className="h-2.5 w-2.5" />
      <span>{t(storeCategoryLabelKey(props.category))}</span>
    </Button>
  );
}

export function SkillCategoryBadges(props: {
  categories: ClawHubCategorySlug[];
  topics?: string[];
  searchQuery?: string;
  onSelect: (category: ClawHubCategorySlug) => void;
}) {
  const { t } = useLocale();
  return (
    <div className="flex flex-wrap items-center gap-1">
      {props.categories.map((category) => {
        const BadgeIcon = STORE_CATEGORY_ICONS[category];
        return (
          <Button
            key={category}
            variant="ghost"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              props.onSelect(category);
            }}
            onKeyDown={(event) => event.stopPropagation()}
            className="h-6 shrink-0 gap-1 px-1.5 text-[10px] font-medium text-muted-foreground hover:text-foreground"
          >
            <BadgeIcon className="h-2.5 w-2.5" />
            <span>{t(storeCategoryLabelKey(category))}</span>
          </Button>
        );
      })}
      {(props.topics ?? []).slice(0, 3).map((topic) => (
        <span
          key={topic}
          className="shrink-0 rounded-md bg-muted px-1.5 py-1 text-[10px] text-muted-foreground"
        >
          <SearchHighlight text={topic} query={props.searchQuery ?? ""} />
        </span>
      ))}
    </div>
  );
}
