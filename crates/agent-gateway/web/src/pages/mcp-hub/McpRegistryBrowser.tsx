import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  AlertTriangle,
  Check,
  ExternalLink,
  Globe2,
  Key,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Server,
  Shield,
  Sparkles,
  Terminal,
  X,
} from "../../components/icons";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { useLocale } from "../../i18n";
import {
  applyMcpRegistryInstallConfig,
  createUniqueMcpServerId,
  MCP_REGISTRY_SOURCE_OPTIONS,
  type McpRegistryCard,
  type McpRegistryConfigInput,
  type McpRegistryInstallDraft,
  type McpRegistrySource,
  mcpRegistryConfigInputKey,
  resolveMcpRegistryInstallDraft,
  searchMcpRegistry,
  withUniqueMcpServerId,
} from "../../lib/mcpRegistry";
import { type AppSettings, type McpServerConfig, updateMcp } from "../../lib/settings";
import { useModalMotion } from "../../lib/shared/modalMotion";
import { cn } from "../../lib/shared/utils";

const STORE_PAGE_LIMIT = 18;

type McpRegistryBrowserProps = {
  settings: AppSettings;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
};

type McpConfigModalDraft = {
  id: string;
  transport: McpServerConfig["transport"];
  timeoutMs: string;
  command: string;
  cwd: string;
  argsText: string;
  envText: string;
  url: string;
  messageUrl: string;
  headersText: string;
  configValues: Record<string, string>;
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
      {Array.from({ length: 12 }).map((_, i) => (
        <i key={i} />
      ))}
    </span>
  );
}

function sourceTone(_source: McpRegistrySource) {
  // Source label is rendered as a neutral frosted-glass chip; the text alone communicates the source.
  return "border-border/45 bg-background/70 text-foreground/75";
}

