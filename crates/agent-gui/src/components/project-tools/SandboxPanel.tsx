import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppSettings } from "../../lib/settings";
import { updateSystem } from "../../lib/settings";
import { normalizeCrateBayRuntimeSummary } from "../../lib/cratebay/runtimeStatus";
import { cn } from "../../lib/shared/utils";
import { CRATEBAY_SYSTEM_TOOL_IDS } from "../../lib/tools/customSystemTools";
import { Download, Loader2, Play, RefreshCw, Server, Square, Trash2, Zap } from "../icons";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

type CliCommandResult = {
  ok: boolean;
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  json?: unknown;
};

type CrateBayStatus = {
  installed: boolean;
  repository: string;
  installDir: string;
  binaryPath?: string | null;
  manifest?: {
    tagName: string;
    assetName: string;
    sha256: string;
    installedAt: string;
  } | null;
  version?: string | null;
  latestRelease?: {
    tagName: string;
    assetName?: string | null;
    prerelease: boolean;
  } | null;
  runtime?: CliCommandResult | null;
  error?: string | null;
};

type ContainerSummary = {
  id?: string;
  name?: string;
  image?: string;
  state?: string;
  status?: string;
};

type SandboxRunResult = {
  podName: string;
  runtimeStart?: CliCommandResult | null;
  podCreate?: CliCommandResult | null;
  containerRun?: CliCommandResult | null;
  podCleanup?: CliCommandResult | null;
};

type SandboxPanelProps = {
  settings: AppSettings;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
};

function asJsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function commandText(result: CliCommandResult | null | undefined) {
  if (!result) return "";
  if (result.json !== undefined && result.json !== null) {
    return JSON.stringify(result.json, null, 2);
  }
  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
}

function jsonItems<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }
  if (value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items)) {
    return (value as { items: T[] }).items;
  }
  return [];
}

function containerKey(container: ContainerSummary) {
  return container.id || container.name || `${container.image}:${container.status}`;
}

function sandboxResultText(result: SandboxRunResult | null) {
  if (!result) return "";
  const run = result.containerRun;
  if (run) {
    const payload = asJsonRecord(run.json);
    const stdout = typeof payload.stdout === "string" ? payload.stdout.trimEnd() : "";
    const stderr = typeof payload.stderr === "string" ? payload.stderr.trimEnd() : "";
    const output = [stdout, stderr].filter(Boolean).join("\n");
    return output || commandText(run) || "(no output)";
  }

  const failedStep = [result.runtimeStart, result.podCreate, result.podCleanup].find((step) => step && !step.ok);
  return commandText(failedStep) || "(no output)";
}

function sandboxExitText(result: CliCommandResult | null | undefined) {
  if (!result) return null;
  const payload = asJsonRecord(result.json);
  const exitCode = typeof payload.exitCode === "number" ? payload.exitCode : result.exitCode;
  return typeof exitCode === "number" ? `exit ${exitCode}` : null;
}

function sandboxStepClass(result: CliCommandResult | null | undefined) {
  if (!result) return "border-border bg-muted/40 text-muted-foreground";
  return result.ok
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
    : "border-destructive/30 bg-destructive/10 text-destructive";
}

