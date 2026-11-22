// Host side of an MCP App view (the public MCP Apps `ui/` postMessage protocol) rendered
// inline in a tool card. Same transport rules as plugin panels; the view may only call
// tools of its own server, and the host applies the server's "ask" policy itself because
// K-brain's POST /v1/mcp/tools/call only enforces "deny".

import type { SandboxedUiConfirmChoice, SessionToolGrants } from "./pluginPanelHost";
import {
  createSandboxedUiBridge,
  isPlainRecord,
  JSONRPC_INVALID_PARAMS,
  type JsonRpcNotification,
  type JsonRpcResponse,
  SANDBOXED_UI_DENIED,
  SANDBOXED_UI_LIMIT_EXCEEDED,
  SANDBOXED_UI_NOT_ALLOWED,
  type SandboxedUiBridge,
  SandboxedUiError,
} from "./protocol";
import type { SandboxedUiTheme } from "./theme";

export const MCP_APP_DEFAULT_PROTOCOL_VERSION = "2026-01-26";
export const MCP_APP_MIN_HEIGHT = 48;
export const MCP_APP_MAX_HEIGHT = 640;
/** When a view never sends ui/notifications/initialized, data still follows its initialize. */
export const MCP_APP_INITIALIZED_GRACE_MS = 300;

export type McpToolPolicy = "allow" | "ask" | "deny";

export type McpAppToolTarget = {
  /** Full K-brain name (mcp__<server>__<tool>) for POST /v1/mcp/tools/call. */
  fullName: string;
  policy: McpToolPolicy;
};

export type McpAppConfirmRequest = {
  serverId: string;
  serverLabel: string;
  toolName: string;
  args: Record<string, unknown>;
};

