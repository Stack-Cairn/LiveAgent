/**
 * Diagnostics bundle assembly.
 *
 * The bundle is built from an allowlist: each file states exactly which fields
 * it carries, and everything still passes through `redactJson`/`redactText`
 * as a second line of defence. Nothing here reads conversations, prompts,
 * agent templates, SSH host credentials or file contents.
 */
import type { KBrainHealth } from "../kbrain/health";
import type { AppSettings } from "../settings/types";
import {
  emptyRedactionCounts,
  mergeRedactionCounts,
  type RedactionCounts,
  redactJson,
  redactText,
  totalRedactions,
  urlOrigin,
  urlWithoutSecrets,
} from "./redact";

export type DiagnosticsHost = "desktop" | "webui" | "browser";

export type DiagnosticsLogEntry = {
  at: number;
  level: "error" | "warn" | "info";
  source: string;
  message: string;
  /**
   * What the in-memory capture already removed from this entry. Entries are
   * scrubbed when recorded, so the bundle adds these to its tally; the field
   * itself is never written to the bundle.
   */
  redactions?: RedactionCounts;
};

export type DiagnosticsLogFile = {
  /** File name inside `logs/`, e.g. `k-brain.log`. */
  name: string;
  content: string;
  /** True when only the tail of a longer file is included. */
  truncated: boolean;
  /** Size of the file on disk before trimming. */
  originalBytes: number;
};

export type DiagnosticsConnection = {
  state: "connected" | "unreachable" | "unknown";
  endpoint?: string;
  latencyMs?: number;
  error?: string;
};

export type DiagnosticsInput = {
  generatedAt: Date;
  host: DiagnosticsHost;
  app: {
    version: string;
    build?: string;
    channel?: string;
    os?: string;
    osVersion?: string;
    arch?: string;
    userAgent?: string;
    locale?: string;
  };
  kbrain: {
    health: KBrainHealth | null;
    healthError?: string;
    connection: DiagnosticsConnection;
  };
  settings: AppSettings | null;
  sessionCount?: number | null;
  recentErrors: readonly DiagnosticsLogEntry[];
  appLog: readonly DiagnosticsLogEntry[];
  logFiles: readonly DiagnosticsLogFile[];
  /** Home directories to fold to `~`; generic home patterns are always folded. */
  homeDirs: readonly string[];
  dataRoot?: string;
};

export type DiagnosticsFile = {
  path: string;
  content: string;
  bytes: number;
};

export type DiagnosticsBundle = {
  fileName: string;
  files: DiagnosticsFile[];
  redactions: RedactionCounts;
  summary: string;
};

/** Upper bound of log text in one bundle (all log files together). */
export const DIAGNOSTICS_LOG_BUDGET_BYTES = 4 * 1024 * 1024;
export const DIAGNOSTICS_MAX_LOG_ENTRIES = 400;
const MAX_ENTRY_CHARS = 2000;

const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** Keeps the last `maxBytes` of text, cut at a line boundary when possible. */
export function tailText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let tail = new TextDecoder().decode(bytes.subarray(bytes.length - maxBytes));
  // Drop a split UTF-8 sequence and the partial first line.
  tail = tail.replace(/^�+/, "");
  const newline = tail.indexOf("\n");
  if (newline >= 0 && newline < tail.length - 1) tail = tail.slice(newline + 1);
  return { text: tail, truncated: true };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function diagnosticsFileName(at: Date): string {
  const stamp = `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}-${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`;
  return `liveagent-diagnostics-${stamp}.zip`;
}

function providerSummary(settings: AppSettings) {
  return settings.customProviders.map((provider) => ({
    id: provider.id,
    name: provider.name,
    type: provider.type,
    endpoint: urlWithoutSecrets(provider.baseUrl),
    modelsEndpoint: provider.modelsUrl ? urlWithoutSecrets(provider.modelsUrl) : undefined,
    isFullUrl: provider.isFullUrl,
    requestFormat: provider.requestFormat,
    apiKeyConfigured: Boolean(provider.apiKeyConfigured || provider.apiKey),
    customHeaderNames: (provider.customHeaders ?? []).map((header) => header.key),
    useSystemProxy: provider.useSystemProxy,
    models: provider.models.map((model) => model.id),
    activeModels: [...provider.activeModels],
    usageQueryEnabled: provider.usageQuery?.enabled ?? false,
  }));
}

