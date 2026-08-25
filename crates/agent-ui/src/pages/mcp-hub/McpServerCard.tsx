import {
  type AppSettings,
  type McpServerConfig,
  removeWorkspaceResourceReferences,
  type ToolPolicy,
  updateMcp,
} from "@liveagent/app/lib/settings/index";
import { openUrl } from "@liveagent/app/shims/tauriOpener";
import { ToolPolicyToggle } from "@liveagent/ui/components/hub/ToolPolicyToggle";
import { ExternalLink, Settings, Trash2 } from "@liveagent/ui/components/IconSet";
import { getMcpTransportMeta } from "@liveagent/ui/components/resources/McpTransportMeta";
import { ResourceActivationSwitch } from "@liveagent/ui/components/resources/ResourceActivationSwitch";
import { Badge } from "@liveagent/ui/components/ui/badge";
import { Button } from "@liveagent/ui/components/ui/button";
import { ConfirmDeletePopover } from "@liveagent/ui/components/ui/confirm-action-popover";
import { SearchHighlight } from "@liveagent/ui/components/ui/search-highlight";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  isOauthServer,
  type McpOauthStatus,
  mcpOauthAuthorize,
  mcpOauthClear,
  mcpOauthStatus,
} from "@liveagent/ui/lib/mcp/oauthApi";
import { resolveMcpDocsHref } from "@liveagent/ui/lib/mcpServerMetadata";
import { isGatewayWebuiRuntime } from "@liveagent/ui/lib/runtimeEnv";
import { memo, useEffect, useState } from "react";

type SetMcpSettingsFn = (updater: (prev: AppSettings) => AppSettings) => void;

function ConfigurationCount(props: { count: number; label: string }) {
  return (
    <span className="inline-flex h-5 items-center gap-1 rounded-full bg-muted px-2 text-[10px] text-muted-foreground ring-1 ring-border/60">
      <span className="font-semibold tabular-nums text-foreground">{props.count}</span>
      <span>{props.label}</span>
    </span>
  );
}

/**
 * OAuth 授权徽章 + Connect/断开（docs/design/mcp-oauth.md §5）。授权流仅桌面
 * 端可发起（系统浏览器），WebUI 只展示引导文案；token 永不过前端，这里只
 * 消费状态摘要。
 */
function OauthControls(props: { server: McpServerConfig }) {
  const { server } = props;
  const { t } = useLocale();
  const isWebui = isGatewayWebuiRuntime();
  const [status, setStatus] = useState<McpOauthStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isWebui) return;
    let cancelled = false;
    mcpOauthStatus(server)
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        // 状态查询失败按未知处理（不阻塞卡片渲染）。
      });
    return () => {
      cancelled = true;
    };
  }, [isWebui, server]);

  const state = status?.state ?? "none";
  const stateLabel =
    state === "authorized"
      ? t("mcpHub.oauthStatusAuthorized")
      : state === "expired"
        ? t("mcpHub.oauthStatusExpired")
        : t("mcpHub.oauthStatusNone");
  // 设计约束：卡片内禁用裸色板 class，一律走 Badge 语义 variant。
  const badgeVariant =
    state === "authorized" ? "success" : state === "expired" ? "destructive" : "muted";

  async function handleConnect() {
    setBusy(true);
    setError(null);
    try {
      // authorize 阻塞至浏览器回调/超时；resolve 即拿到最新状态。
      const next = await mcpOauthAuthorize(server);
      setStatus(next);
    } catch (err) {
      setError(
        `${t("mcpHub.oauthAuthorizeFailed")}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    setBusy(true);
    setError(null);
    try {
      await mcpOauthClear(server.id);
      setStatus((prev) => (prev ? { ...prev, state: "none", refreshable: false } : prev));
    } catch (err) {
      setError(
        `${t("mcpHub.oauthDisconnectFailed")}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      <Badge
        variant={badgeVariant}
        className="h-5 px-1.5 text-[10px]"
        title={error ?? (status?.issuer ? `${stateLabel} · ${status.issuer}` : stateLabel)}
      >
        {stateLabel}
      </Badge>
      {isWebui ? null : (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-5 rounded-full px-2 text-[10px]"
            disabled={busy}
            onClick={() => void handleConnect()}
          >
            {state === "none" ? t("mcpHub.oauthConnect") : t("mcpHub.oauthReauthorize")}
          </Button>
          {state !== "none" ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-5 rounded-full px-2 text-[10px] text-muted-foreground"
              disabled={busy}
              onClick={() => void handleDisconnect()}
            >
              {t("mcpHub.oauthDisconnect")}
            </Button>
          ) : null}
        </>
      )}
    </span>
  );
}

