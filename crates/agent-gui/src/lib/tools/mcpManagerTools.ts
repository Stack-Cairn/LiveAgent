import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { SystemToolRuntimeScope } from "@liveagent/ui/lib/tools/systemToolOptions";
import { invoke } from "@tauri-apps/api/core";
import { Type } from "typebox";
import {
  type McpAuthConfig,
  type McpServerConfig,
  type McpSettings,
  type McpSettingsOp,
  normalizeMcpServerConfig,
  normalizeMcpSettings,
} from "../settings";
import {
  type BuiltinToolBundle,
  createBuiltinMetadataMap,
  type McpManagerResultDetails,
} from "./builtinTypes";
import { ToolPathResolver } from "./pathUtils";
import type { ShellSandboxSettings } from "./shellTools";

type McpManagerAction =
  | "list"
  | "read"
  | "create"
  | "update"
  | "delete"
  | "enable"
  | "disable"
  | "validate"
  | "test"
  | "diagnose"
  | "restart"
  | "stop"
  | "tools";

type McpDiagnosticToolInfo = {
  serverId: string;
  serverLabel: string;
  name: string;
  description: string;
  inputSchema?: unknown;
};

type McpRuntimeStatus = {
  serverId: string;
  running: boolean;
  initialized: boolean;
  transport: string;
  lastError?: string | null;
};

type McpRuntimeTestResponse = {
  serverId: string;
  ok: boolean;
  phase: string;
  transport: string;
  durationMs: number;
  running: boolean;
  initialized: boolean;
  toolsCount: number;
  tools: McpDiagnosticToolInfo[];
  error?: string | null;
  stderrTail?: string | null;
};

type McpStopServerResponse = {
  serverId: string;
  stopped: boolean;
};

type ValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

type McpManagerExecutionResult = {
  action: McpManagerAction;
  serverId?: string;
  serverIds?: string[];
  servers?: McpServerConfig[];
  server?: McpServerConfig;
  validation?: ValidationResult;
  runtime?: McpRuntimeStatus | null;
  test?: McpRuntimeTestResponse | null;
  tools?: McpDiagnosticToolInfo[];
  stopped?: boolean;
  changed?: boolean;
  runtimeWarnings?: string[];
  suggestions?: string[];
};

const WRITE_ACTIONS = new Set<McpManagerAction>([
  "create",
  "update",
  "delete",
  "enable",
  "disable",
]);

// Restarting or killing a pooled runtime instance affects every conversation
// sharing the process-wide runtime manager, so it is gated like a write.
const RUNTIME_MUTATING_ACTIONS = new Set<McpManagerAction>(["restart", "stop"]);

// Actions that connect to a server runtime. For `transport: "stdio"` that means
// spawning a local child process from a free-form `command`/`args` pair, i.e. a
// general-purpose process spawn primitive that the OS sandbox does not cover
// (MCP runtimes are pooled process-wide and started outside the shell funnel).
const RUNTIME_CONNECTING_ACTIONS = new Set<McpManagerAction>([
  "test",
  "tools",
  "restart",
  "diagnose",
]);

const MCP_STRING_MAP_SCHEMA = Type.Record(Type.String(), Type.String());

// OAuth 2.1 auth for http/sse servers. token/client_secret never live here —
// only the non-secret config does (type/scope/clientId); credentials are held
// by the Rust keychain store. Kept in sync with McpAuthConfig in settings/types.
const MCP_AUTH_PARAMETERS = Type.Object(
  {
    type: Type.Union([Type.Literal("none"), Type.Literal("oauth")]),
    scope: Type.Optional(
      Type.String({
        description:
          "Optional space-separated OAuth scopes overriding the server's advertised set.",
      }),
    ),
    clientId: Type.Optional(
      Type.String({
        description: "Optional static OAuth client_id; omit to use RFC 7591 dynamic registration.",
      }),
    ),
  },
  {
    description:
      "Optional OAuth 2.1 auth for http/sse servers. Authorization itself is a desktop-only user gesture; this only stores the non-secret config. No credentials are ever accepted or returned here.",
  },
);

const MCP_SERVER_PARAMETERS = Type.Object(
  {
    id: Type.Optional(Type.String()),
    description: Type.Optional(
      Type.String({ description: "Optional operator-facing description of this MCP server." }),
    ),
    docsUrl: Type.Optional(
      Type.String({ description: "Optional project or documentation URL for this MCP server." }),
    ),
    enabled: Type.Optional(Type.Boolean()),
    transport: Type.Optional(
      Type.Union([Type.Literal("stdio"), Type.Literal("http"), Type.Literal("sse")]),
    ),
    command: Type.Optional(Type.String()),
    args: Type.Optional(Type.Array(Type.String())),
    cwd: Type.Optional(
      Type.String({
        description:
          "Optional local working directory for stdio servers. Accepts workspace-relative paths exactly as returned by file tools, absolute paths, ~/..., or file:// values.",
      }),
    ),
    env: Type.Optional(MCP_STRING_MAP_SCHEMA),
    url: Type.Optional(Type.String()),
    headers: Type.Optional(MCP_STRING_MAP_SCHEMA),
    timeoutMs: Type.Optional(Type.Number({ minimum: 1 })),
    messageUrl: Type.Optional(Type.String()),
    auth: Type.Optional(MCP_AUTH_PARAMETERS),
  },
  { description: "Full MCP Server config for create/test/validate." },
);

