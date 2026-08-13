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
import { resolveMcpDocsHref } from "@liveagent/ui/lib/mcpServerMetadata";
import { memo } from "react";

type SetMcpSettingsFn = (updater: (prev: AppSettings) => AppSettings) => void;

function ConfigurationCount(props: { count: number; label: string }) {
  return (
    <span className="inline-flex h-5 items-center gap-1 rounded-full bg-muted px-2 text-[10px] text-muted-foreground ring-1 ring-border/60">
      <span className="font-semibold tabular-nums text-foreground">{props.count}</span>
      <span>{props.label}</span>
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
          onConfirm={() =>
            setSettings((prev) =>
              removeWorkspaceResourceReferences(
                updateMcp(prev, {
                  servers: prev.mcp.servers.filter((_, index) => index !== idx),
                }),
                { mcpServerIds: [server.id] },
              ),
            )
          }
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