function transportTone(_transport: string) {
  return "bg-background/70 text-foreground/75 ring-border/45";
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

function installLabelKey(card: McpRegistryCard) {
  if (!card.installDraft && card.source === "smithery") return "mcpHub.storeInstall";
  if (card.installDraft?.status === "needs_config") return "mcpHub.storeConfigure";
  return card.installDraft ? "mcpHub.storeInstall" : "mcpHub.storeManualOnly";
}

function configureDraftForCard(card: McpRegistryCard) {
  return card.installDraft ?? card.manualDraft;
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

function formatKeyValueRecord(input: Record<string, string> | undefined) {
  return input
    ? Object.entries(input)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n")
    : "";
}

function parseLineList(input: string) {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseKeyValueDraft(input: string, errorPrefix: string) {
  const out: Record<string, string> = {};
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      throw new Error(`${errorPrefix}: ${trimmed}`);
    }
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!key || !value) {
      throw new Error(`${errorPrefix}: ${trimmed}`);
    }
    out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function cleanConfigValue(value: string | undefined) {
  if (!value || value === "...") return "";
  return value;
}

function valueFromServerConfig(input: McpRegistryConfigInput, server: McpServerConfig) {
  const targetName = input.targetName ?? input.name;
  if (input.target === "env") {
    return cleanConfigValue(server.env?.[targetName] ?? server.env?.[input.name]);
  }
  if (input.target === "header") {
    return cleanConfigValue(server.headers?.[targetName] ?? server.headers?.[input.name]);
  }
  if (input.target === "url") {
    try {
      const parsed = new URL(server.url);
      return cleanConfigValue(parsed.searchParams.get(targetName) ?? undefined);
    } catch {
      return "";
    }
  }
  if (input.target === "config") {
    for (let index = 0; index < (server.args ?? []).length; index += 1) {
      const arg = server.args[index];
      const rawConfig =
        arg === "--config"
          ? server.args[index + 1]
          : arg.startsWith("--config=")
            ? arg.slice("--config=".length)
            : undefined;
      if (!rawConfig) continue;
      try {
        const parsed = JSON.parse(rawConfig);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        const value =
          (parsed as Record<string, unknown>)[targetName] ??
          (parsed as Record<string, unknown>)[input.name];
        return cleanConfigValue(
          typeof value === "string" ? value : value === undefined ? undefined : String(value),
        );
      } catch {
        return "";
      }
    }
  }
  return "";
}

function pickInitialTransport(card: McpRegistryCard): McpServerConfig["transport"] {
  const transport = configureDraftForCard(card)?.server.transport ?? card.transportHints[0];
  if (transport === "http" || transport === "sse") return transport;
  return "stdio";
}

function buildModalDraft(
  card: McpRegistryCard,
  existingServers: McpServerConfig[],
): McpConfigModalDraft {
  const configureDraft = configureDraftForCard(card);
  const server = configureDraft?.server;
  const transport = pickInitialTransport(card);
  const id = createUniqueMcpServerId(
    server?.id || card.name || card.displayName,
    existingServers.map((item) => item.id),
  );
  const configValues: Record<string, string> = {};
  for (const input of configureDraft?.requiredConfig ?? []) {
    configValues[mcpRegistryConfigInputKey(input)] = server
      ? valueFromServerConfig(input, server)
      : "";
  }

  return {
    id,
    transport,
    timeoutMs: String(server?.timeoutMs ?? 60_000),
    command: server?.command ?? "",
    cwd: server?.cwd ?? "",
    argsText: (server?.args ?? []).join("\n"),
    envText: formatKeyValueRecord(server?.env),
    url: server?.url ?? "",
    messageUrl: server?.messageUrl ?? "",
    headersText: formatKeyValueRecord(server?.headers),
    configValues,
  };
}

function configTargetLabel(input: McpRegistryConfigInput, t: (key: string) => string) {
  if (input.target === "env") return t("mcpHub.previewEnv");
  if (input.target === "header") return t("mcpHub.previewHeaders");
  if (input.target === "argument") return t("mcpHub.previewArgs");
  if (input.target === "url") return "URL";
  return "Config";
}

function keyListLabel(record: Record<string, string> | undefined) {
  const keys = Object.keys(record ?? {}).filter(Boolean);
  return keys.length > 0 ? keys.join(", ") : null;
}

function buildServerFromModalDraft(
  draft: McpConfigModalDraft,
  requiredConfig: McpRegistryConfigInput[],
  t: (key: string) => string,
): McpServerConfig {
  const id = draft.id.trim();
  if (!id) {
    throw new Error(t("mcpHub.storeConfigureNameRequired"));
  }

  const timeoutMs = Number(draft.timeoutMs.trim());
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(t("mcpHub.storeConfigureTimeoutInvalid"));
  }

  for (const input of requiredConfig) {
    const value = draft.configValues[mcpRegistryConfigInputKey(input)]?.trim() ?? "";
    if (input.required && !value) {
      throw new Error(
        t("mcpHub.storeConfigureRequiredMissing").replace("{name}", input.label ?? input.name),
      );
    }
  }

  if (draft.transport === "stdio") {
    const command = draft.command.trim();
    if (!command) {
      throw new Error(t("mcpHub.storeConfigureCommandRequired"));
    }
    return {
      id,
      enabled: true,
      transport: "stdio",
      command,
      args: parseLineList(draft.argsText),
      env: parseKeyValueDraft(draft.envText, t("mcpHub.storeConfigureInvalidKeyValue")),
      cwd: draft.cwd.trim() || undefined,
      url: "",
      timeoutMs: Math.floor(timeoutMs),
    };
  }

  const url = draft.url.trim();
  if (!url) {
    throw new Error(t("mcpHub.storeConfigureUrlRequired"));
  }

  return {
    id,
    enabled: true,
    transport: draft.transport,
    command: "",
    args: [],
    url,
    headers: parseKeyValueDraft(draft.headersText, t("mcpHub.storeConfigureInvalidKeyValue")),
    timeoutMs: Math.floor(timeoutMs),
    messageUrl: draft.transport === "sse" ? draft.messageUrl.trim() || undefined : undefined,
  };
}

function McpConfigureModal(props: {
  card: McpRegistryCard;
  existingServers: McpServerConfig[];
  onClose: () => void;
  onSave: (server: McpServerConfig) => void;
}) {
  const { card, existingServers, onClose, onSave } = props;
  const { t } = useLocale();
  const { modalState, requestClose } = useModalMotion(onClose);
  const configureDraft = configureDraftForCard(card);
  const requiredConfig = configureDraft?.requiredConfig ?? [];
  const [draft, setDraft] = useState(() => buildModalDraft(card, existingServers));
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(buildModalDraft(card, existingServers));
    setFormError(null);
  }, [card, existingServers]);

  function updateDraft(patch: Partial<McpConfigModalDraft>) {
    setFormError(null);
    setDraft((prev) => ({ ...prev, ...patch }));
  }

  function updateConfigValue(input: McpRegistryConfigInput, value: string) {
    setFormError(null);
    const key = mcpRegistryConfigInputKey(input);
    setDraft((prev) => ({
      ...prev,
      configValues: {
        ...prev.configValues,
        [key]: value,
      },
    }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const server = buildServerFromModalDraft(draft, requiredConfig, t);
      const configuredDraft: McpRegistryInstallDraft = {
        server,
        status: requiredConfig.length > 0 ? "needs_config" : "ready",
        requiredConfig,
        warnings: configureDraft?.warnings ?? [],
        commandPreview: "",
      };
      const finalDraft =
        requiredConfig.length > 0
          ? applyMcpRegistryInstallConfig(configuredDraft, draft.configValues)
          : configuredDraft;
      onSave(finalDraft.server);
      requestClose();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    }
  }

  const isStdio = draft.transport === "stdio";
  const isSse = draft.transport === "sse";

  return createPortal(
    <div
      className="settings-modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4"
      data-state={modalState}
      role="dialog"
      aria-modal="true"
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={requestClose} />
      <form
        onSubmit={handleSubmit}
        className="settings-modal-panel relative z-10 flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border/60 bg-background shadow-2xl"
      >
        <div className="settings-modal-header flex items-center gap-3 border-b border-border/40 px-6 py-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border/55 bg-background/80 text-foreground/85 shadow-[0_1px_0_rgba(255,255,255,0.55)_inset] dark:border-white/[0.09] dark:bg-white/[0.06] dark:shadow-[0_1px_0_rgba(255,255,255,0.06)_inset]">
            <Sparkles className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">{t("mcpHub.storeConfigureTitle")}</h2>
            <p className="mt-0.5 truncate text-xs text-muted-foreground" title={card.displayName}>
              {t("mcpHub.storeConfigureSubtitle").replace("{name}", card.displayName)}
            </p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            title={t("settings.cancel")}
            aria-label={t("settings.cancel")}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="settings-modal-body flex-1 overflow-y-auto px-6 py-5">
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5 sm:col-span-1">
                <Label htmlFor="mcp-store-config-id" className="text-xs text-muted-foreground">
                  {t("mcpHub.serverName")}
                </Label>
                <Input
                  id="mcp-store-config-id"
                  value={draft.id}
                  placeholder={t("mcpHub.serverNamePlaceholder")}
                  onChange={(event) => updateDraft({ id: event.currentTarget.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label
                  htmlFor="mcp-store-config-transport"
                  className="text-xs text-muted-foreground"
                >
                  {t("mcpHub.transport")}
                </Label>
                <Select
                  value={draft.transport}
                  onValueChange={(value) => {
                    const transport = value === "http" ? "http" : value === "sse" ? "sse" : "stdio";
                    updateDraft({ transport });
                  }}
                >
                  <SelectTrigger id="mcp-store-config-transport">
                    <SelectValue placeholder={t("mcpHub.selectTransport")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stdio">{t("mcpHub.stdio")}</SelectItem>
                    <SelectItem value="http">{t("mcpHub.http")}</SelectItem>
                    <SelectItem value="sse">{t("mcpHub.sse")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mcp-store-config-timeout" className="text-xs text-muted-foreground">
                  {t("mcpHub.timeout")}
                </Label>
                <Input
                  id="mcp-store-config-timeout"
                  type="number"
                  value={draft.timeoutMs}
                  placeholder="60000"
                  onChange={(event) => updateDraft({ timeoutMs: event.currentTarget.value })}
                />
              </div>
            </div>

            {isStdio ? (
              <div className="space-y-3 rounded-xl border border-border/45 bg-muted/20 p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="mcp-store-config-command"
                      className="text-xs text-muted-foreground"
                    >
                      {t("mcpHub.command")}
                    </Label>
                    <Input
                      id="mcp-store-config-command"
                      value={draft.command}
                      placeholder="npx"
                      className="font-mono text-[12.5px]"
                      onChange={(event) => updateDraft({ command: event.currentTarget.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="mcp-store-config-cwd" className="text-xs text-muted-foreground">
                      {t("mcpHub.cwd")}
                    </Label>
                    <Input
                      id="mcp-store-config-cwd"
                      value={draft.cwd}
                      placeholder={t("mcpHub.cwdDefault")}
                      className="font-mono text-[12.5px]"
                      onChange={(event) => updateDraft({ cwd: event.currentTarget.value })}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="mcp-store-config-args" className="text-xs text-muted-foreground">
                    {t("mcpHub.args")}
                  </Label>
                  <Textarea
                    id="mcp-store-config-args"
                    value={draft.argsText}
                    placeholder={"-y\n@modelcontextprotocol/server-time"}
                    className="min-h-[92px] font-mono text-[12.5px]"
                    onChange={(event) => updateDraft({ argsText: event.currentTarget.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="mcp-store-config-env" className="text-xs text-muted-foreground">
                    {t("mcpHub.env")}
                  </Label>
                  <Textarea
                    id="mcp-store-config-env"
                    value={draft.envText}
                    placeholder={"BRAVE_API_KEY=...\nHTTP_PROXY=..."}
                    className="min-h-[92px] font-mono text-[12.5px]"
                    onChange={(event) => updateDraft({ envText: event.currentTarget.value })}
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-3 rounded-xl border border-border/45 bg-muted/20 p-4">
                <div className="space-y-1.5">
                  <Label htmlFor="mcp-store-config-url" className="text-xs text-muted-foreground">
                    {draft.transport === "http" ? t("mcpHub.urlHttp") : t("mcpHub.urlSse")}
                  </Label>
                  <Input
                    id="mcp-store-config-url"
                    value={draft.url}
                    placeholder={
                      draft.transport === "http"
                        ? "http://127.0.0.1:3000/mcp"
                        : "http://127.0.0.1:3000/sse"
                    }
                    className="font-mono text-[12.5px]"
                    onChange={(event) => updateDraft({ url: event.currentTarget.value })}
                  />
                </div>
                {isSse ? (
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="mcp-store-config-message-url"
                      className="text-xs text-muted-foreground"
                    >
                      {t("mcpHub.messageUrl")}
                    </Label>
                    <Input
                      id="mcp-store-config-message-url"
                      value={draft.messageUrl}
                      placeholder="http://127.0.0.1:3000/message"
                      className="font-mono text-[12.5px]"
                      onChange={(event) => updateDraft({ messageUrl: event.currentTarget.value })}
                    />
                  </div>
                ) : null}
                <div className="space-y-1.5">
                  <Label
                    htmlFor="mcp-store-config-headers"
                    className="text-xs text-muted-foreground"
                  >
                    {t("mcpHub.headers")}
                  </Label>
                  <Textarea
                    id="mcp-store-config-headers"
                    value={draft.headersText}
                    placeholder={"Authorization=Bearer ...\nX-API-Key=..."}
                    className="min-h-[92px] font-mono text-[12.5px]"
                    onChange={(event) => updateDraft({ headersText: event.currentTarget.value })}
                  />
                </div>
              </div>
            )}

            {requiredConfig.length > 0 ? (
              <div className="space-y-3 rounded-xl border border-border/50 bg-background/65 p-4 backdrop-blur-md">
                <div>
                  <div className="text-sm font-semibold">
                    {t("mcpHub.storeConfigureRequiredTitle")}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("mcpHub.storeConfigureRequiredDesc")}
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {requiredConfig.map((input) => {
                    const key = mcpRegistryConfigInputKey(input);
                    return (
                      <div key={key} className="space-y-1.5">
                        <Label
                          htmlFor={`mcp-store-config-${key}`}
                          className="text-xs text-muted-foreground"
                        >
                          {input.label ?? input.name}
                        </Label>
                        <Input
                          id={`mcp-store-config-${key}`}
                          type={input.secret ? "password" : "text"}
                          value={draft.configValues[key] ?? ""}
                          placeholder={input.name}
                          onChange={(event) => updateConfigValue(input, event.currentTarget.value)}
                        />
                        <div className="flex items-start gap-1.5 text-[10.5px] text-muted-foreground/75">
                          <span className="rounded bg-background/60 px-1.5 py-0.5 font-mono">
                            {configTargetLabel(input, t)}
                          </span>
                          {input.description ? <span>{input.description}</span> : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {formError ? (
              <div className="flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/[0.06] px-3 py-2.5 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{formError}</span>
              </div>
            ) : null}
          </div>
        </div>

        <div className="settings-modal-footer settings-modal-footer-row flex items-center justify-end gap-2 border-t border-border/40 px-6 py-4">
          <Button type="button" variant="outline" onClick={requestClose}>
            {t("settings.cancel")}
          </Button>
          <Button type="submit" className="gap-1.5">
            <Plus className="h-3.5 w-3.5" />
            {t("mcpHub.storeConfigureSubmit")}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

function ConfigChips({ card }: { card: McpRegistryCard }) {
  const inputs = configureDraftForCard(card)?.requiredConfig ?? [];
  if (inputs.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {inputs.slice(0, 5).map((input) => (
        <span
          key={`${input.target}:${input.name}`}
          className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground ring-1 ring-border/30"
          title={input.description ?? input.name}
        >
          {input.secret ? <Key className="h-3 w-3 shrink-0" /> : null}
          <span className="truncate">{input.name}</span>
        </span>
      ))}
      {inputs.length > 5 ? (
        <span className="rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground ring-1 ring-border/30">
          +{inputs.length - 5}
        </span>
      ) : null}
    </div>
  );
}

function RegistryCard(props: {
  group: McpRegistryCardGroup;
  installedIdForCard: (card: McpRegistryCard) => string | undefined;
  installingId: string | null;
  onPreview: (card: McpRegistryCard) => void;
  onInstall: (card: McpRegistryCard) => void;
}) {
  const { group, installedIdForCard, installingId, onPreview, onInstall } = props;
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
    <div
      role="button"
      tabIndex={0}
      onClick={() => onPreview(card)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onPreview(card);
        }
      }}
      className={cn(
        "skill-card-enter group relative flex h-full min-h-[228px] cursor-pointer flex-col rounded-2xl border p-3.5 text-left backdrop-blur-xl transition-all focus:outline-none focus:ring-2 focus:ring-foreground/10",
        done
          ? "border-border/55 bg-background/80 shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_4px_18px_-12px_rgba(15,23,42,0.18)] dark:border-white/[0.10] dark:bg-white/[0.07] dark:shadow-[0_1px_0_rgba(255,255,255,0.07)_inset,0_4px_18px_-12px_rgba(0,0,0,0.55)]"
          : "border-border/40 bg-background/55 hover:-translate-y-0.5 hover:border-border/55 hover:bg-background/70 hover:shadow-[0_4px_16px_-10px_rgba(15,23,42,0.18)] dark:border-white/[0.05] dark:bg-white/[0.03] dark:hover:border-white/[0.10] dark:hover:bg-white/[0.06] dark:hover:shadow-[0_4px_16px_-10px_rgba(0,0,0,0.55)]",
      )}
    >
      {link || hasVersionSelector ? (
        <div
          className="absolute right-2.5 top-2.5 z-10 flex items-center gap-1.5"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {link ? (
            <a
              href={link}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground/70 ring-1 ring-transparent transition-all hover:bg-foreground/[0.06] hover:text-foreground hover:ring-border/45"
              title={t("mcpHub.storeOpenExternal")}
              aria-label={t("mcpHub.storeOpenExternal")}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : null}
          {hasVersionSelector ? (
            <Select value={card.id} onValueChange={setSelectedCardId}>
              <SelectTrigger
                className="h-7 w-[5.75rem] overflow-hidden rounded-lg border-border/40 bg-background/85 px-2 py-0 text-[10.5px] shadow-none backdrop-blur-md [&>svg]:h-3 [&>svg]:w-3 [&>svg]:shrink-0"
                title={versionLabelForCard(card) ?? t("mcpHub.storeVersionLatest")}
                aria-label={t("mcpHub.storeVersion")}
              >
                <SelectValue
                  className="min-w-0 flex-1 truncate text-left"
                  placeholder={t("mcpHub.storeVersionLatest")}
                />
              </SelectTrigger>
              <SelectContent className="z-[70] min-w-[5.75rem]">
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
              ? "border-border/55 bg-background/80 text-foreground/85 shadow-[0_1px_0_rgba(255,255,255,0.55)_inset] dark:border-white/[0.09] dark:bg-white/[0.06] dark:shadow-[0_1px_0_rgba(255,255,255,0.06)_inset]"
              : "border-border/30 bg-muted/50 text-muted-foreground group-hover:border-border/50 group-hover:bg-background/70 group-hover:text-foreground/85",
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
            <span className="truncate text-[13px] font-semibold leading-tight text-foreground">
              {card.displayName}
            </span>
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
        {card.description || t("mcpHub.storeNoDescription")}
      </p>

      {card.tags.length > 0 ? (
        <div className="mt-2.5 flex min-h-[22px] flex-wrap gap-1.5">
          {card.tags.slice(0, 4).map((tag) => (
            <span
              key={tag}
              className="rounded-md bg-muted/55 px-1.5 py-0.5 text-[10px] text-muted-foreground ring-1 ring-border/30"
            >
              {tag}
            </span>
          ))}
        </div>
      ) : null}

      <div
        className={cn(
          "mt-3 min-h-[40px] rounded-lg border border-border/30 px-2.5 py-2 transition-colors",
          done ? "bg-background/65" : "bg-muted/40 group-hover:bg-background/60",
        )}
      >
        {configureDraft?.commandPreview ? (
          <code className="line-clamp-2 break-all text-[10.5px] leading-[1.45] text-muted-foreground/90">
            {configureDraft.commandPreview}
          </code>
        ) : (
          <span className="text-[10.5px] text-muted-foreground/70">
            {card.installUnavailableReason === "needs-manual-command"
              ? t("mcpHub.storeNeedsCommand")
              : t("mcpHub.storeManualOnly")}
          </span>
        )}
      </div>

      <div className="mt-2.5">
        <ConfigChips card={card} />
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/30 pt-3">
        <span
          className="min-w-0 truncate text-[10.5px] text-muted-foreground/80"
          title={done ? `${t("mcpHub.storeInstalledAs")} ${installedId}` : card.name}
        >
          {done ? `${t("mcpHub.storeInstalledAs")} ${installedId}` : card.name}
        </span>
        <Button
          size="sm"
          variant={
            done ? "outline" : card.installDraft?.status === "needs_config" ? "outline" : "default"
          }
          className={cn(
            "h-8 shrink-0 gap-1.5 rounded-lg",
            done && "border-border/55 bg-background/75 text-foreground/85 backdrop-blur-md",
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
            <Sparkles className="h-3.5 w-3.5" />
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

  const [closing, setClosing] = useState(false);
  const closeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, []);

  const handleClose = useCallback(() => {
    if (closing) return;
    setClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      onClose();
    }, 220);
  }, [closing, onClose]);

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-50 flex justify-end bg-background/35 backdrop-blur-[2px]",
        closing ? "skills-drawer-backdrop-closing" : "skills-drawer-backdrop",
      )}
      role="dialog"
      aria-modal="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          handleClose();
        }
      }}
    >
      <aside
        className={cn(
          "flex h-full w-full flex-col border-l border-border/45 bg-background/95 shadow-[-18px_0_45px_-28px_rgba(15,23,42,0.45)] dark:border-white/[0.08] dark:bg-popover/95 dark:shadow-[-18px_0_45px_-28px_rgba(0,0,0,0.7)] backdrop-blur-xl md:w-2/5 md:max-w-[34rem]",
          closing ? "skills-drawer-panel-closing" : "skills-drawer-panel",
        )}
      >
        <div className="flex flex-col gap-2.5 border-b border-border/40 px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-border/55 bg-background/80 text-foreground/85 shadow-[0_1px_0_rgba(255,255,255,0.55)_inset] dark:border-white/[0.09] dark:bg-white/[0.06] dark:shadow-[0_1px_0_rgba(255,255,255,0.06)_inset]">
              {data.remote ? <Globe2 className="h-5 w-5" /> : <Server className="h-5 w-5" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground/80">
                {t("mcpHub.storePreviewTitle")}
              </div>
              <h2 className="mt-0.5 truncate text-[15px] font-semibold tracking-tight text-foreground">
                {data.displayName}
              </h2>
            </div>
            <button
              type="button"
              onClick={handleClose}
              title={t("settings.cancel")}
              aria-label={t("settings.cancel")}
              className="flex h-8 w-8 shrink-0 items-center justify-center self-start rounded-full text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
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
              <div className="space-y-2 rounded-2xl border border-border/35 bg-background/60 p-3">
                <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-foreground/65" />
                  {t("mcpHub.storePreviewLoadingDetail")}
                </div>
                <div className="skills-skeleton-shimmer h-3 w-full rounded" />
                <div className="skills-skeleton-shimmer h-3 w-4/5 rounded" />
              </div>
            ) : null}

            {error ? (
              <div className="rounded-2xl border border-border/40 bg-muted/35 p-3">
                <div className="flex items-start gap-2 text-[12px] text-muted-foreground">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground/65" />
                  <span>{t("mcpHub.storePreviewDetailUnavailable")}</span>
                </div>
              </div>
            ) : null}

            {data.tags.length > 0 ? (
              <div className="rounded-2xl border border-border/40 bg-background/60 p-3">
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

            <div className="rounded-2xl border border-border/40 bg-background/60 p-3">
              <div className="mb-2 text-[12px] font-semibold text-foreground">
                {t("mcpHub.storePreviewInstallPreview")}
              </div>
              {draft?.commandPreview ? (
                <code className="mb-2 block max-h-28 overflow-y-auto whitespace-pre-wrap break-all rounded-xl border border-border/35 bg-muted/35 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
                  {draft.commandPreview}
                </code>
              ) : (
                <div className="mb-2 rounded-xl border border-border/35 bg-muted/35 px-3 py-2 text-[12px] text-muted-foreground">
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

            <div className="rounded-2xl border border-border/40 bg-background/60 p-3">
              <div className="mb-2 text-[12px] font-semibold text-foreground">
                {t("mcpHub.storePreviewRequiredConfig")}
              </div>
              {requiredConfig.length > 0 ? (
                <div className="space-y-2">
                  {requiredConfig.map((input) => (
                    <div
                      key={mcpRegistryConfigInputKey(input)}
                      className="rounded-xl border border-border/35 bg-muted/25 px-3 py-2"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        {input.secret ? (
                          <Key className="h-3.5 w-3.5 shrink-0 text-foreground/65" />
                        ) : null}
                        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                          {input.label ?? input.name}
                        </span>
                        <span className="rounded-md bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground ring-1 ring-border/30">
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
              <div className="rounded-2xl border border-border/55 bg-background/65 p-3 backdrop-blur-md">
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
              <div className="rounded-2xl border border-border/40 bg-background/60 p-3">
                <div className="mb-2 text-[12px] font-semibold text-foreground">
                  {t("mcpHub.storePreviewLinks")}
                </div>
                <div className="space-y-1.5">
                  {links.map((link) => (
                    <a
                      key={`${link.key}:${link.url}`}
                      href={link.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                    >
                      <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                      <span className="shrink-0">{t(link.labelKey)}</span>
                      <span className="min-w-0 truncate font-mono text-[11px] opacity-70">
                        {link.url}
                      </span>
                    </a>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 gap-2 border-t border-border/40 px-5 py-4">
          {primaryLink ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 flex-1 gap-1.5 rounded-xl border-border/50 bg-background/70"
              render={
                <a href={primaryLink} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-3.5 w-3.5" />
                  {t("mcpHub.storeOpenExternal")}
                </a>
              }
            />
          ) : null}
          <Button
            type="button"
            variant={installed || draft?.status === "needs_config" ? "outline" : "default"}
            size="sm"
            className={cn(
              "h-9 flex-1 gap-1.5 rounded-xl",
              installed && "border-border/55 bg-background/75 text-foreground/85 backdrop-blur-md",
            )}
            disabled={installed || installing}
            onClick={() => onInstall(data)}
          >
            {installing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : installed ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {actionLabel}
          </Button>
        </div>
      </aside>
    </div>,
    document.body,
  );
}

function McpPreviewMetric(props: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border/35 bg-background/60 px-3 py-2.5">
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
  const { settings, setSettings } = props;
  const { t } = useLocale();
  const [source, setSource] = useState<McpRegistrySource>("official");
  const [query, setQuery] = useState("");
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
  const groupedItems = useMemo(() => groupMcpRegistryCards(items), [items]);

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
    async (mode: "replace" | "append" = "replace") => {
      const cursor = mode === "append" ? nextCursor : undefined;
      if (mode === "append" && !cursor) return;
      if (mode === "append") {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      setError(null);
      try {
        const result = await searchMcpRegistry({
          source,
          query,
          cursor,
          limit: STORE_PAGE_LIMIT,
        });
        setItems((prev) => (mode === "append" ? [...prev, ...result.items] : result.items));
        setNextCursor(result.nextCursor);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message || t("mcpHub.storeLoadFailed"));
        if (mode === "replace") {
          setItems([]);
          setNextCursor(undefined);
        }
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [nextCursor, query, source, t],
  );

  useEffect(() => {
    // Clear immediately on source switch so the skeleton + hero render right away.
    setItems([]);
    setNextCursor(undefined);
    setError(null);
    setPreviewCard(null);
    void runSearch("replace");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  function installedIdForCard(card: McpRegistryCard) {
    const draft = configureDraftForCard(card);
    const draftId = draft?.server.id ?? "";
    return (
      installedByCardId[card.id] ?? (draftId && existingIds.has(draftId) ? draftId : undefined)
    );
  }

  function addServerFromStore(card: McpRegistryCard, server: McpServerConfig) {
    const installedId = server.id;
    setSettings((prev) => {
      return updateMcp(prev, {
        servers: [...prev.mcp.servers, server],
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
      addServerFromStore(card, draft.server);
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
      <form
        className="hub-panel-enter flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch("replace");
        }}
      >
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={t("mcpHub.storeSearchPlaceholder")}
            className="h-10 w-full rounded-xl border border-border/40 bg-background/60 pl-9 pr-3 text-[13px] outline-hidden backdrop-blur-xl transition-all placeholder:text-muted-foreground/60 focus:border-border/60 focus:bg-background/85 focus:ring-2 focus:ring-foreground/10"
          />
        </div>
        <Button
          size="sm"
          type="submit"
          className="h-10 w-10 shrink-0 rounded-xl px-0 sm:w-auto sm:gap-1.5 sm:px-4"
          disabled={loading}
          title={t("mcpHub.storeSearch")}
          aria-label={t("mcpHub.storeSearch")}
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Search className="h-3.5 w-3.5" />
          )}
          <span className="hidden sm:inline">{t("mcpHub.storeSearch")}</span>
        </Button>
        <Button
          size="sm"
          variant="outline"
          type="button"
          className="h-10 w-10 shrink-0 rounded-xl border-border/50 bg-background/70 px-0 backdrop-blur-md sm:w-auto sm:gap-1.5 sm:px-4"
          disabled={loading || loadingMore}
          onClick={() => void runSearch("replace")}
          title={t("mcpHub.storeRefresh")}
          aria-label={t("mcpHub.storeRefresh")}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading ? "animate-spin" : "")} />
          <span className="hidden sm:inline">{t("mcpHub.storeRefresh")}</span>
        </Button>
      </form>

      <div className="hub-panel-enter flex max-w-full items-center gap-1 self-start overflow-x-auto rounded-xl border border-border/40 bg-background/60 p-1 backdrop-blur-xl shadow-[0_1px_0_rgba(255,255,255,0.5)_inset] dark:border-white/[0.06] dark:bg-white/[0.04] dark:shadow-[0_1px_0_rgba(255,255,255,0.04)_inset] [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {MCP_REGISTRY_SOURCE_OPTIONS.map((option) => {
          const active = source === option.value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => setSource(option.value)}
              className={cn(
                "h-8 shrink-0 whitespace-nowrap rounded-lg px-3 text-[11.5px] font-medium transition-all",
                active
                  ? "bg-background/85 text-foreground shadow-[0_1px_0_rgba(255,255,255,0.55)_inset] ring-1 ring-border/45 dark:bg-white/[0.08] dark:ring-white/[0.09] dark:shadow-[0_1px_0_rgba(255,255,255,0.06)_inset]"
                  : "text-muted-foreground hover:bg-background/80 hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {error ? (
        <div className="hub-panel-enter flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/[0.06] px-3 py-2.5 text-xs text-destructive backdrop-blur-md">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-4 pt-2">
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
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground/80">
                      {t("mcpHub.storeLoadingDesc").replace("{source}", currentSourceLabel)}
                    </div>
                  </div>
                </div>
                <div className="hub-frost-track mt-3.5" />
              </div>

              <div key={`${source}-skeleton`} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {Array.from({ length: 6 }).map((_, index) => (
                  <div key={index} className="hub-frost-skeleton skill-card-enter h-[228px] p-3.5">
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
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {groupedItems.map((group) => (
                <RegistryCard
                  key={group.id}
                  group={group}
                  installedIdForCard={installedIdForCard}
                  installingId={installingId}
                  onPreview={setPreviewCard}
                  onInstall={(next) => void installCard(next)}
                />
              ))}
            </div>
          ) : (
            <div className="hub-panel-enter rounded-2xl border border-dashed border-border/45 bg-background/40 px-6 py-12 text-center backdrop-blur-xl">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-border/55 bg-background/80 text-foreground/85 shadow-[0_1px_0_rgba(255,255,255,0.55)_inset] dark:border-white/[0.09] dark:bg-white/[0.06] dark:shadow-[0_1px_0_rgba(255,255,255,0.06)_inset]">
                <Terminal className="h-6 w-6" />
              </div>
              <p className="mt-4 text-sm font-medium text-foreground">
                {t("mcpHub.storeEmptyTitle")}
              </p>
              <p className="mt-1 text-xs text-muted-foreground/80">{t("mcpHub.storeEmptyDesc")}</p>
            </div>
          )}

          {nextCursor && items.length > 0 ? (
            <div className="hub-panel-enter flex justify-center">
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 rounded-full border-border/50 bg-background/70 backdrop-blur-md"
                disabled={loadingMore}
                onClick={() => void runSearch("append")}
              >
                {loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {t("mcpHub.storeLoadMore")}
              </Button>
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
        <McpConfigureModal
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
