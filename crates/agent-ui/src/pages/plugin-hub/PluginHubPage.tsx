import { useCallback, useEffect, useMemo, useState } from "react";
import { HubBackdrop, HubHeader } from "../../components/hub/HubChrome";
import { AlertTriangle, Package, Plus, RefreshCw, Search, Shield } from "../../components/IconSet";
import { ResourceTabsList } from "../../components/resources/ResourceTabsList";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Tabs } from "../../components/ui/tabs";
import { useLocale } from "../../i18n/index";
import type { PluginClient, PluginInventoryItem } from "../../lib/plugins/types";
import { cn } from "../../lib/shared/utils";
import { PluginCard } from "./PluginCard";
import { PluginDetailModal } from "./PluginDetailModal";
import { PluginInstallModal } from "./PluginInstallModal";
import {
  matchesPluginFilter,
  matchesPluginQuery,
  type PluginHubFilter,
  pluginNeedsAttention,
} from "./pluginPresentation";

type PluginHubPageProps = {
  client: PluginClient;
  workspace?: string;
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
};

function isPluginHubFilter(value: unknown): value is PluginHubFilter {
  return value === "all" || value === "enabled" || value === "attention";
}

export function PluginHubPage(props: PluginHubPageProps) {
  const { client, workspace, sidebarOpen, onOpenSidebar } = props;
  const { t } = useLocale();
  const [items, setItems] = useState<PluginInventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PluginHubFilter>("all");
  const [installOpen, setInstallOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await client.list(workspace));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [client, workspace]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enabledCount = items.filter((item) => item.enabled).length;
  const attentionCount = items.filter(pluginNeedsAttention).length;
  const canInstall = !client.isReadOnly && client.canInstall !== false;

  const visible = useMemo(
    () => items.filter((item) => matchesPluginFilter(item, filter) && matchesPluginQuery(item, query)),
    [items, filter, query],
  );

  // 详情弹层始终按 id 从最新 Inventory 取件：授权/配置写入后父层会刷新列表，
  // 持有旧对象会让弹层显示写入前的状态。插件被卸载时该查找自然落空并关闭弹层。
  const detailItem = detailId ? (items.find((item) => item.id === detailId) ?? null) : null;
  useEffect(() => {
    if (detailId && !loading && !detailItem) setDetailId(null);
  }, [detailId, detailItem, loading]);

  const runFor = async (id: string, operation: () => Promise<unknown>) => {
    setBusyId(id);
    setError(null);
    try {
      await operation();
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="hub-page hub-page-enter relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <HubBackdrop />
      <div className="relative z-10 flex h-full min-h-0 flex-col overflow-hidden">
        <HubHeader
          icon={<Package className="h-5 w-5 text-sky-500" />}
          title={t("pluginHub.title")}
          subtitle={t("pluginHub.subtitle")}
          prominent
          sidebarOpen={sidebarOpen}
          onOpenSidebar={onOpenSidebar}
          actions={
            <div className="flex items-center gap-2">
              <Badge
                variant={enabledCount > 0 ? "success" : "muted"}
                className="hidden h-7 gap-1 tabular-nums sm:inline-flex"
              >
                {items.length > 0
                  ? `${enabledCount}/${items.length} ${t("pluginHub.enabled")}`
                  : t("pluginHub.statusEmpty")}
              </Badge>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => void refresh()}
                disabled={loading}
                title={t("pluginHub.refresh")}
                aria-label={t("pluginHub.refresh")}
              >
                <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
              </Button>
              {canInstall ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 px-3"
                  onClick={() => setInstallOpen(true)}
                  title={t("pluginHub.install")}
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span className="hidden whitespace-nowrap sm:inline">
                    {t("pluginHub.install")}
                  </span>
                </Button>
              ) : null}
            </div>
          }
        />

        <div className="hub-scroll min-h-0 flex-1 overflow-hidden px-5 pb-6 sm:px-6 lg:px-8 xl:px-10">
          <div className="hub-content-stage mx-auto flex h-full min-h-0 w-full max-w-[1320px] flex-col">
            <Tabs
              value={filter}
              onValueChange={(next) => {
                if (isPluginHubFilter(next)) setFilter(next);
              }}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="hub-panel-enter relative mb-5">
                <Search className="pointer-events-none absolute left-4 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  placeholder={t("pluginHub.searchPlaceholder")}
                  aria-label={t("pluginHub.searchPlaceholder")}
                  className="h-11 rounded-full border-border bg-background pl-11 pr-4 text-sm shadow-none placeholder:text-muted-foreground"
                />
              </div>

              <div className="hub-panel-enter flex min-h-11 items-center justify-between gap-3">
                <ResourceTabsList
                  value={filter}
                  ariaLabel={t("pluginHub.title")}
                  items={[
                    {
                      value: "all" as const,
                      label: t("pluginHub.filterAll"),
                      icon: Package,
                      countLabel: items.length > 0 ? String(items.length) : null,
                    },
                    {
                      value: "enabled" as const,
                      label: t("pluginHub.filterEnabled"),
                      icon: Shield,
                      countLabel: enabledCount > 0 ? String(enabledCount) : null,
                    },
                    {
                      value: "attention" as const,
                      label: t("pluginHub.filterAttention"),
                      icon: AlertTriangle,
                      countLabel: attentionCount > 0 ? String(attentionCount) : null,
                    },
                  ]}
                />
              </div>

              {error ? (
                <div className="hub-panel-enter mt-4 flex items-start gap-2.5 rounded-xl border border-destructive/25 bg-destructive/5 px-3 py-2.5">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <div className="min-w-0 flex-1 text-xs leading-5 text-destructive">{error}</div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 shrink-0 px-2 text-xs"
                    onClick={() => setError(null)}
                  >
                    {t("pluginHub.dismiss")}
                  </Button>
                </div>
              ) : null}

              <div className="min-h-0 flex-1 overflow-y-auto pt-4">
                {loading && items.length === 0 ? (
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {[0, 1, 2].map((index) => (
                      <div
                        key={index}
                        className="min-h-44 animate-pulse rounded-xl border border-border/60 bg-muted/30"
                      />
                    ))}
                  </div>
                ) : visible.length === 0 ? (
                  <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border/70 px-6 py-16 text-center">
                    <Package className="h-9 w-9 text-muted-foreground/60" />
                    <p className="mt-3 text-sm font-medium text-foreground">
                      {items.length === 0 ? t("pluginHub.empty") : t("pluginHub.noMatches")}
                    </p>
                    <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                      {items.length === 0
                        ? t("pluginHub.emptyHint")
                        : t("pluginHub.noMatchesHint")}
                    </p>
                    {items.length === 0 && canInstall ? (
                      <Button
                        type="button"
                        size="sm"
                        className="mt-4 gap-1.5"
                        onClick={() => setInstallOpen(true)}
                      >
                        <Plus className="h-3.5 w-3.5" />
                        {t("pluginHub.install")}
                      </Button>
                    ) : items.length > 0 ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="mt-4"
                        onClick={() => {
                          setQuery("");
                          setFilter("all");
                        }}
                      >
                        {t("pluginHub.clearFilters")}
                      </Button>
                    ) : null}
                  </div>
                ) : (
                  <div className="grid gap-3 pb-2 sm:grid-cols-2 xl:grid-cols-3">
                    {visible.map((item) => (
                      <PluginCard
                        key={item.id}
                        item={item}
                        searchQuery={query}
                        busy={busyId === item.id}
                        readOnly={client.isReadOnly === true}
                        onOpen={() => setDetailId(item.id)}
                        onToggle={(enabled) =>
                          void runFor(item.id, () =>
                            client.setEnabled(item.id, enabled, workspace),
                          )
                        }
                      />
                    ))}
                  </div>
                )}
              </div>
            </Tabs>
          </div>
        </div>
      </div>

      {installOpen ? (
        <PluginInstallModal
          client={client}
          workspace={workspace}
          onClose={() => setInstallOpen(false)}
          onInstalled={refresh}
        />
      ) : null}

      {detailItem ? (
        <PluginDetailModal
          item={detailItem}
          client={client}
          workspace={workspace}
          onClose={() => setDetailId(null)}
          onChanged={refresh}
        />
      ) : null}
    </div>
  );
}
