// Desktop wiring of K-brain's sandboxed UI: which capabilities the connected backend
// advertises, the transcript host (MCP App views and HTML preview cards) for one
// conversation, and the clients the right dock's "Panels" tool needs.

import { openUrl } from "@liveagent/app/shims/tauriOpener";
import {
  type McpServerLabels,
  McpServerLabelsProvider,
} from "@liveagent/ui/components/chat/assistant-bubble/McpServerLabelsContext";
import type { RightDockHtmlPreviews } from "@liveagent/ui/components/project-tools/SandboxedPanelsPanel";
import {
  type SandboxedUiTranscriptHost,
  SandboxedUiTranscriptHostProvider,
} from "@liveagent/ui/components/sandboxed-ui/SandboxedUiHostContext";
import {
  type HtmlPreviewRecord,
  recordHtmlPreviews,
  requestHtmlPreviewInSidePanel,
} from "@liveagent/ui/lib/chat/htmlPreviews";
import type { PluginsClient } from "@liveagent/ui/lib/plugins/types";
import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { isKBrainBackendEnabled } from "../../../lib/host";
import { getKBrainSessionId } from "../../../lib/kbrain/mapping";
import {
  getKBrainMcpServerLabels,
  requestKBrainMcpServerLabels,
  subscribeKBrainMcpServerLabels,
} from "../../../lib/kbrain/mcpServerLabels";
import { subscribeKBrainRuntimeConnection } from "../../../lib/kbrain/runtimeConnection";
import {
  callKBrainMcpTool,
  createKBrainPluginsClient,
  type KBrainSandboxedUiCapabilities,
  listKBrainSessionPreviews,
  loadKBrainMcpToolResult,
  loadKBrainSandboxedHtml,
  NO_KBRAIN_SANDBOXED_UI_CAPABILITIES,
  readKBrainMcpServerLabel,
  readKBrainSandboxedUiCapabilities,
  resolveKBrainMcpAppTool,
  sameSandboxedUiCapabilities,
} from "../../../lib/kbrain/sandboxedUi";
import {
  isKBrainHtmlPreviewsPreferred,
  requestKBrainPanelsDock,
  subscribeKBrainHtmlPreviewsPreferred,
} from "../../../lib/kbrain/sandboxedUiPreferences";

