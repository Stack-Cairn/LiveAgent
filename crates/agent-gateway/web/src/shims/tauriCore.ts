import { loadToken } from "../lib/storage";
import { getGatewayWebSocketClient } from "../lib/gatewaySocket";
import type { CronExecutionLog } from "../lib/settings";

type GatewayRuntimeStatus = {
  online: boolean;
  enabled: boolean;
  configured: boolean;
  gatewayUrl?: string;
  sessionId?: string | null;
  connectedSince?: number | null;
  lastHeartbeat?: number | null;
  lastError?: string | null;
};

type GatewayCronLogsListResponse = {
  action?: string;
  logs?: CronExecutionLog[];
};

type GatewayCronLogsClearResponse = {
  action?: string;
  clearedCount?: number;
};

function isValidCronExpression(expression: string) {
  const parts = expression.trim().split(/\s+/);
  return parts.length === 6;
}

function requireGatewayCronTaskId(args?: Record<string, unknown>) {
  const taskId = String(args?.task_id ?? "").trim();
  if (!taskId) {
    throw new Error("task_id is required");
  }
  return taskId;
}

function parseGatewayCronManageResult<T>(resultJson: string, fallback: string): T {
  try {
    return JSON.parse(resultJson) as T;
  } catch (error) {
    throw new Error(
      error instanceof Error && error.message.trim()
        ? `${fallback}: ${error.message.trim()}`
        : fallback,
    );
  }
}

async function listGatewayCronLogs(args?: Record<string, unknown>) {
  const taskId = requireGatewayCronTaskId(args);
  const limit =
    typeof args?.limit === "number" && Number.isFinite(args.limit) && args.limit > 0
      ? Math.trunc(args.limit)
      : 100;
  const response = await getGatewayWebSocketClient(loadToken().trim()).cronManage({
    action: "list_logs",
    task_id: taskId,
    task_json: JSON.stringify({ limit }),
  });
  const payload = parseGatewayCronManageResult<GatewayCronLogsListResponse>(
    response.result_json,
    "Cron log list response is not valid JSON",
  );
  return Array.isArray(payload.logs) ? payload.logs : [];
}

async function clearGatewayCronLogs(args?: Record<string, unknown>) {
  const taskId = requireGatewayCronTaskId(args);
  const response = await getGatewayWebSocketClient(loadToken().trim()).cronManage({
    action: "clear_logs",
    task_id: taskId,
  });
  const payload = parseGatewayCronManageResult<GatewayCronLogsClearResponse>(
    response.result_json,
    "Cron log clear response is not valid JSON",
  );
  return typeof payload.clearedCount === "number" ? payload.clearedCount : 0;
}

