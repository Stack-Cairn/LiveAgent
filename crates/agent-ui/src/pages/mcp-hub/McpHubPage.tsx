import { type AppSettings, type McpServerConfig, updateMcp } from "@liveagent/app/lib/settings";
import { Cloud, Download, Plus, Search, Server } from "@liveagent/ui/components/IconSet";
import { ResourceTabsList } from "@liveagent/ui/components/resources/ResourceTabsList";
import { Badge } from "@liveagent/ui/components/ui/badge";
import { useLocale } from "@liveagent/ui/i18n/index";
import { McpRegistryBrowser } from "@liveagent/ui/pages/mcp-hub/McpRegistryBrowser";
import { McpServerEditModal, McpServersForm } from "@liveagent/ui/pages/mcp-hub/McpServersForm";
import { useMemo, useState } from "react";
import { HubHeader } from "../../components/hub/HubChrome";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Tabs, TabsContent } from "../../components/ui/tabs";
import { isHubHiddenServerId } from "../../contracts/mcpServerDefaults";
import { McpImportView } from "./McpImportView";

type McpHubPageProps = {
  settings: AppSettings;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
  isAgentMode: boolean;
};

type McpHubView = "installed" | "store" | "import";

type EditingState = { mode: "add" } | { mode: "edit"; idx: number; server: McpServerConfig };

function isMcpHubView(value: unknown): value is McpHubView {
  return value === "installed" || value === "store" || value === "import";
}

export function McpHubPage(props: McpHubPageProps) {
  const { settings, setSettings } = props;
  const { t } = useLocale();
  const [view, setView] = useState<McpHubView>("installed");
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [searchQueries, setSearchQueries] = useState<Record<McpHubView, string>>({
    installed: "",
    store: "",
    import: "",
  });

  // 与 McpServersForm 的列表口径一致：由专属设置页托管的 server 不计入
  // Hub 的徽章，否则会出现「0 个 server 却显示 1/1 已启用」。
  const visibleServers = useMemo(
    () => settings.mcp.servers.filter((server) => !isHubHiddenServerId(server.id)),
    [settings.mcp.servers],
  );
  const serverCount = visibleServers.length;
  const enabledCount = visibleServers.filter((server) => server.enabled).length;
  const activeSearchQuery = searchQueries[view];
  const searchPlaceholder =
    view === "store"
      ? t("mcpHub.storeSearchPlaceholder")
      : view === "import"
        ? t("mcpHub.importSearchPlaceholder")
        : t("mcpHub.searchInstalled");

  function openAdd() {
    setView("installed");
    setEditing({ mode: "add" });
  }

  function openEdit(server: McpServerConfig, idx: number) {
    setEditing({ mode: "edit", idx, server });
  }

  function handleModalSave(server: McpServerConfig) {
    setSettings((prev) => {
      if (editing?.mode === "edit") {
        const targetIdx = editing.idx;
        return updateMcp(prev, {
          servers: prev.mcp.servers.map((item, index) => (index === targetIdx ? server : item)),
        });
      }
      return updateMcp(prev, {
        servers: [...prev.mcp.servers, server],
      });
    });
  }

  return (
    <div className="hub-page hub-page-enter relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="relative z-10 flex h-full min-h-0 flex-col overflow-hidden">
        <HubHeader
          title="MCP Hub"
          subtitle={t("mcpHub.subtitle")}
          prominent
          actions={
            <div className="flex items-center gap-2">
              <Badge
                variant={enabledCount > 0 ? "success" : "muted"}
                className="hidden h-7 gap-1 tabular-nums sm:inline-flex"
              >
                {serverCount > 0
                  ? `${enabledCount}/${serverCount} ${t("mcpHub.enabled")}`
                  : t("mcpHub.statusEmpty")}
              </Badge>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 px-3"
                onClick={openAdd}
                title={t("mcpHub.add")}
              >
                <Plus className="h-3.5 w-3.5" />
                <span className="hidden whitespace-nowrap sm:inline">{t("mcpHub.add")}</span>
              </Button>
            </div>
          }
        />

        <div className="hub-scroll min-h-0 flex-1 overflow-hidden px-5 pb-6 sm:px-6 lg:px-8 xl:px-10">
          <div className="hub-content-stage mx-auto flex h-full min-h-0 w-full max-w-[1320px] flex-col">
            <Tabs
              value={view}
              onValueChange={(nextView) => {
                if (isMcpHubView(nextView)) setView(nextView);
              }}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="hub-panel-enter relative mb-5">
                <Search className="pointer-events-none absolute left-4 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  value={activeSearchQuery}
                  onChange={(event) => {
                    const nextQuery = event.currentTarget.value;
                    setSearchQueries((current) => ({ ...current, [view]: nextQuery }));
                  }}
                  placeholder={searchPlaceholder}
                  aria-label={searchPlaceholder}
                  className="h-11 rounded-full border-border bg-background pl-11 pr-4 text-sm shadow-none placeholder:text-muted-foreground"
                />
              </div>

              <div className="hub-panel-enter flex min-h-11 items-center justify-between gap-3 max-sm:items-stretch">
                <ResourceTabsList
                  value={view}
                  items={[
                    {
                      value: "installed" as const,
                      label: t("mcpHub.tabInstalled"),
                      icon: Server,
                      countLabel: serverCount > 0 ? `${enabledCount}/${serverCount}` : null,
                    },
                    {
                      value: "store" as const,
                      label: t("mcpHub.tabStore"),
                      icon: Cloud,
                    },
                    {
                      value: "import" as const,
                      label: t("mcpHub.tabImport"),
                      icon: Download,
                    },
                  ]}
                  ariaLabel="MCP Hub"
                />
              </div>

              <div className="min-h-0 flex-1 overflow-hidden pt-4">
                <TabsContent value="installed" className="h-full min-h-0">
                  <McpServersForm
                    settings={settings}
                    setSettings={setSettings}
                    query={searchQueries.installed}
                    onAddServer={openAdd}
                    onEditServer={openEdit}
                  />
                </TabsContent>
                <TabsContent value="store" className="h-full min-h-0">
                  <McpRegistryBrowser
                    settings={settings}
                    setSettings={setSettings}
                    query={searchQueries.store}
                  />
                </TabsContent>
                <TabsContent value="import" className="h-full min-h-0">
                  <McpImportView
                    settings={settings}
                    setSettings={setSettings}
                    query={searchQueries.import}
                  />
                </TabsContent>
              </div>
            </Tabs>
          </div>
        </div>
      </div>

      {editing ? (
        <McpServerEditModal
          mode={editing.mode}
          initialServer={editing.mode === "edit" ? editing.server : null}
          existingServers={settings.mcp.servers}
          onClose={() => setEditing(null)}
          onSave={handleModalSave}
        />
      ) : null}
    </div>
  );
}
