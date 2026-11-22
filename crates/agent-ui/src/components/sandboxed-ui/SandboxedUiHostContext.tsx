// What a transcript needs to render sandboxed content (MCP App views, HTML previews) for
// one conversation. Only hosts that can fetch from K-brain with the token provide it; the
// rest render the plain tool output / code instead.

import { createContext, useContext } from "react";
import type { HtmlPreviewRecord } from "../../lib/chat/htmlPreviews";
import type { McpAppToolTarget } from "../../lib/sandboxed-ui/mcpAppHost";

export type SandboxedUiTranscriptHost = {
  /** Local conversation id: the HTML preview store key. */
  conversationId: string;
  workdir?: string;
  /** Backend advertises html_previews and the user has not turned them off. */
  htmlPreviews: boolean;
  /** Backend advertises mcp_apps. */
  mcpApps: boolean;
  /** HTML (with the backend's CSP meta) of a preview `url`. */
  loadPreviewHtml: (url: string) => Promise<string>;
  /** HTML (with the backend's CSP meta) of a tool result's `ui_resource.url`. */
  loadMcpAppHtml: (url: string) => Promise<string>;
  /** Finds `toolName` on `serverId` only, with its effective policy. */
  resolveMcpTool: (serverId: string, toolName: string) => Promise<McpAppToolTarget | null>;
  callMcpTool: (
    fullName: string,
    args: Record<string, unknown>,
  ) => Promise<{ output: string; failed: boolean }>;
  /** Display name of an MCP server id, when known. */
  mcpServerLabel?: (serverId: string) => string | undefined;
  openExternal?: (url: string) => void;
  /** Shows a preview in the right dock; omitted where there is no dock. */
  openPreviewInSidePanel?: (preview: HtmlPreviewRecord) => void;
};

const SandboxedUiTranscriptHostContext = createContext<SandboxedUiTranscriptHost | null>(null);

export const SandboxedUiTranscriptHostProvider = SandboxedUiTranscriptHostContext.Provider;

export function useSandboxedUiTranscriptHost() {
  return useContext(SandboxedUiTranscriptHostContext);
}