function mcpSummary(settings: AppSettings) {
  return settings.mcp.servers
    .filter((server) => server.enabled)
    .map((server) => ({
      id: server.id,
      transport: server.transport,
      // stdio: the program name only; arguments, cwd and env may carry secrets.
      command:
        server.transport === "stdio"
          ? (server.command.trim().split(/\s+/)[0]?.split(/[\\/]/).pop() ?? "")
          : undefined,
      endpoint: server.transport === "stdio" ? undefined : urlOrigin(server.url),
      authType: server.auth?.type ?? "none",
      headerNames: Object.keys(server.headers ?? {}),
      envNames: Object.keys(server.env ?? {}),
      timeoutMs: server.timeoutMs,
      selected: settings.mcp.selected.includes(server.id),
    }));
}

function settingsSnapshot(settings: AppSettings) {
  const { system, customSettings } = settings;
  return {
    theme: settings.theme,
    locale: settings.locale,
    closeWindowBehavior: settings.closeWindowBehavior,
    selectedModel: settings.selectedModel
      ? { providerId: settings.selectedModel.customProviderId, model: settings.selectedModel.model }
      : null,
    system: {
      executionMode: system.executionMode,
      commandSafetyMode: system.commandSafetyMode,
      browserAutomationMode: system.browserAutomationMode,
      defaultTimeZone: system.defaultTimeZone,
      toolPolicyOverrides: Object.keys(system.toolPolicies ?? {}).length,
      cuaAllowSelfTargeting: system.cuaAllowSelfTargeting ?? false,
    },
    ui: {
      runNotifications: customSettings.runNotifications,
      runCompletionSound: customSettings.runCompletionSound,
      promptClarifyEnabled: customSettings.promptClarifyEnabled,
      composerContextDisplay: customSettings.composerContextDisplay,
      fontScale: customSettings.fontScale,
      customFonts: Boolean(
        customSettings.interfaceFontFamily ||
          customSettings.chatFontFamily ||
          customSettings.codeFontFamily,
      ),
    },
    remote: {
      enabled: settings.remote.enabled,
      managedLocal: settings.remote.managedLocal,
      autoReconnect: settings.remote.autoReconnect,
      gatewayConfigured: Boolean(settings.remote.gatewayUrl),
      webTerminal: settings.remote.enableWebTerminal,
      webSshTerminal: settings.remote.enableWebSshTerminal,
      webGit: settings.remote.enableWebGit,
      webTunnels: settings.remote.enableWebTunnels,
    },
    speechToText: { enabled: settings.stt.enabled, provider: settings.stt.provider ?? null },
    updates: { includePrereleases: settings.updates.includePrereleases },
    failover: Object.fromEntries(
      Object.entries(settings.modelFailover).map(([vendor, value]) => [
        vendor,
        { enabled: value.enabled, queueLength: value.queue.length },
      ]),
    ),
    chatRuntime: {
      thinkingEnabled: settings.chatRuntimeControls.thinkingEnabled,
      nativeWebSearchEnabled: settings.chatRuntimeControls.nativeWebSearchEnabled,
      planModeEnabled: settings.chatRuntimeControls.planModeEnabled,
      reasoning: settings.chatRuntimeControls.reasoning,
    },
    counts: {
      providers: settings.customProviders.length,
      mcpServers: settings.mcp.servers.length,
      promptTemplates: settings.agents.length,
      sshHosts: settings.ssh.hosts.length,
    },
  };
}

function workspaceSummary(settings: AppSettings, sessionCount: number | null | undefined) {
  const projects = settings.system.workspaceProjects;
  const byKind: Record<string, number> = {};
  for (const project of projects) byKind[project.kind] = (byKind[project.kind] ?? 0) + 1;
  return {
    workspaces: projects.length,
    byKind,
    groups: settings.system.workspaceProjectGroups.length,
    archived: settings.system.archivedWorkspaceProjectPaths.length,
    missing: settings.system.missingWorkspaceProjectPaths.length,
    sessions: sessionCount ?? null,
  };
}

/** Drops the capture-side tally from an entry and adds it to the bundle tally. */
function exportEntry(entry: DiagnosticsLogEntry, counts: RedactionCounts) {
  const { redactions, ...rest } = entry;
  if (redactions) mergeRedactionCounts(counts, redactions);
  return rest;
}

function formatEntries(entries: readonly DiagnosticsLogEntry[], limit: number): string {
  return entries
    .slice(-limit)
    .map((entry) => {
      const message =
        entry.message.length > MAX_ENTRY_CHARS
          ? `${entry.message.slice(0, MAX_ENTRY_CHARS)}…`
          : entry.message;
      return `${new Date(entry.at).toISOString()} ${entry.level.toUpperCase().padEnd(5)} [${entry.source}] ${message}`;
    })
    .join("\n");
}

