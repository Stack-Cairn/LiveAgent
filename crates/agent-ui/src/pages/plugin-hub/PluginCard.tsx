import { memo } from "react";
import { AlertTriangle, Package, Plug, Shield, Terminal } from "../../components/IconSet";
import { ResourceActivationSwitch } from "../../components/resources/ResourceActivationSwitch";
import { Badge } from "../../components/ui/badge";
import { SearchHighlight } from "../../components/ui/search-highlight";
import { useLocale } from "../../i18n/index";
import type { PluginInventoryItem } from "../../lib/plugins/types";
import { cn } from "../../lib/shared/utils";
import {
  pluginContributionCounts,
  pluginMissingPermissions,
  pluginPhaseTone,
  pluginProblem,
  pluginSubtitle,
  pluginTrustMeta,
} from "./pluginPresentation";

const RUNTIME_ICONS = {
  "wasi-command": Package,
  process: Terminal,
  declarative: Plug,
} as const;

function ContributionCount(props: { count: number; label: string }) {
  if (props.count === 0) return null;
  return (
    <span className="inline-flex h-5 items-center gap-1 rounded-full bg-muted px-2 text-[10px] text-muted-foreground ring-1 ring-border/60">
      <span className="font-semibold tabular-nums text-foreground">{props.count}</span>
      <span>{props.label}</span>
    </span>
  );
}

export const PluginCard = memo(function PluginCard(props: {
  item: PluginInventoryItem;
  searchQuery: string;
  busy: boolean;
  readOnly: boolean;
  onOpen: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const { item, searchQuery, busy, readOnly, onOpen, onToggle } = props;
  const { t } = useLocale();
  const counts = pluginContributionCounts(item);
  const trust = pluginTrustMeta(item, t);
  const problem = pluginProblem(item);
  const missingPermissions = pluginMissingPermissions(item);
  const RuntimeIcon = RUNTIME_ICONS[item.runtime.kind] ?? Plug;
  const subtitle = pluginSubtitle(item);

  return (
    // biome-ignore lint/a11y/useSemanticElements: 卡片内嵌开关等控件，不能是原生 button。
    <div
      role="button"
      tabIndex={0}
      aria-label={`${t("pluginHub.openDetails")}: ${item.name}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpen();
      }}
      className={cn(
        "skill-card-enter group relative flex min-h-44 w-full cursor-pointer flex-col rounded-xl border bg-card p-3.5 text-left shadow-xs transition-[border-color,box-shadow,background-color]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "[content-visibility:auto] [contain-intrinsic-size:auto_11rem]",
        problem
          ? "border-destructive/35"
          : item.enabled
            ? "border-emerald-600/25"
            : "border-border hover:border-foreground/20 hover:shadow-md",
        busy && "opacity-60",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border",
            trust.danger
              ? "border-amber-500/30 bg-amber-500/12 text-amber-800 dark:border-amber-400/30 dark:bg-amber-400/15 dark:text-amber-200"
              : "border-sky-500/30 bg-sky-500/12 text-sky-700 dark:border-sky-400/30 dark:bg-sky-400/15 dark:text-sky-200",
          )}
        >
          <RuntimeIcon className="h-5 w-5" />
        </div>

        <div
          role="toolbar"
          aria-label={item.name}
          className="flex shrink-0 items-center gap-2"
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Badge variant={pluginPhaseTone(item.phase)} className="h-5 px-1.5 text-[10px]">
            {t(`pluginHub.phase.${item.phase}`)}
          </Badge>
          <ResourceActivationSwitch
            checked={item.enabled}
            disabled={busy || readOnly}
            compact
            stopPropagation
            label={`${t("pluginHub.toggle")}: ${item.name}`}
            onCheckedChange={onToggle}
          />
        </div>
      </div>

      <div className="mt-3 min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <SearchHighlight
            text={item.name}
            query={searchQuery}
            className="truncate text-sm font-semibold text-foreground"
          />
          <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
            v{item.version}
          </span>
        </div>
        <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
          <SearchHighlight text={subtitle} query={searchQuery} />
        </p>
        {problem ? (
          <p className="mt-2 line-clamp-2 text-[11px] leading-4 text-destructive" title={problem}>
            {problem}
          </p>
        ) : missingPermissions.length > 0 ? (
          <p className="mt-2 line-clamp-1 text-[11px] leading-4 text-amber-700 dark:text-amber-300">
            {t("pluginHub.missingGrants").replace("{count}", String(missingPermissions.length))}
          </p>
        ) : null}
      </div>

      <div className="mt-3 flex min-w-0 items-center gap-1.5 border-t border-border pt-2">
        <Badge
          variant={trust.variant}
          className="h-5 shrink-0 gap-1 px-1.5 text-[10px]"
          title={trust.description}
        >
          {trust.danger ? (
            <AlertTriangle className="h-2.5 w-2.5" />
          ) : (
            <Shield className="h-2.5 w-2.5" />
          )}
          {trust.label}
        </Badge>
        <div className="ml-auto flex shrink-0 flex-wrap justify-end gap-1">
          <ContributionCount count={counts.tools} label={t("pluginHub.tools")} />
          <ContributionCount count={counts.prompts} label={t("pluginHub.prompts")} />
          <ContributionCount count={counts.hooks} label={t("pluginHub.hooks")} />
        </div>
      </div>
    </div>
  );
});