async function readGatewayStatus(): Promise<GatewayRuntimeStatus> {
  const token = loadToken().trim();
  if (!token) {
    return {
      online: false,
      enabled: false,
      configured: false,
      gatewayUrl: typeof window !== "undefined" ? window.location.origin : "",
      lastError: "未配置 Gateway Token",
    };
  }

  try {
    const payload = (await getGatewayWebSocketClient(token).getStatus()) as {
      online?: boolean;
      session_id?: string;
      connected_since?: number;
      last_heartbeat?: number;
    };

    return {
      online: Boolean(payload.online),
      enabled: true,
      configured: true,
      gatewayUrl: window.location.origin,
      sessionId: payload.session_id ?? null,
      connectedSince: payload.connected_since ?? null,
      lastHeartbeat: payload.last_heartbeat ?? null,
      lastError: null,
    };
  } catch (error) {
    return {
      online: false,
      enabled: true,
      configured: true,
      gatewayUrl: window.location.origin,
      lastError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function invokeGatewayMemory<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const payloadArgs =
    args && typeof args.args === "object" && args.args !== null && !Array.isArray(args.args)
      ? (args.args as Record<string, unknown>)
      : (args ?? {});
  return getGatewayWebSocketClient(loadToken().trim()).memoryManage<T>({
    command,
    args: payloadArgs,
  });
}

function pickWorkdirInBrowser(): string | null {
  if (typeof window === "undefined" || typeof window.prompt !== "function") {
    return null;
  }

  const message = [
    "浏览器无法直接打开远程目录选择器。",
    "请输入桌面端 Agent 可访问的绝对工作目录路径：",
  ].join("\n");
  const picked = window.prompt(message, "");
  return typeof picked === "string" && picked.trim() ? picked.trim() : null;
}

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (command.startsWith("memory_")) {
    return invokeGatewayMemory<T>(command, args);
  }

  switch (command) {
    case "system_pick_folder":
      return pickWorkdirInBrowser() as T;
    case "chat_history_list": {
      const response = await getGatewayWebSocketClient(loadToken().trim()).listHistory(
        typeof args?.page === "number" ? args.page : 1,
        typeof args?.pageSize === "number" ? args.pageSize : 80,
        {
          cwd: typeof args?.cwd === "string" ? args.cwd : undefined,
          cwdEmpty: args?.cwdEmpty === true,
        },
      );
      return {
        items: response.conversations.map((item) => ({
          id: item.id,
          title: item.title,
          providerId: item.provider_id ?? "",
          model: item.model ?? "",
          sessionId: item.session_id || undefined,
          cwd: item.cwd || undefined,
          messageCount: item.message_count,
          createdAt: item.created_at,
          updatedAt: item.updated_at,
          isPinned: item.is_pinned,
          pinnedAt: item.pinned_at,
          isShared: item.is_shared,
        })),
        totalCount: response.total_count,
      } as T;
    }
    case "chat_history_workdirs":
      return (await getGatewayWebSocketClient(loadToken().trim()).listHistoryWorkdirs()) as T;
    case "system_create_project_folder":
      return (await getGatewayWebSocketClient(loadToken().trim()).createProjectFolder(
        String(args?.parent ?? ""),
        String(args?.name ?? ""),
      )) as T;
    case "system_ensure_builtin_skills":
      return [] as T;
    case "fs_roots":
      return (await getGatewayWebSocketClient(loadToken().trim()).listFsRoots()) as T;
    case "fs_list_dirs": {
      const path = String(args?.path ?? "").trim();
      if (!path) {
        throw new Error("path is required");
      }
      const maxResults = typeof args?.max_results === "number" ? args.max_results : undefined;
      return (await getGatewayWebSocketClient(loadToken().trim()).listDirs(path, maxResults)) as T;
    }
    case "fs_list":
      return (await getGatewayWebSocketClient(loadToken().trim()).listFiles(
        String(args?.workdir ?? ""),
        typeof args?.path === "string" ? args.path : undefined,
        typeof args?.depth === "number" ? args.depth : undefined,
        typeof args?.offset === "number" ? args.offset : undefined,
        typeof args?.max_results === "number" ? args.max_results : undefined,
      )) as T;
    case "fs_write_text":
      return (await getGatewayWebSocketClient(loadToken().trim()).writeTextFile({
        workdir: String(args?.workdir ?? ""),
        path: String(args?.path ?? ""),
        content: typeof args?.content === "string" ? args.content : "",
        mode: typeof args?.mode === "string" ? args.mode : undefined,
        expectedMtimeMs:
          typeof args?.expected_mtime_ms === "number" ? args.expected_mtime_ms : undefined,
        expectedContentHash:
          typeof args?.expected_content_hash === "string" ? args.expected_content_hash : undefined,
      })) as T;
    case "fs_read_editable_text":
      return (await getGatewayWebSocketClient(loadToken().trim()).readEditableTextFile(
        String(args?.workdir ?? ""),
        String(args?.path ?? ""),
      )) as T;
    case "fs_read_workspace_image":
      return (await getGatewayWebSocketClient(loadToken().trim()).readWorkspaceImageFile(
        String(args?.workdir ?? ""),
        String(args?.path ?? ""),
      )) as T;
    case "fs_create_dir":
      return (await getGatewayWebSocketClient(loadToken().trim()).createDir(
        String(args?.workdir ?? ""),
        String(args?.path ?? ""),
      )) as T;
    case "fs_rename":
      return (await getGatewayWebSocketClient(loadToken().trim()).renamePath(
        String(args?.workdir ?? ""),
        String(args?.from_path ?? ""),
        String(args?.to_path ?? ""),
      )) as T;
    case "fs_delete":
      return (await getGatewayWebSocketClient(loadToken().trim()).deletePath(
        String(args?.workdir ?? ""),
        String(args?.path ?? ""),
      )) as T;
    case "fs_mention_list":
      return (await getGatewayWebSocketClient(loadToken().trim()).listMentionFiles(
        String(args?.workdir ?? ""),
        typeof args?.max_results === "number" ? args.max_results : undefined,
        typeof args?.query === "string" ? args.query : undefined,
      )) as T;
    case "system_list_skill_files":
      return (await getGatewayWebSocketClient(loadToken().trim()).listSkillFiles()) as T;
    case "system_read_skill_metadata":
      return (await getGatewayWebSocketClient(loadToken().trim()).readSkillMetadata(
        String(args?.path ?? ""),
      )) as T;
    case "system_read_skill_text":
      return (await getGatewayWebSocketClient(loadToken().trim()).readSkillText(
        String(args?.path ?? ""),
        typeof args?.offset === "number" ? args.offset : undefined,
        typeof args?.length === "number" ? args.length : undefined,
      )) as T;
    case "system_manage_skill":
      return (await getGatewayWebSocketClient(loadToken().trim()).manageSkill(
        (args?.payload && typeof args.payload === "object" ? args.payload : {}) as Record<
          string,
          unknown
        >,
      )) as T;
    case "proxy_get_server_info":
      return {
        baseUrl: window.location.origin,
        token: loadToken().trim() || "gateway-webui",
      } as T;
    case "gateway_status":
      return (await readGatewayStatus()) as T;
    case "gateway_provider_models":
      return (await getGatewayWebSocketClient(loadToken().trim()).getProviderModels(
        String(args?.type ?? ""),
        String(args?.base_url ?? ""),
        String(args?.api_key ?? ""),
      )) as T;
    case "cron_validate_expression": {
      const expression = String(args?.expression ?? "").trim();
      if (!isValidCronExpression(expression)) {
        throw new Error("Cron 表达式必须严格包含 6 段。");
      }
      return true as T;
    }
    case "cron_list_logs":
      return (await listGatewayCronLogs(args)) as T;
    case "cron_clear_logs":
      return (await clearGatewayCronLogs(args)) as T;
    case "system_http_get_test":
      return {
        url: `${window.location.origin}/api/status`,
        status: 200,
        ok: true,
        body: "WebUI shim placeholder",
        content_type: "text/plain",
      } as T;
    default:
      throw new Error(`WebUI shim does not implement invoke("${command}")`);
  }
}
