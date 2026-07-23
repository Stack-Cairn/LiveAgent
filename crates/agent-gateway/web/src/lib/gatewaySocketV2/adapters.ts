// v2 线协议适配层：把 gatewaySocket 公开 API 使用的请求类型字符串与 snake_case
// UI 载荷编码为 protobuf 帧，并把服务端帧还原为现有归一化器需要的对象形状。
// bigint 边界：本文件是 64 位整数（生成代码映射为 bigint）的唯一出入口——入站一律 Number()（均为
// 时间戳/计数，远小于 2^53 无精度损失），出站 BigInt() 收窄；适配层之外不允许出现 bigint。
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type {
  AgentEnvelope,
  ChatQueueEvent,
  ConversationSummary,
  GatewayEnvelope,
  HistoryShareStatus,
  HistorySyncEvent,
  ManagedProcessResponse,
  ManagedProcessSnapshot,
  SettingsSyncEvent,
  SftpEntry,
  SftpEvent,
  SftpResponse,
  SftpTransfer,
  TerminalEvent,
  TerminalResponse,
  TerminalSession,
  TerminalSshTabsSnapshot,
  TerminalStreamFrame,
  TunnelHealth,
  TunnelStateSnapshot,
  WorkspaceActivityEvent,
} from "@/lib/proto/gen/proto/v2/gateway_pb";
import {
  CancelChatRequestSchema,
  ChatCommandRequestSchema,
  ChatMessageRefSchema,
  ChatQueueRequestSchema,
  ChatRequestSchema,
  ChatRuntimeControlsSchema,
  ChatSelectedModelSchema,
  ChatUploadedFileSchema,
  CronManageRequestSchema,
  FileMentionListRequestSchema,
  FsCreateDirRequestSchema,
  FsCreateProjectFolderRequestSchema,
  FsDeleteRequestSchema,
  FsListDirsRequestSchema,
  FsListRequestSchema,
  FsReadEditableTextRequestSchema,
  FsReadWorkspaceImageRequestSchema,
  FsRenameRequestSchema,
  FsRootsRequestSchema,
  FsWriteTextRequestSchema,
  GatewayEnvelopeSchema,
  GitRequestSchema,
  HistoryBranchRequestSchema,
  HistoryDeleteRequestSchema,
  HistoryGetRequestSchema,
  HistoryListRequestSchema,
  HistoryPinRequestSchema,
  HistoryPrefixRequestSchema,
  HistoryRenameRequestSchema,
  HistoryShareGetRequestSchema,
  HistoryShareSetRequestSchema,
  HistoryWorkdirsRequestSchema,
  ManagedProcessRequestSchema,
  MemoryManageRequestSchema,
  ProviderListRequestSchema,
  ProviderModelsRequestSchema,
  SettingsGetRequestSchema,
  SettingsResetSshKnownHostRequestSchema,
  SettingsUpdateRequestSchema,
  SftpRequestSchema,
  SkillFilesListRequestSchema,
  SkillManageRequestSchema,
  SkillMetadataReadRequestSchema,
  SkillTextReadRequestSchema,
  TerminalRequestSchema,
  TerminalStreamFrameSchema,
  TunnelMutationSchema,
  UploadedImagePreviewRequestSchema,
} from "@/lib/proto/gen/proto/v2/gateway_pb";
import type {
  ChatActivityEvent,
  ChatCommandUpdate,
  ChatRunActivity,
  ChatRunSnapshot,
  ChatSubscribeResult,
  StatusEvent,
  TerminalServerFrame,
  WebClientFrame,
  WebServerFrame,
} from "@/lib/proto/gen/proto/v2/gateway_ws_pb";
import {
  AgentListRequestSchema,
  ChatActivitiesRequestSchema,
  ChatPrepareRequestSchema,
  ChatSubscribeRequestSchema,
  ChatUnsubscribeRequestSchema,
  ClientHelloSchema,
  ClientRole,
  PongFrameSchema,
  StatusGetRequestSchema,
  TerminalClientFrameSchema,
  TerminalServerFrameSchema,
  WebClientFrameSchema,
  WebServerFrameSchema,
  WorkspaceSubscribeRequestSchema,
  WorkspaceUnsubscribeRequestSchema,
} from "@/lib/proto/gen/proto/v2/gateway_ws_pb";

// v2 WebSocket 子协议名（服务端必须回显）。
export const GATEWAY_V2_SUBPROTOCOL = "liveagent.v2.pb";
// ClientHello.protocol_version 的当前取值。
export const GATEWAY_V2_PROTOCOL_VERSION = 2;

const textDecoder = new TextDecoder();

type J = Record<string, unknown>;

// ---------------------------------------------------------------------------
// 基础读写小工具（入站 JSON 载荷是 unknown，出站 proto 需要窄化类型）
// ---------------------------------------------------------------------------

