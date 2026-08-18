import { getGatewayWebSocketClient } from "../lib/gatewaySocket";
import { loadToken } from "../lib/storage";
import { promptPathInBrowser } from "./browserPathPrompt";

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

async function pickWorkdirInBrowser(): Promise<string | null> {
  return promptPathInBrowser({
    title: "选择工作目录",
    description: "浏览器无法直接打开远程目录选择器。请输入桌面端 Agent 可访问的绝对工作目录路径。",
    label: "工作目录路径",
    placeholder: "/Users/name/project",
    inputId: "gateway-browser-workdir-path",
  });
}

async function pickFilePathInBrowser(): Promise<string | null> {
  return promptPathInBrowser({
    title: "选择配置文件",
    description: "浏览器无法直接打开远程文件选择器。请输入桌面端 Agent 可访问的配置文件绝对路径。",
    label: "配置文件路径",
    placeholder: "~/.mcp.json",
    inputId: "gateway-browser-file-path",
  });
}

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (command.startsWith("memory_")) {
    return invokeGatewayMemory<T>(command, args);
  }

  switch (command) {
    // 轨迹是只读诊断视图；两端共用同一份宿主实现，差异只在这里的路由。
    case "trajectory_get_events":
      return (await getGatewayWebSocketClient(loadToken().trim()).trajectoryFetch<T>({
        conversation_id: typeof args?.conversationId === "string" ? args.conversationId : "",
      })) as T;
    case "trajectory_get_window":
      return (await getGatewayWebSocketClient(loadToken().trim()).trajectoryFetch<T>({
        conversation_id: typeof args?.conversationId === "string" ? args.conversationId : "",
        max_segments: typeof args?.maxSegments === "number" ? args.maxSegments : undefined,
        before_segment_index:
          typeof args?.beforeSegmentIndex === "number" ? args.beforeSegmentIndex : undefined,
      })) as T;
    case "trajectory_get_subagent_runs":
      return (await getGatewayWebSocketClient(loadToken().trim()).trajectoryFetch<T>({
        conversation_id: typeof args?.conversationId === "string" ? args.conversationId : "",
        subagent_run_ids: Array.isArray(args?.runIds)
          ? (args.runIds as unknown[]).filter((id): id is string => typeof id === "string")
          : [],
        include_subagent_runs: true,
      })) as T;
    case "trajectory_get_sections": {
      const response = (await getGatewayWebSocketClient(loadToken().trim()).trajectoryFetch<{
        sections?: unknown;
      }>({
        conversation_id: typeof args?.conversationId === "string" ? args.conversationId : "",
        section_ids: Array.isArray(args?.sectionIds)
          ? (args.sectionIds as unknown[]).filter((id): id is string => typeof id === "string")
          : [],
      })) as { sections?: unknown };
      return (Array.isArray(response?.sections) ? response.sections : []) as T;
    }
    case "system_pick_folder":
      return (await pickWorkdirInBrowser()) as T;
    case "system_pick_file":
      return (await pickFilePathInBrowser()) as T;
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
        typeof args?.show_hidden === "boolean" ? args.show_hidden : undefined,
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
    case "open_chat_file_link":
      return (await getGatewayWebSocketClient(loadToken().trim()).openChatFile({
        conversationId: String(args?.conversation_id ?? ""),
        workdir: String(args?.workdir ?? ""),
        path: String(args?.path ?? ""),
        source: String(args?.source ?? ""),
        line: typeof args?.line === "number" ? args.line : undefined,
        endLine: typeof args?.end_line === "number" ? args.end_line : undefined,
        column: typeof args?.column === "number" ? args.column : undefined,
        openInFileManager:
          typeof args?.open_in_file_manager === "boolean" ? args.open_in_file_manager : undefined,
      })) as T;
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
        typeof args?.show_hidden === "boolean" ? args.show_hidden : undefined,
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
        args?.use_system_proxy === true,
        String(args?.models_url ?? ""),
        String(args?.provider_id ?? ""),
        typeof args?.is_full_url === "boolean" ? args.is_full_url : undefined,
      )) as T;
    case "settings_reset_ssh_known_host": {
      const host = String(args?.host ?? "").trim();
      const port = typeof args?.port === "number" ? args.port : Number(args?.port ?? 0);
      return (await getGatewayWebSocketClient(loadToken().trim()).resetSshKnownHost({
        host,
        port,
      })) as T;
    }
    case "terminal_list":
      return {
        sessions: await getGatewayWebSocketClient(loadToken().trim()).listTerminals(
          typeof args?.project_path_key === "string" ? args.project_path_key : undefined,
        ),
      } as T;
    case "terminal_close":
      return (await getGatewayWebSocketClient(loadToken().trim()).closeTerminal(
        String(args?.session_id ?? ""),
        typeof args?.project_path_key === "string" ? args.project_path_key : undefined,
      )) as T;
    case "terminal_ssh_reconnect":
      return (await getGatewayWebSocketClient(loadToken().trim()).reconnectSshTerminal(
        String(args?.session_id ?? ""),
        typeof args?.project_path_key === "string" ? args.project_path_key : undefined,
      )) as T;
    default:
      throw new Error(`WebUI shim does not implement invoke("${command}")`);
  }
}
