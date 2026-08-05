import { useState } from "react";
import { HubBackdrop, HubHeader } from "../../components/hub/HubChrome";
import { Cable, Cloud, Download, Plug, Plus, Server, Sparkles } from "../../components/icons";
import { Button } from "../../components/ui/button";
import { useLocale } from "../../i18n";
import { type AppSettings, type McpServerConfig, updateMcp } from "../../lib/settings";
import { cn } from "../../lib/shared/utils";
import { McpImportView } from "./McpImportView";
import { McpRegistryBrowser } from "./McpRegistryBrowser";
import { McpServerEditModal, McpServersForm } from "./McpServersForm";

type McpHubPageProps = {
  settings: AppSettings;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
  isAgentMode: boolean;
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
};

type McpHubView = "installed" | "store" | "import";

type EditingState = { mode: "add" } | { mode: "edit"; idx: number; server: McpServerConfig };

export function McpHubPage(props: McpHubPageProps) {
  const { settings, setSettings, sidebarOpen, onOpenSidebar } = props;
  const { t } = useLocale();
  const [view, setView] = useState<McpHubView>("installed");
  const [editing, setEditing] = useState<EditingState | null>(null);

  const serverCount = settings.mcp.servers.length;
  const enabledCount = settings.mcp.servers.filter((server) => server.enabled).length;
  const ready = serverCount > 0;
  const statusHint = ready ? null : t("mcpHub.statusEmptyDesc");

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
    <div className="hub-page hub-page-enter relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <HubBackdrop tone="violet" />

      <div className="relative z-10 flex h-full min-h-0 flex-col overflow-hidden">
        <HubHeader
          icon={<Cable className="h-5 w-5" />}
          title="MCP Hub"
          subtitle={t("mcpHub.subtitle")}
          sidebarOpen={sidebarOpen}
          onOpenSidebar={onOpenSidebar}
        />

        <div className="hub-scroll min-h-0 flex-1 overflow-hidden px-5 pb-6 pt-2 sm:px-6 lg:px-8 xl:px-10">
          <div className="hub-content-stage mx-auto flex h-full min-h-0 w-full max-w-[1320px] flex-col gap-4">
            {/* Status banner */}
            <div
              className={cn(
                "hub-panel-enter relative overflow-hidden rounded-2xl border backdrop-blur-xl",
                ready
                  ? "border-border/50 bg-background/75 shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_8px_24px_-18px_rgba(15,23,42,0.18)] dark:border-white/[0.09] dark:bg-white/[0.05] dark:shadow-[0_1px_0_rgba(255,255,255,0.06)_inset,0_8px_24px_-18px_rgba(0,0,0,0.6)]"
                  : "border-border/40 bg-background/60",
              )}
            >
              <div className="flex items-center gap-3 px-4 py-3.5 sm:gap-x-5 sm:px-5">
                <div className="flex min-w-0 flex-1 items-center gap-3 sm:gap-3.5">
                  <div
                    className={cn(
                      "relative flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border transition-colors",
                      ready
                        ? "border-border/50 bg-background/80 text-foreground/85 shadow-[0_1px_0_rgba(255,255,255,0.55)_inset] dark:border-white/[0.09] dark:bg-white/[0.06] dark:shadow-[0_1px_0_rgba(255,255,255,0.06)_inset]"
                        : "border-border/40 bg-muted/40 text-muted-foreground",
                    )}
                  >
                    <Plug className="h-5 w-5" />
                    {ready && enabledCount > 0 ? (
                      <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-background" />
                    ) : null}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <div className="text-[13.5px] font-semibold tracking-tight text-foreground">
                        {ready ? t("mcpHub.statusReady") : t("mcpHub.statusEmpty")}
                      </div>
                      {ready ? (
                        <span
                          className={cn(
                            "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium tabular-nums backdrop-blur-md",
                            enabledCount > 0
                              ? "bg-foreground/[0.06] text-foreground/85 ring-1 ring-border/50"
                              : "bg-background/60 text-muted-foreground ring-1 ring-border/40",
                          )}
                        >
                          <span className="font-semibold">{enabledCount}</span>
                          <span className="opacity-50">/</span>
                          <span className="opacity-80">{serverCount}</span>
                          <span className="ml-0.5 opacity-70">{t("mcpHub.enabled")}</span>
                        </span>
                      ) : null}
                    </div>
                    {statusHint ? (
                      <div className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                        {statusHint}
                      </div>
                    ) : null}
                  </div>
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0 gap-1.5 rounded-full border-border/50 bg-background/70 px-3 backdrop-blur-md sm:px-3.5"
                  onClick={openAdd}
                  title={t("mcpHub.add")}
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span className="hidden whitespace-nowrap sm:inline">{t("mcpHub.add")}</span>
                </Button>
              </div>
            </div>

            {/* Tab bar */}
            <div className="hub-panel-enter flex items-center justify-between gap-3">
              <div className="inline-flex shrink-0 rounded-2xl border border-border/40 bg-background/60 p-1 backdrop-blur-xl shadow-[0_1px_0_rgba(255,255,255,0.5)_inset] dark:border-white/[0.06] dark:bg-white/[0.04] dark:shadow-[0_1px_0_rgba(255,255,255,0.04)_inset]">
                {[
                  {
                    value: "installed" as const,
                    label: t("mcpHub.tabInstalled"),
                    icon: Server,
                    count: serverCount,
                  },
                  {
                    value: "store" as const,
                    label: t("mcpHub.tabStore"),
                    icon: Cloud,
                    count: null,
                  },
                  {
                    value: "import" as const,
                    label: t("mcpHub.tabImport"),
                    icon: Download,
                    count: null,
                  },
                ].map((item) => {
                  const Icon = item.icon;
                  const active = view === item.value;
                  return (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => setView(item.value)}
                      className={cn(
                        "relative inline-flex h-9 items-center justify-center gap-2 rounded-xl px-4 text-[12.5px] font-medium transition-all",
                        active
                          ? "bg-background/85 text-foreground shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_4px_12px_-8px_rgba(15,23,42,0.18)] ring-1 ring-border/45 dark:bg-white/[0.08] dark:ring-white/[0.09] dark:shadow-[0_1px_0_rgba(255,255,255,0.07)_inset,0_4px_12px_-8px_rgba(0,0,0,0.55)]"
                          : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      <span>{item.label}</span>
                      {item.count !== null && item.count > 0 ? (
                        <span
                          className={cn(
                            "ml-0.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums",
                            active
                              ? "bg-foreground/[0.08] text-foreground/85"
                              : "bg-muted/70 text-muted-foreground",
                          )}
                        >
                          {item.count}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>

              {view === "store" ? (
                <div className="hidden text-[11.5px] text-muted-foreground sm:flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-foreground/55" />
                  <span>{t("mcpHub.storeSubtitle")}</span>
                </div>
              ) : null}
            </div>

            {/* Content */}
            <div className="min-h-0 flex-1 overflow-hidden">
              {view === "installed" ? (
                <McpServersForm
                  settings={settings}
                  setSettings={setSettings}
                  onAddServer={openAdd}
                  onEditServer={openEdit}
                />
              ) : view === "store" ? (
                <McpRegistryBrowser settings={settings} setSettings={setSettings} />
              ) : (
                <McpImportView settings={settings} setSettings={setSettings} />
              )}
            </div>
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
