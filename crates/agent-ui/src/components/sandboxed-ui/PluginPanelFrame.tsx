// One plugin UI panel: the sandboxed frame plus the host.* bridge (docs/sandboxed-ui.md).

import "@liveagent/ui/i18n/namespaces/projectTools";
import { AlertTriangle, RefreshCw } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { EmptyState } from "@liveagent/ui/components/ui/empty-state";
import { toast } from "@liveagent/ui/components/ui/toast-manager";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  type PluginInfo,
  type PluginsClient,
  type PluginUiPanel,
  pluginManifestToolNames,
} from "@liveagent/ui/lib/plugins/types";
import {
  createPluginPanelHost,
  type HostNotifyLevel,
  type PluginPanelHost,
  type PluginPanelLoadError,
} from "@liveagent/ui/lib/sandboxed-ui/pluginPanelHost";
import { readSandboxedUiTheme } from "@liveagent/ui/lib/sandboxed-ui/theme";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  SandboxedFrame,
  type SandboxedFramePost,
  useDocumentThemeMode,
  useSandboxedUiLocale,
} from "./SandboxedFrame";
import { useSandboxedConfirm } from "./useSandboxedConfirm";

/** A page that never initializes this long after loading is treated as a dead URL once. */
const PANEL_INIT_TIMEOUT_MS = 5000;

function showNotice(message: string, level: HostNotifyLevel) {
  if (level === "error") toast.error(message);
  else if (level === "warning") toast.warning(message);
  else toast.success(message);
}

export type PluginPanelFrameProps = {
  client: PluginsClient;
  plugin: PluginInfo;
  panel: PluginUiPanel & { url: string };
  workdir?: string;
  visible: boolean;
  className?: string;
  onOpenFile?: (path: string, line?: number) => void;
  /** The capability URL may have expired (backend restart): re-read the plugin list. */
  onStale?: () => void;
};

const MISSING_CODES = new Set([
  "ui_root_missing",
  "entry_missing",
  "entry_not_file",
  "asset_not_found",
]);
const TOO_LARGE_CODES = new Set(["entry_too_large", "asset_too_large"]);

function panelErrorKey(code: string) {
  if (MISSING_CODES.has(code)) return "sandboxedUi.panelError.missing";
  if (TOO_LARGE_CODES.has(code)) return "sandboxedUi.panelError.tooLarge";
  if (code === "plugin_unavailable") return "sandboxedUi.panelError.unavailable";
  return "sandboxedUi.panelError.generic";
}

/** A panel that cannot load: what went wrong instead of a blank frame. */
function PluginPanelError(props: {
  code: string;
  message?: string;
  className?: string;
  onRetry?: () => void;
}) {
  const { t } = useLocale();
  return (
    <EmptyState
      className={cn("min-h-0 flex-1 gap-2 px-6 py-8", props.className)}
      data-plugin-panel-error={props.code}
      role="alert"
    >
      <AlertTriangle className="size-5 text-destructive" />
      <p className="font-medium text-foreground">{t("sandboxedUi.panelError.title")}</p>
      <p className="max-w-sm text-xs text-muted-foreground">{t(panelErrorKey(props.code))}</p>
      {props.message ? (
        <p className="max-w-sm break-words text-xs text-muted-foreground/75">{props.message}</p>
      ) : null}
      <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-tiny text-muted-foreground">
        {props.code}
      </code>
      {props.onRetry ? (
        <Button type="button" variant="outline" size="sm" className="mt-1" onClick={props.onRetry}>
          <RefreshCw className="size-3.5" />
          {t("sandboxedUi.reload")}
        </Button>
      ) : null}
    </EmptyState>
  );
}

export function PluginPanelFrame(props: PluginPanelFrameProps) {
  // Panels the backend already knows are broken (`plugin_ui_errors`) never get a frame.
  if (props.panel.errorCode) {
    return (
      <PluginPanelError
        code={props.panel.errorCode}
        message={props.panel.error}
        className={props.className}
        onRetry={props.onStale}
      />
    );
  }
  return <PluginPanelFrameBody {...props} />;
}

