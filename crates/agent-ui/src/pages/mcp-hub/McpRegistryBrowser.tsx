import {
  type AppSettings,
  type McpServerConfig,
  updateMcp,
} from "@liveagent/app/lib/settings/index";
import { openUrl } from "@liveagent/app/shims/tauriOpener";
import {
  AlertTriangle,
  Check,
  ExternalLink,
  Globe2,
  Key,
  Loader2,
  Plus,
  Server,
  Shield,
  Terminal,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { SearchHighlight } from "@liveagent/ui/components/ui/search-highlight";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@liveagent/ui/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@liveagent/ui/components/ui/sheet";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  createUniqueMcpServerId,
  MCP_REGISTRY_SOURCE_OPTIONS,
  type McpRegistryCard,
  type McpRegistryConfigInput,
  type McpRegistrySource,
  mcpRegistryConfigInputKey,
  resolveMcpRegistryInstallDraft,
  searchMcpRegistry,
  withUniqueMcpServerId,
} from "@liveagent/ui/lib/mcpRegistry/index";
import { enrichMcpServerWithRegistryMetadata } from "@liveagent/ui/lib/mcpServerMetadata";
import { rankFuzzySearchResults } from "@liveagent/ui/lib/shared/fuzzySearch";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { McpRegistryConfigureModal } from "./McpRegistryConfigureModal";
import { McpRegistryToolbar } from "./McpRegistryToolbar";

export const MCP_STORE_PAGE_LIMIT = 24;
const FROST_SPINNER_SEGMENTS = Array.from({ length: 12 }, (_, index) => `segment-${index + 1}`);
const STORE_SKELETON_IDS = Array.from({ length: 8 }, (_, index) => `skeleton-${index + 1}`);

type McpRegistryBrowserProps = {
  settings: AppSettings;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
  query: string;
};

type McpPreviewLink = {
  key: string;
  labelKey: string;
  url: string;
};

type McpRegistryCardGroup = {
  id: string;
  cards: McpRegistryCard[];
};

function FrostSpinner() {
  return (
    <span className="hub-frost-spinner shrink-0" aria-hidden="true">
      {FROST_SPINNER_SEGMENTS.map((segment) => (
        <i key={segment} />
      ))}
    </span>
  );
}

function sourceTone(_source: McpRegistrySource) {
  return "border-border/60 bg-muted text-foreground/75";
}

function transportTone(_transport: string) {
  return "bg-muted text-foreground/75 ring-border/60";
}

function versionLabelForCard(card: McpRegistryCard) {
  return card.versionLabel ?? (card.source === "official" ? card.scoreLabel : undefined);
}

function groupMcpRegistryCards(cards: McpRegistryCard[]) {
  const groups: McpRegistryCardGroup[] = [];
  const byKey = new Map<string, McpRegistryCardGroup>();

  for (const card of cards) {
    const key = versionLabelForCard(card)
      ? `${card.source}:${card.sourceId || card.name || card.id}`
      : card.id;
    let group = byKey.get(key);
    if (!group) {
      group = { id: key, cards: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    if (!group.cards.some((item) => item.id === card.id)) {
      group.cards.push(card);
    }
  }

  return groups;
}

function appendUniqueRegistryCards(current: McpRegistryCard[], incoming: McpRegistryCard[]) {
  const seen = new Set(current.map((card) => card.id));
  const uniqueIncoming = incoming.filter((card) => {
    if (seen.has(card.id)) return false;
    seen.add(card.id);
    return true;
  });
  return [...current, ...uniqueIncoming];
}

function installLabelKey(card: McpRegistryCard) {
  if (!card.installDraft && card.source === "smithery") return "mcpHub.storeInstall";
  if (card.installDraft?.status === "needs_config") return "mcpHub.storeConfigure";
  return card.installDraft ? "mcpHub.storeInstall" : "mcpHub.storeManualOnly";
}

function configureDraftForCard(card: McpRegistryCard) {
  return card.installDraft ?? card.manualDraft;
}

function configTargetLabel(input: McpRegistryConfigInput, t: (key: string) => string) {
  if (input.target === "env") return t("mcpHub.previewEnv");
  if (input.target === "header") return t("mcpHub.previewHeaders");
  if (input.target === "argument") return t("mcpHub.previewArgs");
  if (input.target === "url") return "URL";
  return "Config";
}

function primaryRegistryLink(card: McpRegistryCard) {
  return card.detailUrl ?? card.homepageUrl ?? card.repositoryUrl;
}

function registryExternalLinks(card: McpRegistryCard): McpPreviewLink[] {
  const candidates: Array<{ key: string; labelKey: string; url?: string }> = [
    { key: "detail", labelKey: "mcpHub.storePreviewDetailPage", url: card.detailUrl },
    { key: "homepage", labelKey: "mcpHub.storePreviewHomepage", url: card.homepageUrl },
    { key: "repository", labelKey: "mcpHub.storePreviewRepository", url: card.repositoryUrl },
  ];
  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    const url = candidate.url?.trim();
    if (!url || seen.has(url)) return [];
    seen.add(url);
    return [{ key: candidate.key, labelKey: candidate.labelKey, url }];
  });
}

