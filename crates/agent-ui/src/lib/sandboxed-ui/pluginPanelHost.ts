// host.* methods for plugin UI panels (K-brain docs/sandboxed-ui.md, protocol "1").
// Plugin and panel identity come from the loaded panel, never from the page.

import { type PluginsHttpError, pluginPanelKey } from "../plugins/types";
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
import { resolvePathInsideWorkdir } from "./workspacePath";

export const PLUGIN_PANEL_PROTOCOL_VERSION = "1";

export const PLUGIN_PANEL_METHODS = [
  "host.initialize",
  "host.getTheme",
  "host.notify",
  "host.openFile",
  "host.callTool",
] as const;

export const HOST_NOTIFY_MAX_CHARS = 200;

export type HostNotifyLevel = "info" | "success" | "warning" | "error";

/** "always" remembers the grant for this plugin's tool until the app restarts. */
export type SandboxedUiConfirmChoice = "once" | "always" | "deny";

export type PluginToolConfirmRequest = {
  pluginId: string;
  pluginName: string;
  toolName: string;
  args: Record<string, unknown>;
};

export type PluginPanelHostOptions = {
  plugin: { id: string; name: string; version: string; tools: readonly string[] };
  panel: { id: string; placement: "sidePane" | "settings" };
  /** Session workdir; host.openFile and host.callTool are refused without one where needed. */
  workdir?: string;
  locale: string;
  getTheme: () => SandboxedUiTheme;
  notify: (message: string, level: HostNotifyLevel) => void;
  openFile: (path: string, line?: number) => void | Promise<void>;
  confirmToolCall: (request: PluginToolConfirmRequest) => Promise<SandboxedUiConfirmChoice>;
  callTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ output: string; failed: boolean }>;
  post: (message: JsonRpcResponse | JsonRpcNotification) => void;
  /**
   * The page reported it could not load (`host.panelLoadError`, sent by the backend's
   * error page under `plugin_ui_errors`). Only ever shown as an error state.
   */
  onLoadError?: (error: PluginPanelLoadError) => void;
  grants?: SessionToolGrants;
  now?: () => number;
};

export type PluginPanelLoadError = {
  /** asset_not_found, plugin_unavailable, asset_too_large, or a page's own code. */
  code: string;
  message: string;
  status?: number;
};

const LOAD_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const LOAD_ERROR_MESSAGE_MAX_CHARS = 300;

/** Validates `host.panelLoadError` params; anything malformed is dropped. */
export function parsePanelLoadError(params: unknown): PluginPanelLoadError | null {
  if (!isPlainRecord(params)) return null;
  const code = typeof params.code === "string" ? params.code.trim() : "";
  if (!LOAD_ERROR_CODE.test(code)) return null;
  const flat = typeof params.message === "string" ? params.message.replace(/\s+/g, " ").trim() : "";
  const message =
    flat.length > LOAD_ERROR_MESSAGE_MAX_CHARS
      ? `${flat.slice(0, LOAD_ERROR_MESSAGE_MAX_CHARS - 1)}…`
      : flat;
  const status =
    typeof params.status === "number" && Number.isInteger(params.status)
      ? params.status
      : undefined;
  return { code, message, ...(status !== undefined ? { status } : {}) };
}

/** Tool calls the user allowed for the rest of the app session. */
export type SessionToolGrants = {
  has: (key: string) => boolean;
  add: (key: string) => void;
};

const appSessionGrants = new Set<string>();
export const PLUGIN_TOOL_SESSION_GRANTS: SessionToolGrants = {
  has: (key) => appSessionGrants.has(key),
  add: (key) => {
    appSessionGrants.add(key);
  },
};

const NOTIFY_LEVELS = new Set<HostNotifyLevel>(["info", "success", "warning", "error"]);
const NOTIFY_WINDOW_MS = 5000;
const NOTIFY_MAX_PER_WINDOW = 3;

/**
 * Plain-text notices, cut to 200 characters; repeats of the same notice and bursts beyond
 * three per five seconds are merged away.
 */
export function createNotifyCoalescer(
  show: (message: string, level: HostNotifyLevel) => void,
  now: () => number = () => Date.now(),
) {
  const recent: Array<{ at: number; key: string }> = [];
  return (message: string, level: HostNotifyLevel) => {
    const flat = message.replace(/\s+/g, " ").trim();
    if (!flat) return;
    const text =
      flat.length > HOST_NOTIFY_MAX_CHARS ? `${flat.slice(0, HOST_NOTIFY_MAX_CHARS - 1)}…` : flat;
    const at = now();
    while (recent.length && at - recent[0].at >= NOTIFY_WINDOW_MS) recent.shift();
    const key = `${level}\u0000${text}`;
    if (recent.some((entry) => entry.key === key)) return;
    if (recent.length >= NOTIFY_MAX_PER_WINDOW) return;
    recent.push({ at, key });
    show(text, level);
  };
}

function httpStatus(error: unknown) {
  return typeof (error as PluginsHttpError | undefined)?.status === "number"
    ? (error as PluginsHttpError).status
    : undefined;
}