function healthSnapshot(health: KBrainHealth | null, error?: string) {
  if (!health) return { available: false, error: error ?? null };
  return {
    available: true,
    legacy: health.legacy,
    protocol: health.protocol,
    build: health.build,
    startupContract: health.startupContract,
    instanceId: health.instanceId,
    capabilityRevision: health.capabilityRevision,
    capabilities: health.capabilities,
  };
}

function healthVersion(health: KBrainHealth | null): string {
  if (!health) return "unavailable";
  if (health.build?.version) {
    const channel = health.build.channel ? ` (${health.build.channel})` : "";
    return `${health.build.version}${channel}`;
  }
  return health.legacy ? "legacy" : "unknown";
}

function buildSummary(
  input: DiagnosticsInput,
  redactions: RedactionCounts,
  fileCount: number,
): string {
  const settings = input.settings;
  const lines = [
    "LiveAgent diagnostics summary",
    `Generated: ${input.generatedAt.toISOString()}`,
    `App: ${input.app.version}${input.app.build ? ` build ${input.app.build}` : ""}${input.app.channel ? ` (${input.app.channel})` : ""} [${input.host}]`,
    `OS: ${[input.app.os, input.app.osVersion, input.app.arch].filter(Boolean).join(" ") || "unknown"}`,
    `K-brain: ${healthVersion(input.kbrain.health)}`,
    `Protocol: ${input.kbrain.health ? `${input.kbrain.health.protocol.name} ${input.kbrain.health.protocol.major}.${input.kbrain.health.protocol.minor}` : "unknown"}`,
    `Capabilities: ${input.kbrain.health ? Object.keys(input.kbrain.health.capabilities).length : 0}`,
    `Backend: ${input.kbrain.connection.state}${input.kbrain.connection.latencyMs != null ? ` (${Math.round(input.kbrain.connection.latencyMs)} ms)` : ""}${input.kbrain.connection.error ? ` - ${input.kbrain.connection.error}` : ""}`,
  ];
  if (settings) {
    const providers = settings.customProviders
      .map((provider) => `${provider.type}:${provider.models.length}`)
      .join(", ");
    lines.push(
      `Providers: ${settings.customProviders.length}${providers ? ` (${providers})` : ""}`,
      `Default model: ${settings.selectedModel ? "set" : "not set"}`,
      `MCP servers enabled: ${settings.mcp.servers.filter((server) => server.enabled).length}/${settings.mcp.servers.length}`,
      `Workspaces: ${settings.system.workspaceProjects.length}`,
      `Safety mode: ${settings.system.commandSafetyMode}`,
    );
  }
  if (input.sessionCount != null) lines.push(`Sessions: ${input.sessionCount}`);
  lines.push(`Recent errors: ${input.recentErrors.length}`);
  const latest = input.recentErrors.slice(-3);
  for (const entry of latest) {
    lines.push(
      `  - ${new Date(entry.at).toISOString()} [${entry.source}] ${entry.message.slice(0, 200)}`,
    );
  }
  lines.push(`Bundle files: ${fileCount}`, `Redactions: ${totalRedactions(redactions)}`);
  return lines.join("\n");
}