function rec(value: unknown): J {
  return value && typeof value === "object" ? (value as J) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function trimStr(value: unknown): string {
  return str(value).trim();
}

// 32 位整数出站：非法值一律回落为 0。
function n32(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function bool(value: unknown): boolean {
  return value === true;
}

function optBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

// 64 位整数出站边界：number → bigint。
function toI64(value: unknown): bigint {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? BigInt(Math.trunc(parsed)) : 0n;
}

// 64 位整数入站边界：bigint → number（详见文件头注释）。
function num(value: number | bigint | undefined): number {
  return Number(value ?? 0);
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

// WireBytes：可直接投递给 WebSocket.send 的二进制帧。toBinary 的泛型参数是 ArrayBufferLike，
// 运行时总是普通 ArrayBuffer，此处统一收窄避免各调用点重复断言。
export type WireBytes = Uint8Array<ArrayBuffer>;

function wireBytes(bytes: Uint8Array): WireBytes {
  return bytes as WireBytes;
}

// 网关本地或解码期错误，由 gatewaySocket 统一转为请求失败。
class GatewayFrameError extends Error {}

function frameError(message: string): never {
  throw new GatewayFrameError(message);
}

// ---------------------------------------------------------------------------
// 出站：hello / pong / 请求编码
// ---------------------------------------------------------------------------

export function encodeHelloFrame(requestId: string, token: string): WireBytes {
  const frame = create(WebClientFrameSchema, {
    requestId,
    payload: {
      case: "hello",
      value: create(ClientHelloSchema, {
        protocolVersion: GATEWAY_V2_PROTOCOL_VERSION,
        role: ClientRole.BROWSER,
        token,
        clientName: "webui",
        clientVersion: "",
      }),
    },
  });
  return wireBytes(toBinary(WebClientFrameSchema, frame));
}

export function encodePongFrame(timestamp: number): WireBytes {
  const frame = create(WebClientFrameSchema, {
    payload: { case: "pong", value: create(PongFrameSchema, { timestamp: toI64(timestamp) }) },
  });
  return wireBytes(toBinary(WebClientFrameSchema, frame));
}

// 把请求类型字符串与 UI 载荷编码为 WebClientFrame；未知类型抛错。
// 目标型请求必须携带明确 agentId；目录与全局会话请求不需要目标。
export function encodeRequestFrame(
  requestId: string,
  type: string,
  payload: unknown,
  agentId = "",
): WireBytes {
  const frame = buildRequestFrame(requestId, type, payload);
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId && !["agent.list", "chat.activities"].includes(type)) {
    throw new Error("agent_id is required");
  }
  frame.agentId = normalizedAgentId;
  return wireBytes(toBinary(WebClientFrameSchema, frame));
}

function buildRequestFrame(requestId: string, type: string, payload: unknown): WebClientFrame {
  const body = rec(payload);
  switch (type) {
    case "agent.list":
      return create(WebClientFrameSchema, {
        requestId,
        payload: { case: "agentList", value: create(AgentListRequestSchema, {}) },
      });
    case "status.get":
      return webFrame(requestId, "statusGet", create(StatusGetRequestSchema, {}));
    case "chat.prepare":
      return webFrame(
        requestId,
        "chatPrepare",
        create(ChatPrepareRequestSchema, { reason: str(body.reason) }),
      );
    case "chat.command":
      return webFrame(requestId, "chatCommand", buildChatCommand(body));
    case "chat.cancel":
      return webFrame(
        requestId,
        "chatCommand",
        create(ChatCommandRequestSchema, {
          type: "chat.cancel",
          cancel: create(CancelChatRequestSchema, {
            conversationId: trimStr(body.conversation_id),
            runId: trimStr(body.run_id),
          }),
        }),
      );
    case "chat.subscribe":
      return webFrame(
        requestId,
        "chatSubscribe",
        create(ChatSubscribeRequestSchema, {
          conversationId: trimStr(body.conversation_id),
          afterSeq: toI64(body.after_seq),
          streamEpoch: str(body.stream_epoch),
        }),
      );
    case "chat.unsubscribe":
      return webFrame(
        requestId,
        "chatUnsubscribe",
        create(ChatUnsubscribeRequestSchema, { conversationId: trimStr(body.conversation_id) }),
      );
    case "chat.activities":
      return webFrame(requestId, "chatActivities", create(ChatActivitiesRequestSchema, {}));
    case "workspace.subscribe":
      return webFrame(
        requestId,
        "workspaceSubscribe",
        create(WorkspaceSubscribeRequestSchema, { workdir: trimStr(body.workdir) }),
      );
    case "workspace.unsubscribe":
      return webFrame(
        requestId,
        "workspaceUnsubscribe",
        create(WorkspaceUnsubscribeRequestSchema, { workdir: trimStr(body.workdir) }),
      );
    default:
      return create(WebClientFrameSchema, {
        requestId,
        payload: { case: "agentRequest", value: buildAgentRequest(type, body) },
      });
  }
}

type WebFrameCase =
  | "statusGet"
  | "chatCommand"
  | "chatPrepare"
  | "chatSubscribe"
  | "chatUnsubscribe"
  | "chatActivities"
  | "workspaceSubscribe"
  | "workspaceUnsubscribe";

function webFrame(requestId: string, frameCase: WebFrameCase, value: unknown): WebClientFrame {
  return create(WebClientFrameSchema, {
    requestId,
    // 受控断言换取 switch 简洁：各分支 value 均为对应 schema 实例，oneof 判别类型无法自动收窄。
    payload: { case: frameCase, value } as WebClientFrame["payload"],
  });
}

function buildChatCommand(body: J) {
  const inner = rec(body.payload);
  const selectedModel = rec(inner.selected_model);
  const runtimeControls = rec(inner.runtime_controls);
  const uploadedFiles = Array.isArray(inner.uploaded_files) ? inner.uploaded_files : [];
  return create(ChatCommandRequestSchema, {
    type: str(body.type),
    request: create(ChatRequestSchema, {
      conversationId: str(inner.conversation_id),
      message: str(inner.message),
      selectedModel: inner.selected_model
        ? create(ChatSelectedModelSchema, {
            customProviderId: str(selectedModel.custom_provider_id),
            model: str(selectedModel.model),
            providerType: str(selectedModel.provider_type),
          })
        : undefined,
      executionMode: str(inner.execution_mode),
      workdir: str(inner.workdir),
      selectedSystemTools: Array.isArray(inner.selected_system_tools)
        ? inner.selected_system_tools.map((item) => str(item))
        : [],
      uploadedFiles: uploadedFiles.map((file) => {
        const raw = rec(file);
        return create(ChatUploadedFileSchema, {
          relativePath: str(raw.relative_path),
          absolutePath: str(raw.absolute_path),
          fileName: str(raw.file_name),
          kind: str(raw.kind),
          sizeBytes: toI64(raw.size_bytes),
        });
      }),
      clientRequestId: str(inner.client_request_id),
      runtimeControls: inner.runtime_controls
        ? create(ChatRuntimeControlsSchema, {
            thinkingEnabled: bool(runtimeControls.thinking_enabled),
            nativeWebSearchEnabled: bool(runtimeControls.native_web_search_enabled),
            reasoning: str(runtimeControls.reasoning),
          })
        : undefined,
      queuePolicy: str(inner.queue_policy),
    }),
    baseMessageRef: inner.base_message_ref
      ? buildMessageRef(rec(inner.base_message_ref))
      : undefined,
  });
}

function buildMessageRef(ref: J) {
  return create(ChatMessageRefSchema, {
    segmentIndex: n32(ref.segment_index),
    messageIndex: n32(ref.message_index),
    segmentId: str(ref.segment_id),
    messageId: str(ref.message_id),
    role: str(ref.role),
    contentHash: str(ref.content_hash),
  });
}

// 构造直通 GatewayEnvelope，并把 UI 字段映射到对应 proto 载荷臂。
function buildAgentRequest(type: string, body: J): GatewayEnvelope {
  return create(GatewayEnvelopeSchema, { payload: agentRequestPayload(type, body) });
}

function agentRequestPayload(type: string, body: J): GatewayEnvelope["payload"] {
  if (type.startsWith("git.")) {
    return {
      case: "gitRequest",
      value: create(GitRequestSchema, {
        action: type.slice("git.".length),
        workdir: trimStr(body.workdir),
        argsJson: body.args === undefined ? "{}" : JSON.stringify(body.args),
      }),
    };
  }
  if (type.startsWith("terminal.")) {
    return {
      case: "terminalRequest",
      value: create(TerminalRequestSchema, {
        action: type.slice("terminal.".length),
        sessionId: trimStr(body.session_id),
        projectPathKey: trimStr(body.project_path_key),
        cwd: trimStr(body.cwd),
        shell: trimStr(body.shell),
        title: trimStr(body.title),
        data: str(body.data),
        cols: n32(body.cols),
        rows: n32(body.rows),
        maxBytes: n32(body.max_bytes),
        sshHostId: trimStr(body.ssh_host_id),
        promptId: trimStr(body.prompt_id),
        promptAnswer: str(body.prompt_answer),
        trustHostKey: bool(body.trust_host_key),
        sftpEnabled: bool(body.sftp_enabled),
        tabId: trimStr(body.tab_id),
        tabKind: trimStr(body.tab_kind),
      }),
    };
  }
  if (type.startsWith("sftp.")) {
    // UI 载荷中的 side 与 direction 互为回落；proto 只保留 direction。
    const direction = trimStr(body.direction) || trimStr(body.side);
    return {
      case: "sftpRequest",
      value: create(SftpRequestSchema, {
        action: type.slice("sftp.".length),
        sessionId: trimStr(body.session_id),
        projectPathKey: trimStr(body.project_path_key),
        workdir: trimStr(body.workdir),
        localPath: str(body.local_path),
        remotePath: str(body.remote_path),
        fromPath: str(body.from_path),
        toPath: str(body.to_path),
        direction,
        targetPath: str(body.target_path),
        recursive: bool(body.recursive),
        overwrite: bool(body.overwrite),
      }),
    };
  }
  if (type.startsWith("tunnel.")) {
    return {
      case: "tunnelMutation",
      value: create(TunnelMutationSchema, {
        action: type.slice("tunnel.".length),
        tunnelId: str(body.tunnel_id),
        targetUrl: str(body.target_url),
        name: str(body.name),
        ttlSeconds: typeof body.ttl_seconds === "number" ? n32(body.ttl_seconds) : undefined,
        projectPathKey: str(body.project_path_key),
      }),
    };
  }
  if (type.startsWith("process.")) {
    return {
      case: "managedProcessRequest",
      value: create(ManagedProcessRequestSchema, {
        action: type.slice("process.".length),
        processId: trimStr(body.process_id),
        maxBytes: n32(body.max_bytes),
      }),
    };
  }
  if (type.startsWith("chat_queue.")) {
    return {
      case: "chatQueue",
      value: create(ChatQueueRequestSchema, {
        action: type.slice("chat_queue.".length),
        conversationId: trimStr(body.conversation_id),
        itemId: trimStr(body.item_id),
        direction: trimStr(body.direction),
        revision: toI64(body.revision),
        draftJson: trimStr(body.draft_json),
        uploadedFilesJson: trimStr(body.uploaded_files_json),
        requestJson: trimStr(body.request_json),
      }),
    };
  }

  switch (type) {
    case "history.list":
      return {
        case: "historyList",
        value: create(HistoryListRequestSchema, {
          page: n32(body.page),
          pageSize: n32(body.page_size),
          cwd: trimStr(body.cwd),
          cwdEmpty: bool(body.cwd_empty),
        }),
      };
    case "history.workdirs":
      return { case: "historyWorkdirs", value: create(HistoryWorkdirsRequestSchema, {}) };
    case "history.shared_list":
      // shared_list 通过 memory_manage 直通命令实现，并保持现有结果形状。
      return {
        case: "memoryManage",
        value: create(MemoryManageRequestSchema, {
          command: "history_shared_list",
          argsJson: JSON.stringify({ page: n32(body.page), page_size: n32(body.page_size) }),
        }),
      };
    case "history.get":
      return {
        case: "historyGet",
        value: create(HistoryGetRequestSchema, {
          conversationId: trimStr(body.conversation_id),
          maxMessages: n32(body.max_messages),
        }),
      };
    case "history.prefix":
      return {
        case: "historyPrefix",
        value: create(HistoryPrefixRequestSchema, {
          conversationId: trimStr(body.conversation_id),
          maxMessages: n32(body.max_messages),
          baseMessageRef: body.base_message_ref
            ? buildMessageRef(rec(body.base_message_ref))
            : undefined,
        }),
      };
    case "history.rename":
      return {
        case: "historyRename",
        value: create(HistoryRenameRequestSchema, {
          conversationId: trimStr(body.conversation_id),
          title: trimStr(body.title),
        }),
      };
    case "history.branch":
      return {
        case: "historyBranch",
        value: create(HistoryBranchRequestSchema, {
          conversationId: trimStr(body.conversation_id),
          baseMessageRef: body.base_message_ref
            ? buildMessageRef(rec(body.base_message_ref))
            : undefined,
        }),
      };
    case "history.pin":
      return {
        case: "historyPin",
        value: create(HistoryPinRequestSchema, {
          conversationId: trimStr(body.conversation_id),
          isPinned: bool(body.is_pinned),
        }),
      };
    case "history.share.get":
      return {
        case: "historyShareGet",
        value: create(HistoryShareGetRequestSchema, {
          conversationId: trimStr(body.conversation_id),
        }),
      };
    case "history.share.set":
      return {
        case: "historyShareSet",
        value: create(HistoryShareSetRequestSchema, {
          conversationId: trimStr(body.conversation_id),
          enabled: bool(body.enabled),
          redactToolContent: optBool(body.redact_tool_content),
        }),
      };
    case "history.delete":
      return {
        case: "historyDelete",
        value: create(HistoryDeleteRequestSchema, {
          conversationId: trimStr(body.conversation_id),
        }),
      };
    case "providers.list":
      return { case: "providerList", value: create(ProviderListRequestSchema, {}) };
    case "provider.models":
      return {
        case: "providerModels",
        value: create(ProviderModelsRequestSchema, {
          providerType: trimStr(body.type),
          baseUrl: trimStr(body.base_url),
          apiKey: trimStr(body.api_key),
          useSystemProxy: bool(body.use_system_proxy),
        }),
      };
    case "settings.get":
      return { case: "settingsGet", value: create(SettingsGetRequestSchema, {}) };
    case "settings.update":
      return {
        case: "settingsUpdate",
        value: create(SettingsUpdateRequestSchema, { settingsJson: JSON.stringify(rec(body)) }),
      };
    case "settings.ssh_known_host.reset":
      return {
        case: "settingsResetSshKnownHost",
        value: create(SettingsResetSshKnownHostRequestSchema, {
          host: trimStr(body.host),
          port: n32(body.port),
        }),
      };
    case "skills.list":
      return { case: "skillFilesList", value: create(SkillFilesListRequestSchema, {}) };
    case "skills.manage":
      return {
        case: "skillManage",
        value: create(SkillManageRequestSchema, { payloadJson: JSON.stringify(rec(body)) }),
      };
    case "skills.read-metadata":
      return {
        case: "skillMetadataRead",
        value: create(SkillMetadataReadRequestSchema, { path: trimStr(body.path) }),
      };
    case "skills.read-text":
      return {
        case: "skillTextRead",
        value: create(SkillTextReadRequestSchema, {
          path: trimStr(body.path),
          offset: n32(body.offset),
          length: n32(body.length),
        }),
      };
    case "mentions.list":
      return {
        case: "fileMentionList",
        value: create(FileMentionListRequestSchema, {
          workdir: trimStr(body.workdir),
          maxResults: n32(body.max_results),
          query: trimStr(body.query),
          showHidden: optBool(body.show_hidden),
        }),
      };
    case "files.preview":
      return {
        case: "uploadedImagePreview",
        value: create(UploadedImagePreviewRequestSchema, {
          workdir: trimStr(body.workdir),
          absolutePath: trimStr(body.absolute_path),
        }),
      };
    case "memory.manage":
      return {
        case: "memoryManage",
        value: create(MemoryManageRequestSchema, {
          command: trimStr(body.command),
          argsJson: body.args === undefined ? "{}" : JSON.stringify(body.args),
        }),
      };
    case "cron.manage":
      return {
        case: "cronManage",
        value: create(CronManageRequestSchema, {
          action: str(body.action),
          taskId: str(body.task_id),
          taskJson: str(body.task_json),
        }),
      };
    case "fs.roots":
      return { case: "fsRoots", value: create(FsRootsRequestSchema, {}) };
    case "fs.list_dirs":
      return {
        case: "fsListDirs",
        value: create(FsListDirsRequestSchema, {
          path: trimStr(body.path),
          maxResults: n32(body.max_results),
        }),
      };
    case "fs.create_project_folder":
      return {
        case: "fsCreateProjectFolder",
        value: create(FsCreateProjectFolderRequestSchema, {
          parent: trimStr(body.parent),
          name: trimStr(body.name),
        }),
      };
    case "fs.list":
      return {
        case: "fsList",
        value: create(FsListRequestSchema, {
          workdir: trimStr(body.workdir),
          path: trimStr(body.path),
          depth: n32(body.depth),
          offset: n32(body.offset),
          maxResults: n32(body.max_results),
          showHidden: optBool(body.show_hidden),
        }),
      };
    case "fs.write_text":
      return {
        case: "fsWriteText",
        value: create(FsWriteTextRequestSchema, {
          workdir: trimStr(body.workdir),
          path: trimStr(body.path),
          content: str(body.content),
          mode: trimStr(body.mode) || "rewrite",
          expectedMtimeMs: toI64(body.expected_mtime_ms),
          expectedContentHash: trimStr(body.expected_content_hash),
          hasExpectedMtimeMs: body.expected_mtime_ms !== undefined,
          hasExpectedContentHash: body.expected_content_hash !== undefined,
        }),
      };
    case "fs.create_dir":
      return {
        case: "fsCreateDir",
        value: create(FsCreateDirRequestSchema, {
          workdir: trimStr(body.workdir),
          path: trimStr(body.path),
        }),
      };
    case "fs.rename":
      return {
        case: "fsRename",
        value: create(FsRenameRequestSchema, {
          workdir: trimStr(body.workdir),
          fromPath: trimStr(body.from_path),
          toPath: trimStr(body.to_path),
        }),
      };
    case "fs.delete":
      return {
        case: "fsDelete",
        value: create(FsDeleteRequestSchema, {
          workdir: trimStr(body.workdir),
          path: trimStr(body.path),
        }),
      };
    case "fs.read_editable_text":
      return {
        case: "fsReadEditableText",
        value: create(FsReadEditableTextRequestSchema, {
          workdir: trimStr(body.workdir),
          path: trimStr(body.path),
        }),
      };
    case "fs.read_workspace_image":
      return {
        case: "fsReadWorkspaceImage",
        value: create(FsReadWorkspaceImageRequestSchema, {
          workdir: trimStr(body.workdir),
          path: trimStr(body.path),
        }),
      };
    default:
      throw new Error(`unsupported gateway request type: ${type}`);
  }
}

// ---------------------------------------------------------------------------
// 入站：服务端帧解码
// ---------------------------------------------------------------------------

export type DecodedServerFrame =
  | {
      kind: "hello";
      requestId: string;
      ok: boolean;
      message: string;
      heartbeatPeriodSeconds: number;
      maxMessageBytes: number;
      serverTime: number;
    }
  | { kind: "ping"; timestamp: number }
  | { kind: "response"; requestId: string; agentId: string; payload: unknown }
  | { kind: "error"; requestId: string; agentId: string; message: string }
  | { kind: "event"; type: string; agentId: string; payload: unknown };

export function decodeServerFrameBinary(data: ArrayBuffer | Uint8Array): WebServerFrame {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return fromBinary(WebServerFrameSchema, bytes);
}

// 把一帧 WebServerFrame 归一化为分发单元。agentOnline 用于给 process.state
// 补齐客户端从 status 事件维护的在线位。
export function decodeServerFrame(
  frame: WebServerFrame,
  options: { agentOnline: boolean },
): DecodedServerFrame | null {
  const requestId = frame.requestId ?? "";
  const agentId = frame.agentId ?? "";
  const payload = frame.payload;
  switch (payload.case) {
    case "hello":
      return {
        kind: "hello",
        requestId,
        ok: payload.value.ok,
        message: payload.value.message,
        heartbeatPeriodSeconds: payload.value.heartbeatPeriodSeconds,
        maxMessageBytes: num(payload.value.maxMessageBytes),
        serverTime: num(payload.value.serverTime),
      };
    case "ping":
      return { kind: "ping", timestamp: num(payload.value.timestamp) };
    case "localError":
      return {
        kind: "error",
        requestId,
        agentId,
        message: payload.value.message || "Request failed",
      };
    case "agentResponse":
      try {
        return {
          kind: "response",
          requestId,
          agentId,
          payload: decodeAgentResponse(payload.value, options),
        };
      } catch (error) {
        return {
          kind: "error",
          requestId,
          agentId,
          message: error instanceof Error ? error.message : "Request failed",
        };
      }
    case "status":
      // status 臂身兼二职：带 request_id 是 status.get/chat.prepare 响应，空则为 status.event 广播。
      return requestId
        ? { kind: "response", requestId, agentId, payload: statusPayload(payload.value) }
        : { kind: "event", type: "status.event", agentId, payload: statusPayload(payload.value) };
    case "chatSubscribed":
      return {
        kind: "response",
        requestId,
        agentId,
        payload: chatSubscribedPayload(payload.value),
      };
    case "chatAccepted":
      return {
        kind: "response",
        requestId,
        agentId,
        payload: {
          run_id: payload.value.runId,
          conversation_id: payload.value.conversationId,
          accepted_seq: num(payload.value.acceptedSeq),
          deduped: payload.value.deduped,
        },
      };
    case "chatActivities":
      return {
        kind: "response",
        requestId,
        agentId,
        payload: {
          running_conversations: payload.value.runningConversations.map(runningConversationPayload),
        },
      };
    case "chatCancelled":
      return {
        kind: "response",
        requestId,
        agentId,
        payload: {
          ok: payload.value.ok,
          run_id: payload.value.runId,
          conversation_id: payload.value.conversationId,
        },
      };
    case "ack":
      return { kind: "response", requestId, agentId, payload: { ok: payload.value.ok } };
    case "chatEvent": {
      const parsed = parseJsonBytes(payload.value.payloadJson);
      return parsed === undefined
        ? null
        : { kind: "event", type: "chat.event", agentId, payload: parsed };
    }
    case "chatCommandUpdate":
      return {
        kind: "event",
        type: "chat.command_update",
        agentId,
        payload: chatCommandUpdatePayload(payload.value),
      };
    case "chatSubscriptionReset":
      return {
        kind: "event",
        type: "chat.subscription_reset",
        agentId,
        payload: { conversation_id: payload.value.conversationId },
      };
    case "chatActivity":
      return {
        kind: "event",
        type: "chat.activity",
        agentId,
        payload: chatActivityPayload(payload.value),
      };
    case "historyEvent":
      return {
        kind: "event",
        type: "history.event",
        agentId,
        payload: historyEventPayload(payload.value),
      };
    case "settingsEvent": {
      // settings_json 在客户端解析为现有设置事件对象。
      const parsed = settingsEventPayload(payload.value);
      return parsed === null
        ? null
        : { kind: "event", type: "settings.event", agentId, payload: parsed };
    }
    case "terminalEvent":
      return {
        kind: "event",
        type: "terminal.event",
        agentId,
        payload: terminalEventPayload(payload.value),
      };
    case "sftpEvent":
      return {
        kind: "event",
        type: "sftp.event",
        agentId,
        payload: sftpEventPayload(payload.value),
      };
    case "chatQueueEvent":
      return {
        kind: "event",
        type: "chat_queue.event",
        agentId,
        payload: chatQueueEventPayload(payload.value),
      };
    case "tunnelState":
      return {
        kind: "event",
        type: "tunnel.state",
        agentId,
        payload: tunnelStatePayload(payload.value),
      };
    case "processState":
      return {
        kind: "event",
        type: "process.state",
        agentId,
        payload: processStatePayload(payload.value, options.agentOnline),
      };
    case "agentList":
      return {
        kind: "response",
        requestId,
        agentId,
        payload: { agents: payload.value.agents.map(statusPayload) },
      };
    case "workspaceActivity":
      return {
        kind: "event",
        type: "workspace.activity",
        agentId,
        payload: workspaceActivityPayload(payload.value),
      };
    default:
      return null;
  }
}

function parseJsonBytes(bytes: Uint8Array): unknown {
  try {
    return parseJson(textDecoder.decode(bytes));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 直通响应（AgentEnvelope）→ gatewaySocket 响应对象
// ---------------------------------------------------------------------------

function decodeAgentResponse(envelope: AgentEnvelope, options: { agentOnline: boolean }): unknown {
  const payload = envelope.payload;
  switch (payload.case) {
    case "error":
      frameError(payload.value.message || "Request failed");
      break;
    case "historyListResp":
      // running_conversations 由 gatewaySocket 侧经 chat.activities 帧合并。
      return {
        conversations: payload.value.conversations.map(conversationSummaryPayload),
        total_count: payload.value.totalCount,
      };
    case "historyGetResp":
    case "historyPrefixResp":
      return {
        conversation_id: payload.value.conversationId,
        messages_json: payload.value.messagesJson,
        total_message_count: payload.value.totalMessageCount,
        returned_message_count: payload.value.returnedMessageCount,
        has_more: payload.value.hasMore,
        conversation: payload.value.conversation
          ? conversationSummaryPayload(payload.value.conversation)
          : null,
      };
    case "historyRenameResp":
    case "historyBranchResp":
    case "historyPinResp":
      if (!payload.value.conversation) {
        frameError("unexpected agent response");
      }
      return conversationSummaryPayload(payload.value.conversation);
    case "historyShareGetResp":
    case "historyShareSetResp":
      if (!payload.value.share) {
        frameError("unexpected agent response");
      }
      return historyShareStatusPayload(payload.value.share);
    case "historyDeleteResp":
      return { ok: true };
    case "historyWorkdirsResp":
      return {
        workdirs: payload.value.workdirs.map((workdir) => ({
          path: workdir.path,
          conversation_count: workdir.conversationCount,
          updated_at: num(workdir.updatedAt),
        })),
      };
    case "providerListResp": {
      const raw = payload.value.providersJson.trim();
      if (!raw) return [];
      try {
        return parseJson(raw);
      } catch {
        frameError("provider list response is not valid JSON");
      }
      break;
    }
    case "providerModelsResp":
      try {
        return parseJson(payload.value.modelsJson);
      } catch {
        frameError("provider model response is not valid JSON");
      }
      break;
    case "settingsGetResp": {
      const raw = payload.value.settingsJson.trim();
      if (!raw) return {};
      try {
        const parsed = parseJson(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch {
        frameError("gateway settings payload is not valid JSON");
      }
      break;
    }
    case "settingsUpdateResp":
      return { accepted: payload.value.accepted, message: payload.value.message.trim() };
    case "settingsResetSshKnownHostResp":
      return { deleted: payload.value.deleted };
    case "skillFilesListResp":
      return {
        rootDir: payload.value.rootDir,
        paths: payload.value.paths,
        truncated: payload.value.truncated,
      };
    case "skillMetadataReadResp": {
      const name = payload.value.name.trim();
      const description = payload.value.description.trim();
      return { name: name || null, description: description || null };
    }
    case "skillTextReadResp":
      return { content: payload.value.content, truncated: payload.value.truncated };
    case "skillManageResp": {
      const raw = payload.value.resultJson.trim();
      if (!raw) return {};
      try {
        return parseJson(raw);
      } catch {
        frameError("skill manage response is not valid JSON");
      }
      break;
    }
    case "fileMentionListResp":
      return {
        entries: payload.value.entries.map((entry) => ({
          path: entry.path,
          kind: entry.kind,
          hidden: entry.hidden,
        })),
        truncated: payload.value.truncated,
      };
    case "uploadedImagePreviewResp":
      return { mimeType: payload.value.mimeType, data: payload.value.data };
    case "memoryManageResp":
      return unmarshalJsonPayload(payload.value.resultJson);
    case "cronManageResp":
      return { action: payload.value.action, result_json: payload.value.resultJson };
    case "fsRootsResp":
      return {
        roots: payload.value.roots.map((root) => ({
          id: root.id,
          path: root.path,
          kind: root.kind,
          label: root.label,
        })),
      };
    case "fsListDirsResp":
      return {
        path: payload.value.path.trim(),
        entries: payload.value.entries.map((entry) => ({ path: entry.path, name: entry.name })),
        truncated: payload.value.truncated,
      };
    case "fsCreateProjectFolderResp":
      return { path: payload.value.path.trim() };
    case "fsListResp":
      return {
        path: payload.value.hasPath ? payload.value.path : null,
        depth: payload.value.depth,
        offset: payload.value.offset,
        maxResults: payload.value.maxResults,
        total: payload.value.total,
        hasMore: payload.value.hasMore,
        entries: payload.value.entries.map((entry) => ({
          path: entry.path,
          kind: entry.kind,
          hidden: entry.hidden,
        })),
      };
    case "fsReadEditableTextResp":
      return {
        path: payload.value.path,
        content: payload.value.content,
        mtimeMs: num(payload.value.mtimeMs),
        contentHash: payload.value.contentHash,
        sizeBytes: num(payload.value.sizeBytes),
        totalLines: num(payload.value.totalLines),
      };
    case "fsReadWorkspaceImageResp":
      return {
        path: payload.value.path,
        mimeType: payload.value.mimeType,
        data: payload.value.data,
        sizeBytes: num(payload.value.sizeBytes),
        mtimeMs: num(payload.value.mtimeMs),
        contentHash: payload.value.contentHash,
      };
    case "fsWriteTextResp":
      return {
        path: payload.value.path,
        mode: payload.value.mode,
        existedBefore: payload.value.existedBefore,
        bytesWritten: num(payload.value.bytesWritten),
        mtimeMs: num(payload.value.mtimeMs),
        contentHash: payload.value.contentHash,
        totalLines: num(payload.value.totalLines),
      };
    case "fsCreateDirResp":
      return { path: payload.value.path, kind: payload.value.kind };
    case "fsRenameResp":
      return {
        fromPath: payload.value.fromPath,
        path: payload.value.path,
        kind: payload.value.kind,
      };
    case "fsDeleteResp":
      return { path: payload.value.path, kind: payload.value.kind };
    case "gitResponse":
      return unmarshalJsonPayload(payload.value.resultJson);
    case "sftpResponse":
      return sftpResponsePayload(payload.value);
    case "chatQueueResp":
      return {
        accepted: payload.value.accepted,
        message: payload.value.message,
        snapshot_json: payload.value.snapshotJson,
        item_json: payload.value.itemJson,
        error_code: payload.value.errorCode,
        revision: num(payload.value.revision),
      };
    case "terminalResponse":
      return terminalResponsePayload(payload.value);
    case "tunnelMutationResult":
      if (payload.value.errorMessage) {
        frameError(payload.value.errorMessage);
      }
      return { tunnel_id: payload.value.tunnelId };
    case "managedProcessResponse":
      return managedProcessResponsePayload(payload.value, options.agentOnline);
    default:
      frameError("unexpected agent response");
  }
}

function unmarshalJsonPayload(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed = parseJson(trimmed);
    return parsed ?? {};
  } catch {
    frameError("response is not valid JSON");
  }
}

// ---------------------------------------------------------------------------
// gatewaySocket 载荷塑形
// ---------------------------------------------------------------------------

// 对应 websocketConversationSummaryPayload：protojson UseProtoNames+EmitUnpopulated（全字段恒出现），
// 64 位数字转 number。
function conversationSummaryPayload(conversation: ConversationSummary): J {
  return {
    id: conversation.id,
    title: conversation.title,
    created_at: num(conversation.createdAt),
    updated_at: num(conversation.updatedAt),
    message_count: conversation.messageCount,
    provider_id: conversation.providerId,
    model: conversation.model,
    session_id: conversation.sessionId,
    cwd: conversation.cwd,
    is_pinned: conversation.isPinned,
    pinned_at: num(conversation.pinnedAt),
    is_shared: conversation.isShared,
    selected_model_json: conversation.selectedModelJson,
  };
}

function historyShareStatusPayload(share: HistoryShareStatus): J {
  return {
    conversation_id: share.conversationId,
    enabled: share.enabled,
    token: share.token,
    created_at: num(share.createdAt),
    updated_at: num(share.updatedAt),
    redact_tool_content: share.redactToolContent,
  };
}

function historyEventPayload(event: HistorySyncEvent): J {
  const payload: J = {
    kind: event.kind.trim(),
    conversation_id: event.conversationId.trim(),
  };
  if (event.conversation) {
    payload.conversation = conversationSummaryPayload(event.conversation);
  }
  return payload;
}

function settingsEventPayload(event: SettingsSyncEvent): J | null {
  const raw = event.settingsJson.trim();
  if (!raw) return {};
  try {
    const parsed = parseJson(raw);
    return parsed && typeof parsed === "object" ? (parsed as J) : {};
  } catch {
    return null;
  }
}

function chatQueueEventPayload(event: ChatQueueEvent): J {
  return {
    conversation_id: event.conversationId.trim(),
    snapshot_json: event.snapshotJson.trim(),
    revision: num(event.revision),
  };
}

function workspaceActivityPayload(event: WorkspaceActivityEvent): J {
  return {
    workdir: event.workdir,
    revision: num(event.revision),
    fs: event.fs,
    git: event.git,
    changedPaths: event.changedPaths,
    truncated: event.truncated,
  };
}

// 对应 session.Status 的 json tag（含 omitempty 语义）。
function statusPayload(status: StatusEvent): J {
  const payload: J = {
    online: status.online,
    agent_ready: status.agentReady,
    chat_runtime_ready: status.chatRuntimeReady,
    agent_id: status.agentId,
    agent_version: status.agentVersion,
    connected_since: num(status.connectedSince),
    last_heartbeat: num(status.lastHeartbeat),
  };
  if (status.sessionId) payload.session_id = status.sessionId;
  if (status.runtimeState) payload.runtime_state = status.runtimeState;
  if (num(status.runtimeLastHeartbeat) !== 0) {
    payload.runtime_last_heartbeat = num(status.runtimeLastHeartbeat);
  }
  if (status.runtimeWorkerId) payload.runtime_worker_id = status.runtimeWorkerId;
  if (status.runtimeVisible) payload.runtime_visible = status.runtimeVisible;
  if (status.runtimeActiveRunCount) {
    payload.runtime_active_run_count = status.runtimeActiveRunCount;
  }
  if (status.name) payload.name = status.name;
  return payload;
}

// 对应 websocketRunActivityPayload（updated_at 为 Unix 毫秒）。
function runActivityPayload(activity: ChatRunActivity | undefined): J | null {
  if (!activity || !activity.runId) return null;
  const payload: J = {
    run_id: activity.runId,
    state: activity.state,
    started_seq: num(activity.startedSeq),
    updated_at: num(activity.updatedAtMs),
  };
  if (activity.toolStatus) {
    payload.tool_status = activity.toolStatus;
    payload.tool_status_is_compaction = activity.toolStatusIsCompaction;
  }
  if (activity.clientRequestId) {
    payload.client_request_id = activity.clientRequestId;
  }
  return payload;
}

function runSnapshotPayload(snapshot: ChatRunSnapshot | undefined): J | null {
  if (!snapshot || !snapshot.runId) return null;
  return {
    run_id: snapshot.runId,
    revision: num(snapshot.revision),
    entries_json: snapshot.entriesJson,
    tool_status: snapshot.toolStatus,
    tool_status_is_compaction: snapshot.toolStatusIsCompaction,
    as_of_seq: num(snapshot.asOfSeq),
  };
}

function chatSubscribedPayload(result: ChatSubscribeResult): J {
  const events: unknown[] = [];
  for (const raw of result.eventsJson) {
    const parsed = parseJsonBytes(raw);
    if (parsed !== undefined) {
      events.push(parsed);
    }
  }
  return {
    conversation_id: result.conversationId,
    stream_epoch: result.streamEpoch,
    latest_seq: num(result.latestSeq),
    reset: result.reset,
    activity: runActivityPayload(result.activity),
    snapshot: runSnapshotPayload(result.snapshot),
    events,
  };
}

// 对应 websocketRunningConversationsPayload（workdir 映射为 cwd）。
function runningConversationPayload(activity: ChatRunActivity): J {
  return {
    conversation_id: activity.conversationId,
    run_id: activity.runId,
    state: activity.state,
    cwd: activity.workdir,
    updated_at: num(activity.updatedAtMs),
  };
}

// 对应 websocketChatActivityPayload（可选键仅在非空时出现）。
function chatActivityPayload(event: ChatActivityEvent): J {
  const payload: J = {
    conversation_id: event.conversationId,
    running: event.running,
    updated_at: num(event.updatedAtMs),
  };
  if (event.runId) payload.run_id = event.runId;
  if (event.clientRequestId) payload.client_request_id = event.clientRequestId;
  if (event.state) payload.state = event.state;
  if (event.workdir) payload.workdir = event.workdir;
  return payload;
}

function chatCommandUpdatePayload(update: ChatCommandUpdate): J {
  const payload: J = {
    run_id: update.runId,
    client_request_id: update.clientRequestId,
    phase: update.phase,
  };
  if (update.conversationId) payload.conversation_id = update.conversationId;
  if (update.errorCode) payload.error_code = update.errorCode;
  if (update.message) payload.message = update.message;
  return payload;
}

// ---------------------------------------------------------------------------
// 终端 / SFTP / 隧道 / 进程载荷（对应 websocket_payloads.go 等）
// ---------------------------------------------------------------------------

export function terminalSessionPayload(session: TerminalSession | undefined): J | null {
  if (!session) return null;
  const kind = session.kind.trim() === "ssh" ? "ssh" : "local";
  const payload: J = {
    id: session.id.trim(),
    project_path_key: session.projectPathKey.trim(),
    cwd: session.cwd.trim(),
    shell: session.shell.trim(),
    title: session.title.trim(),
    kind,
    pid: session.pid,
    cols: session.cols,
    rows: session.rows,
    created_at: num(session.createdAt),
    updated_at: num(session.updatedAt),
    finished_at: num(session.finishedAt),
    exit_code: session.exitCode,
    running: session.running,
  };
  if (session.pid === 0) payload.pid = null;
  if (num(session.finishedAt) === 0) payload.finished_at = null;
  if (kind === "ssh") payload.pid = null;
  if (session.ssh) {
    payload.ssh = {
      host_id: session.ssh.hostId.trim(),
      host_name: session.ssh.hostName.trim(),
      username: session.ssh.username.trim(),
      host: session.ssh.host.trim(),
      port: session.ssh.port,
      auth_type: session.ssh.authType.trim(),
      status: session.ssh.status.trim(),
      reconnect_attempt: session.ssh.reconnectAttempt,
      reconnect_max_attempts: session.ssh.reconnectMaxAttempts,
      sftp_enabled: session.ssh.sftpEnabled,
      sftpEnabled: session.ssh.sftpEnabled,
    };
  }
  return payload;
}

function terminalSshTabsPayload(snapshot: TerminalSshTabsSnapshot | undefined): J | null {
  if (!snapshot) return null;
  return {
    project_path_key: snapshot.projectPathKey.trim(),
    tabs: snapshot.tabs.map((tab) => ({
      id: tab.id.trim(),
      session_id: tab.sessionId.trim(),
      project_path_key: tab.projectPathKey.trim(),
      kind: tab.kind.trim(),
      created_at: num(tab.createdAt),
      updated_at: num(tab.updatedAt),
    })),
    revision: num(snapshot.revision),
  };
}

function terminalResponsePayload(resp: TerminalResponse): J {
  const sessions: J[] = [];
  for (const session of resp.sessions) {
    const payload = terminalSessionPayload(session);
    if (payload) sessions.push(payload);
  }
  const payload: J = {
    action: resp.action.trim(),
    sessions,
    output: textDecoder.decode(resp.output),
    output_bytes: resp.output,
    truncated: resp.truncated,
    shell_options: resp.shellOptions.map((option) => ({
      id: option.id.trim(),
      label: option.label.trim(),
      command: option.command.trim(),
    })),
    default_shell: resp.defaultShell,
  };
  if (
    num(resp.outputStartOffset) !== 0 ||
    num(resp.outputEndOffset) !== 0 ||
    resp.output.length > 0
  ) {
    payload.output_start_offset = num(resp.outputStartOffset);
    payload.output_end_offset = num(resp.outputEndOffset);
  }
  if (resp.latencyMs > 0) payload.latency_ms = resp.latencyMs;
  const session = terminalSessionPayload(resp.session);
  if (session) payload.session = session;
  if (resp.sshPrompt) {
    payload.ssh_prompt = {
      id: resp.sshPrompt.id.trim(),
      kind: resp.sshPrompt.kind.trim(),
      host_id: resp.sshPrompt.hostId.trim(),
      host_name: resp.sshPrompt.hostName.trim(),
      host: resp.sshPrompt.host.trim(),
      port: resp.sshPrompt.port,
      message: resp.sshPrompt.message.trim(),
      fingerprint_sha256: resp.sshPrompt.fingerprintSha256.trim(),
      key_type: resp.sshPrompt.keyType.trim(),
      answer_echo: resp.sshPrompt.answerEcho,
    };
  }
  const sshTabs = terminalSshTabsPayload(resp.sshTabs);
  if (sshTabs) payload.ssh_tabs = sshTabs;
  return payload;
}

function terminalEventPayload(event: TerminalEvent): J {
  const payload: J = {
    kind: event.kind.trim(),
    session_id: event.sessionId.trim(),
    project_path_key: event.projectPathKey.trim(),
  };
  if (event.data.length > 0) {
    payload.data = textDecoder.decode(event.data);
    payload.data_bytes = event.data;
  }
  if (
    num(event.outputStartOffset) !== 0 ||
    num(event.outputEndOffset) !== 0 ||
    event.data.length > 0
  ) {
    payload.output_start_offset = num(event.outputStartOffset);
    payload.output_end_offset = num(event.outputEndOffset);
  }
  const session = terminalSessionPayload(event.session);
  if (session) payload.session = session;
  const sshTabs = terminalSshTabsPayload(event.sshTabs);
  if (sshTabs) payload.ssh_tabs = sshTabs;
  return payload;
}

function sftpEntryPayload(entry: SftpEntry): J {
  return {
    path: entry.path,
    name: entry.name,
    kind: entry.kind.trim(),
    sizeBytes: num(entry.sizeBytes),
    size_bytes: num(entry.sizeBytes),
    mtime: num(entry.mtime),
  };
}

function sftpTransferPayload(transfer: SftpTransfer): J {
  return {
    id: transfer.id.trim(),
    sessionId: transfer.sessionId.trim(),
    session_id: transfer.sessionId.trim(),
    direction: transfer.direction.trim(),
    status: transfer.status.trim(),
    sourcePath: transfer.sourcePath,
    source_path: transfer.sourcePath,
    targetPath: transfer.targetPath,
    target_path: transfer.targetPath,
    currentPath: transfer.currentPath,
    current_path: transfer.currentPath,
    bytesDone: num(transfer.bytesDone),
    bytes_done: num(transfer.bytesDone),
    bytesTotal: num(transfer.bytesTotal),
    bytes_total: num(transfer.bytesTotal),
    filesDone: transfer.filesDone,
    files_done: transfer.filesDone,
    filesTotal: transfer.filesTotal,
    files_total: transfer.filesTotal,
    error: transfer.error.trim(),
  };
}

function sftpResponsePayload(resp: SftpResponse): J {
  const payload: J = {
    action: resp.action.trim(),
    path: resp.path,
    exists: resp.exists,
    entries: resp.entries.map(sftpEntryPayload),
  };
  if (resp.entry) payload.entry = sftpEntryPayload(resp.entry);
  if (resp.transfer) payload.transfer = sftpTransferPayload(resp.transfer);
  return payload;
}

function sftpEventPayload(event: SftpEvent): J {
  const payload: J = { kind: event.kind.trim() };
  if (event.transfer) payload.transfer = sftpTransferPayload(event.transfer);
  return payload;
}

function tunnelHealthPayload(health: TunnelHealth | undefined): J | null {
  if (!health) return null;
  return {
    status: health.status,
    http_status: health.httpStatus,
    error: health.error,
    checked_at: num(health.checkedAt),
    rtt_ms: health.rttMs,
  };
}

function tunnelStatePayload(snapshot: TunnelStateSnapshot): J {
  return {
    revision: num(snapshot.revision),
    agent_online: snapshot.agentOnline,
    relay: tunnelHealthPayload(snapshot.relay),
    tunnels: snapshot.tunnels.map((tunnel) => ({
      id: tunnel.id,
      slug: tunnel.slug,
      name: tunnel.name,
      target_url: tunnel.targetUrl,
      public_path: tunnel.publicPath,
      created_at: num(tunnel.createdAt),
      expires_at: num(tunnel.expiresAt),
      active_connections: tunnel.activeConnections,
      project_path_key: tunnel.projectPathKey,
      local: tunnelHealthPayload(tunnel.local),
    })),
  };
}

// 托管进程载荷；agent_online 由客户端维护的 status 在线位注入。
function processStatePayload(
  snapshot: ManagedProcessSnapshot | undefined,
  agentOnline: boolean,
): J {
  const processes: J[] = [];
  let revision = 0;
  if (snapshot) {
    revision = num(snapshot.revision);
    for (const record of snapshot.processes) {
      const entry: J = {
        id: record.id,
        label: record.label,
        command: record.command,
        cwd: record.cwd,
        shell: record.shell,
        pid: record.pid,
        log_path: record.logPath,
        started_at: num(record.startedAt),
        running: record.running,
        isolated: record.isolated,
        restored: record.restored,
      };
      if (record.finishedAt !== undefined) entry.finished_at = num(record.finishedAt);
      if (record.exitCode !== undefined) entry.exit_code = record.exitCode;
      processes.push(entry);
    }
  }
  return { revision, agent_online: agentOnline, processes };
}

function managedProcessResponsePayload(
  resp: ManagedProcessResponse,
  agentOnline: boolean,
): unknown {
  const action = resp.action.trim();
  switch (action) {
    case "snapshot":
      // process.snapshot 返回扁平状态载荷。
      return processStatePayload(resp.snapshot, agentOnline);
    case "stop":
      return {
        action,
        stopped: resp.stopped,
        state: processStatePayload(resp.snapshot, agentOnline),
      };
    case "clear":
      return { action, state: processStatePayload(resp.snapshot, agentOnline) };
    case "read_log":
      return {
        action,
        log_content: resp.logContent,
        log_path: resp.logPath,
        log_truncated: resp.logTruncated,
      };
    default:
      return { action };
  }
}

// ---------------------------------------------------------------------------
// 终端数据面（/ws/v2/terminal）帧编解码
// ---------------------------------------------------------------------------

// TerminalWireHeader 保持旧自定义帧头字段命名，上层 attach/snapshot/output/error 路由无需感知 proto 化。
export type TerminalWireHeader = {
  kind?: string;
  streamId?: string;
  sessionId?: string;
  projectPathKey?: string;
  seq?: number;
  startOffset?: number;
  endOffset?: number;
  cols?: number;
  rows?: number;
  maxBytes?: number;
  truncated?: boolean;
  error?: string;
  session?: unknown;
};

// agentId 通过 hello.agent_id 显式绑定终端数据面的目标 Agent。
export function encodeTerminalHelloFrame(token: string, agentId: string): WireBytes {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) {
    throw new Error("agent_id is required");
  }
  const frame = create(TerminalClientFrameSchema, {
    payload: {
      case: "hello",
      value: create(ClientHelloSchema, {
        protocolVersion: GATEWAY_V2_PROTOCOL_VERSION,
        role: ClientRole.BROWSER,
        token,
        agentId: normalizedAgentId,
        clientName: "webui",
        clientVersion: "",
      }),
    },
  });
  return wireBytes(toBinary(TerminalClientFrameSchema, frame));
}

export function encodeTerminalStreamFrame(
  header: TerminalWireHeader,
  data: Uint8Array = new Uint8Array(),
): WireBytes {
  const frame = create(TerminalClientFrameSchema, {
    payload: {
      case: "frame",
      value: create(TerminalStreamFrameSchema, {
        kind: header.kind?.trim() ?? "",
        streamId: header.streamId ?? "",
        sessionId: header.sessionId ?? "",
        projectPathKey: header.projectPathKey ?? "",
        seq: toI64(header.seq),
        startOffset: toI64(header.startOffset),
        endOffset: toI64(header.endOffset),
        cols: n32(header.cols),
        rows: n32(header.rows),
        maxBytes: n32(header.maxBytes),
        truncated: header.truncated === true,
        error: header.error ?? "",
        data,
      }),
    },
  });
  return wireBytes(toBinary(TerminalClientFrameSchema, frame));
}

export type DecodedTerminalServerFrame =
  | { kind: "hello"; ok: boolean; message: string }
  | { kind: "frame"; header: TerminalWireHeader; data: Uint8Array };

export function decodeTerminalServerFrame(
  data: ArrayBuffer | Uint8Array,
): DecodedTerminalServerFrame | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let frame: TerminalServerFrame;
  try {
    frame = fromBinary(TerminalServerFrameSchema, bytes);
  } catch {
    return null;
  }
  const payload = frame.payload;
  if (payload.case === "hello") {
    return { kind: "hello", ok: payload.value.ok, message: payload.value.message };
  }
  if (payload.case === "frame") {
    return { kind: "frame", header: terminalStreamHeader(payload.value), data: payload.value.data };
  }
  return null;
}

function terminalStreamHeader(frame: TerminalStreamFrame): TerminalWireHeader {
  return {
    kind: frame.kind,
    streamId: frame.streamId,
    sessionId: frame.sessionId,
    projectPathKey: frame.projectPathKey,
    seq: num(frame.seq),
    startOffset: num(frame.startOffset),
    endOffset: num(frame.endOffset),
    cols: frame.cols,
    rows: frame.rows,
    maxBytes: frame.maxBytes,
    truncated: frame.truncated,
    error: frame.error,
    session: terminalSessionPayload(frame.session) ?? undefined,
  };
}