export type PluginPanelHost = SandboxedUiBridge & {
  readonly initialized: boolean;
  /** panel.themeChanged; only after the page initialized. */
  themeChanged: () => void;
  /** panel.visibilityChanged; only after the page initialized. */
  visibilityChanged: (visible: boolean) => void;
};

export function createPluginPanelHost(options: PluginPanelHostOptions): PluginPanelHost {
  const grants = options.grants ?? PLUGIN_TOOL_SESSION_GRANTS;
  const notify = createNotifyCoalescer(options.notify, options.now);
  const tools = new Set(options.plugin.tools);
  let initialized = false;
  // One confirmation at a time: a page cannot stack dialogs behind the one on screen.
  let confirming = false;

  const initializeResult = () => ({
    protocolVersion: PLUGIN_PANEL_PROTOCOL_VERSION,
    plugin: { id: options.plugin.id, version: options.plugin.version },
    panel: { id: options.panel.id, placement: options.panel.placement },
    theme: options.getTheme(),
    locale: options.locale,
    methods: [...PLUGIN_PANEL_METHODS],
  });

  const bridge = createSandboxedUiBridge({
    post: options.post,
    now: options.now,
    methods: {
      "host.initialize": () => {
        initialized = true;
        return initializeResult();
      },
      "host.getTheme": () => options.getTheme(),
      "host.notify": (params) => {
        if (!isPlainRecord(params) || typeof params.message !== "string") {
          throw new SandboxedUiError(JSONRPC_INVALID_PARAMS, "message must be a string");
        }
        const level =
          typeof params.level === "string" && NOTIFY_LEVELS.has(params.level as HostNotifyLevel)
            ? (params.level as HostNotifyLevel)
            : "info";
        notify(params.message, level);
        return null;
      },
      "host.openFile": async (params) => {
        if (!isPlainRecord(params) || typeof params.path !== "string" || !params.path.trim()) {
          throw new SandboxedUiError(JSONRPC_INVALID_PARAMS, "path must be a non-empty string");
        }
        const line = params.line;
        if (
          line !== undefined &&
          (typeof line !== "number" || !Number.isInteger(line) || line < 1)
        ) {
          throw new SandboxedUiError(JSONRPC_INVALID_PARAMS, "line must be a positive integer");
        }
        const resolved = options.workdir
          ? resolvePathInsideWorkdir(options.workdir, params.path)
          : null;
        if (!resolved) {
          throw new SandboxedUiError(SANDBOXED_UI_NOT_ALLOWED, "Path is outside the workdir");
        }
        await options.openFile(resolved, line as number | undefined);
        return null;
      },
      "host.callTool": async (params) => {
        if (!isPlainRecord(params) || typeof params.name !== "string" || !params.name) {
          throw new SandboxedUiError(JSONRPC_INVALID_PARAMS, "name must be a non-empty string");
        }
        if (params.arguments !== undefined && !isPlainRecord(params.arguments)) {
          throw new SandboxedUiError(JSONRPC_INVALID_PARAMS, "arguments must be an object");
        }
        const name = params.name;
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        // Only this plugin's own manifest tools; never another plugin's or a built-in.
        if (!tools.has(name)) {
          throw new SandboxedUiError(SANDBOXED_UI_NOT_ALLOWED, `Tool not allowed: ${name}`);
        }
        const grantKey = pluginPanelKey(options.plugin.id, name);
        if (!grants.has(grantKey)) {
          if (confirming) {
            throw new SandboxedUiError(SANDBOXED_UI_LIMIT_EXCEEDED, "A confirmation is pending");
          }
          confirming = true;
          let choice: SandboxedUiConfirmChoice;
          try {
            choice = await options.confirmToolCall({
              pluginId: options.plugin.id,
              pluginName: options.plugin.name,
              toolName: name,
              args,
            });
          } finally {
            confirming = false;
          }
          if (choice === "deny") throw new SandboxedUiError(SANDBOXED_UI_DENIED, "Denied by user");
          if (choice === "always") grants.add(grantKey);
        }
        try {
          const result = await options.callTool(name, args);
          return { output: result.output, failed: result.failed };
        } catch (error) {
          if (httpStatus(error) === 404) {
            throw new SandboxedUiError(SANDBOXED_UI_NOT_ALLOWED, "Tool is not available");
          }
          throw error;
        }
      },
    },
    notifications: {
      "host.panelLoadError": (params) => {
        const error = parsePanelLoadError(params);
        if (error) options.onLoadError?.(error);
      },
    },
  });

  return {
    receive: bridge.receive,
    notify: bridge.notify,
    dispose: bridge.dispose,
    get disposed() {
      return bridge.disposed;
    },
    get initialized() {
      return initialized;
    },
    themeChanged() {
      if (initialized) bridge.notify("panel.themeChanged", options.getTheme());
    },
    visibilityChanged(visible) {
      if (initialized) bridge.notify("panel.visibilityChanged", { visible });
    },
  };
}