/** The connected backend's sandboxed UI capabilities; none until known or off K-brain. */
export function useKBrainSandboxedUiCapabilities(): KBrainSandboxedUiCapabilities {
  const [capabilities, setCapabilities] = useState<KBrainSandboxedUiCapabilities>(
    NO_KBRAIN_SANDBOXED_UI_CAPABILITIES,
  );
  useEffect(() => {
    if (!isKBrainBackendEnabled()) return;
    let cancelled = false;
    const read = () => {
      void readKBrainSandboxedUiCapabilities().then((next) => {
        if (cancelled) return;
        setCapabilities((current) => (sameSandboxedUiCapabilities(current, next) ? current : next));
      });
    };
    read();
    const unsubscribe = subscribeKBrainRuntimeConnection(read);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return capabilities;
}

export function useKBrainHtmlPreviewsPreferred(): boolean {
  return useSyncExternalStore(
    subscribeKBrainHtmlPreviewsPreferred,
    isKBrainHtmlPreviewsPreferred,
    isKBrainHtmlPreviewsPreferred,
  );
}

let pluginsClient: PluginsClient | null = null;

/** The plugins client when the backend serves plugin UI panels, for the right dock. */
export function kbrainDockPluginsClient(
  capabilities: KBrainSandboxedUiCapabilities,
): PluginsClient | null {
  if (!capabilities.plugins || !capabilities.pluginUi) return null;
  pluginsClient ??= createKBrainPluginsClient();
  return pluginsClient;
}

const loadHtml = (url: string) => loadKBrainSandboxedHtml(url);

/** The current conversation's previews for the right dock, when previews are on. */
export function useKBrainDockHtmlPreviews(
  capabilities: KBrainSandboxedUiCapabilities,
  conversationId: string | null | undefined,
): RightDockHtmlPreviews | null {
  const preferred = useKBrainHtmlPreviewsPreferred();
  const id = conversationId?.trim() ?? "";
  return useMemo(
    () =>
      capabilities.htmlPreviews && preferred && id
        ? { conversationId: id, loadPreviewHtml: loadHtml }
        : null,
    [capabilities.htmlPreviews, id, preferred],
  );
}

const openExternal = (url: string) => {
  void openUrl(url);
};

/** MCP server labels for tool row headers, from the one shared desktop lookup. */
function useKBrainMcpServerLabels(): McpServerLabels {
  const labels = useSyncExternalStore(
    subscribeKBrainMcpServerLabels,
    getKBrainMcpServerLabels,
    getKBrainMcpServerLabels,
  );
  return useMemo(() => ({ labels, request: requestKBrainMcpServerLabels }), [labels]);
}

/**
 * Gives one conversation's transcript its sandboxed UI host and MCP server labels, and
 * loads the previews the session already has so cards survive a reload.
 */
export function KBrainSandboxedUiTranscriptHost(props: {
  conversationId: string;
  workdir?: string;
  children: ReactNode;
}) {
  const { conversationId, workdir, children } = props;
  const capabilities = useKBrainSandboxedUiCapabilities();
  const preferred = useKBrainHtmlPreviewsPreferred();
  const htmlPreviews = capabilities.htmlPreviews && preferred;
  const mcpApps = capabilities.mcpApps;
  const { mcpAppsStructuredContent, mcpToolCallApproval, mcpToolVisibility } = capabilities;
  const cwd = workdir?.trim() ?? "";
  const mcpServerLabels = useKBrainMcpServerLabels();

  useEffect(() => {
    if (!htmlPreviews || !conversationId) return;
    const sessionId = getKBrainSessionId(conversationId);
    if (!sessionId) return;
    let cancelled = false;
    void listKBrainSessionPreviews(sessionId).then(
      (previews) => {
        if (!cancelled && previews.length) recordHtmlPreviews(conversationId, previews);
      },
      () => {
        // The session may not exist on the backend yet; live events still arrive.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [conversationId, htmlPreviews]);

  const host = useMemo<SandboxedUiTranscriptHost | null>(() => {
    if (!htmlPreviews && !mcpApps) return null;
    return {
      conversationId,
      workdir: cwd || undefined,
      htmlPreviews,
      mcpApps,
      loadPreviewHtml: loadHtml,
      loadMcpAppHtml: loadHtml,
      mcpToolCallApproval,
      resolveMcpTool: (serverId, toolName) =>
        resolveKBrainMcpAppTool(cwd, serverId, toolName, { appAudience: mcpToolVisibility }),
      callMcpTool: (fullName, args, approvalId) =>
        callKBrainMcpTool(cwd, fullName, args, {
          appCaller: mcpToolVisibility,
          // Never sent to a backend that would reject the field.
          ...(mcpToolCallApproval && approvalId ? { approvalId } : {}),
        }),
      ...(mcpAppsStructuredContent ? { loadMcpToolResult: loadKBrainMcpToolResult } : {}),
      mcpServerLabel: (serverId) =>
        readKBrainMcpServerLabel(cwd, serverId, { appAudience: mcpToolVisibility }),
      openExternal,
      openPreviewInSidePanel: (preview: HtmlPreviewRecord) => {
        requestHtmlPreviewInSidePanel(conversationId, preview.previewId);
        requestKBrainPanelsDock();
      },
    };
  }, [
    conversationId,
    cwd,
    htmlPreviews,
    mcpApps,
    mcpAppsStructuredContent,
    mcpToolCallApproval,
    mcpToolVisibility,
  ]);

  return (
    <McpServerLabelsProvider value={mcpServerLabels}>
      {host ? (
        <SandboxedUiTranscriptHostProvider value={host}>
          {children}
        </SandboxedUiTranscriptHostProvider>
      ) : (
        children
      )}
    </McpServerLabelsProvider>
  );
}