const MCP_SERVER_PATCH_PARAMETERS = Type.Object(
  {
    description: Type.Optional(
      Type.String({ description: "Optional operator-facing description of this MCP server." }),
    ),
    docsUrl: Type.Optional(
      Type.String({ description: "Optional project or documentation URL for this MCP server." }),
    ),
    enabled: Type.Optional(Type.Boolean()),
    transport: Type.Optional(
      Type.Union([Type.Literal("stdio"), Type.Literal("http"), Type.Literal("sse")]),
    ),
    command: Type.Optional(Type.String()),
    args: Type.Optional(Type.Array(Type.String())),
    cwd: Type.Optional(
      Type.String({
        description:
          "Optional local working directory for stdio servers. Accepts workspace-relative paths exactly as returned by file tools, absolute paths, ~/..., or file:// values.",
      }),
    ),
    env: Type.Optional(MCP_STRING_MAP_SCHEMA),
    url: Type.Optional(Type.String()),
    headers: Type.Optional(MCP_STRING_MAP_SCHEMA),
    timeoutMs: Type.Optional(Type.Number({ minimum: 1 })),
    messageUrl: Type.Optional(Type.String()),
    auth: Type.Optional(MCP_AUTH_PARAMETERS),
  },
  { description: "Partial MCP Server config for update. The id field cannot be changed." },
);

const MCP_MANAGER_PARAMETERS = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("read"),
    Type.Literal("create"),
    Type.Literal("update"),
    Type.Literal("delete"),
    Type.Literal("enable"),
    Type.Literal("disable"),
    Type.Literal("validate"),
    Type.Literal("test"),
    Type.Literal("diagnose"),
    Type.Literal("restart"),
    Type.Literal("stop"),
    Type.Literal("tools"),
  ]),
  server_id: Type.Optional(Type.String({ description: "Target MCP Server id." })),
  server_ids: Type.Optional(Type.Array(Type.String(), { description: "Target MCP Server ids." })),
  server: Type.Optional(MCP_SERVER_PARAMETERS),
  patch: Type.Optional(MCP_SERVER_PATCH_PARAMETERS),
  conflict: Type.Optional(Type.Union([Type.Literal("fail"), Type.Literal("overwrite")])),
  include_disabled: Type.Optional(Type.Boolean()),
  include_tools: Type.Optional(Type.Boolean()),
  include_schema: Type.Optional(Type.Boolean()),
  include_stderr: Type.Optional(Type.Boolean()),
});

