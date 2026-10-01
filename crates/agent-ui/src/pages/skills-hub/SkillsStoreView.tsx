import { GlassPanel } from "@liveagent/ui/components/hub/HubChrome";
import {
  FrostSpinner,
  LoadingSurface,
  LoadingTrack,
} from "@liveagent/ui/components/hub/HubLoading";
import {
  AlertTriangle,
  Check,
  Cloud,
  ExternalLink,
  Loader2,
  RefreshCw,
  SkillIcon,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { Separator } from "@liveagent/ui/components/ui/separator";
import {
  Sheet,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "@liveagent/ui/components/ui/sheet";
import { Skeleton } from "@liveagent/ui/components/ui/skeleton";
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
import type { SkillInstallJobSnapshot } from "@liveagent/ui/lib/skills/index";
import { useEffect, useMemo, useState } from "react";
import { StoreCategoryChips, type StoreCategoryValue } from "./SkillCategoryControls";
import { StoreSkillCard, type StoreSkillInstallState } from "./StoreSkillCard";
import { SKILL_LIST_GRID_CLASS } from "./skillCardLayout";
import {
  isSkillStoreDetailFresh,
  loadSkillStoreDetail,
  readSkillStoreDetail,
} from "./skillStoreCache";
import {
  buildClawHubSkillUrl,
  formatCompactNumber,
  formatFullStoreDate,
  formatInstallProgress,
  formatStoreDate,
  getInstallProgressPercent,
  installPhaseLabel,
} from "./skillStoreFormat";
import { useDrawerPresence } from "./useDrawerPresence";

export const TERMINAL_INSTALL_PHASES = new Set(["done", "error", "cancelled"]);

const STORE_CATEGORY_FILL_TARGET = 12;
export const STORE_SORT_OPTIONS: Array<{ value: ClawHubSort; labelKey: string }> = [
  { value: "downloads", labelKey: "settings.skillsStoreSortMostDownloaded" },
  { value: "stars", labelKey: "settings.skillsStoreSortMostStarred" },
  { value: "installs", labelKey: "settings.skillsStoreSortMostInstalled" },
  { value: "updated", labelKey: "settings.skillsStoreSortRecentlyUpdated" },
  { value: "newest", labelKey: "settings.skillsStoreSortNewest" },
];

export function SkillsStoreView(props: {
  items: ClawHubSkillCard[];
  query: string;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  cursor: string | null;
  installedKeys: Set<string>;
  installedSlugs: Set<string>;
  pendingInstallKeys: ReadonlySet<string>;
  installingByStoreKey: Record<string, string>;
  installJobs: Record<string, SkillInstallJobSnapshot>;
  onLoadMore: () => void;
  onInstall: (skill: ClawHubSkillCard) => void;
}) {
  const {
    items,
    query,
    loading,
    loadingMore,
    error,
    cursor,
    installedKeys,
    installedSlugs,
    pendingInstallKeys,
    installingByStoreKey,
    installJobs,
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
    <div
      className="relative flex h-full min-h-0 flex-1 flex-col gap-3 overflow-hidden"
      aria-busy={loading}
    >
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 z-40 h-px overflow-hidden rounded-full bg-transparent",
          "transition-opacity duration-200 motion-reduce:transition-none",
          refreshing ? "opacity-100" : "opacity-0",
        )}
      >
        <div className="w-[42%] origin-left animate-hub-loading-progress motion-reduce:animate-none! h-full rounded-full bg-foreground/45" />
      </div>
      <span className="sr-only" aria-live="polite">
        {refreshing ? t("settings.skillsStoreLoadingTitle") : ""}
      </span>

      <div className="min-h-0 flex-1 overflow-y-auto px-0.5 pb-4 pr-1">
        <div className="flex flex-col gap-3">
          <StoreCategoryChips
            value={storeCategory}
            counts={categoryCounts}
            onChange={setStoreCategory}
            className="sticky top-0 z-30 -mx-0.5 bg-background/95 px-0.5 backdrop-blur supports-[backdrop-filter]:bg-background/90"
          />

          {error ? (
            <GlassPanel tone="error">
              <div className="flex items-center gap-2">
                <AlertTriangle className="size-4 shrink-0 text-destructive" />
                <span className="text-xs text-destructive">{error}</span>
              </div>
            </GlassPanel>
          ) : null}
          {loading && items.length === 0 ? (
            <>
              <LoadingSurface variant="hero" className="px-4 py-3.5">
                <div className="flex items-center gap-3.5">
                  <FrostSpinner />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium tracking-tight text-foreground">
                      {t("settings.skillsStoreLoadingTitle")}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">
                      {t("settings.skillsStoreLoadingDesc")}
                    </div>
                  </div>
                </div>
                <LoadingTrack className="mt-3.5" />
              </LoadingSurface>

              <div className={SKILL_LIST_GRID_CLASS}>
                {[1, 2, 3, 4, 5, 6].map((item) => (
                  <LoadingSurface variant="skeleton" key={item} className="p-3.5">
                    <div className="space-y-3">
                      <div className="flex items-center gap-3">
                        <Skeleton className="size-9 shrink-0 rounded-lg" />
                        <div className="flex-1 space-y-2">
                          <Skeleton className="h-3.5 w-full max-w-32 rounded" />
                          <Skeleton className="h-3 w-full max-w-44 rounded" />
                        </div>
                      </div>
                      <Skeleton className="h-8 w-full rounded-xl" />
                    </div>
                  </LoadingSurface>
                ))}
              </div>
            </>
          ) : null}

          {!loading && items.length === 0 && !error ? (
            <GlassPanel>
              <div className="flex flex-col items-center gap-3 py-8 text-center">
                <div className="flex size-12 items-center justify-center rounded-full bg-muted/60">
                  <Cloud className="size-5 text-muted-foreground" />
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
            <div className={SKILL_LIST_GRID_CLASS}>
              {filteredItems.map(({ skill, categories }) => (
                <StoreSkillCard
                  key={buildClawHubSkillKey(skill)}
                  skill={skill}
                  categories={categories}
                  query={query}
                  installState={getInstallState(skill)}
                  onOpenPreview={setPreviewSkill}
                  onSelectCategory={setStoreCategory}
                  onInstall={onInstall}
                />
              ))}
            </div>
          ) : null}

          {items.length > 0 && filteredItems.length === 0 && !loading && !loadingMore && !cursor ? (
            <GlassPanel tone="muted">
              <p className="py-2 text-center text-sm text-foreground/70">
                {t("settings.skillsStoreEmptyTitle")}
              </p>
            </GlassPanel>
          ) : null}

          {cursor && !searching ? (
            <div className="flex justify-center">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5 rounded-full border-border/50 bg-background backdrop-blur-md"
                disabled={loadingMore}
                onClick={onLoadMore}
              >
                <RefreshCw className={cn("size-3.5", loadingMore && "animate-spin")} />
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
      className="w-full sm:max-w-136"
    >
      <SheetHeader className="flex-row items-start gap-3 border-b border-border px-5 py-4 pr-14">
        <div
          className={cn(
            "flex size-11 shrink-0 items-center justify-center overflow-hidden",
            "rounded-xl border border-border bg-muted text-foreground",
          )}
        >
          {detail?.ownerImage ? (
            <img src={detail.ownerImage} alt="" className="size-full object-cover" loading="lazy" />
          ) : (
            <SkillIcon className="size-7" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t("settings.skillsStorePreviewTitle")}
          </div>
          <SheetTitle className="mt-1 truncate">{data.displayName}</SheetTitle>
          <div
            className={cn(
              "mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1",
              "text-xs text-muted-foreground",
            )}
          >
            {owner ? <span className="truncate">@{owner}</span> : null}
            <span>v{version}</span>
            {data.updatedAt ? <span>{formatStoreDate(data.updatedAt)}</span> : null}
          </div>
        </div>
      </SheetHeader>

      <SheetPanel className="p-5">
        <div className="flex flex-col gap-5">
          {data.summary ? (
            <p className="text-sm leading-6 text-muted-foreground">{data.summary}</p>
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
              <div className="flex items-center justify-between gap-3 text-xs text-foreground">
                <span>
                  {installPhaseLabel(installState.pending ? undefined : installState.job, t)}
                </span>
                {installState.job && !installState.pending ? (
                  <span>{formatInstallProgress(installState.job)}</span>
                ) : null}
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-background">
                {installState.progress === null ? (
                  <div className="w-[42%] origin-left animate-hub-loading-progress motion-reduce:animate-none! h-full rounded-full bg-foreground/55" />
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
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-foreground" />
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
                <ExternalLink className="size-3.5" />
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
            <Loader2 className="size-3.5 animate-spin" />
          ) : installState.done ? (
            <Check className="size-3.5" />
          ) : (
            <Cloud className="size-3.5" />
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
      <div className="text-tiny text-muted-foreground">{props.label}</div>
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
        <Skeleton variant="pulse" className="mb-3 h-2.5 w-12 rounded-full" />
        <div className="divide-y divide-border/30">
          {STORE_PREVIEW_FIELD_WIDTHS.map((width) => (
            <div key={width} className="grid grid-cols-form-label items-center gap-3 py-2.5">
              <Skeleton variant="pulse" className="h-2.5 w-14 rounded-full" />
              <Skeleton variant="pulse" className={cn("h-2.5 rounded-full", width)} />
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-2xl border border-border/40 bg-background/60 p-3">
        <Skeleton variant="pulse" className="mb-3 h-2.5 w-16 rounded-full" />
        <div className="space-y-2">
          <Skeleton variant="pulse" className="h-2.5 w-full rounded-full" />
          <Skeleton variant="pulse" className="h-2.5 w-11/12 rounded-full" />
          <Skeleton variant="pulse" className="h-2.5 w-3/5 rounded-full" />
        </div>
      </div>
    </>
  );
}

function StorePreviewField(props: { label: string; value?: string | null }) {
  if (!props.value) return null;
  return (
    <div className="grid grid-cols-form-label gap-3 py-2 text-xs">
      <div className="text-muted-foreground">{props.label}</div>
      <div className="min-w-0 break-words text-foreground">{props.value}</div>
    </div>
  );
}
