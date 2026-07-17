import { getGatewayWebSocketClient } from "../lib/gatewaySocket";
import { loadToken } from "../lib/storage";

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
  if (typeof window === "undefined" || typeof document === "undefined" || !document.body) {
    return null;
  }

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className =
      "fixed inset-0 z-[120] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "选择工作目录");

    const panel = document.createElement("form");
    panel.className =
      "relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-border/70 bg-background shadow-2xl";

    const header = document.createElement("div");
    header.className = "border-b border-border/60 px-5 py-4";

    const title = document.createElement("div");
    title.className = "text-base font-semibold text-foreground";
    title.textContent = "选择工作目录";

    const description = document.createElement("div");
    description.className = "mt-1 text-xs text-muted-foreground";
    description.textContent =
      "浏览器无法直接打开远程目录选择器。请输入桌面端 Agent 可访问的绝对工作目录路径。";

    const body = document.createElement("div");
    body.className = "space-y-2 px-5 py-5";

    const label = document.createElement("label");
    label.className = "block text-xs font-medium text-muted-foreground";
    label.htmlFor = "gateway-browser-workdir-path";
    label.textContent = "工作目录路径";

    const input = document.createElement("input");
    input.id = "gateway-browser-workdir-path";
    input.className =
      "h-10 w-full rounded-lg border border-input bg-background px-3 font-mono text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-ring focus:ring-2 focus:ring-ring/20";
    input.placeholder = "/Users/name/project";
    input.type = "text";

    const footer = document.createElement("div");
    footer.className =
      "flex flex-col-reverse gap-2 border-t border-border/60 bg-muted/20 px-5 py-4 sm:flex-row sm:justify-end";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className =
      "inline-flex h-9 items-center justify-center rounded-lg border border-input bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted sm:w-auto";
    cancelButton.textContent = "取消";

    const confirmButton = document.createElement("button");
    confirmButton.type = "submit";
    confirmButton.className =
      "inline-flex h-9 items-center justify-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50 sm:w-auto";
    confirmButton.disabled = true;
    confirmButton.textContent = "确认";
    let closed = false;

    const cleanup = (value: string | null) => {
      if (closed) return;
      closed = true;
      window.removeEventListener("keydown", handleKeyDown);
      overlay.remove();
      resolve(value);
    };

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        cleanup(null);
      }
    }

    input.addEventListener("input", () => {
      confirmButton.disabled = input.value.trim().length === 0;
    });
    cancelButton.addEventListener("click", () => cleanup(null));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        cleanup(null);
      }
    });
    panel.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (value) {
        cleanup(value);
      }
    });
    window.addEventListener("keydown", handleKeyDown);

    header.append(title, description);
    body.append(label, input);
    footer.append(cancelButton, confirmButton);
    panel.append(header, body, footer);
    overlay.append(panel);
    document.body.append(overlay);
    window.requestAnimationFrame(() => input.focus());
  });
}

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (command.startsWith("memory_")) {
    return invokeGatewayMemory<T>(command, args);
  }

  switch (command) {
    case "system_pick_folder":
      return (await pickWorkdirInBrowser()) as T;
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
        args?.allow_private_network === true,
      )) as T;
    case "settings_reset_ssh_known_host": {
      const host = String(args?.host ?? "").trim();
      const port = typeof args?.port === "number" ? args.port : Number(args?.port ?? 0);
      return (await getGatewayWebSocketClient(loadToken().trim()).resetSshKnownHost({
        host,
        port,
      })) as T;
    }
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
