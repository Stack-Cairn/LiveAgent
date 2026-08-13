import { type AppSettings, type McpServerConfig, updateMcp } from "@liveagent/app/lib/settings";
import { invoke } from "@liveagent/app/shims/tauriCore";
import {
  AlertTriangle,
  Check,
  Download,
  FileText,
  Globe2,
  Loader2,
  RefreshCw,
  Terminal,
} from "@liveagent/ui/components/IconSet";
import { SearchHighlight } from "@liveagent/ui/components/ui/search-highlight";
import { useLocale } from "@liveagent/ui/i18n/index";
import { rankFuzzySearchResults } from "@liveagent/ui/lib/shared/fuzzySearch";
import {
  type ExternalMcpServerEntry,
  type ExternalMcpToolScan,
  scanExternalMcpServers,
  scanMcpConfigFile,
} from "@liveagent/ui/lib/skills/index";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GlassPanel } from "../../components/hub/HubChrome";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/shared/utils";
import { LOCAL_FILE_TOOL, McpImportSourcePicker } from "./McpImportSourcePicker";

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
  query: string;
}) {
  const { settings, setSettings, query } = props;
  const { t } = useLocale();

  const [scans, setScans] = useState<ExternalMcpToolScan[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileScan, setFileScan] = useState<ExternalMcpToolScan | null>(null);
  const [filePicking, setFilePicking] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [importedCount, setImportedCount] = useState<number | null>(null);
  const [activeTool, setActiveTool] = useState<string>("claude-code");
  const [rescanComplete, setRescanComplete] = useState(false);
  const userChoseToolRef = useRef(false);
  const rescanFeedbackTimerRef = useRef<number | null>(null);

  const allScans = useMemo(
    () => (fileScan ? [...(scans ?? []), fileScan] : (scans ?? [])),
    [scans, fileScan],
  );

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
      // 清掉扫描结果中已不存在的选择项（「从文件导入」的选择项不受重扫影响）
      setSelected((prev) => {
        const valid = new Set(
          result.flatMap((scan) =>
            scan.servers.map((server) => externalServerKey(scan.tool, server)),
          ),
        );
        const next = new Set(
          [...prev].filter((key) => valid.has(key) || key.startsWith(`${LOCAL_FILE_TOOL}:`)),
        );
        return next.size === prev.size ? prev : next;
      });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  const handleRescan = useCallback(async () => {
    if (rescanFeedbackTimerRef.current !== null) {
      window.clearTimeout(rescanFeedbackTimerRef.current);
      rescanFeedbackTimerRef.current = null;
    }
    setRescanComplete(false);
    const succeeded = await rescan();
    if (!succeeded) return;
    setRescanComplete(true);
    rescanFeedbackTimerRef.current = window.setTimeout(() => {
      setRescanComplete(false);
      rescanFeedbackTimerRef.current = null;
    }, 2400);
  }, [rescan]);

  useEffect(
    () => () => {
      if (rescanFeedbackTimerRef.current !== null) {
        window.clearTimeout(rescanFeedbackTimerRef.current);
      }
    },
    [],
  );

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

  const pickFileAndScan = useCallback(async () => {
    setFileError(null);
    setFilePicking(true);
    try {
      const picked = await invoke<string | null>("system_pick_file", {
        filter_name: "JSON / TOML",
        extensions: ["json", "toml"],
      });
      const path = picked?.trim();
      if (!path) return;
      const scan = await scanMcpConfigFile(path);
      // 换文件后清掉上一个文件遗留的选择项，避免按 id 误选到新文件的同名条目
      setSelected((prev) => {
        const next = new Set([...prev].filter((key) => !key.startsWith(`${LOCAL_FILE_TOOL}:`)));
        return next.size === prev.size ? prev : next;
      });
      setFileScan(scan);
      userChoseToolRef.current = true;
      setActiveTool(LOCAL_FILE_TOOL);
    } catch (err) {
      setFileError(err instanceof Error ? err.message : String(err));
    } finally {
      setFilePicking(false);
    }
  }, []);

  const activeScan = allScans.find((scan) => scan.tool === activeTool);
  const visibleServers = useMemo(
    () =>
      rankFuzzySearchResults(activeScan?.servers ?? [], query, (server) => [
        server.id,
        server.transport,
        server.command,
        server.url,
        server.origin,
        ...server.args,
        ...Object.keys(server.env),
        ...Object.keys(server.headers),
      ]),
    [activeScan, query],
  );
  const importableInActive = useMemo(
    () => visibleServers.filter((server) => !installedIds.has(server.id.trim().toLowerCase())),
    [installedIds, visibleServers],
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
    const targets = allScans.flatMap((scan) =>
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

        {fileError ? (
          <GlassPanel tone="error" className="hub-panel-enter">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
              <span className="text-xs text-destructive">
                {t("mcpHub.importFileFailed")}: {fileError}
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
              <McpImportSourcePicker
                scans={allScans}
                value={activeTool}
                onChange={(nextTool) => {
                  userChoseToolRef.current = true;
                  setActiveTool(nextTool);
                }}
              />

              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 rounded-full"
                  disabled={filePicking}
                  title={t("mcpHub.importFromFileHint")}
                  onClick={() => void pickFileAndScan()}
                >
                  {filePicking ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <FileText className="h-3.5 w-3.5" />
                  )}
                  {t("mcpHub.importFromFile")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="min-w-[6.75rem] justify-center gap-1.5 rounded-full"
                  disabled={loading}
                  aria-busy={loading}
                  onClick={() => void handleRescan()}
                >
                  {loading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : rescanComplete ? (
                    <Check className="h-3.5 w-3.5 text-[hsl(var(--chat-success))]" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  <span aria-live="polite">
                    {loading
                      ? t("mcpHub.importScanning")
                      : rescanComplete
                        ? t("settings.skillsScanComplete")
                        : t("mcpHub.importRescan")}
                  </span>
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
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                    <span className="font-mono">{activeScan.configPath}</span>
                    {activeScan.errors.length > 0 ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span
                          className="cursor-help underline decoration-dotted underline-offset-2"
                          title={activeScan.errors.join("\n")}
                        >
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
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={toggleAllActive}
                        className="h-7 rounded-lg border-border/70 bg-card px-2 text-[11px] shadow-xs"
                      >
                        {allActiveSelected
                          ? t("mcpHub.importDeselectAll")
                          : t("mcpHub.importSelectAll")}
                      </Button>
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
                ) : visibleServers.length === 0 ? (
                  <GlassPanel tone="muted">
                    <p className="py-2 text-center text-xs text-muted-foreground">
                      {t("mcpHub.importNoMatch")}
                    </p>
                  </GlassPanel>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {visibleServers.map((server) => {
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
                            "group flex min-h-36 items-start gap-2.5 rounded-xl border p-3.5 text-left transition-[border-color,background-color,box-shadow]",
                            alreadyImported
                              ? "cursor-not-allowed border-border/70 bg-muted/50"
                              : checked
                                ? "border-primary/60 bg-primary/10 shadow-xs"
                                : "border-border bg-card shadow-xs hover:border-foreground/20 hover:bg-muted/30",
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
                                <SearchHighlight text={server.id} query={query} />
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
                              <SearchHighlight text={preview} query={query} />
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
