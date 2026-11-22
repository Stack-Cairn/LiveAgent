// An MCP App view inline in its tool card (K-brain capability `mcp_apps`). The HTML is
// fetched with the token by the host and rendered via srcdoc in the shared sandbox; on any
// failure the card keeps its normal text output and this shows a one-line notice.

import { AppWindow, ChevronRight, RefreshCw } from "@liveagent/ui/components/IconSet";
import {
  SandboxedFrame,
  type SandboxedFramePost,
  useDocumentThemeMode,
  useSandboxedUiLocale,
} from "@liveagent/ui/components/sandboxed-ui/SandboxedFrame";
import { useSandboxedUiTranscriptHost } from "@liveagent/ui/components/sandboxed-ui/SandboxedUiHostContext";
import { useSandboxedConfirm } from "@liveagent/ui/components/sandboxed-ui/useSandboxedConfirm";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  type McpUiResource,
  mcpToolShortName,
  resolveMcpAppToolResult,
} from "@liveagent/ui/lib/chat/mcpApps";
import { createMcpAppHost, type McpAppHost } from "@liveagent/ui/lib/sandboxed-ui/mcpAppHost";
import { readSandboxedUiTheme } from "@liveagent/ui/lib/sandboxed-ui/theme";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useCallback, useEffect, useRef, useState } from "react";

const DEFAULT_VIEW_HEIGHT = 180;

type LoadState =
  | { status: "loading" }
  | { status: "ready"; html: string }
  | { status: "error"; message: string };

export type McpAppViewProps = {
  resource: McpUiResource;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput: string;
  toolFailed: boolean;
};

export function McpAppView(props: McpAppViewProps) {
  const host = useSandboxedUiTranscriptHost();
  const { t } = useLocale();
  if (!host) {
    // Hosts without direct backend access (web UI) keep the text output only.
    return (
      <div className="py-1 text-xs text-muted-foreground" data-mcp-app-view="unavailable">
        {t("sandboxedUi.mcpApp.unavailableHere")}
      </div>
    );
  }
  if (!host.mcpApps) return null;
  return <McpAppViewBody {...props} />;
}

