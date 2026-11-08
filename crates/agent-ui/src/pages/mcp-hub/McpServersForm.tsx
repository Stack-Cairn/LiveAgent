import {
  type AppSettings,
  type McpServerConfig,
  updateMcp,
} from "@liveagent/app/lib/settings/index";
import { Plug, Plus, Server } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { McpServerRuntimeStatus } from "@liveagent/ui/lib/resourceHost";
import { rankFuzzySearchResults } from "@liveagent/ui/lib/shared/fuzzySearch";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useMemo } from "react";
import {
  effectiveServerPolicyDefault,
  isHubHiddenServerId,
} from "../../contracts/mcpServerDefaults";
import { McpServerCard } from "./McpServerCard";

export { McpServerEditModal } from "./McpServerEditModal";

type SetMcpSettingsFn = (updater: (prev: AppSettings) => AppSettings) => void;

type McpServersFormProps = {
  settings: AppSettings;
  setSettings: SetMcpSettingsFn;
  query: string;
  onAddServer?: () => void;
  onEditServer?: (server: McpServerConfig, idx: number) => void;
  /** Connection status by server id; absent where the host cannot read it. */
  statuses?: Map<string, McpServerRuntimeStatus> | null;
};

export function McpServersForm(props: McpServersFormProps) {
  const { settings, setSettings, query, onAddServer, onEditServer, statuses } = props;
  const { t } = useLocale();
  // 由专属设置页托管的 server 不在 Hub 里露面（当前是 cua-driver，归
  // 「设置 → CUA」管）。过滤后仍需拿到原始下标：McpServerCard 的编辑 /
  // 删除都按 settings.mcp.servers 的位置写回。
  const servers = useMemo(
    () =>
      settings.mcp.servers
        .map((server, idx) => ({ server, idx }))
        .filter(({ server }) => !isHubHiddenServerId(server.id)),
    [settings.mcp.servers],
  );
  const serverCount = servers.length;

  const filtered = useMemo(() => {
    return rankFuzzySearchResults(servers, query, ({ server }) => [
      server.id,
      server.description,
      server.docsUrl,
      server.command,
      server.url,
      server.transport,
      ...(server.args ?? []),
      ...Object.keys(server.env ?? {}),
      ...Object.keys(server.headers ?? {}),
    ]);
  }, [query, servers]);

  return (
    <div className="h-full min-h-0 overflow-y-auto px-0.5 pb-4 pr-1 pt-1.5">
      <div className="flex flex-col gap-4">
        {serverCount === 0 ? (
          <div className={cn("rounded-xl bg-settings-tile px-6 py-12 text-center")}>
            <div
              className={cn(
                "mx-auto flex size-14 items-center justify-center",
                "rounded-xl bg-settings-active text-foreground",
              )}
            >
              <Server className="size-6" />
            </div>
            <p className="mt-4 text-sm font-medium text-foreground">{t("mcpHub.noServers")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t("mcpHub.noServersHint")}</p>
            {onAddServer ? (
              <Button variant="outline" size="sm" className="mt-4 gap-1.5" onClick={onAddServer}>
                <Plus className="size-3.5" />
                {t("mcpHub.add")}
              </Button>
            ) : null}
          </div>
        ) : null}

        {query.trim() && filtered.length === 0 && serverCount > 0 ? (
          <div className="rounded-xl bg-settings-tile px-6 py-8 text-center">
            <Plug className="mx-auto size-5 text-muted-foreground" />
            <p className="mt-3 text-sm text-muted-foreground">{t("mcpHub.noMatchInstalled")}</p>
          </div>
        ) : null}

        {filtered.length > 0 ? (
          <div className="space-y-1.5">
            {filtered.map(({ server, idx }) => (
              <McpServerCard
                key={`${server.id}:${idx}`}
                server={server}
                idx={idx}
                searchQuery={query}
                setSettings={setSettings}
                onEdit={() => onEditServer?.(server, idx)}
                // K-brain enforces the server's policy["*"]; a tool-specific entry set
                // elsewhere still takes precedence for that tool.
                policy={server.policy?.["*"] ?? effectiveServerPolicyDefault(server)}
                onPolicyChange={(next) =>
                  setSettings((prev) =>
                    updateMcp(prev, {
                      servers: prev.mcp.servers.map((item, index) =>
                        index === idx ? { ...item, policy: { ...item.policy, "*": next } } : item,
                      ),
                    }),
                  )
                }
                runtimeStatus={statuses?.get(server.id)}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
