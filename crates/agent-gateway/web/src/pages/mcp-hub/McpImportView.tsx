import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GlassPanel } from "../../components/hub/HubChrome";
import {
  AlertTriangle,
  Check,
  Download,
  Folder,
  Globe2,
  Loader2,
  RefreshCw,
  Terminal,
} from "../../components/icons";
import { Button } from "../../components/ui/button";
import { useLocale } from "../../i18n";
import { type AppSettings, type McpServerConfig, updateMcp } from "../../lib/settings";
import { cn } from "../../lib/shared/utils";
import {
  type ExternalMcpServerEntry,
  type ExternalMcpToolScan,
  scanExternalMcpServers,
} from "../../lib/skills";

const EXTERNAL_MCP_TOOL_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "claude-desktop": "Claude Desktop",
};

const DEFAULT_IMPORT_TIMEOUT_MS = 60_000;

function externalServerKey(tool: string, server: ExternalMcpServerEntry) {
  return `${tool}:${server.id.toLowerCase()}`;
}

function toMcpServerConfig(entry: ExternalMcpServerEntry): McpServerConfig {
  const server: McpServerConfig = {
    id: entry.id.trim(),
    enabled: true,
    transport: entry.transport,
    command: entry.command,
    args: entry.args,
    url: entry.url,
    timeoutMs:
      typeof entry.timeoutMs === "number" && entry.timeoutMs > 0
        ? entry.timeoutMs
        : DEFAULT_IMPORT_TIMEOUT_MS,
  };
  if (Object.keys(entry.env).length > 0) server.env = entry.env;
  if (Object.keys(entry.headers).length > 0) server.headers = entry.headers;
  if (entry.cwd) server.cwd = entry.cwd;
  return server;
}

