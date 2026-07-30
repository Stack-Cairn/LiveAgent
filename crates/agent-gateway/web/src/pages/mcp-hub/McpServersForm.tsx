import { type FormEvent, memo, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ToolPolicyToggle } from "../../components/hub/ToolPolicyToggle";
import {
  AlertTriangle,
  Globe2,
  Pencil,
  Plug,
  Plus,
  Search,
  Server,
  Terminal,
  Trash2,
  Wifi,
  X,
} from "../../components/icons";
import { Button } from "../../components/ui/button";
import { ConfirmDeletePopover } from "../../components/ui/confirm-action-popover";
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
  type AppSettings,
  type McpServerConfig,
  type ToolPolicy,
  updateMcp,
  updateSystem,
} from "../../lib/settings";

import { useModalMotion } from "../../lib/shared/modalMotion";
import { cn } from "../../lib/shared/utils";

// MCP 按 server 的审批策略键(须与 lib/tools/toolPolicy.ts 的 TOOL_SERVER_POLICY_PREFIX
// 一致)。未显式设置的 server 缺省 allow(与 resolveToolPolicy 一致,组级 group:mcp
// 的 UI 已移除,恒回落 allow)。
const SERVER_POLICY_PREFIX = "server:";
function serverPolicyKey(serverId: string): string {
  return `${SERVER_POLICY_PREFIX}${serverId}`;
}

type SetMcpSettingsFn = (updater: (prev: AppSettings) => AppSettings) => void;

type McpServersFormProps = {
  settings: AppSettings;
  setSettings: SetMcpSettingsFn;
  onAddServer?: () => void;
  onEditServer?: (server: McpServerConfig, idx: number) => void;
};

type ServerDraft = {
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
      throw new Error(`${errorPrefix}${trimmed}`);
    }
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!key || !value) {
      throw new Error(`${errorPrefix}${trimmed}`);
    }
    out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function suggestServerName(existing: string[]): string {
  const taken = new Set(existing.map((id) => id.trim()).filter(Boolean));
  let idx = existing.length + 1;
  let name = `MCP Server ${idx}`;
  while (taken.has(name)) {
    idx += 1;
    name = `MCP Server ${idx}`;
  }
  return name;
}

function blankDraft(existingIds: string[]): ServerDraft {
  return {
    id: suggestServerName(existingIds),
    transport: "stdio",
    timeoutMs: "60000",
    command: "",
    cwd: "",
    argsText: "",
    envText: "",
    url: "",
    messageUrl: "",
    headersText: "",
  };
}

function draftFromServer(server: McpServerConfig): ServerDraft {
  const transport: McpServerConfig["transport"] = server.transport ?? "stdio";
  return {
    id: server.id,
    transport,
    timeoutMs: String(server.timeoutMs ?? 60_000),
    command: server.command ?? "",
    cwd: server.cwd ?? "",
    argsText: (server.args ?? []).join("\n"),
    envText: formatKeyValueRecord(server.env),
    url: server.url ?? "",
    messageUrl: server.messageUrl ?? "",
    headersText: formatKeyValueRecord(server.headers),
  };
}

function buildServerFromDraft(
  draft: ServerDraft,
  base: McpServerConfig | null,
  existingIds: string[],
  t: (key: string) => string,
): McpServerConfig {
  const id = draft.id.trim();
  if (!id) {
    throw new Error(t("mcpHub.invalidName"));
  }
  if (existingIds.includes(id)) {
    throw new Error(t("mcpHub.duplicateName"));
  }

  const parsedTimeout = Number(draft.timeoutMs);
  const timeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? Math.floor(parsedTimeout) : 60_000;

  if (draft.transport === "stdio") {
    const command = draft.command.trim();
    if (!command) {
      throw new Error(t("mcpHub.invalidCommand"));
    }
    return {
      ...(base ?? {}),
      id,
      enabled: base?.enabled ?? true,
      transport: "stdio",
      command,
      args: parseLineList(draft.argsText),
      cwd: draft.cwd.trim() || undefined,
      env: parseKeyValueDraft(draft.envText, `${t("mcpHub.invalidKeyValue")} `),
      url: "",
      messageUrl: undefined,
      headers: undefined,
      timeoutMs,
    };
  }

  const url = draft.url.trim();
  if (!url) {
    throw new Error(t("mcpHub.invalidUrl"));
  }
  return {
    ...(base ?? {}),
    id,
    enabled: base?.enabled ?? true,
    transport: draft.transport,
    command: "",
    args: [],
    url,
    messageUrl: draft.transport === "sse" ? draft.messageUrl.trim() || undefined : undefined,
    headers: parseKeyValueDraft(draft.headersText, `${t("mcpHub.invalidKeyValue")} `),
    cwd: undefined,
    env: undefined,
    timeoutMs,
  };
}