export function SandboxPanel({ settings, setSettings }: SandboxPanelProps) {
  const [status, setStatus] = useState<CrateBayStatus | null>(null);
  const [containers, setContainers] = useState<ContainerSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [logs, setLogs] = useState<CliCommandResult | null>(null);
  const [execResult, setExecResult] = useState<CliCommandResult | null>(null);
  const [containerName, setContainerName] = useState("");
  const [image, setImage] = useState("alpine:3.20");
  const [sandboxImage, setSandboxImage] = useState("cratebay-ubuntu-base:v1");
  const [sandboxCommand, setSandboxCommand] = useState("uname -a && pwd");
  const [sandboxResult, setSandboxResult] = useState<SandboxRunResult | null>(null);
  const [execCommand, setExecCommand] = useState("uname -a");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const installed = status?.installed === true;
  const enabledCrateBayToolCount = useMemo(() => {
    const selected = new Set(settings.system.selectedSystemTools);
    return CRATEBAY_SYSTEM_TOOL_IDS.filter((id) => selected.has(id)).length;
  }, [settings.system.selectedSystemTools]);
  const crateBayToolsEnabled = enabledCrateBayToolCount === CRATEBAY_SYSTEM_TOOL_IDS.length;
  const selectedContainer = useMemo(
    () => containers.find((container) => (container.id || container.name) === selectedId) ?? null,
    [containers, selectedId],
  );

  const refreshContainers = useCallback(async () => {
    if (!installed) {
      setContainers([]);
      return;
    }
    const result = await invoke<CliCommandResult>("cratebay_engine_containers");
    setContainers(jsonItems<ContainerSummary>(result.json));
  }, [installed]);

  const refresh = useCallback(async () => {
    setBusy((current) => current || "refresh");
    setError("");
    try {
      const nextStatus = await invoke<CrateBayStatus>("cratebay_status", {
        include_prerelease: false,
      });
      setStatus(nextStatus);
      if (nextStatus.installed) {
        const list = await invoke<CliCommandResult>("cratebay_engine_containers");
        setContainers(jsonItems<ContainerSummary>(list.json));
      } else {
        setContainers([]);
        setSelectedId("");
        setLogs(null);
        setExecResult(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy((current) => (current === "refresh" ? "" : current));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runAction = async (name: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(name);
    setError("");
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  };

  const install = () =>
    runAction("install", async () => {
      const next = await invoke<CrateBayStatus>("cratebay_install", {
        include_prerelease: false,
      });
      setStatus(next);
      await refreshContainers();
    });

  const uninstall = () =>
    runAction("uninstall", async () => {
      const next = await invoke<CrateBayStatus>("cratebay_uninstall");
      setStatus(next);
      setContainers([]);
      setSelectedId("");
    });

  const runtimeStart = () =>
    runAction("runtime-start", async () => {
      await invoke<CliCommandResult>("cratebay_runtime_start");
      await refresh();
    });

  const runtimeStop = () =>
    runAction("runtime-stop", async () => {
      await invoke<CliCommandResult>("cratebay_runtime_stop");
      await refresh();
    });

  const createContainer = () =>
    runAction("create", async () => {
      await invoke<CliCommandResult>("cratebay_engine_container_create", {
        request: {
          name: containerName.trim(),
          image: image.trim(),
          command: "sleep infinity",
        },
      });
      setContainerName("");
      await refresh();
    });

  const runSandboxPod = () =>
    runAction("sandbox-run", async () => {
      const command = sandboxCommand.trim();
      const imageName = sandboxImage.trim();
      const podName = `liveagent-ui-${Date.now().toString(36)}`;
      const initialResult: SandboxRunResult = {
        podName,
        runtimeStart: null,
        podCreate: null,
        containerRun: null,
        podCleanup: null,
      };
      let podCreated = false;
      let pendingError: unknown = null;

      const commitResult = (patch: Partial<SandboxRunResult>) => {
        setSandboxResult((current) =>
          current?.podName === podName ? { ...current, ...patch } : { ...initialResult, ...patch },
        );
      };

      setSandboxResult(initialResult);
      try {
        const runtimeStart = await invoke<CliCommandResult>("cratebay_runtime_start");
        commitResult({ runtimeStart });
        if (!runtimeStart.ok) return;

        const podCreate = await invoke<CliCommandResult>("cratebay_engine_pod_create", {
          name: podName,
        });
        podCreated = podCreate.ok;
        commitResult({ podCreate });
        if (!podCreate.ok) return;

        const containerRun = await invoke<CliCommandResult>("cratebay_engine_container_run", {
          request: {
            image: imageName,
            command: ["sh", "-lc", command],
            pod: podName,
            remove: true,
            timeout: 120,
            maxOutputBytes: 200000,
          },
        });
        commitResult({ containerRun });
      } catch (err) {
        pendingError = err;
      } finally {
        if (podCreated) {
          try {
            const podCleanup = await invoke<CliCommandResult>("cratebay_engine_pod_remove", {
              name: podName,
            });
            commitResult({ podCleanup });
          } catch (err) {
            pendingError = pendingError ?? err;
          }
        }
        await refresh();
      }

      if (pendingError) throw pendingError;
    });

  const loadLogs = (id: string) =>
    runAction("logs", async () => {
      setSelectedId(id);
      const result = await invoke<CliCommandResult>("cratebay_engine_container_logs", {
        request: { id, tail: 200, timestamps: false },
      });
      setLogs(result);
    });

  const runExec = () =>
    runAction("exec", async () => {
      if (!selectedId) return;
      const command = execCommand.split(/\s+/).filter(Boolean);
      const result = await invoke<CliCommandResult>("cratebay_engine_container_exec", {
        request: { id: selectedId, command, timeout: 30 },
      });
      setExecResult(result);
    });

  const removeContainer = (id: string) =>
    runAction("remove", async () => {
      await invoke<CliCommandResult>("cratebay_engine_container_remove", { id, force: true });
      setSelectedId("");
      setLogs(null);
      setExecResult(null);
      await refresh();
    });

  const enableAgentTools = () => {
    setSettings((prev) => {
      const selected = new Set(prev.system.selectedSystemTools);
      for (const id of CRATEBAY_SYSTEM_TOOL_IDS) {
        selected.add(id);
      }
      return updateSystem(prev, { selectedSystemTools: Array.from(selected) });
    });
  };

  const disableAgentTools = () => {
    setSettings((prev) => {
      const disabled = new Set(CRATEBAY_SYSTEM_TOOL_IDS);
      return updateSystem(prev, {
        selectedSystemTools: prev.system.selectedSystemTools.filter((id) => !disabled.has(id)),
      });
    });
  };

  const runtimeSummary = normalizeCrateBayRuntimeSummary(
    status?.runtime?.json,
    installed ? "unknown" : "not installed",
  );
  const sandboxExit = sandboxExitText(sandboxResult?.containerRun);
  const sandboxSteps: Array<{ label: string; result?: CliCommandResult | null }> = sandboxResult
    ? [
        { label: "Runtime", result: sandboxResult.runtimeStart },
        { label: "Pod", result: sandboxResult.podCreate },
        { label: "Run", result: sandboxResult.containerRun },
        { label: "Cleanup", result: sandboxResult.podCleanup },
      ]
    : [];

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="sandbox-panel">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Server className="h-4 w-4 text-muted-foreground" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">CrateBay Sandbox</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {installed ? (status?.manifest?.tagName ?? status?.version ?? "installed") : "not installed"}
            </div>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => void refresh()}
          disabled={Boolean(busy)}
          title="Refresh"
        >
          {busy === "refresh" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
        {error ? (
          <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        ) : null}

        <div className="mb-3 grid grid-cols-2 gap-2 text-xs">
          <div className="col-span-2 rounded-md border border-border bg-muted/20 px-3 py-2">
            <div className="text-muted-foreground">Install</div>
            <div className="mt-1 font-medium text-foreground">{installed ? "Ready" : "Required"}</div>
          </div>
          <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
            <div className="text-muted-foreground">CrateBay Engine</div>
            <div className="mt-1 font-medium text-foreground">{runtimeSummary.engineName}</div>
          </div>
          <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
            <div className="text-muted-foreground">Engine VM</div>
            <div className="mt-1 font-medium text-foreground">{runtimeSummary.state}</div>
          </div>
          <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
            <div className="text-muted-foreground">Container backend</div>
            <div className="mt-1 font-medium text-foreground">
              {runtimeSummary.backendRuntime} / {runtimeSummary.ociRuntime}
            </div>
          </div>
          <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
            <div className="text-muted-foreground">Network</div>
            <div className="mt-1 font-medium text-foreground">{runtimeSummary.networkStack}</div>
          </div>
          <div className="col-span-2 rounded-md border border-border bg-muted/20 px-3 py-2">
            <div className="text-muted-foreground">Native API</div>
            <div className="mt-1 font-medium text-foreground">
              {runtimeSummary.engineResponsive === undefined
                ? runtimeSummary.engineApi
                : runtimeSummary.engineResponsive
                  ? `Ready · ${runtimeSummary.engineApi}`
                  : "Offline"}
            </div>
          </div>
          <div className="col-span-2 rounded-md border border-border bg-muted/20 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-muted-foreground">Agent tools</div>
                <div className="mt-1 font-medium text-foreground">
                  {crateBayToolsEnabled
                    ? "Enabled"
                    : `${enabledCrateBayToolCount}/${CRATEBAY_SYSTEM_TOOL_IDS.length} selected`}
                </div>
              </div>
              <Button
                size="sm"
                variant={crateBayToolsEnabled ? "outline" : "default"}
                onClick={crateBayToolsEnabled ? disableAgentTools : enableAgentTools}
                className="h-8 shrink-0"
              >
                {crateBayToolsEnabled ? "Disable tools" : "Enable tools"}
              </Button>
            </div>
          </div>
        </div>

        <div className="mb-4 flex flex-wrap gap-2">
          <Button size="sm" onClick={install} disabled={Boolean(busy)} className="h-8 gap-1.5">
            {busy === "install" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {installed ? "Update" : "Install"}
          </Button>
          <Button size="sm" variant="outline" onClick={runtimeStart} disabled={!installed || Boolean(busy)} className="h-8 gap-1.5">
            <Play className="h-3.5 w-3.5" />
            Start
          </Button>
          <Button size="sm" variant="outline" onClick={runtimeStop} disabled={!installed || Boolean(busy)} className="h-8 gap-1.5">
            <Square className="h-3.5 w-3.5" />
            Stop
          </Button>
          <Button size="sm" variant="ghost" onClick={uninstall} disabled={!installed || Boolean(busy)} className="h-8 gap-1.5 text-muted-foreground">
            <Trash2 className="h-3.5 w-3.5" />
            Uninstall
          </Button>
        </div>

        {installed ? (
          <>
            <div className="mb-4 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-medium text-muted-foreground">Run in Pod</div>
                {sandboxResult ? (
                  <span className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                    {sandboxResult.podName}
                  </span>
                ) : null}
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                <input
                  value={sandboxImage}
                  onChange={(event) => setSandboxImage(event.currentTarget.value)}
                  placeholder="image"
                  className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
                />
                <Button
                  size="sm"
                  onClick={runSandboxPod}
                  disabled={!sandboxImage.trim() || !sandboxCommand.trim() || Boolean(busy)}
                  className="h-8 gap-1.5"
                >
                  {busy === "sandbox-run" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                  Run
                </Button>
              </div>
              <Textarea
                value={sandboxCommand}
                onChange={(event) => setSandboxCommand(event.currentTarget.value)}
                className="min-h-[72px] resize-y font-mono text-xs leading-relaxed"
                spellCheck={false}
              />
              {sandboxResult ? (
                <div className="space-y-2 rounded-md border border-border bg-muted/20 p-2">
                  <div className="flex flex-wrap gap-1.5">
                    {sandboxSteps.map(({ label, result }) => (
                      <span
                        key={label}
                        className={cn(
                          "inline-flex h-6 items-center gap-1 rounded border px-2 text-[11px]",
                          sandboxStepClass(result),
                        )}
                      >
                        <span>{label}</span>
                        <span>{result ? (result.ok ? "ok" : "failed") : "pending"}</span>
                      </span>
                    ))}
                    {sandboxExit ? (
                      <span className="inline-flex h-6 items-center rounded border border-border bg-background px-2 font-mono text-[11px] text-muted-foreground">
                        {sandboxExit}
                      </span>
                    ) : null}
                  </div>
                  <pre className="max-h-44 overflow-auto rounded-md bg-background/70 p-2 text-[11px] leading-relaxed text-foreground">
                    {sandboxResultText(sandboxResult)}
                  </pre>
                </div>
              ) : null}
            </div>

            <div className="mb-4 space-y-2">
              <div className="text-xs font-medium text-muted-foreground">Create Container</div>
              <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
                <input
                  value={containerName}
                  onChange={(event) => setContainerName(event.currentTarget.value)}
                  placeholder="name"
                  className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
                />
                <input
                  value={image}
                  onChange={(event) => setImage(event.currentTarget.value)}
                  placeholder="image"
                  className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
                />
                <Button size="sm" onClick={createContainer} disabled={!containerName.trim() || !image.trim() || Boolean(busy)} className="h-8">
                  Create
                </Button>
              </div>
            </div>

            <div className="mb-3 flex items-center justify-between">
              <div className="text-xs font-medium text-muted-foreground">Containers</div>
              <span className="text-[11px] text-muted-foreground">{containers.length}</span>
            </div>

            <div className="space-y-1">
              {containers.length === 0 ? (
                <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                  No containers
                </div>
              ) : (
                containers.map((container) => {
                  const id = container.id || container.name || "";
                  const active = selectedId === id;
                  return (
                    <div
                      key={containerKey(container)}
                      role="button"
                      tabIndex={0}
                      onClick={() => void loadLogs(id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          void loadLogs(id);
                        }
                      }}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-2 rounded-md border border-transparent px-2 py-2 text-left text-xs hover:bg-muted/70 focus:outline-none focus:ring-1 focus:ring-ring",
                        active && "border-border bg-muted",
                      )}
                    >
                      <span className={cn("h-2 w-2 rounded-full", container.state === "running" ? "bg-emerald-500" : "bg-muted-foreground/50")} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-foreground">{container.name || id}</span>
                        <span className="block truncate text-muted-foreground">{container.image}</span>
                      </span>
                      <span className="shrink-0 text-muted-foreground">{container.state || container.status}</span>
                      <button
                        type="button"
                        className="ml-1 rounded p-1 text-muted-foreground hover:bg-background hover:text-destructive"
                        onClick={(event) => {
                          event.stopPropagation();
                          void removeContainer(id);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })
              )}
            </div>

            {selectedContainer ? (
              <div className="mt-4 space-y-3">
                <div className="space-y-2">
                  <div className="text-xs font-medium text-muted-foreground">Exec</div>
                  <div className="grid grid-cols-[1fr_auto] gap-2">
                    <input
                      value={execCommand}
                      onChange={(event) => setExecCommand(event.currentTarget.value)}
                      className="h-8 min-w-0 rounded-md border border-input bg-background px-2 font-mono text-xs outline-none focus:ring-1 focus:ring-ring"
                    />
                    <Button size="sm" onClick={runExec} disabled={!execCommand.trim() || Boolean(busy)} className="h-8 gap-1.5">
                      <Zap className="h-3.5 w-3.5" />
                      Run
                    </Button>
                  </div>
                  {execResult ? (
                    <pre className="max-h-40 overflow-auto rounded-md bg-muted/50 p-2 text-[11px] leading-relaxed text-foreground">
                      {commandText(execResult)}
                    </pre>
                  ) : null}
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-medium text-muted-foreground">Logs</div>
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => void loadLogs(selectedId)} disabled={Boolean(busy)}>
                      Refresh
                    </Button>
                  </div>
                  <pre className="max-h-56 overflow-auto rounded-md bg-muted/50 p-2 text-[11px] leading-relaxed text-foreground">
                    {logs ? commandText(logs) : "No logs loaded"}
                  </pre>
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            Install CrateBay to enable sandbox containers.
          </div>
        )}
      </div>
    </div>
  );
}