class McpManagerCancelledError extends Error {
  constructor() {
    super("Cancelled");
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new McpManagerCancelledError();
}

function asErrorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function normalizeAction(value: unknown): McpManagerAction {
  const action = typeof value === "string" ? value.trim() : "";
  switch (action) {
    case "list":
    case "read":
    case "create":
    case "update":
    case "delete":
    case "enable":
    case "disable":
    case "validate":
    case "test":
    case "diagnose":
    case "restart":
    case "stop":
    case "tools":
      return action;
    default:
      throw new Error(`McpManager.action is not supported: ${JSON.stringify(value)}`);
  }
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireServerId(value: unknown, label = "server_id") {
  const id = optionalString(value);
  if (!id) throw new Error(`McpManager.${label} is required.`);
  return id;
}

function targetServerIds(args: Record<string, unknown>) {
  const ids = new Set<string>();
  const single = optionalString(args.server_id);
  if (single) ids.add(single);
  if (Array.isArray(args.server_ids)) {
    for (const item of args.server_ids) {
      const id = optionalString(item);
      if (id) ids.add(id);
    }
  }
  if (ids.size === 0) {
    throw new Error("McpManager requires server_id or server_ids.");
  }
  return Array.from(ids);
}

function normalizeServerInput(input: unknown, label = "McpManager.server"): McpServerConfig {
  const raw = asObject(input, label);
  validateRawServerShape(raw, label);
  return normalizeMcpServerConfig({
    enabled: true,
    transport: "stdio",
    command: "",
    args: [],
    url: "",
    timeoutMs: 60_000,
    ...raw,
  });
}

function validateRawServerShape(raw: Record<string, unknown>, label: string) {
  if (Object.hasOwn(raw, "args")) {
    const value = raw.args;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new Error(`${label}.args must be a string array.`);
    }
  }
  if (Object.hasOwn(raw, "env")) {
    normalizeStringMap(raw.env, `${label}.env`);
  }
  if (Object.hasOwn(raw, "headers")) {
    normalizeStringMap(raw.headers, `${label}.headers`);
  }
  if (Object.hasOwn(raw, "auth")) {
    normalizeAuthInput(raw.auth, `${label}.auth`);
  }
}

function normalizePatch(input: unknown): Partial<McpServerConfig> {
  const raw = asObject(input, "McpManager.patch");
  if (Object.hasOwn(raw, "id")) {
    throw new Error("McpManager.update does not allow changing server id.");
  }
  const patch: Partial<McpServerConfig> = {};
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case "enabled":
        if (typeof value !== "boolean")
          throw new Error("McpManager.patch.enabled must be a boolean.");
        patch.enabled = value;
        break;
      case "transport":
        if (value !== "stdio" && value !== "http" && value !== "sse") {
          throw new Error("McpManager.patch.transport must be one of: stdio, http, sse.");
        }
        patch.transport = value;
        break;
      case "command":
      case "url":
      case "cwd":
      case "messageUrl":
      case "description":
      case "docsUrl":
        if (typeof value !== "string") throw new Error(`McpManager.patch.${key} must be a string.`);
        (patch as Record<string, unknown>)[key] =
          key === "cwd" || key === "messageUrl" || key === "description" || key === "docsUrl"
            ? value.trim() || undefined
            : value.trim();
        break;
      case "args":
        if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
          throw new Error("McpManager.patch.args must be a string array.");
        }
        patch.args = value.map((item) => item.trim()).filter(Boolean);
        break;
      case "env":
      case "headers":
        (patch as Record<string, unknown>)[key] = normalizeStringMap(
          value,
          `McpManager.patch.${key}`,
        );
        break;
      case "auth":
        patch.auth = normalizeAuthInput(value, "McpManager.patch.auth");
        break;
      case "timeoutMs": {
        const numeric = typeof value === "number" ? value : Number(value);
        if (!Number.isFinite(numeric) || numeric <= 0) {
          throw new Error("McpManager.patch.timeoutMs must be a positive number.");
        }
        patch.timeoutMs = Math.floor(numeric);
        break;
      }
      default:
        throw new Error(`McpManager.patch field is not supported: ${key}`);
    }
  }
  return patch;
}

