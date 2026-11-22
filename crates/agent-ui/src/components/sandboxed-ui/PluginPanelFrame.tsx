// One plugin UI panel: the sandboxed frame plus the host.* bridge (docs/sandboxed-ui.md).

import { toast } from "@liveagent/ui/components/ui/toast-manager";
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
} from "@liveagent/ui/lib/sandboxed-ui/pluginPanelHost";
import { readSandboxedUiTheme } from "@liveagent/ui/lib/sandboxed-ui/theme";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useCallback, useEffect, useRef } from "react";
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

export function PluginPanelFrame(props: PluginPanelFrameProps) {
  const { client, plugin, panel, workdir, visible, className, onOpenFile, onStale } = props;
  const locale = useSandboxedUiLocale();
  const themeMode = useDocumentThemeMode();
  const { confirmTool, dialog } = useSandboxedConfirm();
  const hostRef = useRef<PluginPanelHost | null>(null);
  const staleReportedRef = useRef(false);
  const latest = useRef({ confirmTool, onOpenFile, visible });
  latest.current = { confirmTool, onOpenFile, visible };

  const src = client.resolvePanelUrl(panel.url);
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
        post,
      });
      hostRef.current = host;
      return host;
    },
    [
      client,
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
      if (hostRef.current?.initialized || staleReportedRef.current) return;
      staleReportedRef.current = true;
      onStale();
    }, PANEL_INIT_TIMEOUT_MS);
  }, [onStale]);

  return (
    <>
      <SandboxedFrame
        key={src}
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