/** Assembles the redacted file list, the redaction tally and a plain-text summary. */
export function buildDiagnosticsBundle(input: DiagnosticsInput): DiagnosticsBundle {
  const redactions = emptyRedactionCounts();
  const options = { counts: redactions, homeDirs: input.homeDirs };
  const files: DiagnosticsFile[] = [];
  const addText = (path: string, text: string) => {
    const content = redactText(text, options);
    files.push({ path, content, bytes: byteLength(content) });
  };
  const addJson = (path: string, value: unknown) => {
    const content = `${JSON.stringify(redactJson(value, options), null, 2)}\n`;
    files.push({ path, content, bytes: byteLength(content) });
  };

  addJson("app.json", {
    host: input.host,
    version: input.app.version,
    build: input.app.build ?? null,
    channel: input.app.channel ?? null,
    os: input.app.os ?? null,
    osVersion: input.app.osVersion ?? null,
    arch: input.app.arch ?? null,
    userAgent: input.app.userAgent ?? null,
    locale: input.app.locale ?? null,
    dataRoot: input.dataRoot ?? null,
    generatedAt: input.generatedAt.toISOString(),
  });
  addJson("kbrain/health.json", healthSnapshot(input.kbrain.health, input.kbrain.healthError));
  addJson("kbrain/connection.json", {
    ...input.kbrain.connection,
    endpoint: input.kbrain.connection.endpoint ? urlOrigin(input.kbrain.connection.endpoint) : null,
  });
  if (input.settings) {
    addJson("settings.json", settingsSnapshot(input.settings));
    addJson("providers.json", providerSummary(input.settings));
    addJson("mcp.json", {
      servers: mcpSummary(input.settings),
      skills: {
        enabled: input.settings.skills.enabled,
        selected: input.settings.skills.selected.length,
        packs: input.settings.skills.packs ?? {},
      },
    });
    addJson("workspaces.json", workspaceSummary(input.settings, input.sessionCount));
  }
  addJson(
    "errors.json",
    input.recentErrors
      .slice(-DIAGNOSTICS_MAX_LOG_ENTRIES)
      .map((entry) => exportEntry(entry, redactions)),
  );

  let remaining = DIAGNOSTICS_LOG_BUDGET_BYTES;
  const appLog = tailText(
    formatEntries(
      input.appLog
        .slice(-DIAGNOSTICS_MAX_LOG_ENTRIES)
        .map((entry) => exportEntry(entry, redactions)),
      DIAGNOSTICS_MAX_LOG_ENTRIES,
    ),
    Math.min(remaining, 512 * 1024),
  );
  if (appLog.text) {
    addText("logs/app.log", appLog.text);
    remaining -= byteLength(appLog.text);
  }
  const logIndex: Array<{
    name: string;
    includedBytes: number;
    originalBytes: number;
    truncated: boolean;
  }> = [];
  for (const file of input.logFiles) {
    if (remaining <= 0) break;
    const name = file.name.replace(/[^A-Za-z0-9._-]/g, "_");
    const tail = tailText(file.content, remaining);
    if (!tail.text) continue;
    addText(`logs/${name}`, tail.text);
    remaining -= byteLength(tail.text);
    logIndex.push({
      name,
      includedBytes: byteLength(tail.text),
      originalBytes: file.originalBytes,
      truncated: file.truncated || tail.truncated,
    });
  }
  if (logIndex.length > 0) addJson("logs/index.json", logIndex);

  // The summary is built from already-allowlisted fields and redacted again.
  const summaryCounts = emptyRedactionCounts();
  const summary = redactText(buildSummary(input, redactions, files.length + 2), {
    homeDirs: input.homeDirs,
    counts: summaryCounts,
  });
  files.unshift({ path: "summary.txt", content: `${summary}\n`, bytes: byteLength(summary) + 1 });
  const readme = [
    "LiveAgent diagnostics bundle",
    "",
    "Generated for bug reports. It contains version information, backend health,",
    "settings structure, provider endpoints and model names, enabled MCP servers,",
    "workspace counts, recent errors and bounded log tails.",
    "",
    "Not included: API keys, tokens, cookies, auth headers, passwords, SSH keys or",
    "host credentials, conversation messages, prompts and file contents.",
    "Home directories are written as ~ and emails are removed.",
    "",
  ].join("\n");
  files.unshift({ path: "README.txt", content: readme, bytes: byteLength(readme) });
  return { fileName: diagnosticsFileName(input.generatedAt), files, redactions, summary };
}

/** Writes the bundle into a zip archive (used by hosts without a native writer). */
export async function createDiagnosticsZip(
  bundle: Pick<DiagnosticsBundle, "files">,
): Promise<Uint8Array> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  for (const file of bundle.files) zip.file(file.path, file.content);
  return await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

export type ClipboardWriter = { writeText(text: string): Promise<void> };

/** Copies the redacted summary. The clipboard is injected so tests never reach a real one. */
export async function copyDiagnosticsSummary(
  bundle: Pick<DiagnosticsBundle, "summary">,
  clipboard: ClipboardWriter | undefined = globalThis.navigator?.clipboard,
): Promise<boolean> {
  if (!clipboard) return false;
  await clipboard.writeText(bundle.summary);
  return true;
}

/** Facts a host gathers about itself; settings and captured errors come from the shared app. */
export type HostDiagnosticsFacts = Pick<
  DiagnosticsInput,
  "host" | "app" | "kbrain" | "sessionCount" | "logFiles" | "homeDirs" | "dataRoot"
>;

export type DiagnosticsSaveResult =
  | { status: "saved"; location?: string }
  | { status: "cancelled" };

/** Browser download of the zip (WebUI, and the desktop UI when it runs in a plain browser). */
export async function downloadDiagnosticsZip(
  bundle: Pick<DiagnosticsBundle, "files" | "fileName">,
  doc: Document = document,
): Promise<DiagnosticsSaveResult> {
  const bytes = await createDiagnosticsZip(bundle);
  const blob = new Blob([bytes as BlobPart], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = doc.createElement("a");
    anchor.href = url;
    anchor.download = bundle.fileName;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    doc.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Give the browser a moment to start the download before the URL goes away.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
  return { status: "saved" };
}

export { requestDiagnosticsExport, subscribeDiagnosticsExportRequests } from "./exportRequests";