function keyListLabel(record: Record<string, string> | undefined) {
  const keys = Object.keys(record ?? {}).filter(Boolean);
  return keys.length > 0 ? keys.join(", ") : null;
}

function ConfigChips({ card }: { card: McpRegistryCard }) {
  const inputs = configureDraftForCard(card)?.requiredConfig ?? [];
  if (inputs.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {inputs.slice(0, 5).map((input) => (
        <span
          key={`${input.target}:${input.name}`}
          className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground ring-1 ring-border/60"
          title={input.description ?? input.name}
        >
          {input.secret ? <Key className="h-3 w-3 shrink-0" /> : null}
          <span className="truncate">{input.name}</span>
        </span>
      ))}
      {inputs.length > 5 ? (
        <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground ring-1 ring-border/60">
          +{inputs.length - 5}
        </span>
      ) : null}
    </div>
  );
}

function RegistryCard(props: {
  group: McpRegistryCardGroup;
  searchQuery: string;
  installedIdForCard: (card: McpRegistryCard) => string | undefined;
  installingId: string | null;
  onPreview: (card: McpRegistryCard) => void;
  onInstall: (card: McpRegistryCard) => void;
}) {
  const { group, searchQuery, installedIdForCard, installingId, onPreview, onInstall } = props;
  const { t } = useLocale();
  const [selectedCardId, setSelectedCardId] = useState(group.cards[0]?.id ?? "");

  useEffect(() => {
    if (!group.cards.some((card) => card.id === selectedCardId)) {
      setSelectedCardId(group.cards[0]?.id ?? "");
    }
  }, [group.cards, selectedCardId]);

  const card = group.cards.find((item) => item.id === selectedCardId) ?? group.cards[0];
  if (!card) return null;

  const installedId = installedIdForCard(card);
  const installing = installingId === card.id;
  const done = Boolean(installedId);
  const configureDraft = configureDraftForCard(card);
  const transports = configureDraft ? [configureDraft.server.transport] : card.transportHints;
  const link = primaryRegistryLink(card);
  const versionOptions = group.cards.map((item) => ({
    id: item.id,
    label: versionLabelForCard(item) ?? t("mcpHub.storeVersionLatest"),
  }));
  const hasVersionSelector = versionOptions.length > 1;
  const headerPadding = hasVersionSelector ? (link ? "pr-36" : "pr-28") : link ? "pr-8" : undefined;

  return (
    // biome-ignore lint/a11y/useSemanticElements: The card contains nested controls and cannot be a native button.
    <div
      role="button"
      tabIndex={0}
      aria-label={card.displayName}
      onClick={() => onPreview(card)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onPreview(card);
        }
      }}
      className={cn(
        "skill-card-enter group relative flex h-full min-h-[228px] cursor-pointer flex-col rounded-xl border bg-card p-3.5 text-left shadow-xs transition-[border-color,box-shadow,background-color] focus:outline-none focus:ring-2 focus:ring-ring",
        done ? "border-emerald-600/25" : "border-border hover:border-foreground/20 hover:shadow-md",
      )}
    >
      {link || hasVersionSelector ? (
        // biome-ignore lint/a11y/useSemanticElements: This wrapper only isolates nested link/select events from the interactive preview card.
        <div
          role="group"
          aria-label={t("mcpHub.storeVersion")}
          className="absolute right-2.5 top-2.5 z-10 flex items-center gap-1.5"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {link ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-lg text-muted-foreground ring-1 ring-transparent hover:bg-muted hover:text-foreground hover:ring-border/60"
              title={t("mcpHub.storeOpenExternal")}
              aria-label={t("mcpHub.storeOpenExternal")}
              onClick={(event) => {
                event.stopPropagation();
                void openUrl(link);
              }}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          ) : null}
          {hasVersionSelector ? (
            <Select value={card.id} onValueChange={setSelectedCardId}>
              <SelectTrigger
                className="h-7 w-[5.75rem] overflow-hidden rounded-lg border-border/70 bg-background px-2 py-0 text-[10.5px] shadow-xs [&>svg]:h-3 [&>svg]:w-3 [&>svg]:shrink-0"
                title={versionLabelForCard(card) ?? t("mcpHub.storeVersionLatest")}
                aria-label={t("mcpHub.storeVersion")}
              >
                <SelectValue
                  className="min-w-0 flex-1 truncate text-left"
                  placeholder={t("mcpHub.storeVersionLatest")}
                />
              </SelectTrigger>
              <SelectContent className="min-w-[5.75rem]">
                {versionOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id} className="text-xs">
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </div>
      ) : null}
      <div className={cn("flex min-w-0 items-start gap-3", headerPadding)}>
        <div
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border transition-all",
            done
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : "border-border/70 bg-muted text-muted-foreground group-hover:text-foreground",
          )}
        >
          {card.remote ? (
            <Globe2 className="h-[18px] w-[18px]" />
          ) : (
            <Server className="h-[18px] w-[18px]" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start gap-1.5">
            <SearchHighlight
              text={card.displayName}
              query={searchQuery}
              className="truncate text-[13px] font-semibold leading-tight text-foreground"
            />
            {card.verified ? <Shield className="h-3.5 w-3.5 shrink-0 text-foreground/65" /> : null}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span
              className={cn(
                "inline-flex rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
                sourceTone(card.source),
              )}
            >
              {card.source}
            </span>
            {transports.map((transport) => (
              <span
                key={transport}
                className={cn(
                  "inline-flex rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase ring-1",
                  transportTone(transport),
                )}
              >
                {transport}
              </span>
            ))}
          </div>
        </div>
      </div>

      <p className="mt-3 line-clamp-3 min-h-[48px] text-[11.5px] leading-[1.45] text-muted-foreground">
        <SearchHighlight
          text={card.description || t("mcpHub.storeNoDescription")}
          query={searchQuery}
        />
      </p>

      {card.tags.length > 0 ? (
        <div className="mt-2.5 flex min-h-[22px] flex-wrap gap-1.5">
          {card.tags.slice(0, 4).map((tag) => (
            <span
              key={tag}
              className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground ring-1 ring-border/60"
            >
              <SearchHighlight text={tag} query={searchQuery} />
            </span>
          ))}
        </div>
      ) : null}

      <div
        className={cn(
          "mt-3 flex min-h-[40px] items-center rounded-lg border border-border/60 px-2.5 py-2 transition-colors",
          done ? "bg-emerald-500/5" : "bg-muted/50",
        )}
      >
        {configureDraft?.commandPreview ? (
          <code className="line-clamp-2 w-full break-all text-[10.5px] leading-[1.45] text-muted-foreground">
            <SearchHighlight text={configureDraft.commandPreview} query={searchQuery} />
          </code>
        ) : (
          <span className="text-[10.5px] text-muted-foreground">
            {card.installUnavailableReason === "needs-manual-command"
              ? t("mcpHub.storeNeedsCommand")
              : t("mcpHub.storeManualOnly")}
          </span>
        )}
      </div>

      <div className="mt-2.5">
        <ConfigChips card={card} />
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/60 pt-3">
        <span
          className="min-w-0 truncate text-[10.5px] text-muted-foreground"
          title={done ? `${t("mcpHub.storeInstalledAs")} ${installedId}` : card.name}
        >
          <SearchHighlight
            text={done ? `${t("mcpHub.storeInstalledAs")} ${installedId}` : card.name}
            query={searchQuery}
          />
        </span>
        <Button
          size="sm"
          variant={
            done ? "outline" : card.installDraft?.status === "needs_config" ? "outline" : "default"
          }
          className={cn(
            "h-8 shrink-0 gap-1.5 rounded-lg",
            done &&
              "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
          )}
          disabled={done || installing}
          onClick={(event) => {
            event.stopPropagation();
            onInstall(card);
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {installing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : done ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
          {done ? t("mcpHub.storeInstalled") : t(installLabelKey(card))}
        </Button>
      </div>
    </div>
  );
}

function McpRegistryPreviewDrawer(props: {
  card: McpRegistryCard;
  detail: McpRegistryCard | null;
  loading: boolean;
  error: string | null;
  installedId?: string;
  installing: boolean;
  onClose: () => void;
  onInstall: (card: McpRegistryCard) => void;
}) {
  const { card, detail, loading, error, installedId, installing, onClose, onInstall } = props;
  const { t } = useLocale();
  const data = detail ?? card;
  const draft = configureDraftForCard(data);
  const server = draft?.server;
  const transports = draft ? [draft.server.transport] : data.transportHints;
  const links = registryExternalLinks(data);
  const primaryLink = primaryRegistryLink(data);
  const requiredConfig = draft?.requiredConfig ?? [];
  const warnings = draft?.warnings ?? [];
  const installed = Boolean(installedId);
  const installActionKey = installLabelKey(data);
  const actionLabel = installing
    ? t("mcpHub.storeInstalling")
    : installed
      ? t("mcpHub.storeInstalled")
      : installActionKey === "mcpHub.storeInstall" || installActionKey === "mcpHub.storeConfigure"
        ? t(installActionKey)
        : t("mcpHub.storeAddDraft");

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        className="max-w-none border-border/70 shadow-[-18px_0_45px_-28px_rgba(15,23,42,0.45)] md:w-2/5 md:max-w-[34rem] dark:shadow-[-18px_0_45px_-28px_rgba(0,0,0,0.7)]"
        closeLabel={t("settings.cancel")}
      >
        <div className="flex flex-col gap-2.5 border-b border-border/70 px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-border/70 bg-muted/50 text-foreground shadow-xs">
              {data.remote ? <Globe2 className="h-5 w-5" /> : <Server className="h-5 w-5" />}
            </div>
            <div className="min-w-0 flex-1">
              <SheetDescription className="text-[10.5px] font-medium uppercase tracking-wider">
                {t("mcpHub.storePreviewTitle")}
              </SheetDescription>
              <SheetTitle className="mt-0.5 truncate text-[15px] tracking-tight">
                {data.displayName}
              </SheetTitle>
            </div>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <span
              className={cn("inline-flex rounded-md border px-1.5 py-0.5", sourceTone(data.source))}
            >
              {data.source}
            </span>
            {transports.map((transport) => (
              <span
                key={transport}
                className={cn(
                  "inline-flex rounded-md px-1.5 py-0.5 font-semibold uppercase ring-1",
                  transportTone(transport),
                )}
              >
                {transport}
              </span>
            ))}
            {data.verified ? (
              <span className="inline-flex items-center gap-1 text-foreground/75">
                <Shield className="h-3 w-3" />
                {t("mcpHub.storePreviewVerified")}
              </span>
            ) : null}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="flex flex-col gap-4">
            <p className="text-[13px] leading-6 text-muted-foreground">
              {data.description || t("mcpHub.storeNoDescription")}
            </p>

            <div className="grid grid-cols-2 gap-2">
              <McpPreviewMetric label={t("mcpHub.storePreviewSource")} value={data.source} />
              <McpPreviewMetric
                label={t("mcpHub.storePreviewMode")}
                value={data.remote ? t("mcpHub.storePreviewRemote") : t("mcpHub.storePreviewLocal")}
              />
            </div>

            {loading ? (
              <div className="space-y-2 rounded-2xl border border-border/70 bg-card p-3 shadow-xs">
                <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-foreground/65" />
                  {t("mcpHub.storePreviewLoadingDetail")}
                </div>
                <div className="skills-skeleton-shimmer h-3 w-full rounded" />
                <div className="skills-skeleton-shimmer h-3 w-4/5 rounded" />
              </div>
            ) : null}

            {error ? (
              <div className="rounded-2xl border border-border/70 bg-muted/50 p-3">
                <div className="flex items-start gap-2 text-[12px] text-muted-foreground">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground/65" />
                  <span>{t("mcpHub.storePreviewDetailUnavailable")}</span>
                </div>
              </div>
            ) : null}

            {data.tags.length > 0 ? (
              <div className="rounded-2xl border border-border/70 bg-card p-3 shadow-xs">
                <div className="mb-2 text-[12px] font-semibold text-foreground">
                  {t("mcpHub.storePreviewTags")}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {data.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-md bg-muted/55 px-1.5 py-0.5 text-[10.5px] text-muted-foreground ring-1 ring-border/30"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="rounded-2xl border border-border/70 bg-card p-3 shadow-xs">
              <div className="mb-2 text-[12px] font-semibold text-foreground">
                {t("mcpHub.storePreviewInstallPreview")}
              </div>
              {draft?.commandPreview ? (
                <code className="mb-2 block max-h-28 overflow-y-auto whitespace-pre-wrap break-all rounded-xl border border-border/70 bg-muted/50 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
                  {draft.commandPreview}
                </code>
              ) : (
                <div className="mb-2 rounded-xl border border-border/70 bg-muted/50 px-3 py-2 text-[12px] text-muted-foreground">
                  {data.installUnavailableReason === "needs-manual-command"
                    ? t("mcpHub.storeNeedsCommand")
                    : t("mcpHub.storeManualOnly")}
                </div>
              )}
              <div className="divide-y divide-border/30">
                <McpPreviewField
                  label={t("mcpHub.serverName")}
                  value={server?.id ?? data.name}
                  mono
                />
                <McpPreviewField
                  label={t("mcpHub.transport")}
                  value={transports.length > 0 ? transports.join(", ") : null}
                />
                <McpPreviewField
                  label={t("mcpHub.timeout")}
                  value={server?.timeoutMs ? `${server.timeoutMs} ms` : null}
                />
                <McpPreviewField label={t("mcpHub.command")} value={server?.command} mono />
                <McpPreviewField
                  label={t("mcpHub.args")}
                  value={server?.args?.length ? server.args.join("\n") : null}
                  mono
                />
                <McpPreviewField
                  label={server?.transport === "sse" ? t("mcpHub.urlSse") : t("mcpHub.urlHttp")}
                  value={server?.url}
                  mono
                />
                <McpPreviewField label={t("mcpHub.messageUrl")} value={server?.messageUrl} mono />
                <McpPreviewField label={t("mcpHub.env")} value={keyListLabel(server?.env)} mono />
                <McpPreviewField
                  label={t("mcpHub.headers")}
                  value={keyListLabel(server?.headers)}
                  mono
                />
              </div>
            </div>

            <div className="rounded-2xl border border-border/70 bg-card p-3 shadow-xs">
              <div className="mb-2 text-[12px] font-semibold text-foreground">
                {t("mcpHub.storePreviewRequiredConfig")}
              </div>
              {requiredConfig.length > 0 ? (
                <div className="space-y-2">
                  {requiredConfig.map((input) => (
                    <div
                      key={mcpRegistryConfigInputKey(input)}
                      className="rounded-xl border border-border/70 bg-muted/35 px-3 py-2"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        {input.secret ? (
                          <Key className="h-3.5 w-3.5 shrink-0 text-foreground/65" />
                        ) : null}
                        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                          {input.label ?? input.name}
                        </span>
                        <span className="rounded-md bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground ring-1 ring-border/60">
                          {configTargetLabel(input, t)}
                        </span>
                      </div>
                      {input.description ? (
                        <div className="mt-1 text-[11px] leading-4 text-muted-foreground">
                          {input.description}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[12px] text-muted-foreground">
                  {t("mcpHub.storePreviewNoRequiredConfig")}
                </div>
              )}
            </div>

            {warnings.length > 0 ? (
              <div className="rounded-2xl border border-border/70 bg-card p-3 shadow-xs">
                <div className="mb-2 text-[12px] font-semibold text-foreground/85">
                  {t("mcpHub.storePreviewWarnings")}
                </div>
                <div className="space-y-1 text-[12px] text-muted-foreground">
                  {warnings.map((warning) => (
                    <div key={warning}>{warning}</div>
                  ))}
                </div>
              </div>
            ) : null}

            {links.length > 0 ? (
              <div className="rounded-2xl border border-border/70 bg-card p-3 shadow-xs">
                <div className="mb-2 text-[12px] font-semibold text-foreground">
                  {t("mcpHub.storePreviewLinks")}
                </div>
                <div className="space-y-1.5">
                  {links.map((link) => (
                    <button
                      type="button"
                      key={`${link.key}:${link.url}`}
                      onClick={() => void openUrl(link.url)}
                      className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                    >
                      <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                      <span className="shrink-0">{t(link.labelKey)}</span>
                      <span className="min-w-0 truncate font-mono text-[11px] opacity-70">
                        {link.url}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 gap-2 border-t border-border/70 px-5 py-4">
          {primaryLink ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 flex-1 gap-1.5 rounded-xl border-border/70 bg-card shadow-xs"
              onClick={() => void openUrl(primaryLink)}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t("mcpHub.storeOpenExternal")}
            </Button>
          ) : null}
          <Button
            type="button"
            variant={installed || draft?.status === "needs_config" ? "outline" : "default"}
            size="sm"
            className={cn(
              "h-9 flex-1 gap-1.5 rounded-xl",
              installed &&
                "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
            )}
            disabled={installed || installing}
            onClick={() => onInstall(data)}
          >
            {installing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : installed ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            {actionLabel}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function McpPreviewMetric(props: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card px-3 py-2.5 shadow-xs">
      <div className="text-[10.5px] text-muted-foreground">{props.label}</div>
      <div className="mt-1 truncate text-sm font-semibold text-foreground" title={props.value}>
        {props.value}
      </div>
    </div>
  );
}

function McpPreviewField(props: { label: string; value?: string | null; mono?: boolean }) {
  if (!props.value) return null;
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 py-2 text-[12px]">
      <div className="text-muted-foreground">{props.label}</div>
      <div
        className={cn(
          "min-w-0 break-words text-foreground",
          props.mono && "whitespace-pre-wrap font-mono text-[11px]",
        )}
      >
        {props.value}
      </div>
    </div>
  );
}

export function McpRegistryBrowser(props: McpRegistryBrowserProps) {
  const { settings, setSettings, query } = props;
  const { t } = useLocale();
  const [source, setSource] = useState<McpRegistrySource>("official");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [items, setItems] = useState<McpRegistryCard[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [configuringCard, setConfiguringCard] = useState<McpRegistryCard | null>(null);
  const [previewCard, setPreviewCard] = useState<McpRegistryCard | null>(null);
  const [previewDetail, setPreviewDetail] = useState<McpRegistryCard | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [installedByCardId, setInstalledByCardId] = useState<Record<string, string>>({});
  const scrollRootRef = useRef<HTMLDivElement>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);
  const loadMoreRequestRef = useRef(false);
  const searchGenerationRef = useRef(0);
  const submittedQueryRef = useRef("");
  const previousSourceRef = useRef(source);
  const groupedItems = useMemo(
    () =>
      rankFuzzySearchResults(
        groupMcpRegistryCards(items),
        submittedQuery,
        (group) =>
          group.cards.flatMap((card) => [
            card.displayName,
            card.name,
            card.description,
            card.source,
            card.versionLabel,
            card.installDraft?.commandPreview,
            card.manualDraft?.commandPreview,
            ...card.tags,
            ...card.transportHints,
          ]),
        { includeUnmatched: true },
      ),
    [items, submittedQuery],
  );

  const existingIds = useMemo(
    () => new Set(settings.mcp.servers.map((server) => server.id)),
    [settings.mcp.servers],
  );

  useEffect(() => {
    if (!previewCard) {
      setPreviewDetail(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }

    let cancelled = false;
    setPreviewDetail(null);
    setPreviewError(null);
    setPreviewLoading(true);

    void resolveMcpRegistryInstallDraft(previewCard)
      .then((resolved) => {
        if (cancelled) return;
        setPreviewDetail(resolved);
        setItems((prev) => prev.map((item) => (item.id === resolved.id ? resolved : item)));
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setPreviewError(message || t("mcpHub.storeLoadFailed"));
      })
      .finally(() => {
        if (!cancelled) {
          setPreviewLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [previewCard, t]);

  const runSearch = useCallback(
    async (mode: "replace" | "append" = "replace", nextQuery?: string) => {
      const cursor = mode === "append" ? nextCursor : undefined;
      if (mode === "append" && (!cursor || loadMoreRequestRef.current)) return;
      const requestQuery =
        mode === "append" ? submittedQueryRef.current : (nextQuery ?? query).trim();
      const generation =
        mode === "replace" ? ++searchGenerationRef.current : searchGenerationRef.current;
      if (mode === "append") {
        loadMoreRequestRef.current = true;
        setLoadingMore(true);
      } else {
        submittedQueryRef.current = requestQuery;
        setSubmittedQuery(requestQuery);
        setLoading(true);
      }
      setError(null);
      try {
        const result = await searchMcpRegistry({
          source,
          query: requestQuery,
          cursor,
          limit: MCP_STORE_PAGE_LIMIT,
        });
        if (generation !== searchGenerationRef.current) return;
        setItems((prev) =>
          mode === "append" ? appendUniqueRegistryCards(prev, result.items) : result.items,
        );
        setNextCursor(result.nextCursor === cursor ? undefined : result.nextCursor);
      } catch (err) {
        if (generation !== searchGenerationRef.current) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message || t("mcpHub.storeLoadFailed"));
        if (mode === "replace") {
          setItems([]);
          setNextCursor(undefined);
        }
      } finally {
        if (mode === "append") loadMoreRequestRef.current = false;
        if (generation === searchGenerationRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [nextCursor, query, source, t],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: Search runs only when the controlled query or source changes; pagination state must not retrigger it.
  useEffect(() => {
    searchGenerationRef.current += 1;
    loadMoreRequestRef.current = false;
    setLoadingMore(false);
    setNextCursor(undefined);
    const sourceChanged = previousSourceRef.current !== source;
    previousSourceRef.current = source;
    if (sourceChanged) {
      setItems([]);
      setError(null);
      setPreviewCard(null);
    }
    const timer = window.setTimeout(
      () => void runSearch("replace", query),
      sourceChanged || !query.trim() ? 0 : 260,
    );
    return () => window.clearTimeout(timer);
  }, [query, source]);

  useEffect(() => {
    const root = scrollRootRef.current;
    const sentinel = loadMoreSentinelRef.current;
    if (!root || !sentinel || !nextCursor || loading || loadingMore || error) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void runSearch("append");
        }
      },
      {
        root,
        rootMargin: "0px 0px 320px 0px",
        threshold: 0,
      },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [error, loading, loadingMore, nextCursor, runSearch]);

  function installedIdForCard(card: McpRegistryCard) {
    const draft = configureDraftForCard(card);
    const draftId = draft?.server.id ?? "";
    return (
      installedByCardId[card.id] ?? (draftId && existingIds.has(draftId) ? draftId : undefined)
    );
  }

  function addServerFromStore(card: McpRegistryCard, server: McpServerConfig) {
    const enrichedServer = enrichMcpServerWithRegistryMetadata(server, card);
    const installedId = enrichedServer.id;
    setSettings((prev) => {
      return updateMcp(prev, {
        servers: [...prev.mcp.servers, enrichedServer],
      });
    });
    setInstalledByCardId((prev) => ({ ...prev, [card.id]: installedId }));
  }

  async function installCard(card: McpRegistryCard) {
    setInstallingId(card.id);
    setError(null);
    try {
      const resolved = await resolveMcpRegistryInstallDraft(card);
      setItems((prev) => prev.map((item) => (item.id === card.id ? resolved : item)));
      if (previewCard?.id === card.id) {
        setPreviewDetail(resolved);
      }
      if (!resolved.installDraft) {
        setConfiguringCard(resolved);
        return;
      }
      if (resolved.installDraft.status === "needs_config") {
        setConfiguringCard(resolved);
        return;
      }
      const draft = withUniqueMcpServerId(resolved.installDraft, settings.mcp.servers);
      addServerFromStore(resolved, draft.server);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message || t("mcpHub.storeInstallFailed"));
    } finally {
      setInstallingId(null);
    }
  }

  const currentSourceLabel =
    MCP_REGISTRY_SOURCE_OPTIONS.find((option) => option.value === source)?.label ?? source;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      <McpRegistryToolbar
        source={source}
        loading={loading}
        loadingMore={loadingMore}
        onSourceChange={setSource}
        onRefresh={() => void runSearch("replace", query)}
      />

      {error ? (
        <div className="hub-panel-enter flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      ) : null}

      <div ref={scrollRootRef} className="min-h-0 flex-1 overflow-y-auto px-1 pb-4 pt-2">
        <div className="flex flex-col gap-4">
          {loading && items.length === 0 ? (
            <>
              <div key={source} className="hub-frost-hero hub-panel-enter px-4 py-3.5">
                <div className="flex items-center gap-3.5">
                  <FrostSpinner />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium tracking-tight text-foreground">
                      {t("mcpHub.storeLoadingTitle")}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {t("mcpHub.storeLoadingDesc").replace("{source}", currentSourceLabel)}
                    </div>
                  </div>
                </div>
                <div className="hub-frost-track mt-3.5" />
              </div>

              <div key={`${source}-skeleton`} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {STORE_SKELETON_IDS.map((skeletonId) => (
                  <div
                    key={skeletonId}
                    className="hub-frost-skeleton skill-card-enter h-[228px] p-3.5"
                  >
                    <div className="flex items-center gap-3">
                      <div className="skills-skeleton-shimmer h-10 w-10 shrink-0 rounded-xl" />
                      <div className="flex-1 space-y-2">
                        <div className="skills-skeleton-shimmer h-3.5 w-28 rounded" />
                        <div className="skills-skeleton-shimmer h-3 w-full max-w-[12rem] rounded" />
                      </div>
                    </div>
                    <div className="mt-3 space-y-2">
                      <div className="skills-skeleton-shimmer h-3 w-full rounded" />
                      <div className="skills-skeleton-shimmer h-3 w-3/4 rounded" />
                    </div>
                    <div className="skills-skeleton-shimmer mt-4 h-8 w-full rounded-lg" />
                  </div>
                ))}
              </div>
            </>
          ) : groupedItems.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {groupedItems.map((group) => (
                <RegistryCard
                  key={group.id}
                  group={group}
                  searchQuery={submittedQuery}
                  installedIdForCard={installedIdForCard}
                  installingId={installingId}
                  onPreview={setPreviewCard}
                  onInstall={(next) => void installCard(next)}
                />
              ))}
            </div>
          ) : (
            <div className="hub-panel-enter rounded-2xl border border-dashed border-border/70 bg-card px-6 py-12 text-center shadow-xs">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-border/70 bg-background text-foreground shadow-xs">
                <Terminal className="h-6 w-6" />
              </div>
              <p className="mt-4 text-sm font-medium text-foreground">
                {t("mcpHub.storeEmptyTitle")}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{t("mcpHub.storeEmptyDesc")}</p>
            </div>
          )}

          {nextCursor && items.length > 0 ? (
            <div
              ref={loadMoreSentinelRef}
              className="flex min-h-12 items-center justify-center"
              aria-live="polite"
            >
              {loadingMore ? (
                <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>{t("mcpHub.storeLoadingTitle")}</span>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      {previewCard ? (
        <McpRegistryPreviewDrawer
          card={previewCard}
          detail={previewDetail}
          loading={previewLoading}
          error={previewError}
          installedId={installedIdForCard(previewDetail ?? previewCard)}
          installing={installingId === previewCard.id}
          onClose={() => setPreviewCard(null)}
          onInstall={(next) => void installCard(next)}
        />
      ) : null}
      {configuringCard ? (
        <McpRegistryConfigureModal
          card={configuringCard}
          existingServers={settings.mcp.servers}
          onClose={() => setConfiguringCard(null)}
          onSave={(server) => {
            const uniqueServer = {
              ...server,
              id: createUniqueMcpServerId(
                server.id || configuringCard.name || configuringCard.displayName,
                settings.mcp.servers.map((item) => item.id),
              ),
            };
            addServerFromStore(configuringCard, uniqueServer);
          }}
        />
      ) : null}
    </div>
  );
}