function McpAppViewBody({
  resource,
  toolName,
  toolInput,
  toolOutput,
  toolFailed,
}: McpAppViewProps) {
  const host = useSandboxedUiTranscriptHost();
  const { t } = useLocale();
  const locale = useSandboxedUiLocale();
  const themeMode = useDocumentThemeMode();
  const { confirmTool, confirmLink, dialog } = useSandboxedConfirm();
  const [expanded, setExpanded] = useState(true);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [height, setHeight] = useState(DEFAULT_VIEW_HEIGHT);
  const [reloadKey, setReloadKey] = useState(0);
  const [approvalConflict, setApprovalConflict] = useState(false);
  const [namedLabel, setNamedLabel] = useState<string | undefined>(undefined);
  const appHostRef = useRef<McpAppHost | null>(null);
  const latest = useRef({ confirmTool, confirmLink, host });
  latest.current = { confirmTool, confirmLink, host };

  const serverLabel = namedLabel ?? resource.serverId;
  const shortName = resource.toolName || mcpToolShortName(toolName);
  const backendApproval = Boolean(host?.mcpToolCallApproval);
  const loadMcpToolResult = host?.loadMcpToolResult;
  // The raw result: inline in live events, stored behind result_url for history.
  const hasRawResult = Boolean(resource.result || (resource.resultUrl && loadMcpToolResult));

  useEffect(() => {
    const read = host?.mcpServerLabel;
    if (!read) return;
    let cancelled = false;
    read(resource.serverId).then(
      (label) => {
        if (!cancelled) setNamedLabel(label);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [host?.mcpServerLabel, resource.serverId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey forces a fresh fetch.
  useEffect(() => {
    if (!expanded || !host) return;
    let cancelled = false;
    setState({ status: "loading" });
    host.loadMcpAppHtml(resource.url).then(
      (html) => {
        if (!cancelled) setState({ status: "ready", html });
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [expanded, host?.loadMcpAppHtml, resource.url, reloadKey]);

  const createBridge = useCallback(
    (post: SandboxedFramePost) => {
      const appHost = createMcpAppHost({
        serverId: resource.serverId,
        serverLabel,
        toolName: shortName,
        toolInput,
        toolOutput,
        toolFailed,
        ...(hasRawResult
          ? {
              loadToolResult: () =>
                resolveMcpAppToolResult({
                  resource,
                  output: toolOutput,
                  failed: toolFailed,
                  fetchResult: loadMcpToolResult,
                }),
            }
          : {}),
        backendApproval,
        locale,
        getTheme: () => readSandboxedUiTheme(),
        resolveTool: (serverId, name) => {
          const current = latest.current.host;
          return current ? current.resolveMcpTool(serverId, name) : Promise.resolve(null);
        },
        callTool: (fullName, args, approvalId) => {
          const current = latest.current.host;
          if (!current) return Promise.reject(new Error("Host unavailable"));
          return current.callMcpTool(fullName, args, approvalId);
        },
        onApprovalConflict: () => setApprovalConflict(true),
        confirmToolCall: (request) =>
          latest.current.confirmTool({
            source: request.serverLabel,
            toolName: request.toolName,
            args: request.args,
            kind: "mcpApp",
          }),
        ...(host?.openExternal
          ? {
              confirmOpenLink: (url: string) => latest.current.confirmLink(url),
              openExternal: (url: string) => latest.current.host?.openExternal?.(url),
            }
          : {}),
        onSizeChanged: setHeight,
        post,
      });
      appHostRef.current = appHost;
      return appHost;
    },
    [
      backendApproval,
      hasRawResult,
      host?.openExternal,
      loadMcpToolResult,
      locale,
      resource,
      serverLabel,
      shortName,
      toolFailed,
      toolInput,
      toolOutput,
    ],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: themeMode is the trigger.
  useEffect(() => {
    appHostRef.current?.themeChanged();
  }, [themeMode]);

  return (
    <div
      className="my-1 overflow-hidden rounded-lg border border-border/60 bg-background"
      data-mcp-app-view={state.status}
      data-sandboxed-view=""
    >
      <div className="flex h-8 items-center gap-1.5 border-b border-border/50 px-2 text-xs">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-muted-foreground hover:text-foreground"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
          title={expanded ? t("sandboxedUi.collapse") : t("sandboxedUi.expand")}
        >
          <ChevronRight
            className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")}
          />
          <AppWindow className="size-3.5 shrink-0" />
          <span className="truncate font-medium text-foreground/85">{serverLabel}</span>
          <span className="truncate">· {shortName}</span>
        </button>
        {expanded ? (
          <button
            type="button"
            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            title={t("sandboxedUi.reload")}
            aria-label={t("sandboxedUi.reload")}
            onClick={() => {
              setApprovalConflict(false);
              setReloadKey((key) => key + 1);
            }}
          >
            <RefreshCw className="size-3.5" />
          </button>
        ) : null}
      </div>
      {expanded ? (
        state.status === "ready" ? (
          <SandboxedFrame
            key={reloadKey}
            title={`${serverLabel} · ${shortName}`}
            srcDoc={state.html}
            style={{ height }}
            createBridge={createBridge}
          />
        ) : state.status === "error" ? (
          <div className="px-3 py-2 text-xs text-muted-foreground" title={state.message}>
            {t("sandboxedUi.mcpApp.loadFailed")}
          </div>
        ) : (
          <div className="px-3 py-2 text-xs text-muted-foreground">{t("sandboxedUi.loading")}</div>
        )
      ) : null}
      {approvalConflict ? (
        <div
          className="border-t border-destructive/25 bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
          data-mcp-app-notice="approval-conflict"
          role="status"
        >
          {t("sandboxedUi.mcpApp.approvalConflict")}
        </div>
      ) : null}
      {dialog}
    </div>
  );
}