function normalizeStringMap(value: unknown, label: string): Record<string, string> | undefined {
  if (value === null || typeof value === "undefined") return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object with string values.`);
  }
  const out: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rawValue !== "string") {
      throw new Error(`${label}.${key} must be a string.`);
    }
    const normalizedKey = key.trim();
    if (!normalizedKey) continue;
    out[normalizedKey] = rawValue.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// Mirror of normalizeMcpAuthConfig in settings: only `type:"oauth"` is stored;
// "none"/undefined collapses to no auth so the server config stays at its
// current (static-headers) behavior. Secrets never pass through here.
function normalizeAuthInput(value: unknown, label: string): McpAuthConfig | undefined {
  if (value === null || typeof value === "undefined") return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const obj = value as Record<string, unknown>;
  if (Object.hasOwn(obj, "type") && obj.type !== "none" && obj.type !== "oauth") {
    throw new Error(`${label}.type must be one of: none, oauth.`);
  }
  if (obj.type !== "oauth") return undefined;
  if (Object.hasOwn(obj, "scope") && typeof obj.scope !== "string") {
    throw new Error(`${label}.scope must be a string.`);
  }
  if (Object.hasOwn(obj, "clientId") && typeof obj.clientId !== "string") {
    throw new Error(`${label}.clientId must be a string.`);
  }
  const scope = typeof obj.scope === "string" ? obj.scope.trim() : "";
  const clientId = typeof obj.clientId === "string" ? obj.clientId.trim() : "";
  return {
    type: "oauth",
    ...(scope ? { scope } : {}),
    ...(clientId ? { clientId } : {}),
  };
}

function validateUrl(value: string, label: string, base?: string) {
  try {
    const url = base ? new URL(value, base) : new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return `${label} must use http or https.`;
    }
    return null;
  } catch {
    return `${label} must be a valid URL.`;
  }
}

function validateServer(server: McpServerConfig, existing?: McpSettings): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const id = server.id.trim();
  if (!id) errors.push("id is required.");
  if (existing) {
    const duplicates = existing.servers.filter((item) => item.id === id).length;
    if (id && duplicates > 1) errors.push(`id is duplicated: ${id}`);
  }

  if (server.timeoutMs <= 0) errors.push("timeoutMs must be greater than 0.");
  if (typeof server.cwd === "string" && server.cwd.includes("\0")) {
    errors.push("cwd must not contain NUL bytes.");
  }

  if (server.transport === "stdio") {
    if (!server.command.trim()) errors.push("transport=stdio requires command.");
    if (!Array.isArray(server.args)) errors.push("transport=stdio args must be a string array.");
  } else if (server.transport === "http") {
    if (!server.url.trim()) {
      errors.push("transport=http requires url.");
    } else {
      const error = validateUrl(server.url, "url");
      if (error) errors.push(error);
    }
  } else if (server.transport === "sse") {
    if (!server.url.trim()) {
      errors.push("transport=sse requires url.");
    } else {
      const urlError = validateUrl(server.url, "url");
      if (urlError) errors.push(urlError);
      if (server.messageUrl) {
        const messageUrlError = validateUrl(server.messageUrl, "messageUrl", server.url);
        if (messageUrlError) errors.push(messageUrlError);
      }
    }
  }

  if (!server.enabled) warnings.push("server is disabled and will not be loaded for model use.");
  return { ok: errors.length === 0, errors, warnings };
}

function findServer(settings: McpSettings, serverId: string) {
  return settings.servers.find((server) => server.id === serverId);
}

function requireExistingServer(settings: McpSettings, serverId: string) {
  const server = findServer(settings, serverId);
  if (!server) throw new Error(`MCP server does not exist: ${serverId}`);
  return server;
}

function redactMap(map: Record<string, string> | undefined) {
  if (!map || Object.keys(map).length === 0) return undefined;
  return Object.fromEntries(Object.keys(map).map((key) => [key, "<redacted>"]));
}

export function redactMcpServerConfig(server: McpServerConfig): McpServerConfig {
  return {
    ...server,
    env: redactMap(server.env),
    headers: redactMap(server.headers),
  };
}

function summarizeTool(tool: McpDiagnosticToolInfo, includeSchema: boolean): McpDiagnosticToolInfo {
  if (includeSchema) return tool;
  return {
    serverId: tool.serverId,
    serverLabel: tool.serverLabel,
    name: tool.name,
    description: tool.description,
  };
}

async function stopRuntime(serverId: string, warnings: string[]) {
  try {
    const stopped = await invoke<McpStopServerResponse>("mcp_stop_server", {
      server_id: serverId,
    });
    return stopped.stopped;
  } catch (err) {
    warnings.push(`failed to stop runtime for ${serverId}: ${asErrorMessage(err)}`);
    return false;
  }
}

async function runtimeStatus(serverId: string) {
  return invoke<McpRuntimeStatus>("mcp_runtime_status", { server_id: serverId });
}

async function runtimeTest(
  server: McpServerConfig,
  includeSchema: boolean,
  restart: boolean,
  persist: boolean,
) {
  return invoke<McpRuntimeTestResponse>(restart ? "mcp_restart_server" : "mcp_test_server", {
    server,
    include_schema: includeSchema,
    persist,
  });
}

function applyRuntimeTestOutputOptions(
  response: McpRuntimeTestResponse,
  includeStderr: boolean,
): McpRuntimeTestResponse {
  if (includeStderr) return response;
  return {
    ...response,
    stderrTail: undefined,
  };
}

function buildSuggestions(result: {
  validation?: ValidationResult;
  test?: McpRuntimeTestResponse | null;
  server?: McpServerConfig;
}) {
  const suggestions: string[] = [];
  for (const error of result.validation?.errors ?? []) {
    if (error.includes("requires command")) suggestions.push("Set command for stdio transport.");
    if (error.includes("requires url")) suggestions.push("Set a valid MCP endpoint URL.");
    if (error.includes("timeoutMs")) suggestions.push("Increase timeoutMs to a positive value.");
  }
  const message = result.test?.error ?? "";
  if (/No such file|os error 2|启动 MCP server|spawn/i.test(message)) {
    suggestions.push("Check that the stdio command exists in PATH or set cwd/env explicitly.");
  }
  if (/timed out|timeout/i.test(message)) {
    suggestions.push(
      "Increase timeoutMs or check whether the MCP server is hanging during initialize/tools/list.",
    );
  }
  if (/401|403|Unauthorized|Forbidden/i.test(message)) {
    suggestions.push("Check headers/env credentials for this MCP server.");
  }
  if (result.server?.transport === "sse" && /endpoint|Message URL/i.test(message)) {
    suggestions.push("Set messageUrl explicitly for legacy SSE transport.");
  }
  return Array.from(new Set(suggestions));
}

function formatServerLine(server: McpServerConfig) {
  const metadata = [
    server.description ? `description=${JSON.stringify(server.description)}` : null,
    server.docsUrl ? `docsUrl=${JSON.stringify(server.docsUrl)}` : null,
    server.auth?.type === "oauth" ? "auth=oauth" : null,
  ].filter(Boolean);
  const suffix = metadata.length > 0 ? ` | ${metadata.join(" | ")}` : "";
  return `- ${server.id} | transport=${server.transport} | enabled=${server.enabled ? "true" : "false"}${suffix}`;
}

function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function formatMcpManagerResult(result: McpManagerExecutionResult) {
  const lines = [`McpManager action=${result.action}`];
  if (result.serverId) lines.push(`server=${result.serverId}`);
  if (result.serverIds?.length) lines.push(`servers=${result.serverIds.join(",")}`);
  if (typeof result.changed === "boolean")
    lines.push(`changed=${result.changed ? "true" : "false"}`);
  if (typeof result.stopped === "boolean")
    lines.push(`stopped=${result.stopped ? "true" : "false"}`);
  if (result.validation) {
    lines.push(`validation=${result.validation.ok ? "ok" : "failed"}`);
    for (const error of result.validation.errors) lines.push(`- error: ${error}`);
    for (const warning of result.validation.warnings) lines.push(`- warning: ${warning}`);
  }
  if (result.runtime) {
    lines.push(
      `runtime=running:${result.runtime.running ? "true" : "false"} initialized:${result.runtime.initialized ? "true" : "false"} transport=${result.runtime.transport}`,
    );
    if (result.runtime.lastError) lines.push(`runtimeError=${result.runtime.lastError}`);
  }
  if (result.test) {
    lines.push(
      `test=${result.test.ok ? "ok" : "failed"} phase=${result.test.phase} durationMs=${result.test.durationMs}`,
    );
    lines.push(`tools=${result.test.toolsCount}`);
    if (result.test.error) lines.push(`error=${result.test.error}`);
    if (result.test.stderrTail) lines.push(result.test.stderrTail);
  }
  if (result.servers) {
    lines.push(`serversCount=${result.servers.length}`);
    for (const server of result.servers) lines.push(formatServerLine(server));
  } else if (result.server) {
    lines.push(formatServerLine(result.server));
    if (result.action === "read") {
      lines.push("serverConfig:");
      lines.push(formatJson(result.server));
    }
  }
  if (result.tools && result.tools.length > 0) {
    const hasSchema = result.tools.some((tool) => typeof tool.inputSchema !== "undefined");
    if (hasSchema) {
      lines.push("toolsJson:");
      lines.push(formatJson(result.tools));
    } else {
      lines.push("tools:");
      for (const tool of result.tools) {
        lines.push(`- ${tool.name}${tool.description ? ` | ${tool.description}` : ""}`);
      }
    }
  }
  if (result.runtimeWarnings?.length) {
    lines.push("runtimeWarnings:");
    for (const warning of result.runtimeWarnings) lines.push(`- ${warning}`);
  }
  if (result.suggestions?.length) {
    lines.push("suggestions:");
    for (const suggestion of result.suggestions) lines.push(`- ${suggestion}`);
  }
  return lines.join("\n");
}

function detailsForResult(result: McpManagerExecutionResult): McpManagerResultDetails {
  return {
    kind: "manage_mcp",
    action: result.action,
    serverId: result.serverId,
    serverIds: result.serverIds,
    transport: result.test?.transport ?? result.runtime?.transport ?? result.server?.transport,
    ok: result.test
      ? result.test.ok && (result.validation?.ok ?? true)
      : result.validation
        ? result.validation.ok
        : true,
    phase: result.test?.phase,
    serverCount: result.servers?.length,
    enabledCount: result.servers
      ? result.servers.filter((server) => server.enabled).length
      : result.server
        ? result.server.enabled
          ? 1
          : 0
        : undefined,
    toolsCount: result.test?.toolsCount ?? result.tools?.length,
    changed: result.changed,
    stopped: result.stopped,
    errors: [
      ...(result.validation?.errors ?? []),
      ...(result.test?.error ? [result.test.error] : []),
      ...(result.runtime?.lastError ? [result.runtime.lastError] : []),
    ],
  };
}

export function createMcpManagerTools(params: {
  workdir: string;
  /** Live read of the authoritative MCP settings; must never be a snapshot. */
  getMcpSettings: () => McpSettings;
  /** Id-keyed merge commit; absent means this scope cannot modify settings. */
  applyMcpOps?: (ops: McpSettingsOp[]) => void;
  runtimeScope: SystemToolRuntimeScope;
  /**
   * 本轮的 OS 沙箱设置(与 Bash / ManagedProcess 同一份契约)。启用时,本工具的
   * stdio 运行时探测一律拒绝(P1#1)。
   */
  sandbox?: ShellSandboxSettings;
  resolveHomeDir?: () => Promise<string>;
}): BuiltinToolBundle {
  const pathResolver = new ToolPathResolver({
    workdir: params.workdir,
    resolveHomeDir: params.resolveHomeDir,
  });

  async function resolveMcpCwd(cwd: string | undefined, label: string) {
    const input = typeof cwd === "string" ? cwd.trim() : "";
    if (!input) return undefined;
    const resolved = await pathResolver.resolvePath(input, {
      label,
      intent: "cwd",
      required: true,
      allowExternal: true,
    });
    return resolved.absolutePath;
  }

  async function resolveServerCwd(server: McpServerConfig, label: string) {
    const cwd = await resolveMcpCwd(server.cwd, label);
    return cwd ? { ...server, cwd } : { ...server, cwd: undefined };
  }

  async function resolvePatchCwd(patch: Partial<McpServerConfig>, label: string) {
    if (!Object.hasOwn(patch, "cwd")) return patch;
    const cwd = await resolveMcpCwd(patch.cwd, label);
    return { ...patch, cwd };
  }

  function currentSettings() {
    return normalizeMcpSettings(params.getMcpSettings());
  }

  function requireApplyOps() {
    if (!params.applyMcpOps) {
      throw new Error("McpManager cannot modify MCP settings in this runtime scope.");
    }
    return params.applyMcpOps;
  }

  /**
   * 沙箱围栏的对称性守卫(P1#1)。
   *
   * `transport: "stdio"` 的运行时探测最终走到 Rust `build_stdio_command` 的裸
   * `Command::new`,不带任何 SandboxSpec;而 `action: "test"` 允许模型传入自由格式的
   * `command`/`args`,既不写配置也不持久化 —— 等于在"选了最严格模式"的会话里留下一个
   * 与 Bash 同样通用、却完全无围栏的进程 spawn 入口(sandboxOffline 下尤其矛盾:
   * 该模式的全部意义就是内核级断网)。MCP 运行时是进程级共享池,且 http/sse 传输根本
   * 不落到 shell funnel 上,无法复用同一套沙箱包装,故在沙箱模式下一律 fail-closed 拒绝。
   *
   * create / update / enable 同样会把 stdio `command`/`args` 写入设置,下一轮
   * registry 构建(或同轮 subagent)经 `createMcpTools` → `mcp_list_tools` 自动拉起
   * 该进程,所以配置写入路径必须走同一守卫,不能只拦运行时探测。
   *
   * 非 stdio 传输不 spawn 进程,不在本守卫范围内;用户在设置界面里手动测试 MCP 服务器
   * 也不受影响(那是显式用户操作,与 hooks / 用户自建 Cron 脚本同一豁免)。
   */
  function assertRuntimeSpawnAllowed(action: McpManagerAction, server: McpServerConfig) {
    if (!params.sandbox?.enabled) return;
    if (server.transport !== "stdio") return;
    throw new Error(
      `McpManager action=${action} would spawn a local stdio process for "${server.id}" ` +
        `(command: ${server.command || "<empty>"}), but the current command mode runs model-driven ` +
        `processes inside the OS sandbox and MCP runtimes cannot be fenced. Refused. ` +
        `Use Bash for sandboxed commands; if this MCP server really needs probing, ask the user ` +
        `to switch the command mode in the composer, or to test it from Settings → MCP.`,
    );
  }

  // Write commits are deliberately synchronous: each one re-reads the live
  // settings, validates, and applies its ops without any await in between, so
  // the single-threaded JS runtime guarantees the read-modify-write is atomic
  // with respect to UI edits, gateway sync, and concurrent turns. Never make
  // these functions async, and never reuse settings read before an await.

  function commitCreate(server: McpServerConfig, conflict: "fail" | "overwrite") {
    const applyOps = requireApplyOps();
    const existed = Boolean(findServer(currentSettings(), server.id));
    if (existed && conflict === "fail") {
      throw new Error(`MCP server already exists: ${server.id}`);
    }
    applyOps([{ kind: "upsert", server }]);
    return { existed };
  }

  function commitUpdate(serverId: string, patch: Partial<McpServerConfig>) {
    const applyOps = requireApplyOps();
    const existing = requireExistingServer(currentSettings(), serverId);
    const updated = normalizeMcpServerConfig({ ...existing, ...patch, id: existing.id });
    const validation = validateServer(updated);
    if (!validation.ok) return { server: updated, validation, changed: false };
    applyOps([{ kind: "patch", serverId, patch }]);
    return { server: updated, validation, changed: true };
  }

  function commitDelete(serverId: string) {
    const applyOps = requireApplyOps();
    requireExistingServer(currentSettings(), serverId);
    applyOps([{ kind: "remove", serverId }]);
  }

  function commitSetEnabled(serverIds: string[], enabled: boolean) {
    const applyOps = requireApplyOps();
    const settings = currentSettings();
    for (const id of serverIds) requireExistingServer(settings, id);
    applyOps([{ kind: "setEnabled", serverIds, enabled }]);
  }

  // The config commit is the source of truth; runtime cleanup afterwards is
  // best effort. If the stop fails (or the call was aborted post-commit) the
  // stale pooled client is replaced on the next ensure_client config check.
  async function stopRuntimeAfterCommit(
    serverIds: string[],
    runtimeWarnings: string[],
    signal?: AbortSignal,
  ) {
    let stopped = false;
    for (const id of serverIds) {
      if (signal?.aborted) {
        runtimeWarnings.push(
          `cancelled before runtime cleanup for ${id}; the old runtime instance (if any) is replaced on next use.`,
        );
        continue;
      }
      stopped = (await stopRuntime(id, runtimeWarnings)) || stopped;
    }
    return stopped;
  }

  async function executeAction(
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpManagerExecutionResult> {
    const action = normalizeAction(args.action);
    if (
      params.runtimeScope !== "chat" &&
      (WRITE_ACTIONS.has(action) || RUNTIME_MUTATING_ACTIONS.has(action))
    ) {
      throw new Error(`McpManager action=${action} is not allowed in ${params.runtimeScope}.`);
    }

    const includeSchema = args.include_schema === true;

    if (action === "list") {
      const settings = currentSettings();
      const includeDisabled = args.include_disabled !== false;
      const servers = includeDisabled
        ? settings.servers
        : settings.servers.filter((server) => server.enabled);
      return {
        action,
        servers: servers.map(redactMcpServerConfig),
      };
    }

    if (action === "read") {
      const serverId = requireServerId(args.server_id);
      const server = requireExistingServer(currentSettings(), serverId);
      return {
        action,
        serverId,
        server: redactMcpServerConfig(server),
      };
    }

    if (action === "create") {
      const server = await resolveServerCwd(
        normalizeServerInput(args.server),
        "McpManager.server.cwd",
      );
      throwIfAborted(signal);
      const validation = validateServer(server);
      if (!validation.ok) {
        return {
          action,
          serverId: server.id,
          server: redactMcpServerConfig(server),
          validation,
          changed: false,
        };
      }

      const conflict = args.conflict === "overwrite" ? "overwrite" : "fail";
      assertRuntimeSpawnAllowed(action, server);
      const { existed } = commitCreate(server, conflict);
      const runtimeWarnings: string[] = [];
      const stopped = existed
        ? await stopRuntimeAfterCommit([server.id], runtimeWarnings, signal)
        : false;
      return {
        action,
        serverId: server.id,
        server: redactMcpServerConfig(server),
        validation,
        changed: true,
        stopped,
        runtimeWarnings,
      };
    }

    if (action === "update") {
      const serverId = requireServerId(args.server_id);
      const patch = await resolvePatchCwd(normalizePatch(args.patch), "McpManager.patch.cwd");
      throwIfAborted(signal);
      const existing = requireExistingServer(currentSettings(), serverId);
      const updatedPreview = normalizeMcpServerConfig({ ...existing, ...patch, id: existing.id });
      assertRuntimeSpawnAllowed(action, updatedPreview);
      const { server, validation, changed } = commitUpdate(serverId, patch);
      if (!changed) {
        return {
          action,
          serverId,
          server: redactMcpServerConfig(server),
          validation,
          changed,
        };
      }
      const runtimeWarnings: string[] = [];
      const stopped = await stopRuntimeAfterCommit([serverId], runtimeWarnings, signal);
      return {
        action,
        serverId,
        server: redactMcpServerConfig(server),
        validation,
        changed,
        stopped,
        runtimeWarnings,
      };
    }

    if (action === "delete") {
      const serverId = requireServerId(args.server_id);
      const deleted = requireExistingServer(currentSettings(), serverId);
      commitDelete(serverId);
      const runtimeWarnings: string[] = [];
      const stopped = await stopRuntimeAfterCommit([serverId], runtimeWarnings, signal);
      // OAuth server：卸载即清 keychain 条目（roadmap 验收项）；best effort。
      if (deleted.auth?.type === "oauth") {
        try {
          await invoke("mcp_oauth_clear", { server_id: serverId });
        } catch (err) {
          runtimeWarnings.push(
            `failed to clear OAuth credentials for ${serverId}: ${asErrorMessage(err)}`,
          );
        }
      }
      return { action, serverId, changed: true, stopped, runtimeWarnings };
    }

    if (action === "enable" || action === "disable") {
      const ids = targetServerIds(args);
      const enable = action === "enable";
      if (enable) {
        const settings = currentSettings();
        for (const id of ids) {
          assertRuntimeSpawnAllowed(action, requireExistingServer(settings, id));
        }
      }
      commitSetEnabled(ids, enable);
      const runtimeWarnings: string[] = [];
      const stopped = enable ? false : await stopRuntimeAfterCommit(ids, runtimeWarnings, signal);
      return { action, serverIds: ids, changed: true, stopped, runtimeWarnings };
    }

    if (action === "validate") {
      const server = args.server
        ? await resolveServerCwd(normalizeServerInput(args.server), "McpManager.server.cwd")
        : requireExistingServer(currentSettings(), requireServerId(args.server_id));
      const validation = validateServer(server, args.server ? undefined : currentSettings());
      return {
        action,
        serverId: server.id,
        server: redactMcpServerConfig(server),
        validation,
        changed: false,
      };
    }

    if (action === "stop") {
      const serverId = requireServerId(args.server_id);
      const stopped = await invoke<McpStopServerResponse>("mcp_stop_server", {
        server_id: serverId,
      });
      return { action, serverId, stopped: stopped.stopped, changed: false };
    }

    if (RUNTIME_CONNECTING_ACTIONS.has(action)) {
      const hasInlineServer = Boolean(args.server);
      const server = hasInlineServer
        ? await resolveServerCwd(normalizeServerInput(args.server), "McpManager.server.cwd")
        : requireExistingServer(currentSettings(), requireServerId(args.server_id));
      throwIfAborted(signal);
      assertRuntimeSpawnAllowed(action, server);
      const validation = validateServer(server, hasInlineServer ? undefined : currentSettings());
      let runtime: McpRuntimeStatus | null = null;
      if (!hasInlineServer) {
        runtime = await runtimeStatus(server.id).catch((err) => ({
          serverId: server.id,
          running: false,
          initialized: false,
          transport: server.transport,
          lastError: asErrorMessage(err),
        }));
        throwIfAborted(signal);
      }
      if (!validation.ok) {
        const suggestions = buildSuggestions({ validation, server });
        return {
          action,
          serverId: server.id,
          server: redactMcpServerConfig(server),
          validation,
          runtime,
          changed: false,
          suggestions,
        };
      }
      const shouldIncludeStderr = Object.hasOwn(args, "include_stderr")
        ? args.include_stderr === true
        : action === "diagnose";
      // Outside chat, tests never persist into (or restart entries of) the
      // shared runtime pool: the connection is transient.
      const persist = params.runtimeScope === "chat" && !hasInlineServer;
      const test = applyRuntimeTestOutputOptions(
        await runtimeTest(server, includeSchema, action === "restart", persist),
        shouldIncludeStderr,
      );
      const tools = (test.tools ?? []).map((tool) => summarizeTool(tool, includeSchema));
      return {
        action,
        serverId: server.id,
        server: redactMcpServerConfig(server),
        validation,
        runtime,
        test,
        tools:
          action === "tools" || args.include_tools === true || action === "diagnose"
            ? tools
            : undefined,
        changed: false,
        suggestions: buildSuggestions({ validation, test, server }),
      };
    }

    throw new Error(`McpManager.action is not supported: ${action}`);
  }

  const toolMcpManager: Tool = {
    name: "McpManager",
    description:
      "Manage LiveAgent MCP Server configuration. Use this built-in tool for MCP server CRUD, enable/disable, static validation, connection tests, diagnostics, restart/stop, and tools/list. Enabled MCP servers are automatically loaded as dynamic mcp_* tools. It does not call arbitrary MCP business tools; use the dynamically loaded mcp_* tools for actual MCP tool execution.",
    parameters: MCP_MANAGER_PARAMETERS,
  };

  async function executeToolCall(
    toolCall: ToolCall,
    signal?: AbortSignal,
  ): Promise<ToolResultMessage> {
    const now = Date.now();
    if (toolCall.name !== "McpManager") {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: `Unknown tool: ${toolCall.name}` }],
        details: {},
        isError: true,
        timestamp: now,
      };
    }

    try {
      throwIfAborted(signal);
      const result = await executeAction(
        (toolCall.arguments ?? {}) as Record<string, unknown>,
        signal,
      );
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: formatMcpManagerResult(result) }],
        details: detailsForResult(result),
        isError: false,
        timestamp: now,
      };
    } catch (err) {
      if (err instanceof McpManagerCancelledError) {
        return {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: "text", text: "Cancelled" }],
          details: {},
          isError: true,
          timestamp: now,
        };
      }
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: `McpManager failed: ${asErrorMessage(err)}` }],
        details: {
          kind: "manage_mcp",
          action: "unknown",
          ok: false,
          errors: [asErrorMessage(err)],
        },
        isError: true,
        timestamp: now,
      };
    }
  }

  return {
    groupId: "mcp",
    tools: [toolMcpManager],
    executeToolCall,
    metadataByName: createBuiltinMetadataMap([
      [
        "McpManager",
        {
          groupId: "mcp",
          kind: "manage_mcp",
          isReadOnly: false,
          displayCategory: "mcp",
        },
      ],
    ]),
  };
}