function transportMeta(transport: string) {
  // Transport badges stay subtly differentiated; using neutral tints to keep the macOS frosted look.
  if (transport === "http") {
    return {
      label: "http",
      tone: "bg-background/70 text-foreground/75 ring-border/45",
      Icon: Globe2,
    } as const;
  }
  if (transport === "sse") {
    return {
      label: "sse",
      tone: "bg-background/70 text-foreground/75 ring-border/45",
      Icon: Wifi,
    } as const;
  }
  return {
    label: "stdio",
    tone: "bg-background/70 text-foreground/75 ring-border/45",
    Icon: Terminal,
  } as const;
}

function CounterPill(props: { label: string; count: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted/55 px-2 py-0.5 text-[10px] text-muted-foreground ring-1 ring-border/40">
      <span className="font-semibold text-foreground/85 tabular-nums">{props.count}</span>
      <span className="opacity-70">{props.label}</span>
    </span>
  );
}

const McpServerCard = memo(function McpServerCard(props: {
  server: McpServerConfig;
  idx: number;
  setSettings: SetMcpSettingsFn;
  onEdit: () => void;
  policy: ToolPolicy;
  onPolicyChange: (next: ToolPolicy) => void;
}) {
  const { server: serverConfig, idx, setSettings, onEdit, policy, onPolicyChange } = props;
  const { t } = useLocale();
  const transport = serverConfig.transport || "stdio";
  const isStdio = transport === "stdio";
  const isHttp = transport === "http";
  const meta = transportMeta(transport);
  const MetaIcon = meta.Icon;
  const enabled = serverConfig.enabled;

  const patchServer = (patch: Partial<McpServerConfig>) => {
    setSettings((prev) =>
      updateMcp(prev, {
        servers: prev.mcp.servers.map((item, index) =>
          index === idx ? { ...item, ...patch } : item,
        ),
      }),
    );
  };

  const argsCount = (serverConfig.args ?? []).filter(Boolean).length;
  const envCount = serverConfig.env ? Object.keys(serverConfig.env).length : 0;
  const headerCount = serverConfig.headers ? Object.keys(serverConfig.headers).length : 0;
  const previewLine = isStdio
    ? [serverConfig.command, ...(serverConfig.args ?? [])].filter(Boolean).join(" ")
    : serverConfig.url || "";
  const previewLabel = isStdio
    ? t("mcpHub.command")
    : isHttp
      ? t("mcpHub.urlHttp")
      : t("mcpHub.urlSse");

  return (
    <div
      className={cn(
        "skill-card-enter group rounded-2xl border backdrop-blur-xl transition-all",
        enabled
          ? "border-border/55 bg-background/80 shadow-[0_1px_0_rgba(255,255,255,0.55)_inset,0_4px_18px_-12px_rgba(15,23,42,0.16)] dark:border-white/[0.10] dark:bg-white/[0.06] dark:shadow-[0_1px_0_rgba(255,255,255,0.06)_inset,0_4px_18px_-12px_rgba(0,0,0,0.5)]"
          : "border-border/40 bg-background/55 hover:border-border/55 hover:bg-background/70 dark:border-white/[0.05] dark:bg-white/[0.03] dark:hover:border-white/[0.10] dark:hover:bg-white/[0.06]",
      )}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Toggle */}
        <button
          type="button"
          title={enabled ? t("settings.disable") : t("settings.enable")}
          onClick={() => patchServer({ enabled: !enabled })}
          className={cn(
            "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full ring-1 transition-colors",
            enabled
              ? "bg-foreground/80 ring-foreground/30 shadow-[0_2px_8px_-3px_rgba(15,23,42,0.4)] dark:shadow-[0_2px_8px_-3px_rgba(0,0,0,0.6)]"
              : "bg-muted-foreground/25 ring-border/40",
          )}
        >
          <span
            className={cn(
              "pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
              enabled ? "translate-x-[1.05rem]" : "translate-x-[0.125rem]",
            )}
          />
        </button>

        {/* Clickable body */}
        <button
          type="button"
          onClick={onEdit}
          title={t("settings.edit")}
          className="flex min-w-0 flex-1 items-center gap-3 text-left outline-hidden"
        >
          <div
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border transition-all",
              enabled
                ? "border-border/55 bg-background/80 text-foreground/85 shadow-[0_1px_0_rgba(255,255,255,0.55)_inset] dark:border-white/[0.09] dark:bg-white/[0.06] dark:shadow-[0_1px_0_rgba(255,255,255,0.06)_inset]"
                : "border-border/40 bg-muted/45 text-muted-foreground group-hover:border-border/55 group-hover:bg-background/70 group-hover:text-foreground/85",
            )}
          >
            <MetaIcon className="h-[18px] w-[18px]" />
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  "truncate text-[13px] font-semibold leading-tight",
                  enabled ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {serverConfig.id || `Server ${idx + 1}`}
              </span>
              <span
                className={cn(
                  "inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ring-1",
                  meta.tone,
                )}
              >
                {meta.label}
              </span>
            </div>
            {previewLine ? (
              <div className="truncate text-[11px] text-muted-foreground/85" title={previewLine}>
                <span className="text-muted-foreground/55">{previewLabel}:</span>{" "}
                <span className="font-mono">{previewLine}</span>
              </div>
            ) : (
              <div className="truncate text-[11px] italic text-muted-foreground/55">
                {isStdio ? "未配置启动命令" : "未配置 URL"}
              </div>
            )}
          </div>
        </button>

        {/* Counters (≥md) */}
        {argsCount > 0 || envCount > 0 || headerCount > 0 ? (
          <div className="hidden shrink-0 items-center gap-1 md:flex">
            {argsCount > 0 ? (
              <CounterPill label={t("mcpHub.previewArgs")} count={argsCount} />
            ) : null}
            {envCount > 0 ? <CounterPill label={t("mcpHub.previewEnv")} count={envCount} /> : null}
            {headerCount > 0 ? (
              <CounterPill label={t("mcpHub.previewHeaders")} count={headerCount} />
            ) : null}
          </div>
        ) : null}

        <div className="flex shrink-0 items-center gap-1.5">
          {/* 审批策略:该 server 全部工具的默认放行/询问/拒绝,就地可改。 */}
          <ToolPolicyToggle
            value={policy}
            ariaLabel={serverConfig.id || `Server ${idx + 1}`}
            onChange={onPolicyChange}
            size="sm"
          />
          <button
            type="button"
            onClick={onEdit}
            title={t("settings.edit")}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <ConfirmDeletePopover
            name={serverConfig.id || `Server ${idx + 1}`}
            onConfirm={() =>
              setSettings((prev) =>
                updateMcp(prev, {
                  servers: prev.mcp.servers.filter((_, index) => index !== idx),
                }),
              )
            }
          >
            {(open) => (
              <button
                type="button"
                onClick={open}
                className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                title={t("settings.delete")}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </ConfirmDeletePopover>
        </div>
      </div>
    </div>
  );
});

