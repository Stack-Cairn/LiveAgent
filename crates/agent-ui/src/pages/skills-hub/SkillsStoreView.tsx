import {
  AlertTriangle,
  Check,
  Cloud,
  ExternalLink,
  Loader2,
  RefreshCw,
  SkillIcon,
  X,
} from "@liveagent/app/components/icons";
import { GlassPanel } from "@liveagent/ui/components/hub/HubChrome";
import { Button } from "@liveagent/ui/components/ui/button";
import { SearchHighlight } from "@liveagent/ui/components/ui/search-highlight";
import { Separator } from "@liveagent/ui/components/ui/separator";
import {
  Sheet,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "@liveagent/ui/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@liveagent/ui/components/ui/toggle-group";
import { useLocale } from "@liveagent/ui/i18n/index";
import { rankFuzzySearchResults } from "@liveagent/ui/lib/shared/fuzzySearch";
import { cn } from "@liveagent/ui/lib/shared/utils";
import {
  buildClawHubSkillKey,
  type ClawHubSkillCard,
  type ClawHubSkillDetail,
  type ClawHubSort,
} from "@liveagent/ui/lib/skills/clawHub";
import { classifyClawHubSkill } from "@liveagent/ui/lib/skills/clawHubCategories";
import {
  cancelSkillInstallJob,
  type SkillInstallJobSnapshot,
} from "@liveagent/ui/lib/skills/index";
import { useEffect, useMemo, useState } from "react";
import {
  SkillCategoryBadges,
  STORE_CATEGORY_ICONS,
  StoreCategoryChips,
  type StoreCategoryValue,
} from "./SkillCategoryControls";
import { FrostSpinner } from "./SkillsLoading";
import {
  isSkillStoreDetailFresh,
  loadSkillStoreDetail,
  readSkillStoreDetail,
} from "./skillStoreCache";
import { useDrawerPresence } from "./useDrawerPresence";

export const TERMINAL_INSTALL_PHASES = new Set(["done", "error", "cancelled"]);
const STORE_CATEGORY_FILL_TARGET = 12;
const STORE_SORT_OPTIONS: Array<{ value: ClawHubSort; labelKey: string }> = [
  { value: "downloads", labelKey: "settings.skillsStoreSortMostDownloaded" },
  { value: "stars", labelKey: "settings.skillsStoreSortMostStarred" },
  { value: "installs", labelKey: "settings.skillsStoreSortMostInstalled" },
  { value: "updated", labelKey: "settings.skillsStoreSortRecentlyUpdated" },
  { value: "newest", labelKey: "settings.skillsStoreSortNewest" },
];

type StoreSkillInstallState = {
  done: boolean;
  installing: boolean;
  pending: boolean;
  terminalJob: boolean;
  job: SkillInstallJobSnapshot | undefined;
  progress: number | null;
};

let cachedCompactNumberFormat: Intl.NumberFormat | null = null;
let cachedShortDateFormat: Intl.DateTimeFormat | null = null;
let cachedFullDateFormat: Intl.DateTimeFormat | null = null;

function getFullDateFormat() {
  cachedFullDateFormat ??= new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return cachedFullDateFormat;
}

export function SkillsStoreView(props: {
  items: ClawHubSkillCard[];
  query: string;
  sort: ClawHubSort;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  cursor: string | null;
  installedKeys: Set<string>;
  installedSlugs: Set<string>;
  pendingInstallKeys: ReadonlySet<string>;
  installingByStoreKey: Record<string, string>;
  installJobs: Record<string, SkillInstallJobSnapshot>;
  onSortChange: (value: ClawHubSort) => void;
  onLoadMore: () => void;
  onInstall: (skill: ClawHubSkillCard) => void;
}) {
  const {
    items,
    query,
    sort,
    loading,
    loadingMore,
    error,
    cursor,
    installedKeys,
    installedSlugs,
    pendingInstallKeys,
    installingByStoreKey,
    installJobs,
    onSortChange,
    onLoadMore,
    onInstall,
  } = props;
  const { t } = useLocale();
  const searching = query.trim().length > 0;
  const refreshing = loading && items.length > 0;
  const [previewSkill, setPreviewSkill] = useState<ClawHubSkillCard | null>(null);
  const [previewDetail, setPreviewDetail] = useState<ClawHubSkillDetail | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [storeCategory, setStoreCategory] = useState<StoreCategoryValue>("all");

  const rankedItems = useMemo(
    () =>
      rankFuzzySearchResults(
        items,
        query,
        (skill) => [
          skill.displayName,
          skill.slug,
          skill.summary,
          skill.ownerHandle,
          skill.latestVersion,
          ...skill.topics,
        ],
        { includeUnmatched: true },
      ),
    [items, query],
  );

  const categorizedItems = useMemo(
    () =>
      rankedItems.map((skill) => ({
        skill,
        categories: classifyClawHubSkill(skill),
      })),
    [rankedItems],
  );

  const categoryCounts = useMemo(() => {
    const counts = new Map<StoreCategoryValue, number>();
    counts.set("all", categorizedItems.length);
    for (const { categories } of categorizedItems) {
      for (const category of categories) {
        counts.set(category, (counts.get(category) ?? 0) + 1);
      }
    }
    return counts;
  }, [categorizedItems]);

  const filteredItems = useMemo(
    () =>
      storeCategory === "all"
        ? categorizedItems
        : categorizedItems.filter(({ categories }) => categories.includes(storeCategory)),
    [categorizedItems, storeCategory],
  );

  // 分类是本地过滤：选中分类后结果太少且还有下一页时自动补页，
  // 避免出现"一屏只剩两张卡"的稀疏页面。
  useEffect(() => {
    if (storeCategory === "all" || searching) return;
    if (!cursor || loading || loadingMore) return;
    if (filteredItems.length >= STORE_CATEGORY_FILL_TARGET) return;
    onLoadMore();
  }, [cursor, filteredItems.length, loading, loadingMore, onLoadMore, searching, storeCategory]);

  useEffect(() => {
    if (!previewSkill) {
      setPreviewDetail(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }

    let cancelled = false;
    const cached = readSkillStoreDetail(previewSkill);
    setPreviewDetail(cached?.detail ?? null);
    setPreviewError(null);
    setPreviewLoading(!cached);
    if (cached && isSkillStoreDetailFresh(cached, previewSkill)) return;

    void loadSkillStoreDetail(previewSkill)
      .then((snapshot) => {
        if (!cancelled) {
          setPreviewDetail(snapshot.detail);
        }
      })
      .catch((err) => {
        if (!cancelled && !cached) {
          const msg = err instanceof Error ? err.message : String(err);
          setPreviewError(msg || t("settings.skillsHubDetailLoadFailed"));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setPreviewLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [previewSkill, t]);

  function getInstallState(skill: ClawHubSkillCard): StoreSkillInstallState {
    const storeKey = buildClawHubSkillKey(skill);
    const pending = pendingInstallKeys.has(storeKey);
    const jobId = installingByStoreKey[storeKey];
    const job = jobId ? installJobs[jobId] : undefined;
    const terminalJob = Boolean(job && TERMINAL_INSTALL_PHASES.has(job.phase));
    const done =
      installedKeys.has(storeKey) ||
      (!skill.ownerHandle && installedSlugs.has(skill.slug)) ||
      job?.phase === "done";
    return {
      done,
      installing: pending || Boolean(job && !terminalJob),
      pending,
      terminalJob,
      job,
      progress: pending ? null : job ? getInstallProgressPercent(job) : null,
    };
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-3 overflow-hidden" aria-busy={loading}>
      <div className="hub-panel-enter relative flex items-center justify-start">
        <div className="flex shrink-0 items-center">
          <ToggleGroup
            value={[sort]}
            onValueChange={(values) => {
              const nextSort = values[0] as ClawHubSort | undefined;
              if (nextSort) onSortChange(nextSort);
            }}
            aria-label={t("settings.skillsStoreSortMostDownloaded")}
            className="flex max-w-full shrink-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {STORE_SORT_OPTIONS.map((option) => {
              return (
                <ToggleGroupItem
                  key={option.value}
                  value={option.value}
                  disabled={searching}
                  className="h-8 shrink-0 rounded-md px-2.5 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground data-[pressed]:bg-muted data-[pressed]:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t(option.labelKey)}
                </ToggleGroupItem>
              );
            })}
          </ToggleGroup>
        </div>
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-0 -bottom-1 h-px overflow-hidden rounded-full bg-transparent transition-opacity duration-200 motion-reduce:transition-none",
            refreshing ? "opacity-100" : "opacity-0",
          )}
        >
          <div className="hub-loading-progress h-full rounded-full bg-foreground/45" />
        </div>
        <span className="sr-only" aria-live="polite">
          {refreshing ? t("settings.skillsStoreLoadingTitle") : ""}
        </span>
      </div>

      <StoreCategoryChips
        value={storeCategory}
        counts={categoryCounts}
        onChange={setStoreCategory}
      />

      {error ? (
        <GlassPanel tone="error" className="hub-panel-enter">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
            <span className="text-xs text-destructive">{error}</span>
          </div>
        </GlassPanel>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-0.5 pb-4 pr-1 pt-1.5">
        <div className="flex flex-col gap-3">
          {loading && items.length === 0 ? (
            <>
              <div className="hub-frost-hero hub-panel-enter px-4 py-3.5">
                <div className="flex items-center gap-3.5">
                  <FrostSpinner />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium tracking-tight text-foreground">
                      {t("settings.skillsStoreLoadingTitle")}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {t("settings.skillsStoreLoadingDesc")}
                    </div>
                  </div>
                </div>
                <div className="hub-frost-track mt-3.5" />
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                {[1, 2, 3, 4, 5, 6].map((item) => (
                  <div key={item} className="hub-frost-skeleton skill-card-enter p-3.5">
                    <div className="space-y-3">
                      <div className="flex items-center gap-3">
                        <div className="skills-skeleton-shimmer h-9 w-9 shrink-0 rounded-lg" />
                        <div className="flex-1 space-y-2">
                          <div className="skills-skeleton-shimmer h-3.5 w-full max-w-[8rem] rounded" />
                          <div className="skills-skeleton-shimmer h-3 w-full max-w-[11rem] rounded" />
                        </div>
                      </div>
                      <div className="skills-skeleton-shimmer h-8 w-full rounded-xl" />
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {!loading && items.length === 0 && !error ? (
            <GlassPanel className="hub-panel-enter">
              <div className="flex flex-col items-center gap-3 py-8 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted/60">
                  <Cloud className="h-5 w-5 text-muted-foreground" />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium text-muted-foreground">
                    {t("settings.skillsStoreEmptyTitle")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("settings.skillsStoreEmptyDesc")}
                  </p>
                </div>
              </div>
            </GlassPanel>
          ) : null}

          {items.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
              {filteredItems.map(({ skill, categories }) => {
                const { done, installing, pending, job, progress } = getInstallState(skill);
                const link = buildClawHubSkillUrl(skill);
                const PrimaryCategoryIcon = STORE_CATEGORY_ICONS[categories[0] ?? "other"];

                return (
                  // biome-ignore lint/a11y/useSemanticElements: The card contains nested controls and cannot be a native button.
                  <div
                    key={buildClawHubSkillKey(skill)}
                    role="button"
                    tabIndex={0}
                    aria-label={skill.displayName}
                    onClick={() => setPreviewSkill(skill)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setPreviewSkill(skill);
                      }
                    }}
                    className={cn(
                      "skill-card-enter flex h-full cursor-pointer flex-col rounded-2xl border bg-card p-3.5 text-left shadow-xs focus:outline-none focus:ring-2 focus:ring-ring",
                      done
                        ? "border-emerald-500/40 dark:border-emerald-400/35"
                        : "border-border/70",
                    )}
                  >
                    <div className="flex h-full flex-col gap-3">
                      <div className="flex items-start gap-3">
                        <div
                          className={cn(
                            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border",
                            done
                              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                              : "border-border/70 bg-muted/60 text-foreground/75",
                          )}
                        >
                          <PrimaryCategoryIcon className="h-5 w-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-start gap-1.5">
                            <SearchHighlight
                              text={skill.displayName}
                              query={query}
                              className="truncate text-[13px] font-semibold leading-tight text-foreground"
                            />
                            {link ? (
                              <a
                                href={link}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(event) => event.stopPropagation()}
                                onKeyDown={(event) => event.stopPropagation()}
                                className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                                title={t("settings.skillsStoreOpenInClawHub")}
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                            ) : null}
                          </div>
                          <div className="mt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                            v{skill.latestVersion ?? t("settings.skillsStoreVersionLatest")}
                          </div>
                        </div>
                      </div>

                      <SkillCategoryBadges
                        categories={categories}
                        topics={skill.topics}
                        searchQuery={query}
                        onSelect={setStoreCategory}
                      />

                      {skill.summary ? (
                        <p className="line-clamp-3 text-[11.5px] leading-[1.45] text-muted-foreground">
                          <SearchHighlight text={skill.summary} query={query} />
                        </p>
                      ) : null}

                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-border/60 pt-2 text-[10.5px] text-muted-foreground">
                        <span
                          className="inline-flex items-center gap-1"
                          title={t("settings.skillsStorePreviewDownloads")}
                        >
                          <span className="h-1 w-1 rounded-full bg-foreground/40" />
                          {formatCompactNumber(skill.downloads)}
                        </span>
                        <span
                          className="inline-flex items-center gap-1"
                          title={t("settings.skillsStorePreviewStars")}
                        >
                          <span className="h-1 w-1 rounded-full bg-foreground/40" />
                          {formatCompactNumber(skill.stars)}
                        </span>
                        <span
                          className="inline-flex items-center gap-1"
                          title={t("settings.skillsStorePreviewInstalls")}
                        >
                          <span className="h-1 w-1 rounded-full bg-foreground/40" />
                          {formatCompactNumber(skill.installsCurrent)}
                        </span>
                        {skill.updatedAt ? (
                          <span className="ml-auto opacity-75">
                            {formatStoreDate(skill.updatedAt)}
                          </span>
                        ) : null}
                      </div>

                      {installing && !done ? (
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between gap-3 text-[10.5px] text-muted-foreground">
                            <span>{installPhaseLabel(pending ? undefined : job, t)}</span>
                            {job && !pending ? (
                              <span className="flex items-center gap-1.5">
                                {formatInstallProgress(job)}
                                <button
                                  type="button"
                                  title={t("settings.cancel")}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void cancelSkillInstallJob(job.jobId).catch(() => undefined);
                                  }}
                                  onKeyDown={(event) => event.stopPropagation()}
                                  className="text-muted-foreground transition-colors hover:text-foreground"
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              </span>
                            ) : null}
                          </div>
                          <div className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.08]">
                            {progress === null ? (
                              <div className="hub-loading-progress h-full rounded-full bg-foreground/55" />
                            ) : (
                              <div
                                className="h-full rounded-full bg-foreground/65 transition-[width] duration-300"
                                style={{ width: `${progress}%` }}
                              />
                            )}
                          </div>
                        </div>
                      ) : null}

                      {job?.phase === "error" && job.error && !done && !pending ? (
                        <div className="rounded-xl border border-destructive/25 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
                          {job.error}
                        </div>
                      ) : null}

                      <Button
                        type="button"
                        variant={done ? "outline" : "default"}
                        size="sm"
                        className={cn(
                          "mt-auto h-9 w-full gap-1.5 rounded-xl",
                          done &&
                            "border-border/55 bg-background/75 text-foreground/85 backdrop-blur-md",
                        )}
                        disabled={done || installing}
                        aria-busy={installing}
                        onClick={(event) => {
                          event.stopPropagation();
                          onInstall(skill);
                        }}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
                        {installing ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : done ? (
                          <Check className="h-3.5 w-3.5" />
                        ) : (
                          <Cloud className="h-3.5 w-3.5" />
                        )}
                        {installing
                          ? installPhaseLabel(pending ? undefined : job, t)
                          : done
                            ? t("settings.skillsStoreInstalled")
                            : t("settings.skillsStoreInstall")}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}

          {items.length > 0 && filteredItems.length === 0 && !loading && !loadingMore && !cursor ? (
            <GlassPanel tone="muted" className="hub-panel-enter">
              <p className="py-2 text-center text-sm text-muted-foreground">
                {t("settings.skillsStoreEmptyTitle")}
              </p>
            </GlassPanel>
          ) : null}

          {cursor && !searching ? (
            <div className="hub-panel-enter flex justify-center">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5 rounded-full border-border/50 bg-background/70 backdrop-blur-md"
                disabled={loadingMore}
                onClick={onLoadMore}
              >
                <RefreshCw className={cn("h-3.5 w-3.5", loadingMore && "animate-spin")} />
                {loadingMore
                  ? t("settings.skillsStoreLoadingMore")
                  : t("settings.skillsStoreLoadMore")}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
      <SkillsStorePreviewDrawer
        skill={previewSkill ? (previewDetail ?? previewSkill) : null}
        detail={previewDetail}
        loading={previewLoading}
        error={previewError}
        installState={previewSkill ? getInstallState(previewDetail ?? previewSkill) : null}
        onClose={() => setPreviewSkill(null)}
        onInstall={() => {
          const target = previewDetail ?? previewSkill;
          if (target) onInstall(target);
        }}
      />
    </div>
  );
}

function SkillsStorePreviewDrawer(props: {
  skill: ClawHubSkillCard | null;
  detail: ClawHubSkillDetail | null;
  loading: boolean;
  error: string | null;
  installState: StoreSkillInstallState | null;
  onClose: () => void;
  onInstall: () => void;
}) {
  const { onClose, onInstall } = props;
  const presence = useDrawerPresence(
    props.skill && props.installState
      ? {
          skill: props.skill,
          detail: props.detail,
          loading: props.loading,
          error: props.error,
          installState: props.installState,
        }
      : null,
  );
  const snapshot = presence.snapshot;

  return (
    <Sheet
      open={presence.open}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onOpenChangeComplete={presence.handleOpenChangeComplete}
    >
      {snapshot ? (
        <SkillsStorePreviewPopup
          skill={snapshot.skill}
          detail={snapshot.detail}
          loading={snapshot.loading || !presence.entered}
          error={snapshot.error}
          installState={snapshot.installState}
          onInstall={onInstall}
        />
      ) : null}
    </Sheet>
  );
}

function SkillsStorePreviewPopup(props: {
  skill: ClawHubSkillCard;
  detail: ClawHubSkillDetail | null;
  loading: boolean;
  error: string | null;
  installState: StoreSkillInstallState;
  onInstall: () => void;
}) {
  const { skill, detail, loading, error, installState, onInstall } = props;
  const { t } = useLocale();
  const data = detail ?? skill;
  const link = data.webUrl ?? buildClawHubSkillUrl(data);
  const version = data.latestVersion ?? t("settings.skillsStoreVersionLatest");
  const owner = detail?.ownerDisplayName ?? data.ownerHandle;
  const supportedOs = detail?.supportedOs ?? [];
  const supportedSystems = detail?.supportedSystems ?? [];
  const actionLabel = installState.installing
    ? installPhaseLabel(installState.pending ? undefined : installState.job, t)
    : installState.done
      ? t("settings.skillsStoreInstalled")
      : t("settings.skillsStoreInstall");

  return (
    <SheetPopup
      side="right"
      variant="inset"
      closeLabel={t("settings.cronViewClose")}
      className="w-full sm:max-w-[34rem]"
    >
      <SheetHeader className="flex-row items-start gap-3 border-b border-border px-5 py-4 pr-14">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted text-foreground">
          {detail?.ownerImage ? (
            <img
              src={detail.ownerImage}
              alt=""
              className="h-full w-full object-cover"
              loading="lazy"
            />
          ) : (
            <SkillIcon className="h-7 w-7" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {t("settings.skillsStorePreviewTitle")}
          </div>
          <SheetTitle className="mt-1 truncate">{data.displayName}</SheetTitle>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            {owner ? <span className="truncate">@{owner}</span> : null}
            <span>v{version}</span>
            {data.updatedAt ? <span>{formatStoreDate(data.updatedAt)}</span> : null}
          </div>
        </div>
      </SheetHeader>

      <SheetPanel className="px-5 py-5">
        <div className="flex flex-col gap-5">
          {data.summary ? (
            <p className="text-[13px] leading-6 text-muted-foreground">{data.summary}</p>
          ) : null}

          <div className="grid grid-cols-3 gap-2">
            <StorePreviewMetric
              label={t("settings.skillsStorePreviewDownloads")}
              value={formatCompactNumber(data.downloads)}
            />
            <StorePreviewMetric
              label={t("settings.skillsStorePreviewStars")}
              value={formatCompactNumber(data.stars)}
            />
            <StorePreviewMetric
              label={t("settings.skillsStorePreviewInstalls")}
              value={formatCompactNumber(data.installsCurrent)}
            />
          </div>

          {installState.installing && !installState.done ? (
            <div className="rounded-lg border border-border bg-muted p-3">
              <div className="flex items-center justify-between gap-3 text-[11px] text-foreground">
                <span>
                  {installPhaseLabel(installState.pending ? undefined : installState.job, t)}
                </span>
                {installState.job && !installState.pending ? (
                  <span>{formatInstallProgress(installState.job)}</span>
                ) : null}
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-background">
                {installState.progress === null ? (
                  <div className="hub-loading-progress h-full rounded-full bg-foreground/55" />
                ) : (
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-300"
                    style={{ width: `${installState.progress}%` }}
                  />
                )}
              </div>
            </div>
          ) : null}

          {installState.job?.phase === "error" &&
          installState.job.error &&
          !installState.done &&
          !installState.pending ? (
            <div className="rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-xs text-destructive">
              {installState.job.error}
            </div>
          ) : null}

          {error ? (
            <div className="rounded-lg border border-border bg-muted p-3">
              <div className="flex items-start gap-2 text-xs text-muted-foreground">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground" />
                <span>{t("settings.skillsStorePreviewDetailUnavailable")}</span>
              </div>
            </div>
          ) : null}

          {loading ? (
            <StorePreviewSkeleton />
          ) : (
            <>
              <Separator />
              <section aria-labelledby="store-skill-metadata">
                <h3
                  id="store-skill-metadata"
                  className="mb-1 text-xs font-semibold text-foreground"
                >
                  {t("settings.skillsStorePreviewMetadata")}
                </h3>
                <div className="divide-y divide-border">
                  <StorePreviewField
                    label={t("settings.skillsStorePreviewSlug")}
                    value={data.slug}
                  />
                  <StorePreviewField label={t("settings.skillsStorePreviewOwner")} value={owner} />
                  <StorePreviewField
                    label={t("settings.skillsStorePreviewVersion")}
                    value={version}
                  />
                  <StorePreviewField
                    label={t("settings.skillsStorePreviewUpdated")}
                    value={data.updatedAt ? formatFullStoreDate(data.updatedAt) : null}
                  />
                  <StorePreviewField
                    label={t("settings.skillsStorePreviewCreated")}
                    value={detail?.createdAt ? formatFullStoreDate(detail.createdAt) : null}
                  />
                  <StorePreviewField
                    label={t("settings.skillsStorePreviewPublished")}
                    value={
                      detail?.latestVersionCreatedAt
                        ? formatFullStoreDate(detail.latestVersionCreatedAt)
                        : null
                    }
                  />
                  <StorePreviewField
                    label={t("settings.skillsStorePreviewLicense")}
                    value={detail?.license}
                  />
                  <StorePreviewField
                    label={t("settings.skillsStorePreviewOs")}
                    value={supportedOs.length > 0 ? supportedOs.join(", ") : null}
                  />
                  <StorePreviewField
                    label={t("settings.skillsStorePreviewSystems")}
                    value={supportedSystems.length > 0 ? supportedSystems.join(", ") : null}
                  />
                  <StorePreviewField
                    label={t("settings.skillsStorePreviewModeration")}
                    value={detail?.moderationStatus}
                  />
                </div>
              </section>

              {detail?.latestVersionChangelog ? (
                <>
                  <Separator />
                  <section aria-labelledby="store-skill-changelog">
                    <h3
                      id="store-skill-changelog"
                      className="mb-2 text-xs font-semibold text-foreground"
                    >
                      {t("settings.skillsStorePreviewChangelog")}
                    </h3>
                    <p className="whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
                      {detail.latestVersionChangelog}
                    </p>
                  </section>
                </>
              ) : null}
            </>
          )}
        </div>
      </SheetPanel>

      <SheetFooter className="shrink-0 border-t border-border px-5 py-4">
        {link ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 flex-1 gap-1.5"
            render={
              <a href={link} target="_blank" rel="noreferrer">
                <ExternalLink className="h-3.5 w-3.5" />
                {t("settings.skillsStoreOpenInClawHub")}
              </a>
            }
          />
        ) : null}
        <Button
          type="button"
          variant={installState.done ? "outline" : "default"}
          size="sm"
          className="h-9 flex-1 gap-1.5"
          disabled={installState.done || installState.installing}
          aria-busy={installState.installing}
          onClick={onInstall}
        >
          {installState.installing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : installState.done ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Cloud className="h-3.5 w-3.5" />
          )}
          {actionLabel}
        </Button>
      </SheetFooter>
    </SheetPopup>
  );
}

function StorePreviewMetric(props: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="text-[10.5px] text-muted-foreground">{props.label}</div>
      <div className="mt-1 text-sm font-semibold tabular-nums text-foreground">{props.value}</div>
    </div>
  );
}

const STORE_PREVIEW_FIELD_WIDTHS = [
  "w-[82%]",
  "w-2/3",
  "w-[55%]",
  "w-3/4",
  "w-[45%]",
  "w-3/5",
] as const;

function StorePreviewSkeleton() {
  return (
    <>
      <div className="rounded-2xl border border-border/40 bg-background/60 p-3">
        <div className="skills-skeleton-pulse mb-3 h-2.5 w-12 rounded-full" />
        <div className="divide-y divide-border/30">
          {STORE_PREVIEW_FIELD_WIDTHS.map((width) => (
            <div
              key={width}
              className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-3 py-2.5"
            >
              <div className="skills-skeleton-pulse h-2.5 w-14 rounded-full" />
              <div className={cn("skills-skeleton-pulse h-2.5 rounded-full", width)} />
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-2xl border border-border/40 bg-background/60 p-3">
        <div className="skills-skeleton-pulse mb-3 h-2.5 w-16 rounded-full" />
        <div className="space-y-2">
          <div className="skills-skeleton-pulse h-2.5 w-full rounded-full" />
          <div className="skills-skeleton-pulse h-2.5 w-11/12 rounded-full" />
          <div className="skills-skeleton-pulse h-2.5 w-3/5 rounded-full" />
        </div>
      </div>
    </>
  );
}

function StorePreviewField(props: { label: string; value?: string | null }) {
  if (!props.value) return null;
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 py-2 text-[12px]">
      <div className="text-muted-foreground">{props.label}</div>
      <div className="min-w-0 break-words text-foreground">{props.value}</div>
    </div>
  );
}

function buildClawHubSkillUrl(skill: ClawHubSkillCard) {
  if (!skill.ownerHandle) return null;
  return `https://clawhub.ai/${encodeURIComponent(skill.ownerHandle)}/${encodeURIComponent(skill.slug)}`;
}

function formatCompactNumber(value: number) {
  cachedCompactNumberFormat ??= new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  return cachedCompactNumberFormat.format(value);
}

function formatStoreDate(value: number) {
  cachedShortDateFormat ??= new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  });
  return cachedShortDateFormat.format(new Date(value));
}

function formatFullStoreDate(value: number) {
  return getFullDateFormat().format(new Date(value));
}

function getInstallProgressPercent(job: SkillInstallJobSnapshot) {
  if (job.phase === "done") return 100;
  if (!job.totalBytes || job.totalBytes <= 0) return null;
  return Math.max(2, Math.min(100, Math.round((job.downloadedBytes / job.totalBytes) * 100)));
}

function formatInstallProgress(job: SkillInstallJobSnapshot) {
  if (job.phase === "done") return "100%";
  if (job.totalBytes && job.totalBytes > 0) {
    return `${formatBytes(job.downloadedBytes)} / ${formatBytes(job.totalBytes)}`;
  }
  return job.downloadedBytes > 0 ? formatBytes(job.downloadedBytes) : "";
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let next = value;
  let unit = 0;
  while (next >= 1024 && unit < units.length - 1) {
    next /= 1024;
    unit += 1;
  }
  return `${next >= 10 || unit === 0 ? Math.round(next) : next.toFixed(1)} ${units[unit]}`;
}

function installPhaseLabel(job: SkillInstallJobSnapshot | undefined, t: (key: string) => string) {
  switch (job?.phase) {
    case "queued":
      return t("settings.skillsStorePhaseQueued");
    case "downloading":
      return t("settings.skillsStorePhaseDownloading");
    case "extracting":
      return t("settings.skillsStorePhaseExtracting");
    case "validating":
      return t("settings.skillsStorePhaseValidating");
    case "installing":
      return t("settings.skillsStorePhaseInstalling");
    case "done":
      return t("settings.skillsStoreInstalled");
    case "error":
      return t("settings.skillsStorePhaseError");
    default:
      return t("settings.skillsStorePhasePreparing");
  }
}
