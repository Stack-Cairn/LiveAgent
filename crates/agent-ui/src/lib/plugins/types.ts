// K-brain plugins (capabilities `plugins` and `plugin_ui`): wire types, a tolerant parser
// for GET /v1/plugins and the host client both apps implement (only the desktop talks to
// K-brain directly; hosts without one leave the client unset and the UI stays hidden).

export const KBRAIN_PLUGINS_CAPABILITY = "plugins";
export const KBRAIN_PLUGIN_UI_CAPABILITY = "plugin_ui";
export const KBRAIN_MCP_APPS_CAPABILITY = "mcp_apps";
export const KBRAIN_HTML_PREVIEWS_CAPABILITY = "html_previews";
export const KBRAIN_PLUGIN_TOOL_NAMES_CAPABILITY = "plugin_tool_names";
export const KBRAIN_PLUGIN_UI_ERRORS_CAPABILITY = "plugin_ui_errors";
export const KBRAIN_PLUGIN_MANIFEST_UNKNOWN_FIELDS_CAPABILITY = "plugin_manifest_unknown_fields";

export type PluginUiPlacement = "sidePane" | "settings";

export type PluginUiPanel = {
  id: string;
  title: string;
  placement: PluginUiPlacement;
  entry: string;
  /** Backend path of the entry page; present only while the plugin is enabled. */
  url?: string;
  /**
   * Why the entry page cannot load (`plugin_ui_errors`): ui_root_missing, entry_missing,
   * entry_not_file or entry_too_large, with a human-readable `error`.
   */
  errorCode?: string;
  error?: string;
};

/** One tool of a plugin (`plugin_tool_names`): manifest name and the name the model sees. */
type PluginToolDetail = {
  name: string;
  modelName: string;
  description: string;
};

export type PluginContributes = {
  tools: string[];
  /** Present on backends with `plugin_tool_names`, in the order of `tools`. */
  toolDetails?: PluginToolDetail[];
  hooks: string[];
  prompt: boolean;
  ui: PluginUiPanel[];
};

/**
 * The plugin's own tool names as plugin.json declares them; a panel's `host.callTool` and
 * `POST /v1/plugins/{id}/tools/call` take them. Newer backends list them in
 * `contributes.toolDetails`; older ones only give the model names (`plugin_<id>_<tool>`)
 * in `contributes.tools`, so the prefix is stripped there.
 */
export function pluginManifestToolNames(plugin: { id: string; contributes: PluginContributes }) {
  if (plugin.contributes.toolDetails) {
    return plugin.contributes.toolDetails.map((detail) => detail.name);
  }
  const prefix = `plugin_${plugin.id}_`;
  return plugin.contributes.tools.map((name) =>
    name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : name,
  );
}

export type PluginSource = "user" | "workspace";

export type PluginInfo = {
  id: string;
  name: string;
  version: string;
  description: string;
  source: PluginSource;
  enabled: boolean;
  path: string;
  contributes: PluginContributes;
};

export type PluginList = {
  workdir: string;
  /** Whether the workdir's folder is trusted; workspace plugins load only then. */
  trusted: boolean;
  revision: number;
  plugins: PluginInfo[];
  errors: string[];
};

export type PluginToolCallResult = {
  output: string;
  failed: boolean;
  /** The manifest name the backend ran (`plugin_tool_names`). */
  toolName?: string;
};

/** HTTP failure of a plugin route; `status` drives the user-facing explanation. */
export class PluginsHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PluginsHttpError";
    this.status = status;
  }
}

export type PluginListRequest = {
  workdir?: string;
  /** Long-poll: wait until the revision differs from `since` (or `wait` seconds pass). */
  since?: number;
  wait?: number;
  signal?: AbortSignal;
};

export type PluginsClient = {
  list: (request?: PluginListRequest) => Promise<PluginList>;
  setEnabled: (id: string, enabled: boolean, workdir?: string) => Promise<PluginList>;
  install: (path: string, workdir?: string) => Promise<PluginList>;
  remove: (id: string, workdir?: string) => Promise<PluginList>;
  reload: (workdir?: string) => Promise<PluginList>;
  callTool: (
    pluginId: string,
    name: string,
    args: Record<string, unknown>,
    workdir?: string,
  ) => Promise<PluginToolCallResult>;
  /** Absolute iframe src for a panel `url` (backend base URL + path). */
  resolvePanelUrl: (url: string) => string;
};

function readString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parsePanel(value: unknown): PluginUiPanel | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  const placement = value.placement;
  if (!id || (placement !== "sidePane" && placement !== "settings")) return null;
  const url = readString(value.url);
  const errorCode = readString(value.errorCode).trim();
  return {
    id,
    title: readString(value.title, id) || id,
    placement,
    entry: readString(value.entry),
    // Only backend paths: a panel can never point the frame at another host.
    ...(url.startsWith("/v1/") ? { url } : {}),
    ...(errorCode ? { errorCode, error: readString(value.error).trim() } : {}),
  };
}

function parseToolDetails(value: unknown): PluginToolDetail[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const details: PluginToolDetail[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const name = readString(item.name);
    if (!name) continue;
    details.push({
      name,
      modelName: readString(item.modelName) || name,
      description: readString(item.description),
    });
  }
  return details;
}

function parsePlugin(value: unknown): PluginInfo | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  if (!id) return null;
  const contributes = isRecord(value.contributes) ? value.contributes : {};
  const toolDetails = parseToolDetails(contributes.toolDetails);
  return {
    id,
    name: readString(value.name, id) || id,
    version: readString(value.version),
    description: readString(value.description),
    source: value.source === "workspace" ? "workspace" : "user",
    enabled: value.enabled === true,
    path: readString(value.path),
    contributes: {
      tools: readStringArray(contributes.tools),
      ...(toolDetails ? { toolDetails } : {}),
      hooks: readStringArray(contributes.hooks),
      prompt: contributes.prompt === true,
      ui: Array.isArray(contributes.ui)
        ? contributes.ui.map(parsePanel).filter((panel): panel is PluginUiPanel => panel !== null)
        : [],
    },
  };
}

export function parsePluginList(value: unknown): PluginList | null {
  if (!isRecord(value) || !Array.isArray(value.plugins)) return null;
  const revision =
    typeof value.revision === "number" && Number.isFinite(value.revision) ? value.revision : 0;
  return {
    workdir: readString(value.workdir),
    trusted: value.trusted === true,
    revision,
    plugins: value.plugins
      .map(parsePlugin)
      .filter((plugin): plugin is PluginInfo => plugin !== null),
    errors: readStringArray(value.errors),
  };
}

/** Panels a placement can render now: enabled plugins only (they carry a url). */
export function listPluginPanels(list: PluginList | null, placement: PluginUiPlacement) {
  const panels: Array<{ plugin: PluginInfo; panel: PluginUiPanel & { url: string } }> = [];
  for (const plugin of list?.plugins ?? []) {
    if (!plugin.enabled) continue;
    for (const panel of plugin.contributes.ui) {
      if (panel.placement === placement && panel.url) {
        panels.push({ plugin, panel: panel as PluginUiPanel & { url: string } });
      }
    }
  }
  return panels;
}

/** Stable key of one panel across list refreshes (its url may change). */
export function pluginPanelKey(pluginId: string, panelId: string) {
  return `${pluginId}\u0000${panelId}`;
}
