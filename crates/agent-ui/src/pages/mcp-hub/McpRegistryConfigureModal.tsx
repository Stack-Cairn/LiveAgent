import type { McpServerConfig } from "@liveagent/app/lib/settings/index";
import { AlertTriangle, Plus, Sparkles, X } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { Input } from "@liveagent/ui/components/ui/input";
import { Label } from "@liveagent/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@liveagent/ui/components/ui/select";
import { Textarea } from "@liveagent/ui/components/ui/textarea";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  applyMcpRegistryInstallConfig,
  createUniqueMcpServerId,
  type McpRegistryCard,
  type McpRegistryConfigInput,
  type McpRegistryInstallDraft,
  mcpRegistryConfigInputKey,
} from "@liveagent/ui/lib/mcpRegistry/index";
import { type FormEvent, useEffect, useState } from "react";

function configureDraftForCard(card: McpRegistryCard) {
  return card.installDraft ?? card.manualDraft;
}

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

export function McpRegistryConfigureModal(props: {
  card: McpRegistryCard;
  existingServers: McpServerConfig[];
  onClose: () => void;
  onSave: (server: McpServerConfig) => void;
}) {
  const { card, existingServers, onClose, onSave } = props;
  const { t } = useLocale();
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
      onClose();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    }
  }

  const isStdio = draft.transport === "stdio";
  const isSse = draft.transport === "sse";

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="settings-modal-panel flex max-h-[92vh] max-w-3xl flex-col p-0">
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="settings-modal-header flex items-center gap-3 border-b border-border/70 px-6 py-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border/70 bg-muted/50 text-foreground shadow-xs">
              <Sparkles className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle>{t("mcpHub.storeConfigureTitle")}</DialogTitle>
              <DialogDescription className="mt-0.5 truncate text-xs" title={card.displayName}>
                {t("mcpHub.storeConfigureSubtitle").replace("{name}", card.displayName)}
              </DialogDescription>
            </div>
            <button
              type="button"
              onClick={onClose}
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
                      const transport =
                        value === "http" ? "http" : value === "sse" ? "sse" : "stdio";
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
                  <Label
                    htmlFor="mcp-store-config-timeout"
                    className="text-xs text-muted-foreground"
                  >
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
                <div className="space-y-3 rounded-xl border border-border/70 bg-muted/35 p-4">
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
                      <Label
                        htmlFor="mcp-store-config-cwd"
                        className="text-xs text-muted-foreground"
                      >
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
                    <Label
                      htmlFor="mcp-store-config-args"
                      className="text-xs text-muted-foreground"
                    >
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
                <div className="space-y-3 rounded-xl border border-border/70 bg-muted/35 p-4">
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
                <div className="space-y-3 rounded-xl border border-border/70 bg-card p-4 shadow-xs">
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
                            onChange={(event) =>
                              updateConfigValue(input, event.currentTarget.value)
                            }
                          />
                          <div className="flex items-start gap-1.5 text-[10.5px] text-muted-foreground">
                            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground/75">
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

          <div className="settings-modal-footer settings-modal-footer-row flex items-center justify-end gap-2 border-t border-border/70 px-6 py-4">
            <Button type="button" variant="outline" onClick={onClose}>
              {t("settings.cancel")}
            </Button>
            <Button type="submit" className="gap-1.5">
              <Plus className="h-3.5 w-3.5" />
              {t("mcpHub.storeConfigureSubmit")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