export type McpAppHostOptions = {
  serverId: string;
  serverLabel: string;
  /** The tool call this view belongs to: its input and text output are pushed after init. */
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput: string;
  toolFailed: boolean;
  locale: string;
  hostVersion?: string;
  getTheme: () => SandboxedUiTheme;
  resolveTool: (serverId: string, toolName: string) => Promise<McpAppToolTarget | null>;
  callTool: (
    fullName: string,
    args: Record<string, unknown>,
  ) => Promise<{ output: string; failed: boolean }>;
  confirmToolCall: (request: McpAppConfirmRequest) => Promise<SandboxedUiConfirmChoice>;
  /** Opening a link always asks first; absent means ui/open-link is not offered. */
  confirmOpenLink?: (url: string) => Promise<boolean>;
  openExternal?: (url: string) => void;
  onSizeChanged: (height: number) => void;
  post: (message: JsonRpcResponse | JsonRpcNotification) => void;
  grants?: SessionToolGrants;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export type McpAppHost = SandboxedUiBridge & {
  readonly initialized: boolean;
  themeChanged: () => void;
};

const appSessionGrants = new Set<string>();
export const MCP_APP_SESSION_GRANTS: SessionToolGrants = {
  has: (key) => appSessionGrants.has(key),
  add: (key) => {
    appSessionGrants.add(key);
  },
};

export function clampMcpAppHeight(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(Math.min(MCP_APP_MAX_HEIGHT, Math.max(MCP_APP_MIN_HEIGHT, value)));
}

function hostContext(options: McpAppHostOptions) {
  const theme = options.getTheme();
  return {
    theme: theme.mode,
    displayMode: "inline",
    availableDisplayModes: ["inline"],
    locale: options.locale,
    platform: "desktop",
    styles: {
      variables: {
        "--color-background-primary": theme.colors.background,
        "--color-text-primary": theme.colors.foreground,
        "--color-text-secondary": theme.colors.muted,
        "--color-border-primary": theme.colors.border,
        "--color-ring-primary": theme.colors.accent,
        "--font-sans": theme.fontFamily,
      },
    },
    toolInfo: { tool: { name: options.toolName } },
  };
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function createMcpAppHost(options: McpAppHostOptions): McpAppHost {
  const grants = options.grants ?? MCP_APP_SESSION_GRANTS;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as never));
  let initialized = false;
  let dataSent = false;
  let graceTimer: unknown = null;
  let confirming = false;

  // Declared before the bridge so handlers can reach it through this holder.
  const holder: { bridge: SandboxedUiBridge | null } = { bridge: null };

  const sendToolData = () => {
    if (dataSent || !holder.bridge || holder.bridge.disposed) return;
    dataSent = true;
    if (graceTimer !== null) clearTimer(graceTimer);
    graceTimer = null;
    holder.bridge.notify("ui/notifications/tool-input", { arguments: options.toolInput });
    // Only the text output: K-brain does not forward structuredContent or the raw result.
    holder.bridge.notify("ui/notifications/tool-result", {
      content: [{ type: "text", text: options.toolOutput }],
      isError: options.toolFailed,
    });
  };

  const withConfirmation = async <T>(run: () => Promise<T>) => {
    if (confirming) {
      throw new SandboxedUiError(SANDBOXED_UI_LIMIT_EXCEEDED, "A confirmation is pending");
    }
    confirming = true;
    try {
      return await run();
    } finally {
      confirming = false;
    }
  };

  const methods: Record<string, (params: unknown) => unknown> = {
    "ui/initialize": (params) => {
      initialized = true;
      const requested = isPlainRecord(params) ? params.protocolVersion : undefined;
      if (graceTimer === null && !dataSent) {
        graceTimer = setTimer(sendToolData, MCP_APP_INITIALIZED_GRACE_MS);
      }
      return {
        protocolVersion:
          typeof requested === "string" && requested.length <= 32
            ? requested
            : MCP_APP_DEFAULT_PROTOCOL_VERSION,
        hostInfo: { name: "LiveAgent", version: options.hostVersion ?? "1" },
        hostCapabilities: {
          serverTools: {},
          ...(options.confirmOpenLink && options.openExternal ? { openLinks: {} } : {}),
        },
        hostContext: hostContext(options),
      };
    },
    ping: () => ({}),
    "tools/call": async (params) => {
      if (!isPlainRecord(params) || typeof params.name !== "string" || !params.name) {
        throw new SandboxedUiError(JSONRPC_INVALID_PARAMS, "name must be a non-empty string");
      }
      if (params.arguments !== undefined && !isPlainRecord(params.arguments)) {
        throw new SandboxedUiError(JSONRPC_INVALID_PARAMS, "arguments must be an object");
      }
      const name = params.name;
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      // Same server only: the lookup is scoped to this view's server id.
      const target = await options.resolveTool(options.serverId, name);
      if (!target)
        throw new SandboxedUiError(SANDBOXED_UI_NOT_ALLOWED, `Tool not allowed: ${name}`);
      if (target.policy === "deny") {
        throw new SandboxedUiError(SANDBOXED_UI_NOT_ALLOWED, "Tool is denied by policy");
      }
      if (target.policy === "ask" && !grants.has(target.fullName)) {
        const choice = await withConfirmation(() =>
          options.confirmToolCall({
            serverId: options.serverId,
            serverLabel: options.serverLabel,
            toolName: name,
            args,
          }),
        );
        if (choice === "deny") throw new SandboxedUiError(SANDBOXED_UI_DENIED, "Denied by user");
        if (choice === "always") grants.add(target.fullName);
      }
      const result = await options.callTool(target.fullName, args);
      return { content: [{ type: "text", text: result.output }], isError: result.failed };
    },
  };
  if (options.confirmOpenLink && options.openExternal) {
    const confirmOpenLink = options.confirmOpenLink;
    const openExternal = options.openExternal;
    methods["ui/open-link"] = async (params) => {
      if (!isPlainRecord(params) || typeof params.url !== "string" || !isHttpUrl(params.url)) {
        throw new SandboxedUiError(JSONRPC_INVALID_PARAMS, "url must be an http(s) URL");
      }
      const url = params.url;
      const allowed = await withConfirmation(() => confirmOpenLink(url));
      if (!allowed) throw new SandboxedUiError(SANDBOXED_UI_DENIED, "Denied by user");
      openExternal(url);
      return {};
    };
  }

  const bridge = createSandboxedUiBridge({
    post: options.post,
    now: options.now,
    methods,
    notifications: {
      "ui/notifications/initialized": () => {
        if (initialized) sendToolData();
      },
      "ui/notifications/size-changed": (params) => {
        if (!isPlainRecord(params)) return;
        const height = clampMcpAppHeight(params.height);
        if (height !== null) options.onSizeChanged(height);
      },
    },
  });
  holder.bridge = bridge;

  return {
    receive: bridge.receive,
    notify: bridge.notify,
    dispose() {
      if (graceTimer !== null) clearTimer(graceTimer);
      graceTimer = null;
      bridge.dispose();
    },
    get disposed() {
      return bridge.disposed;
    },
    get initialized() {
      return initialized;
    },
    themeChanged() {
      if (!initialized) return;
      const context = hostContext(options);
      bridge.notify("ui/notifications/host-context-changed", {
        theme: context.theme,
        styles: context.styles,
      });
    },
  };
}