export function McpServerEditModal(props: {
  mode: "add" | "edit";
  initialServer: McpServerConfig | null;
  existingServers: McpServerConfig[];
  onClose: () => void;
  onSave: (server: McpServerConfig) => void;
}) {
  const { mode, initialServer, existingServers, onClose, onSave } = props;
  const { t } = useLocale();
  const { modalState, requestClose } = useModalMotion(onClose);

  const existingIdsExcludingCurrent = useMemo(() => {
    return existingServers
      .filter((server) => mode !== "edit" || server.id !== initialServer?.id)
      .map((server) => server.id);
  }, [existingServers, initialServer, mode]);

  const [draft, setDraft] = useState<ServerDraft>(() =>
    initialServer ? draftFromServer(initialServer) : blankDraft(existingIdsExcludingCurrent),
  );
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(
      initialServer ? draftFromServer(initialServer) : blankDraft(existingIdsExcludingCurrent),
    );
    setFormError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialServer]);

  function updateDraft(patch: Partial<ServerDraft>) {
    setFormError(null);
    setDraft((prev) => ({ ...prev, ...patch }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const server = buildServerFromDraft(draft, initialServer, existingIdsExcludingCurrent, t);
      onSave(server);
      requestClose();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    }
  }

  const isStdio = draft.transport === "stdio";
  const isSse = draft.transport === "sse";
  const title = mode === "add" ? t("mcpHub.addTitle") : t("mcpHub.editTitle");
  const subtitleRaw =
    mode === "add"
      ? t("mcpHub.addSubtitle")
      : t("mcpHub.editSubtitle").replace("{name}", initialServer?.id ?? "");
  const submitLabel = mode === "add" ? t("mcpHub.modalAdd") : t("mcpHub.modalSave");

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
            <Plug className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">{title}</h2>
            <p className="mt-0.5 truncate text-xs text-muted-foreground" title={subtitleRaw}>
              {subtitleRaw}
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
                <Label htmlFor="mcp-edit-id" className="text-xs text-muted-foreground">
                  {t("mcpHub.serverName")}
                </Label>
                <Input
                  id="mcp-edit-id"
                  value={draft.id}
                  placeholder={t("mcpHub.serverNamePlaceholder")}
                  onChange={(event) => updateDraft({ id: event.currentTarget.value })}
                />
                <p className="text-[10.5px] text-muted-foreground/70">
                  {t("mcpHub.serverNameHint")}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mcp-edit-transport" className="text-xs text-muted-foreground">
                  {t("mcpHub.transport")}
                </Label>
                <Select
                  value={draft.transport}
                  onValueChange={(value) => {
                    const transport = value === "http" ? "http" : value === "sse" ? "sse" : "stdio";
                    updateDraft({ transport });
                  }}
                >
                  <SelectTrigger id="mcp-edit-transport">
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
                <Label htmlFor="mcp-edit-timeout" className="text-xs text-muted-foreground">
                  {t("mcpHub.timeout")}
                </Label>
                <Input
                  id="mcp-edit-timeout"
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
                    <Label htmlFor="mcp-edit-command" className="text-xs text-muted-foreground">
                      {t("mcpHub.command")}
                    </Label>
                    <Input
                      id="mcp-edit-command"
                      value={draft.command}
                      placeholder="npx"
                      className="font-mono text-[12.5px]"
                      onChange={(event) => updateDraft({ command: event.currentTarget.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="mcp-edit-cwd" className="text-xs text-muted-foreground">
                      {t("mcpHub.cwd")}
                    </Label>
                    <Input
                      id="mcp-edit-cwd"
                      value={draft.cwd}
                      placeholder={t("mcpHub.cwdDefault")}
                      className="font-mono text-[12.5px]"
                      onChange={(event) => updateDraft({ cwd: event.currentTarget.value })}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="mcp-edit-args" className="text-xs text-muted-foreground">
                    {t("mcpHub.args")}
                  </Label>
                  <Textarea
                    id="mcp-edit-args"
                    value={draft.argsText}
                    placeholder={"-y\n@modelcontextprotocol/server-time"}
                    className="min-h-[92px] font-mono text-[12.5px]"
                    onChange={(event) => updateDraft({ argsText: event.currentTarget.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="mcp-edit-env" className="text-xs text-muted-foreground">
                    {t("mcpHub.env")}
                  </Label>
                  <Textarea
                    id="mcp-edit-env"
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
                  <Label htmlFor="mcp-edit-url" className="text-xs text-muted-foreground">
                    {draft.transport === "http" ? t("mcpHub.urlHttp") : t("mcpHub.urlSse")}
                  </Label>
                  <Input
                    id="mcp-edit-url"
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
                    <Label htmlFor="mcp-edit-message-url" className="text-xs text-muted-foreground">
                      {t("mcpHub.messageUrl")}
                    </Label>
                    <Input
                      id="mcp-edit-message-url"
                      value={draft.messageUrl}
                      placeholder="http://127.0.0.1:3000/message"
                      className="font-mono text-[12.5px]"
                      onChange={(event) => updateDraft({ messageUrl: event.currentTarget.value })}
                    />
                  </div>
                ) : null}
                <div className="space-y-1.5">
                  <Label htmlFor="mcp-edit-headers" className="text-xs text-muted-foreground">
                    {t("mcpHub.headers")}
                  </Label>
                  <Textarea
                    id="mcp-edit-headers"
                    value={draft.headersText}
                    placeholder={"Authorization=Bearer ...\nX-API-Key=..."}
                    className="min-h-[92px] font-mono text-[12.5px]"
                    onChange={(event) => updateDraft({ headersText: event.currentTarget.value })}
                  />
                </div>
              </div>
            )}

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
            {mode === "add" ? <Plus className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
            {submitLabel}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

export function McpServersForm(props: McpServersFormProps) {
  const { settings, setSettings, onAddServer, onEditServer } = props;
  const { t } = useLocale();
  const [filter, setFilter] = useState("");

  const servers = settings.mcp.servers;
  const serverCount = servers.length;

  const filtered = useMemo(() => {
    const text = filter.trim().toLowerCase();
    if (!text) return servers.map((server, idx) => ({ server, idx }));
    return servers
      .map((server, idx) => ({ server, idx }))
      .filter(({ server }) => {
        const haystack = [server.id, server.command, server.url, server.transport ?? ""]
          .join("\n")
          .toLowerCase();
        return haystack.includes(text);
      });
  }, [filter, servers]);

  const showFilter = serverCount > 4;

  return (
    <div className="h-full min-h-0 overflow-y-auto px-1 pb-4 pt-2">
      <div className="flex flex-col gap-4">
        {showFilter ? (
          <div className="hub-panel-enter relative max-w-md">
            <Search className="absolute left-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.currentTarget.value)}
              placeholder={t("mcpHub.searchInstalled")}
              className="h-10 w-full rounded-xl border border-border/40 bg-background/60 pl-10 pr-3 text-[13px] outline-hidden backdrop-blur-xl transition-all placeholder:text-muted-foreground/60 focus:border-border/60 focus:bg-background/85 focus:ring-2 focus:ring-foreground/10"
            />
          </div>
        ) : null}

        {serverCount === 0 ? (
          <div className="hub-panel-enter rounded-2xl border border-dashed border-border/45 bg-background/40 px-6 py-12 text-center backdrop-blur-xl">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-border/55 bg-background/80 text-foreground/85 shadow-[0_1px_0_rgba(255,255,255,0.55)_inset] dark:border-white/[0.09] dark:bg-white/[0.06] dark:shadow-[0_1px_0_rgba(255,255,255,0.06)_inset]">
              <Server className="h-6 w-6" />
            </div>
            <p className="mt-4 text-sm font-medium text-foreground">{t("mcpHub.noServers")}</p>
            <p className="mt-1 text-xs text-muted-foreground/80">{t("mcpHub.noServersHint")}</p>
            {onAddServer ? (
              <Button
                variant="outline"
                size="sm"
                className="mt-4 gap-1.5 rounded-full"
                onClick={onAddServer}
              >
                <Plus className="h-3.5 w-3.5" />
                {t("mcpHub.add")}
              </Button>
            ) : null}
          </div>
        ) : null}

        {filter.trim() && filtered.length === 0 && serverCount > 0 ? (
          <div className="hub-panel-enter rounded-2xl border border-border/40 bg-background/55 px-6 py-8 text-center backdrop-blur-xl">
            <Plug className="mx-auto h-5 w-5 text-muted-foreground" />
            <p className="mt-3 text-sm text-muted-foreground">{t("mcpHub.noMatchInstalled")}</p>
          </div>
        ) : null}

        {filtered.length > 0 ? (
          <div className="flex flex-col gap-2.5">
            {filtered.map(({ server, idx }) => (
              <McpServerCard
                key={idx}
                server={server}
                idx={idx}
                setSettings={setSettings}
                onEdit={() => onEditServer?.(server, idx)}
                policy={settings.system.toolPolicies?.[serverPolicyKey(server.id)] ?? "allow"}
                onPolicyChange={(next) =>
                  setSettings((prev) => {
                    const current = { ...(prev.system.toolPolicies ?? {}) };
                    const key = serverPolicyKey(server.id);
                    // allow 为缺省,选回即清键保持精简。
                    if (next === "allow") delete current[key];
                    else current[key] = next;
                    return updateSystem(prev, {
                      toolPolicies: Object.keys(current).length > 0 ? current : undefined,
                    });
                  })
                }
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