function PluginPanelFrameBody(props: PluginPanelFrameProps) {
  const { client, plugin, panel, workdir, visible, className, onOpenFile, onStale } = props;
  const locale = useSandboxedUiLocale();
  const themeMode = useDocumentThemeMode();
  const { confirmTool, dialog } = useSandboxedConfirm();
  const hostRef = useRef<PluginPanelHost | null>(null);
  const staleReportedRef = useRef(false);
  const [loadError, setLoadError] = useState<PluginPanelLoadError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // plugin_unavailable refetches the list and reloads once before it shows an error.
  const unavailableRetriedRef = useRef(false);
  const loadErrorRef = useRef(false);
  const latest = useRef({ confirmTool, onOpenFile, visible, onStale });
  latest.current = { confirmTool, onOpenFile, visible, onStale };

  const src = client.resolvePanelUrl(panel.url);

  // A fresh url (after a list refresh) gets a clean slate.
  // biome-ignore lint/correctness/useExhaustiveDependencies: src is the trigger.
  useEffect(() => {
    loadErrorRef.current = false;
    setLoadError(null);
  }, [src]);

  const handleLoadError = useCallback((error: PluginPanelLoadError) => {
    if (loadErrorRef.current) return;
    if (error.code === "plugin_unavailable" && !unavailableRetriedRef.current) {
      unavailableRetriedRef.current = true;
      latest.current.onStale?.();
      setReloadKey((key) => key + 1);
      return;
    }
    loadErrorRef.current = true;
    setLoadError(error);
  }, []);

  const retry = useCallback(() => {
    unavailableRetriedRef.current = false;
    staleReportedRef.current = false;
    loadErrorRef.current = false;
    setLoadError(null);
    latest.current.onStale?.();
    setReloadKey((key) => key + 1);
  }, []);
  const tools = pluginManifestToolNames(plugin);
  const toolsKey = tools.join("\u0000");

  // biome-ignore lint/correctness/useExhaustiveDependencies: toolsKey stands in for the tools array.
  const createBridge = useCallback(
    (post: SandboxedFramePost) => {
      const host = createPluginPanelHost({
        plugin: { id: plugin.id, name: plugin.name, version: plugin.version, tools },
        panel: { id: panel.id, placement: panel.placement },
        workdir,
        locale,
        getTheme: () => readSandboxedUiTheme(),
        notify: showNotice,
        openFile: (path, line) => {
          const open = latest.current.onOpenFile;
          if (!open) throw new Error("Opening files is not available here");
          open(path, line);
        },
        confirmToolCall: (request) =>
          latest.current.confirmTool({
            source: request.pluginName,
            toolName: request.toolName,
            args: request.args,
            kind: "plugin",
          }),
        callTool: (name, args) => client.callTool(plugin.id, name, args, workdir),
        onLoadError: handleLoadError,
        post,
      });
      hostRef.current = host;
      return host;
    },
    [
      client,
      handleLoadError,
      locale,
      panel.id,
      panel.placement,
      plugin.id,
      plugin.name,
      plugin.version,
      toolsKey,
      workdir,
    ],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-announce the theme whenever the mode changes.
  useEffect(() => {
    hostRef.current?.themeChanged();
  }, [themeMode]);

  useEffect(() => {
    hostRef.current?.visibilityChanged(visible);
  }, [visible]);

  const staleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (staleTimerRef.current) clearTimeout(staleTimerRef.current);
    },
    [],
  );
  const handleLoad = useCallback(() => {
    if (staleReportedRef.current || !onStale) return;
    if (staleTimerRef.current) clearTimeout(staleTimerRef.current);
    staleTimerRef.current = setTimeout(() => {
      staleTimerRef.current = null;
      if (hostRef.current?.initialized || staleReportedRef.current || loadErrorRef.current) return;
      staleReportedRef.current = true;
      onStale();
    }, PANEL_INIT_TIMEOUT_MS);
  }, [onStale]);

  if (loadError) {
    return (
      <>
        <PluginPanelError
          code={loadError.code}
          message={loadError.message}
          className={className}
          onRetry={retry}
        />
        {dialog}
      </>
    );
  }

  return (
    <>
      <SandboxedFrame
        key={`${src}\u0000${reloadKey}`}
        title={`${plugin.name} · ${panel.title}`}
        src={src}
        className={cn("h-full min-h-0 flex-1", className)}
        createBridge={createBridge}
        onLoad={handleLoad}
      />
      {dialog}
    </>
  );
}