export function McpImportView(props: {
  settings: AppSettings;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
}) {
  const { settings, setSettings } = props;
  const { t } = useLocale();

  const [scans, setScans] = useState<ExternalMcpToolScan[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [importedCount, setImportedCount] = useState<number | null>(null);
  const [activeTool, setActiveTool] = useState<string>("claude-code");
  const userChoseToolRef = useRef(false);

  const installedIds = useMemo(
    () => new Set(settings.mcp.servers.map((server) => server.id.trim().toLowerCase())),
    [settings.mcp.servers],
  );

  const rescan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await scanExternalMcpServers();
      setScans(result);
      // 清掉扫描结果中已不存在的选择项
      setSelected((prev) => {
        const valid = new Set(
          result.flatMap((scan) =>
            scan.servers.map((server) => externalServerKey(scan.tool, server)),
          ),
        );
        const next = new Set([...prev].filter((key) => valid.has(key)));
        return next.size === prev.size ? prev : next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (scans === null && !loading) {
      void rescan();
    }
  }, [scans, loading, rescan]);

  // 扫描结果就绪后自动定位到第一个有配置的工具；用户手动切换后不再干预
  useEffect(() => {
    if (userChoseToolRef.current || !scans || scans.length === 0) return;
    const preferred =
      scans.find((scan) => scan.servers.length > 0) ??
      scans.find((scan) => scan.exists) ??
      scans[0];
    if (preferred && preferred.tool !== activeTool) {
      setActiveTool(preferred.tool);
    }
  }, [scans, activeTool]);

  const activeScan = scans?.find((scan) => scan.tool === activeTool);
  const importableInActive = useMemo(
    () =>
      (activeScan?.servers ?? []).filter(
        (server) => !installedIds.has(server.id.trim().toLowerCase()),
      ),
    [activeScan, installedIds],
  );
  const selectedInActive = importableInActive.filter((server) =>
    selected.has(externalServerKey(activeTool, server)),
  ).length;
  const allActiveSelected =
    importableInActive.length > 0 && selectedInActive === importableInActive.length;

  function toggleServer(tool: string, server: ExternalMcpServerEntry) {
    const key = externalServerKey(tool, server);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAllActive() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allActiveSelected) {
        for (const server of importableInActive) {
          next.delete(externalServerKey(activeTool, server));
        }
      } else {
        for (const server of importableInActive) {
          next.add(externalServerKey(activeTool, server));
        }
      }
      return next;
    });
  }

  function importSelected() {
    if (!scans) return;
    const targets = scans.flatMap((scan) =>
      scan.servers.filter((server) => selected.has(externalServerKey(scan.tool, server))),
    );
    if (targets.length === 0) return;

    let added = 0;
    setSettings((prev) => {
      const existing = new Set(prev.mcp.servers.map((server) => server.id.trim().toLowerCase()));
      const fresh: McpServerConfig[] = [];
      for (const entry of targets) {
        const id = entry.id.trim().toLowerCase();
        if (!id || existing.has(id)) continue;
        existing.add(id);
        fresh.push(toMcpServerConfig(entry));
      }
      added = fresh.length;
      if (fresh.length === 0) return prev;
      return updateMcp(prev, { servers: [...prev.mcp.servers, ...fresh] });
    });
    setSelected(new Set());
    setImportedCount(added);
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto px-0.5 pb-4 pr-1 pt-1.5">
      <div className="flex flex-col gap-4">
        {error ? (
          <GlassPanel tone="error" className="hub-panel-enter">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
              <span className="text-xs text-destructive">
                {t("mcpHub.importScanFailed")}: {error}
              </span>
            </div>
          </GlassPanel>
        ) : null}

        {importedCount !== null && importedCount > 0 ? (
          <GlassPanel tone="muted" className="hub-panel-enter">
            <div className="flex items-center gap-2">
              <Check className="h-4 w-4 shrink-0 text-[hsl(var(--chat-success))]" />
              <span className="text-xs text-muted-foreground">
                {t("mcpHub.importDone").replace("{count}", String(importedCount))}
              </span>
            </div>
          </GlassPanel>
        ) : null}

        {loading && !scans ? (
          <GlassPanel className="hub-panel-enter">
            <div className="flex items-center gap-3 py-4">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="text-xs text-muted-foreground">{t("mcpHub.importScanning")}</span>
            </div>
          </GlassPanel>
        ) : (
          <>
            <div className="hub-panel-enter flex flex-wrap items-center justify-between gap-3">
              <div className="inline-flex shrink-0 rounded-2xl border border-border/40 bg-background/60 p-1 backdrop-blur-xl shadow-[0_1px_0_rgba(255,255,255,0.5)_inset] dark:border-white/[0.06] dark:bg-white/[0.04] dark:shadow-[0_1px_0_rgba(255,255,255,0.04)_inset]">
                {(scans ?? []).map((scan) => {
                  const toolLabel = EXTERNAL_MCP_TOOL_LABELS[scan.tool] ?? scan.tool;
                  const active = scan.tool === activeTool;
                  return (
                    <button
                      key={scan.tool}
                      type="button"
                      onClick={() => {
                        userChoseToolRef.current = true;
                        setActiveTool(scan.tool);
                      }}
                      className={cn(
                        "relative inline-flex h-9 items-center justify-center gap-2 rounded-xl px-4 text-[12.5px] font-medium transition-all",
                        active
                          ? "bg-background/85 text-foreground shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_4px_12px_-8px_rgba(15,23,42,0.18)] ring-1 ring-border/45 dark:bg-white/[0.08] dark:ring-white/[0.09] dark:shadow-[0_1px_0_rgba(255,255,255,0.07)_inset,0_4px_12px_-8px_rgba(0,0,0,0.55)]"
                          : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
                      )}
                    >
                      <Folder className="h-3.5 w-3.5" />
                      <span>{toolLabel}</span>
                      {scan.exists ? (
                        <span
                          className={cn(
                            "ml-0.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums",
                            active
                              ? "bg-foreground/[0.08] text-foreground/85"
                              : "bg-muted/70 text-muted-foreground",
                          )}
                        >
                          {scan.servers.length}
                        </span>
                      ) : (
                        <span className="ml-0.5 text-[10px] text-muted-foreground/70">
                          {t("mcpHub.importNotDetected")}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 rounded-full"
                  disabled={loading}
                  onClick={() => void rescan()}
                >
                  <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
                  {t("mcpHub.importRescan")}
                </Button>
                <Button
                  size="sm"
                  className="gap-1.5 rounded-full"
                  disabled={selected.size === 0 || loading}
                  onClick={importSelected}
                >
                  <Download className="h-3.5 w-3.5" />
                  {`${t("mcpHub.importButton")}${selected.size > 0 ? ` (${selected.size})` : ""}`}
                </Button>
              </div>
            </div>

            {activeScan ? (
              <div key={activeScan.tool} className="hub-panel-enter flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground/70">
                    <span className="font-mono">{activeScan.configPath}</span>
                    {activeScan.errors.length > 0 ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>
                          {t("mcpHub.importUnparsable").replace(
                            "{count}",
                            String(activeScan.errors.length),
                          )}
                        </span>
                      </>
                    ) : null}
                  </p>
                  {importableInActive.length > 0 ? (
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="tabular-nums">
                        {t("mcpHub.importSelectedCount")
                          .replace("{selected}", String(selectedInActive))
                          .replace("{total}", String(importableInActive.length))}
                      </span>
                      <button
                        type="button"
                        onClick={toggleAllActive}
                        className="rounded-full border border-border/45 bg-background/70 px-2 py-0.5 text-[11px] font-medium text-foreground/80 transition-colors hover:bg-background/90"
                      >
                        {allActiveSelected
                          ? t("mcpHub.importDeselectAll")
                          : t("mcpHub.importSelectAll")}
                      </button>
                    </div>
                  ) : null}
                </div>

                {!activeScan.exists ? (
                  <GlassPanel tone="muted">
                    <p className="py-2 text-center text-xs text-muted-foreground">
                      {t("mcpHub.importNotDetected")} · {activeScan.configPath}
                    </p>
                  </GlassPanel>
                ) : activeScan.servers.length === 0 ? (
                  <GlassPanel tone="muted">
                    <p className="py-2 text-center text-xs text-muted-foreground">
                      {t("mcpHub.importEmpty")}
                    </p>
                  </GlassPanel>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {activeScan.servers.map((server) => {
                      const key = externalServerKey(activeScan.tool, server);
                      const alreadyImported = installedIds.has(server.id.trim().toLowerCase());
                      const checked = selected.has(key);
                      const isStdio = server.transport === "stdio";
                      const preview = isStdio
                        ? [server.command, ...server.args].join(" ")
                        : server.url;
                      const extras = [
                        server.args.length > 0 ? `args ${server.args.length}` : null,
                        Object.keys(server.env).length > 0
                          ? `env ${Object.keys(server.env).length}`
                          : null,
                        Object.keys(server.headers).length > 0
                          ? `headers ${Object.keys(server.headers).length}`
                          : null,
                      ].filter((item): item is string => Boolean(item));
                      return (
                        <button
                          key={key}
                          type="button"
                          disabled={alreadyImported}
                          onClick={() => toggleServer(activeScan.tool, server)}
                          className={cn(
                            "group flex items-start gap-2.5 rounded-xl border p-3 text-left transition-all",
                            alreadyImported
                              ? "cursor-not-allowed border-border/35 bg-muted/30 opacity-70"
                              : checked
                                ? "border-primary/60 bg-primary/5 shadow-sm shadow-primary/10"
                                : "border-border/40 bg-background/60 hover:border-border/70 hover:bg-background/85",
                          )}
                        >
                          <span
                            className={cn(
                              "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                              checked && !alreadyImported
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-border/70 bg-background",
                            )}
                          >
                            {checked && !alreadyImported ? <Check className="h-3 w-3" /> : null}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-1.5">
                              <span className="truncate text-[13px] font-medium text-foreground">
                                {server.id}
                              </span>
                              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted/70 px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                                {isStdio ? (
                                  <Terminal className="h-2.5 w-2.5" />
                                ) : (
                                  <Globe2 className="h-2.5 w-2.5" />
                                )}
                                {server.transport}
                              </span>
                              {server.origin !== "user" ? (
                                <span
                                  className="inline-flex max-w-[10rem] shrink-0 items-center truncate rounded-full bg-muted/70 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                                  title={server.origin}
                                >
                                  {t("mcpHub.importOriginProject")}
                                </span>
                              ) : null}
                              {alreadyImported ? (
                                <span className="inline-flex shrink-0 items-center rounded-full bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-foreground/70 ring-1 ring-border/45">
                                  {t("mcpHub.importAlreadyImported")}
                                </span>
                              ) : null}
                            </span>
                            <span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">
                              {preview}
                            </span>
                            {extras.length > 0 ? (
                              <span className="mt-1 flex flex-wrap gap-1">
                                {extras.map((extra) => (
                                  <span
                                    key={extra}
                                    className="rounded-full bg-muted/60 px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground"
                                  >
                                    {extra}
                                  </span>
                                ))}
                              </span>
                            ) : null}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