export const McpServerCard = memo(function McpServerCard(props: {
  server: McpServerConfig;
  idx: number;
  searchQuery: string;
  setSettings: SetMcpSettingsFn;
  onEdit: () => void;
  policy: ToolPolicy;
  onPolicyChange: (next: ToolPolicy) => void;
}) {
  const { server, idx, searchQuery, setSettings, onEdit, policy, onPolicyChange } = props;
  const { t } = useLocale();
  const transport = server.transport || "stdio";
  const isStdio = transport === "stdio";
  const isHttp = transport === "http";
  const { label: transportLabel } = getMcpTransportMeta(transport);
  const enabled = server.enabled;
  const displayName = server.id || `Server ${idx + 1}`;

  const patchServer = (patch: Partial<McpServerConfig>) => {
    setSettings((prev) =>
      updateMcp(prev, {
        servers: prev.mcp.servers.map((item, index) =>
          index === idx ? { ...item, ...patch } : item,
        ),
      }),
    );
  };

  const previewLine = isStdio
    ? [server.command, ...(server.args ?? [])].filter(Boolean).join(" ")
    : server.url || "";
  const previewLabel = isStdio
    ? t("mcpHub.command")
    : isHttp
      ? t("mcpHub.urlHttp")
      : t("mcpHub.urlSse");
  const detailLine = [server.description, previewLine ? `${previewLabel}: ${previewLine}` : null]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
  const argsCount = (server.args ?? []).filter(Boolean).length;
  const envCount = server.env ? Object.keys(server.env).length : 0;
  const headerCount = server.headers ? Object.keys(server.headers).length : 0;
  const docsLink = resolveMcpDocsHref(server.docsUrl);

  return (
    <article className="skill-card-enter group flex min-h-16 w-full items-center gap-3 bg-card px-4 py-3 text-left transition-colors hover:bg-muted/30">
      <ResourceActivationSwitch
        checked={enabled}
        compact
        label={`${displayName}: ${enabled ? t("settings.disable") : t("settings.enable")}`}
        onCheckedChange={(checked) => patchServer({ enabled: checked })}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onEdit}
            title={t("settings.edit")}
            className="min-w-0 rounded-sm text-left outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            <SearchHighlight
              text={displayName}
              query={searchQuery}
              className="truncate text-[13px] font-semibold text-foreground"
            />
          </button>
          {docsLink ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-5 w-5 shrink-0 text-muted-foreground"
              title={t("mcpHub.storeOpenExternal")}
              aria-label={t("mcpHub.storeOpenExternal")}
              onClick={() => void openUrl(docsLink)}
            >
              <ExternalLink aria-hidden="true" className="h-3 w-3" />
            </Button>
          ) : null}
          <Badge variant="muted" className="h-5 px-1.5 text-[10px] uppercase tracking-wide">
            <SearchHighlight text={transportLabel} query={searchQuery} />
          </Badge>
          {isOauthServer(server) ? <OauthControls server={server} /> : null}
        </div>
        {detailLine ? (
          <button
            type="button"
            onClick={onEdit}
            title={detailLine}
            className="mt-1 min-w-0 truncate rounded-sm text-left text-[11px] text-muted-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            <SearchHighlight text={detailLine} query={searchQuery} />
          </button>
        ) : null}
      </div>

      {argsCount > 0 || envCount > 0 || headerCount > 0 ? (
        <div className="flex max-w-48 shrink-0 flex-wrap justify-end gap-1">
          {argsCount > 0 ? (
            <ConfigurationCount count={argsCount} label={t("mcpHub.previewArgs")} />
          ) : null}
          {envCount > 0 ? (
            <ConfigurationCount count={envCount} label={t("mcpHub.previewEnv")} />
          ) : null}
          {headerCount > 0 ? (
            <ConfigurationCount count={headerCount} label={t("mcpHub.previewHeaders")} />
          ) : null}
        </div>
      ) : null}

      <div className="grid shrink-0 grid-cols-[auto_2rem_2rem] items-center gap-1.5">
        <ToolPolicyToggle
          value={policy}
          ariaLabel={displayName}
          onChange={onPolicyChange}
          size="sm"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onEdit}
          title={t("settings.edit")}
          className="h-8 w-8 text-muted-foreground"
        >
          <Settings className="h-3.5 w-3.5" />
        </Button>
        <ConfirmDeletePopover
          name={server.id || `Server ${idx + 1}`}
          onConfirm={() => {
            // OAuth server 删除时同步清理 keychain 条目（best effort，失败不阻塞
            // 删除，但要留痕——卡片随删除卸载，无处挂 error 态，与 mcpManagerTools
            // 的 runtimeWarnings 对应的最低限度是 console.warn）。
            if (isOauthServer(server) && !isGatewayWebuiRuntime()) {
              void mcpOauthClear(server.id).catch((err: unknown) => {
                console.warn(`[mcp-hub] failed to clear OAuth credentials for ${server.id}:`, err);
              });
            }
            setSettings((prev) =>
              removeWorkspaceResourceReferences(
                updateMcp(prev, {
                  servers: prev.mcp.servers.filter((_, index) => index !== idx),
                }),
                { mcpServerIds: [server.id] },
              ),
            );
          }}
        >
          {(open) => (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={open}
              className="h-8 w-8 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              title={t("settings.delete")}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </ConfirmDeletePopover>
      </div>
    </article>
  );
});
