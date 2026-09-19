import { Check, Cloud, ExternalLink, Loader2, Tag, X } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { SearchHighlight } from "@liveagent/ui/components/ui/search-highlight";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import type { ClawHubSkillCard } from "@liveagent/ui/lib/skills/clawHub";
import type { ClawHubCategorySlug } from "@liveagent/ui/lib/skills/clawHubCategories";
import {
  cancelSkillInstallJob,
  type SkillInstallJobSnapshot,
} from "@liveagent/ui/lib/skills/index";
import {
  SkillCategoryChips,
  SkillTopicBadges,
  STORE_CATEGORY_ICONS,
} from "./SkillCategoryControls";
import { SKILL_CARD_SHELL_CLASS } from "./skillCardLayout";
import {
  buildClawHubSkillUrl,
  formatCompactNumber,
  formatInstallProgress,
  formatStoreDate,
  installPhaseLabel,
} from "./skillStoreFormat";

export type StoreSkillInstallState = {
  done: boolean;
  installing: boolean;
  pending: boolean;
  terminalJob: boolean;
  job: SkillInstallJobSnapshot | undefined;
  progress: number | null;
};

type StoreSkillCardProps = {
  skill: ClawHubSkillCard;
  categories: ClawHubCategorySlug[];
  query: string;
  installState: StoreSkillInstallState;
  onOpenPreview: (skill: ClawHubSkillCard) => void;
  onSelectCategory: (category: ClawHubCategorySlug) => void;
  onInstall: (skill: ClawHubSkillCard) => void;
};

export function StoreSkillCard({
  skill,
  categories,
  query,
  installState,
  onOpenPreview,
  onSelectCategory,
  onInstall,
}: StoreSkillCardProps) {
  const { t } = useLocale();
  const { done, installing, pending, job, progress } = installState;
  const link = buildClawHubSkillUrl(skill);
  const PrimaryCategoryIcon = STORE_CATEGORY_ICONS[categories[0] ?? "other"];

  return (
    // biome-ignore lint/a11y/useSemanticElements: The card contains nested controls and cannot be a native button.
    <div
      role="button"
      tabIndex={0}
      aria-label={skill.displayName}
      onClick={() => onOpenPreview(skill)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenPreview(skill);
        }
      }}
      className={cn(
        SKILL_CARD_SHELL_CLASS,
        "cursor-pointer",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <div
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg",
          "text-muted-foreground transition-colors group-hover:text-foreground/70",
        )}
      >
        <PrimaryCategoryIcon className="size-4" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <SearchHighlight
            text={skill.displayName}
            query={query}
            className="truncate text-sm font-semibold text-foreground"
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
              <ExternalLink className="size-3" />
            </a>
          ) : null}
          <SkillTopicBadges topics={skill.topics} searchQuery={query} />
        </div>

        {skill.summary ? (
          <p className="mt-1 line-clamp-1 text-xs leading-5 text-muted-foreground">
            <SearchHighlight text={skill.summary} query={query} />
          </p>
        ) : null}

        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-tiny text-muted-foreground">
          <SkillCategoryChips categories={categories} onSelect={onSelectCategory} />
          <span className="inline-flex shrink-0 items-center gap-1">
            <Tag className="size-3 shrink-0" />v
            {skill.latestVersion ?? t("settings.skillsStoreVersionLatest")}
          </span>
          <span
            className="inline-flex items-center gap-1"
            title={t("settings.skillsStorePreviewDownloads")}
          >
            <span className="size-1 rounded-full bg-foreground/40" />
            {formatCompactNumber(skill.downloads)}
          </span>
          <span
            className="inline-flex items-center gap-1"
            title={t("settings.skillsStorePreviewStars")}
          >
            <span className="size-1 rounded-full bg-foreground/40" />
            {formatCompactNumber(skill.stars)}
          </span>
          <span
            className="inline-flex items-center gap-1"
            title={t("settings.skillsStorePreviewInstalls")}
          >
            <span className="size-1 rounded-full bg-foreground/40" />
            {formatCompactNumber(skill.installsCurrent)}
          </span>
          {skill.updatedAt ? (
            <span className="shrink-0 opacity-75">{formatStoreDate(skill.updatedAt)}</span>
          ) : null}
        </div>

        {installing && !done ? (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-3 text-xs text-foreground/70">
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
                    className="text-foreground/70 transition-colors hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ) : null}
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.08]">
              {progress === null ? (
                <div className="w-[42%] origin-left animate-hub-loading-progress motion-reduce:animate-none! h-full rounded-full bg-foreground/55" />
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
          <div className="rounded-xl border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {job.error}
          </div>
        ) : null}
      </div>

      <div
        data-card-action-zone=""
        role="toolbar"
        aria-label={skill.displayName}
        className="flex shrink-0 items-center gap-1 self-center"
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            "gap-1.5 rounded-lg bg-background text-foreground hover:bg-settings-active",
            done && "bg-transparent text-muted-foreground disabled:opacity-100",
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
            <Loader2 className="size-3.5 animate-spin" />
          ) : done ? (
            <Check className="size-3.5" />
          ) : (
            <Cloud className="size-3.5" />
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
}
