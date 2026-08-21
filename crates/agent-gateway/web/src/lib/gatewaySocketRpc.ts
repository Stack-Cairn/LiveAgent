import { buildHistoryMessageRefPayload } from "@liveagent/ui/lib/chat/historyMessageRef";
import type {
  GatewaySettingsSyncPayload,
  GatewaySettingsSyncUpdatePayload,
} from "@liveagent/ui/lib/settings/sync";
import {
  normalizeSftpActionResponse,
  normalizeSftpListResponse,
  normalizeSftpReadTextResponse,
  normalizeSftpStatResponse,
  normalizeSftpTransferResponse,
  type RawSftpResponse,
} from "@liveagent/ui/lib/sftp/normalization";
import type {
  SftpActionResponse,
  SftpListResponse,
  SftpReadTextResponse,
  SftpStatResponse,
  SftpTransferResponse,
} from "@liveagent/ui/lib/sftp/types";
import {
  buildTerminalCreatePayload,
  buildTerminalSshCreatePayload,
  buildTerminalSshPromptAnswerPayload,
  normalizeSshTerminalTabsSnapshot,
  normalizeTerminalSession,
  normalizeTerminalShellOptions,
  normalizeTerminalSnapshot,
  normalizeTerminalSshCreateResult,
  normalizeTerminalSshLatency,
} from "@liveagent/ui/lib/terminal/normalization";
import type {
  SshLocalForwardAction,
  SshLocalForwardEvent,
  SshLocalForwardSnapshot,
} from "@liveagent/ui/lib/terminal/sshLocalForwardTypes";
import {
  normalizeSshLocalForwardAction,
  normalizeSshLocalForwardSnapshot,
} from "@liveagent/ui/lib/terminal/sshLocalForwardTypes";
import type {
  SshTerminalTabKind,
  SshTerminalTabsSnapshot,
  TerminalSession,
  TerminalShellOptions,
  TerminalSnapshot,
  TerminalSshCreateResult,
  TerminalSshLatency,
} from "@liveagent/ui/lib/terminal/types";
import type { TunnelCreateInput, TunnelUpdateInput } from "@liveagent/ui/lib/tunnels/constants";
import type { HistoryMessageRef } from "@/lib/chat/conversationState";
import type {
  ChatCommandAccepted,
  ConversationStreamHandlers,
} from "@/lib/chat/stream/streamTypes";
import {
  buildChatCommandPayload,
  CHAT_COMMAND_ACK_TIMEOUT_MS,
  type ChatActivityListener,
  type ChatCommandUpdateListener,
  type ChatFileOpenResponse,
  type ChatQueueListener,
  type CheckpointDiffStats,
  type CheckpointRewindResult,
  type CheckpointTurnSummary,
  type FsCreateDirResponse,
  type FsDeleteResponse,
  type FsListDirsResponse,
  type FsListResponse,
  type FsReadEditableTextResponse,
  type FsReadWorkspaceImageResponse,
  type FsRenameResponse,
  type FsRootsResponse,
  type FsWriteTextResponse,
  type GatewayChatCommandInput,
  type GatewaySettingsUpdateResponse,
  type GatewayWorkspaceRootGrant,
  type GatewayWorkspaceRootGrantDraft,
  type GatewayWorkspaceRootGrantsResponse,
  type HistoryGetOptions,
  isConnectionSetupTimeoutError,
  isRecoverableGatewayTransportError,
  isRequestTimeoutError,
  type ManagedProcessLogPayload,
  type ManagedProcessStatePayload,
  type MentionListResponse,
  normalizeChatQueueResponse,
  normalizeHistoryListPage,
  normalizeHistoryListPageSize,
  normalizeManagedProcessState,
  normalizeTerminalBytes,
  type RawChatCommandResponse,
  type RawChatQueueResponse,
  type RawManagedProcessOpPayload,
  type RawManagedProcessStatePayload,
  type RawTerminalResponse,
  type SkillListResponse,
  type SkillManagePayload,
  type SkillMetadataResponse,
  type SkillTextResponse,
  type SshKnownHostResetResult,
  sftpPathPayload,
  shouldRecoverMemoryManageRequest,
  type UploadedImagePreviewResponse,
} from "./gatewaySocketShared";
import { GatewayWebSocketTransport } from "./gatewaySocketTransport";
import type {
  ChatQueueResponse,
  ConversationSummary,
  CreateProjectFolderResponse,
  CronManagePayload,
  CronManageResponse,
  GatewayProviderSummary,
  HistoryDetail,
  HistoryList,
  HistoryListFilter,
  HistoryShareStatus,
  HistoryWorkdirsResponse,
  MemoryManagePayload,
  RunningConversationSummary,
} from "./gatewayTypes";

const LEGACY_SETTINGS_CHANGED_MESSAGE = "SSH 设置已在另一端更新，已刷新为最新状态，请重新提交。";

export type GatewaySettingsUpdateErrorCode = "settings_changed";

export class GatewaySettingsUpdateError extends Error {
  readonly code: GatewaySettingsUpdateErrorCode;
  readonly responseMessage: string;

  constructor(code: GatewaySettingsUpdateErrorCode, responseMessage: string) {
    super(responseMessage || "Gateway settings update rejected");
    this.name = "GatewaySettingsUpdateError";
    this.code = code;
    this.responseMessage = responseMessage;
  }
}

export class GatewayWebSocketRpcClient extends GatewayWebSocketTransport {
  subscribeChatQueue(listener: ChatQueueListener): () => void {
    this.chatQueueListeners.add(listener);
    return () => {
      this.chatQueueListeners.delete(listener);
    };
  }

  async chatQueueGet(conversationId: string): Promise<ChatQueueResponse> {
    return normalizeChatQueueResponse(
      await this.requestWithRecovery<RawChatQueueResponse>("chat_queue.get", {
        conversation_id: conversationId,
      }),
    );
  }

  async chatQueueGetItem(conversationId: string, itemId: string): Promise<ChatQueueResponse> {
    return normalizeChatQueueResponse(
      await this.requestWithRecovery<RawChatQueueResponse>("chat_queue.get_item", {
        conversation_id: conversationId,
        item_id: itemId,
      }),
    );
  }

  async chatQueueRunNow(conversationId: string, itemId: string): Promise<ChatQueueResponse> {
    return normalizeChatQueueResponse(
      await this.requestWithRecovery<RawChatQueueResponse>("chat_queue.run_now", {
        conversation_id: conversationId,
        item_id: itemId,
      }),
    );
  }

  // 用量环触发的手动压缩：中继到桌面端执行（受理即回包，进度与带
  // operationId 的终态分别经聊天流回传）。
  async chatQueueCompactNow(
    conversationId: string,
    operationId: string,
  ): Promise<ChatQueueResponse> {
    return normalizeChatQueueResponse(
      await this.requestWithRecovery<RawChatQueueResponse>("chat_queue.compact_now", {
        conversation_id: conversationId,
        request_json: JSON.stringify({ operationId }),
      }),
    );
  }

  async chatQueueMove(
    conversationId: string,
    itemId: string,
    direction: "up" | "down",
  ): Promise<ChatQueueResponse> {
    return normalizeChatQueueResponse(
      await this.requestWithRecovery<RawChatQueueResponse>("chat_queue.move", {
        conversation_id: conversationId,
        item_id: itemId,
        direction,
      }),
    );
  }

  async chatQueueRemove(conversationId: string, itemId: string): Promise<ChatQueueResponse> {
    return normalizeChatQueueResponse(
      await this.requestWithRecovery<RawChatQueueResponse>("chat_queue.remove", {
        conversation_id: conversationId,
        item_id: itemId,
      }),
    );
  }

  async chatQueueEditBegin(conversationId: string, itemId: string): Promise<ChatQueueResponse> {
    return normalizeChatQueueResponse(
      await this.requestWithRecovery<RawChatQueueResponse>("chat_queue.edit_begin", {
        conversation_id: conversationId,
        item_id: itemId,
      }),
    );
  }

  async chatQueueEditCommit(input: {
    conversationId: string;
    itemId: string;
    revision: number;
    draftJson: string;
    uploadedFilesJson: string;
  }): Promise<ChatQueueResponse> {
    return normalizeChatQueueResponse(
      await this.requestWithRecovery<RawChatQueueResponse>("chat_queue.edit_commit", {
        conversation_id: input.conversationId,
        item_id: input.itemId,
        revision: input.revision,
        draft_json: input.draftJson,
        uploaded_files_json: input.uploadedFilesJson,
      }),
    );
  }

  async chatQueueEditCancel(conversationId: string, itemId: string): Promise<ChatQueueResponse> {
    return normalizeChatQueueResponse(
      await this.requestWithRecovery<RawChatQueueResponse>("chat_queue.edit_cancel", {
        conversation_id: conversationId,
        item_id: itemId,
      }),
    );
  }

  /** 应答桌面端挂起的 AskUserQuestion：item_id 为 toolCallId，request_json 为选择数组。 */
  async chatQueueToolAnswer(
    conversationId: string,
    toolCallId: string,
    answersJson: string,
  ): Promise<ChatQueueResponse> {
    return normalizeChatQueueResponse(
      await this.requestWithRecovery<RawChatQueueResponse>("chat_queue.tool_answer", {
        conversation_id: conversationId,
        item_id: toolCallId,
        request_json: answersJson,
      }),
    );
  }

  /** 提交对桌面端挂起工具审批的决定：item_id 为 toolCallId，request_json 为 {"decision":...}。 */
  async chatQueueToolApproval(
    conversationId: string,
    toolCallId: string,
    decisionJson: string,
  ): Promise<ChatQueueResponse> {
    return normalizeChatQueueResponse(
      await this.requestWithRecovery<RawChatQueueResponse>("chat_queue.tool_approval", {
        conversation_id: conversationId,
        item_id: toolCallId,
        request_json: decisionJson,
      }),
    );
  }

  /** 提交对桌面端挂起计划的决定：item_id 为 toolCallId，request_json 为 {"decision":...,"feedback"?}。 */
  async chatQueuePlanDecision(
    conversationId: string,
    toolCallId: string,
    decisionJson: string,
  ): Promise<ChatQueueResponse> {
    return normalizeChatQueueResponse(
      await this.requestWithRecovery<RawChatQueueResponse>("chat_queue.plan_decision", {
        conversation_id: conversationId,
        item_id: toolCallId,
        request_json: decisionJson,
      }),
    );
  }

  // Submit a chat command. Streaming does not hang off the command: the
  // conversation subscription (persistent, run-agnostic) carries the reply.
  async chatCommand(input: GatewayChatCommandInput): Promise<ChatCommandAccepted> {
    if (this.token.trim() === "") {
      throw new Error("Gateway token is required");
    }
    // Build exactly once: the gateway deduplicates by client_request_id, so a
    // lost acknowledgement can be retried after reconnect without dispatching
    // a second desktop run. Rebuilding here could generate a different id for
    // callers that omitted one and would defeat that guarantee.
    const payload = buildChatCommandPayload(input);
    const request = () =>
      this.request<RawChatCommandResponse>("chat.command", payload, {
        timeoutMs: CHAT_COMMAND_ACK_TIMEOUT_MS,
      });
    let response: RawChatCommandResponse;
    try {
      response = await request();
    } catch (error) {
      if (
        this.disposed ||
        (!isRecoverableGatewayTransportError(error) &&
          !isRequestTimeoutError(error) &&
          !isConnectionSetupTimeoutError(error))
      ) {
        throw error;
      }
      if (this.socket || this.connectPromise) {
        this.handleDisconnect(
          this.buildTransportStallError("while recovering chat command acknowledgement"),
        );
      }
      try {
        await this.ensureConnected();
      } catch {
        // The forced disconnect may have rejected an in-flight connect
        // attempt whose settled promise ensureConnected replays; one fresh
        // attempt follows it so the retry actually reaches the wire.
        await this.ensureConnected();
      }
      response = await request();
    }
    const runId = String(response.run_id ?? "").trim();
    if (!runId) {
      throw new Error("Gateway chat command returned no run_id");
    }
    return {
      runId,
      conversationId:
        String(response.conversation_id ?? "").trim() || input.conversationId?.trim() || "",
      acceptedSeq:
        typeof response.accepted_seq === "number" && Number.isFinite(response.accepted_seq)
          ? response.accepted_seq
          : 0,
    };
  }

  // Persistent per-conversation stream subscription with built-in resume.
  subscribeConversationStream(
    conversationId: string,
    handlers: ConversationStreamHandlers,
  ): () => void {
    const cleanup = this.conversationStreams.subscribe(conversationId, handlers);
    // Establish the connection (and thereby the subscription) eagerly.
    // Authentication is the single connection notification point; subscribe()
    // handles the already-connected case itself, so replaying handleConnected
    // here would issue every chat.subscribe twice.
    void this.ensureConnected().catch(() => {
      this.scheduleReconnect();
    });
    return cleanup;
  }

  subscribeChatActivity(listener: ChatActivityListener): () => void {
    this.chatActivityListeners.add(listener);
    return () => {
      this.chatActivityListeners.delete(listener);
    };
  }

  // Authenticated-connection state: `true` fires when auth completes (the
  // same point conversation streams resume), `false` when the socket drops.
  // Late subscribers immediately receive the current state.
  subscribeConnection(listener: (connected: boolean) => void): () => void {
    this.connectionListeners.add(listener);
    listener(this.connectionState);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  // On-demand snapshot of every active run (same items as history.list's
  // running_conversations, without the list).
  async listChatActivities(): Promise<RunningConversationSummary[]> {
    const response = await this.requestWithRecovery<{
      running_conversations?: RunningConversationSummary[];
    }>("chat.activities", {});
    return Array.isArray(response?.running_conversations) ? response.running_conversations : [];
  }

  // Re-issue chat.subscribe for a subscribed conversation from its cursor
  // (gap-recovery path); no-op when the conversation is not subscribed.
  resyncConversation(conversationId: string): void {
    this.conversationStreams.resync(conversationId);
  }

  subscribeChatCommandUpdates(listener: ChatCommandUpdateListener): () => void {
    this.chatCommandUpdateListeners.add(listener);
    return () => {
      this.chatCommandUpdateListeners.delete(listener);
    };
  }

  async cancelChat(conversationId: string, runId?: string): Promise<void> {
    const normalized = conversationId.trim();
    if (!normalized) {
      return;
    }
    await this.request("chat.cancel", {
      conversation_id: normalized,
      run_id: runId?.trim() || undefined,
    });
  }

  async processSnapshot(): Promise<ManagedProcessStatePayload> {
    const payload = await this.requestWithRecovery<RawManagedProcessStatePayload>(
      "process.snapshot",
      {},
    );
    const state = normalizeManagedProcessState(payload ?? {});
    this.emitProcessState(state);
    return state;
  }

  async processStop(processId: string): Promise<ManagedProcessStatePayload | null> {
    const payload = await this.requestWithRecovery<RawManagedProcessOpPayload>("process.stop", {
      process_id: processId,
    });
    return payload?.state ? normalizeManagedProcessState(payload.state) : null;
  }

  async processClear(processId?: string): Promise<ManagedProcessStatePayload | null> {
    const payload = await this.requestWithRecovery<RawManagedProcessOpPayload>(
      "process.clear",
      processId ? { process_id: processId } : {},
    );
    return payload?.state ? normalizeManagedProcessState(payload.state) : null;
  }

  async processReadLog(processId: string, maxBytes?: number): Promise<ManagedProcessLogPayload> {
    const payload = await this.requestWithRecovery<RawManagedProcessOpPayload>(
      "process.read_log",
      maxBytes ? { process_id: processId, max_bytes: maxBytes } : { process_id: processId },
    );
    return {
      content: String(payload?.log_content ?? ""),
      logPath: String(payload?.log_path ?? ""),
      truncated: payload?.log_truncated === true,
    };
  }

  async cronManage(payload: CronManagePayload): Promise<CronManageResponse> {
    return this.request<CronManageResponse>("cron.manage", payload);
  }

  async memoryManage<T = unknown>(payload: MemoryManagePayload): Promise<T> {
    if (shouldRecoverMemoryManageRequest(payload)) {
      return this.requestWithRecovery<T>("memory.manage", payload);
    }
    return this.request<T>("memory.manage", payload);
  }

  async trajectoryFetch<T = unknown>(payload: {
    conversation_id: string;
    section_ids?: readonly string[];
    subagent_run_ids?: readonly string[];
    max_segments?: number;
    before_segment_index?: number;
    include_subagent_runs?: boolean;
  }): Promise<T> {
    return this.request<T>("trajectory.fetch", {
      conversation_id: payload.conversation_id,
      section_ids: payload.section_ids === undefined ? [] : [...payload.section_ids],
      subagent_run_ids: payload.subagent_run_ids === undefined ? [] : [...payload.subagent_run_ids],
      ...(payload.max_segments === undefined ? {} : { max_segments: payload.max_segments }),
      ...(payload.before_segment_index === undefined
        ? {}
        : { before_segment_index: payload.before_segment_index }),
      ...(payload.include_subagent_runs === undefined
        ? {}
        : { include_subagent_runs: payload.include_subagent_runs }),
    });
  }

  async gitRequest<T = unknown>(
    action: string,
    workdir: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    const requestType = `git.${action}`;
    if (
      action === "status" ||
      action === "branches" ||
      action === "diff" ||
      action === "log" ||
      action === "commit_details" ||
      action === "compare_commit_with_remote" ||
      action === "commit_diff"
    ) {
      return this.requestWithRecovery<T>(requestType, { workdir, args });
    }
    return this.request<T>(requestType, { workdir, args });
  }

  async sftpList(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    side: "local" | "remote";
    path?: string;
  }): Promise<SftpListResponse> {
    return normalizeSftpListResponse(
      await this.request<RawSftpResponse>("sftp.list", {
        session_id: params.sessionId,
        project_path_key: params.projectPathKey,
        workdir: params.workdir,
        ...sftpPathPayload(params.side, params.path ?? ""),
      }),
    );
  }

  async sftpStat(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    side: "local" | "remote";
    path?: string;
  }): Promise<SftpStatResponse> {
    return normalizeSftpStatResponse(
      await this.request<RawSftpResponse>("sftp.stat", {
        session_id: params.sessionId,
        project_path_key: params.projectPathKey,
        workdir: params.workdir,
        ...sftpPathPayload(params.side, params.path ?? ""),
      }),
    );
  }

  async sftpMkdir(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    side: "local" | "remote";
    path: string;
  }): Promise<SftpActionResponse> {
    return normalizeSftpActionResponse(
      await this.request<RawSftpResponse>("sftp.mkdir", {
        session_id: params.sessionId,
        project_path_key: params.projectPathKey,
        workdir: params.workdir,
        ...sftpPathPayload(params.side, params.path),
      }),
    );
  }

  async sftpRename(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    side: "local" | "remote";
    fromPath: string;
    toPath: string;
  }): Promise<SftpActionResponse> {
    return normalizeSftpActionResponse(
      await this.request<RawSftpResponse>("sftp.rename", {
        session_id: params.sessionId,
        project_path_key: params.projectPathKey,
        workdir: params.workdir,
        side: params.side,
        direction: params.side,
        from_path: params.fromPath,
        to_path: params.toPath,
      }),
    );
  }

  async sftpDelete(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    side: "local" | "remote";
    path: string;
    recursive?: boolean;
  }): Promise<SftpActionResponse> {
    return normalizeSftpActionResponse(
      await this.request<RawSftpResponse>("sftp.delete", {
        session_id: params.sessionId,
        project_path_key: params.projectPathKey,
        workdir: params.workdir,
        ...sftpPathPayload(params.side, params.path),
        recursive: params.recursive ?? false,
      }),
    );
  }

  async sftpTransfer(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    direction: "upload" | "download";
    sourcePath: string;
    targetPath: string;
    recursive?: boolean;
    overwrite?: boolean;
  }): Promise<SftpTransferResponse> {
    return normalizeSftpTransferResponse(
      await this.request<RawSftpResponse>("sftp.transfer", {
        session_id: params.sessionId,
        project_path_key: params.projectPathKey,
        workdir: params.workdir,
        direction: params.direction,
        from_path: params.sourcePath,
        target_path: params.targetPath,
        recursive: params.recursive ?? false,
        overwrite: params.overwrite ?? false,
      }),
    );
  }

  async sftpCancelTransfer(params: { sessionId: string; transferId: string }): Promise<void> {
    await this.request("sftp.cancel", {
      session_id: params.sessionId,
      from_path: params.transferId,
    });
  }

  async sftpReadText(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    path: string;
    maxBytes?: number;
    strictUtf8?: boolean;
  }): Promise<SftpReadTextResponse> {
    return normalizeSftpReadTextResponse(
      await this.request<RawSftpResponse>("sftp.read_text", {
        session_id: params.sessionId,
        project_path_key: params.projectPathKey,
        workdir: params.workdir,
        remote_path: params.path,
        max_bytes: params.maxBytes ?? 0,
        strict_utf8: params.strictUtf8 ?? false,
      }),
    );
  }

  async sftpWriteText(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    path: string;
    content: string;
    expectedMtime?: number;
    expectedSizeBytes?: number;
  }): Promise<SftpActionResponse> {
    return normalizeSftpActionResponse(
      await this.request<RawSftpResponse>("sftp.write_text", {
        session_id: params.sessionId,
        project_path_key: params.projectPathKey,
        workdir: params.workdir,
        remote_path: params.path,
        content: params.content,
        overwrite: true,
        create_parent_dirs: false,
        expected_mtime: params.expectedMtime ?? 0,
        expected_size_bytes: params.expectedSizeBytes ?? 0,
      }),
    );
  }

  async terminalShellOptions(): Promise<TerminalShellOptions> {
    return normalizeTerminalShellOptions(
      await this.requestWithRecovery<RawTerminalResponse>("terminal.shell_options", {}),
    );
  }

  async listTerminals(projectPathKey?: string): Promise<TerminalSession[]> {
    const projectKey = projectPathKey?.trim() ?? "";
    const response = await this.requestWithRecovery<RawTerminalResponse>(
      "terminal.list",
      projectKey ? { project_path_key: projectKey } : {},
    );
    return (response.sessions ?? []).map(normalizeTerminalSession);
  }

  async createTerminal(params: {
    cwd: string;
    projectPathKey: string;
    shell?: string;
    title?: string;
    cols?: number;
    rows?: number;
  }): Promise<TerminalSnapshot> {
    return normalizeTerminalSnapshot(
      await this.request<RawTerminalResponse>("terminal.create", {
        ...buildTerminalCreatePayload(params),
      }),
      normalizeTerminalBytes,
    );
  }

  async createSshTerminal(params: {
    cwd: string;
    projectPathKey: string;
    hostId: string;
    title?: string;
    cols?: number;
    rows?: number;
    sftpEnabled?: boolean;
  }): Promise<TerminalSshCreateResult> {
    return normalizeTerminalSshCreateResult(
      await this.request<RawTerminalResponse>("terminal.create_ssh", {
        ...buildTerminalSshCreatePayload(params),
      }),
      normalizeTerminalBytes,
    );
  }

  async answerSshTerminalPrompt(params: {
    promptId: string;
    answer?: string;
    trustHostKey?: boolean;
  }): Promise<TerminalSshCreateResult> {
    return normalizeTerminalSshCreateResult(
      await this.request<RawTerminalResponse>("terminal.answer_ssh_prompt", {
        ...buildTerminalSshPromptAnswerPayload(params),
      }),
      normalizeTerminalBytes,
    );
  }

  async cancelSshTerminalPrompt(promptId: string): Promise<void> {
    await this.request("terminal.cancel_ssh_prompt", {
      prompt_id: promptId,
    });
  }

  async reconnectSshTerminal(sessionId: string, projectPathKey?: string): Promise<TerminalSession> {
    const response = await this.request<RawTerminalResponse>("terminal.ssh_reconnect", {
      session_id: sessionId,
      project_path_key: projectPathKey,
    });
    if (!response.session) {
      throw new Error("Terminal response did not include a session");
    }
    return normalizeTerminalSession(response.session);
  }

  async sshTerminalLatency(
    sessionId: string,
    projectPathKey?: string,
  ): Promise<TerminalSshLatency> {
    const latency = normalizeTerminalSshLatency(
      await this.request<RawTerminalResponse>("terminal.ssh_latency", {
        session_id: sessionId,
        project_path_key: projectPathKey,
      }),
    );
    return { ...latency, sessionId };
  }

  async listSshTerminalTabs(projectPathKey: string): Promise<SshTerminalTabsSnapshot> {
    const response = await this.requestWithRecovery<RawTerminalResponse>("terminal.ssh_tabs_list", {
      project_path_key: projectPathKey,
    });
    return normalizeSshTerminalTabsSnapshot(response.sshTabs ?? response.ssh_tabs);
  }

  async openSshTerminalTab(params: {
    sessionId: string;
    kind: SshTerminalTabKind;
  }): Promise<SshTerminalTabsSnapshot> {
    const response = await this.request<RawTerminalResponse>("terminal.ssh_tab_open", {
      session_id: params.sessionId,
      tab_kind: params.kind,
    });
    return normalizeSshTerminalTabsSnapshot(response.sshTabs ?? response.ssh_tabs);
  }

  async closeSshTerminalTab(tabId: string): Promise<SshTerminalTabsSnapshot> {
    const response = await this.request<RawTerminalResponse>("terminal.ssh_tab_close", {
      tab_id: tabId,
    });
    return normalizeSshTerminalTabsSnapshot(response.sshTabs ?? response.ssh_tabs);
  }

  async listSshLocalForwards(params?: {
    sessionId?: string;
    projectPathKey?: string;
  }): Promise<SshLocalForwardSnapshot> {
    const response = await this.requestWithRecovery<RawTerminalResponse>(
      "terminal.ssh_local_forward_list",
      {
        session_id: params?.sessionId,
        project_path_key: params?.projectPathKey,
      },
    );
    return normalizeSshLocalForwardSnapshot(
      response.sshLocalForwards ?? response.ssh_local_forwards ?? {},
    );
  }

  async startSshLocalForward(params: {
    sessionId: string;
    projectPathKey?: string;
    remoteHost: string;
    remotePort: number;
    localPort?: number;
  }): Promise<SshLocalForwardAction> {
    const response = await this.request<RawTerminalResponse>("terminal.ssh_local_forward_start", {
      session_id: params.sessionId,
      project_path_key: params.projectPathKey,
      remote_host: params.remoteHost,
      remote_port: params.remotePort,
      local_port: params.localPort ?? 0,
    });
    const action = response.sshLocalForward ?? response.ssh_local_forward;
    if (!action) {
      throw new Error("Terminal response did not include a forward");
    }
    return normalizeSshLocalForwardAction(action);
  }

  async stopSshLocalForward(params: {
    forwardId: string;
    sessionId?: string;
  }): Promise<SshLocalForwardAction> {
    const response = await this.request<RawTerminalResponse>("terminal.ssh_local_forward_stop", {
      forward_id: params.forwardId,
      session_id: params.sessionId,
    });
    const action = response.sshLocalForward ?? response.ssh_local_forward;
    if (!action) {
      throw new Error("Terminal response did not include a forward");
    }
    return normalizeSshLocalForwardAction(action);
  }

  async checkSshLocalForwardPort(localPort: number): Promise<boolean> {
    const response = await this.request<RawTerminalResponse>(
      "terminal.ssh_local_forward_check_port",
      { local_port: localPort },
    );
    return Boolean(
      response.sshLocalForwardPortAvailable ?? response.ssh_local_forward_port_available,
    );
  }

  subscribeSshLocalForward(listener: (event: SshLocalForwardEvent) => void): () => void {
    return this.subscribeTerminal((event) => {
      if (event.kind === "ssh_local_forward" && event.sshLocalForward) {
        listener(event.sshLocalForward);
      }
    });
  }

  async renameTerminal(
    sessionId: string,
    title: string,
    projectPathKey?: string,
  ): Promise<TerminalSession> {
    const response = await this.request<RawTerminalResponse>("terminal.rename", {
      session_id: sessionId,
      project_path_key: projectPathKey,
      title,
    });
    if (!response.session) {
      throw new Error("Terminal response did not include a session");
    }
    return normalizeTerminalSession(response.session);
  }

  async closeTerminal(sessionId: string, projectPathKey?: string): Promise<TerminalSession> {
    const response = await this.request<RawTerminalResponse>("terminal.close", {
      session_id: sessionId,
      project_path_key: projectPathKey,
    });
    if (!response.session) {
      throw new Error("Terminal response did not include a session");
    }
    return normalizeTerminalSession(response.session);
  }

  async closeProjectTerminals(projectPathKey: string): Promise<TerminalSession[]> {
    const response = await this.request<RawTerminalResponse>("terminal.close_project", {
      project_path_key: projectPathKey,
    });
    return (response.sessions ?? []).map(normalizeTerminalSession);
  }

  async createTunnel(input: TunnelCreateInput): Promise<void> {
    const payload: Record<string, unknown> = {
      target_url: input.targetUrl,
      ttl_seconds: input.ttlSeconds,
    };
    const name = input.name?.trim();
    if (name) {
      payload.name = name;
    }
    const projectPathKey = input.projectPathKey?.trim();
    if (projectPathKey) {
      payload.project_path_key = projectPathKey;
    }
    await this.request("tunnel.create", payload);
  }

  async updateTunnel(input: TunnelUpdateInput): Promise<void> {
    const payload: Record<string, unknown> = {
      tunnel_id: input.id,
      target_url: input.targetUrl,
    };
    // Omitting ttl_seconds keeps the current expiry; sending it re-buckets
    // the expiry from now.
    if (input.ttlSeconds !== undefined) {
      payload.ttl_seconds = input.ttlSeconds;
    }
    const name = input.name?.trim();
    if (name) {
      payload.name = name;
    }
    const projectPathKey = input.projectPathKey?.trim();
    if (projectPathKey) {
      payload.project_path_key = projectPathKey;
    }
    await this.request("tunnel.update", payload);
  }

  async closeTunnel(id: string): Promise<void> {
    await this.request("tunnel.close", { tunnel_id: id });
  }

  async checkTunnel(id?: string): Promise<void> {
    const payload: Record<string, unknown> = {};
    const tunnelId = id?.trim();
    if (tunnelId) {
      payload.tunnel_id = tunnelId;
    }
    await this.request("tunnel.check", payload);
  }

  async listHistory(
    page: number,
    pageSize: number,
    filter?: HistoryListFilter,
  ): Promise<HistoryList> {
    const payload: { page: number; page_size: number; cwd?: string; cwd_empty?: boolean } = {
      page: normalizeHistoryListPage(page),
      page_size: normalizeHistoryListPageSize(pageSize),
    };
    const cwd = filter?.cwd?.trim();
    if (cwd) {
      payload.cwd = cwd;
    }
    if (filter?.cwdEmpty === true) {
      payload.cwd_empty = true;
    }
    // running_conversations 由 chat_activities 帧提供：并行取回合并，返回形状不变。
    const [list, runningConversations] = await Promise.all([
      this.requestWithRecovery<HistoryList>("history.list", payload),
      this.listChatActivities().catch(() => [] as RunningConversationSummary[]),
    ]);
    return { ...list, running_conversations: runningConversations };
  }

  async listHistoryWorkdirs(): Promise<HistoryWorkdirsResponse> {
    const response = await this.requestWithRecovery<{
      workdirs?: Array<{ path?: string; conversation_count?: number; updated_at?: number }>;
    }>("history.workdirs", {});
    return {
      workdirs: (response.workdirs ?? []).map((item) => ({
        path: item.path ?? "",
        conversationCount: item.conversation_count ?? 0,
        updatedAt: item.updated_at ?? 0,
      })),
    };
  }

  async listSharedHistory(page: number, pageSize: number): Promise<HistoryList> {
    return this.requestWithRecovery<HistoryList>("history.shared_list", {
      page: normalizeHistoryListPage(page),
      page_size: normalizeHistoryListPageSize(pageSize),
    });
  }

  async getHistory(conversationId: string, options?: HistoryGetOptions): Promise<HistoryDetail> {
    return this.requestWithRecovery<HistoryDetail>("history.get", {
      conversation_id: conversationId,
      max_messages: options?.maxMessages,
    });
  }

  async getHistoryPrefix(
    conversationId: string,
    baseMessageRef: HistoryMessageRef,
    options?: HistoryGetOptions,
  ): Promise<HistoryDetail> {
    return this.requestWithRecovery<HistoryDetail>("history.prefix", {
      conversation_id: conversationId,
      max_messages: options?.maxMessages,
      base_message_ref: buildHistoryMessageRefPayload(baseMessageRef),
    });
  }

  async renameHistory(conversationId: string, title: string): Promise<ConversationSummary> {
    return this.request<ConversationSummary>("history.rename", {
      conversation_id: conversationId,
      title,
    });
  }

  async branchHistory(
    conversationId: string,
    baseMessageRef: HistoryMessageRef,
  ): Promise<ConversationSummary> {
    return this.request<ConversationSummary>("history.branch", {
      conversation_id: conversationId,
      base_message_ref: buildHistoryMessageRefPayload(baseMessageRef),
    });
  }

  async pinHistory(conversationId: string, isPinned: boolean): Promise<ConversationSummary> {
    return this.request<ConversationSummary>("history.pin", {
      conversation_id: conversationId,
      is_pinned: isPinned,
    });
  }

  async setHistoryCwd(conversationId: string, cwd: string): Promise<ConversationSummary> {
    return this.request<ConversationSummary>("history.set_cwd", {
      conversation_id: conversationId,
      cwd,
    });
  }

  async getHistoryShare(conversationId: string): Promise<HistoryShareStatus> {
    return this.requestWithRecovery<HistoryShareStatus>("history.share.get", {
      conversation_id: conversationId,
    });
  }

  async setHistoryShare(
    conversationId: string,
    enabled: boolean,
    options?: { redactToolContent?: boolean },
  ): Promise<HistoryShareStatus> {
    const payload: Record<string, unknown> = {
      conversation_id: conversationId,
      enabled,
    };
    if (typeof options?.redactToolContent === "boolean") {
      payload.redact_tool_content = options.redactToolContent;
    }
    return this.request<HistoryShareStatus>("history.share.set", payload);
  }

  async deleteHistory(conversationId: string): Promise<void> {
    await this.request("history.delete", {
      conversation_id: conversationId,
    });
  }

  async listProviders(): Promise<GatewayProviderSummary[]> {
    return this.requestWithRecovery<GatewayProviderSummary[]>("providers.list", {});
  }

  async getSettings(): Promise<GatewaySettingsSyncPayload> {
    return this.requestWithRecovery<GatewaySettingsSyncPayload>("settings.get", {});
  }

  async updateSettings(payload: GatewaySettingsSyncUpdatePayload): Promise<void> {
    const response = await this.request<GatewaySettingsUpdateResponse>("settings.update", payload);
    if (response?.accepted === false) {
      const message = response.message?.trim() || "Gateway settings update rejected";
      if (message === "settings_changed" || message === LEGACY_SETTINGS_CHANGED_MESSAGE) {
        throw new GatewaySettingsUpdateError("settings_changed", message);
      }
      throw new Error(message);
    }
  }

  async resetSshKnownHost(params: {
    host: string;
    port: number;
  }): Promise<SshKnownHostResetResult> {
    return this.request<SshKnownHostResetResult>("settings.ssh_known_host.reset", {
      host: params.host,
      port: params.port,
    });
  }

  async listSkillFiles(): Promise<SkillListResponse> {
    return this.requestWithRecovery<SkillListResponse>("skills.list", {});
  }

  async manageSkill<T = unknown>(payload: SkillManagePayload): Promise<T> {
    return this.request<T>("skills.manage", payload);
  }

  async listMentionFiles(
    workdir: string,
    maxResults?: number,
    query?: string,
    showHidden?: boolean,
  ): Promise<MentionListResponse> {
    return this.requestWithRecovery<MentionListResponse>("mentions.list", {
      workdir,
      max_results: maxResults,
      query,
      show_hidden: showHidden,
    });
  }

  async listFsRoots(): Promise<FsRootsResponse> {
    return this.requestWithRecovery<FsRootsResponse>("fs.roots", {});
  }

  async listWorkspaceRootGrants(
    projectId: string,
    projectPath: string,
  ): Promise<GatewayWorkspaceRootGrant[]> {
    const response = await this.requestWithRecovery<GatewayWorkspaceRootGrantsResponse>(
      "workspace_root_grants.list",
      { project_id: projectId, project_path: projectPath },
    );
    return response.grants;
  }

  async applyWorkspaceRootGrants(
    projectId: string,
    projectPath: string,
    grants: readonly GatewayWorkspaceRootGrantDraft[],
  ): Promise<GatewayWorkspaceRootGrant[]> {
    const response = await this.request<GatewayWorkspaceRootGrantsResponse>(
      "workspace_root_grants.apply",
      {
        project_id: projectId,
        project_path: projectPath,
        grants: grants.map((grant) => ({
          ...(grant.id ? { id: grant.id } : {}),
          alias: grant.alias,
          display_path: grant.displayPath,
          access: grant.access,
        })),
      },
    );
    return response.grants;
  }

  async revokeWorkspaceRootGrants(projectId: string): Promise<void> {
    await this.request<GatewayWorkspaceRootGrantsResponse>("workspace_root_grants.revoke", {
      project_id: projectId,
    });
  }

  async listCheckpointTurns(conversationId: string): Promise<CheckpointTurnSummary[]> {
    return this.requestWithRecovery<CheckpointTurnSummary[]>("checkpoint.list", {
      conversation_id: conversationId,
    });
  }

  async previewCheckpointRewind(params: {
    conversationId: string;
    turnSeq: number;
    authorizedRoots: string[];
  }): Promise<CheckpointDiffStats> {
    return this.request<CheckpointDiffStats>("checkpoint.diff", {
      conversation_id: params.conversationId,
      turn_seq: params.turnSeq,
      authorized_roots: params.authorizedRoots,
    });
  }

  async rewindCheckpoint(params: {
    conversationId: string;
    turnSeq: number;
    authorizedRoots: string[];
    expected: { key: string; currentHash: string }[];
  }): Promise<CheckpointRewindResult> {
    return this.request<CheckpointRewindResult>("checkpoint.rewind", {
      conversation_id: params.conversationId,
      turn_seq: params.turnSeq,
      authorized_roots: params.authorizedRoots,
      expected: params.expected.map((entry) => ({
        key: entry.key,
        current_hash: entry.currentHash,
      })),
    });
  }

  async listDirs(path: string, maxResults?: number): Promise<FsListDirsResponse> {
    return this.requestWithRecovery<FsListDirsResponse>("fs.list_dirs", {
      path,
      max_results: maxResults,
    });
  }

  async createProjectFolder(parent: string, name: string): Promise<CreateProjectFolderResponse> {
    return this.request<CreateProjectFolderResponse>("fs.create_project_folder", {
      parent,
      name,
    });
  }

  async listFiles(
    workdir: string,
    path?: string,
    depth?: number,
    offset?: number,
    maxResults?: number,
    showHidden?: boolean,
  ): Promise<FsListResponse> {
    return this.requestWithRecovery<FsListResponse>("fs.list", {
      workdir,
      path,
      depth,
      offset,
      max_results: maxResults,
      show_hidden: showHidden,
    });
  }

  async writeTextFile(params: {
    workdir: string;
    path: string;
    content: string;
    mode?: string;
    expectedMtimeMs?: number;
    expectedContentHash?: string;
  }): Promise<FsWriteTextResponse> {
    return this.request<FsWriteTextResponse>("fs.write_text", {
      workdir: params.workdir,
      path: params.path,
      content: params.content,
      mode: params.mode ?? "rewrite",
      expected_mtime_ms: params.expectedMtimeMs,
      expected_content_hash: params.expectedContentHash,
    });
  }

  async readEditableTextFile(workdir: string, path: string): Promise<FsReadEditableTextResponse> {
    return this.request<FsReadEditableTextResponse>("fs.read_editable_text", {
      workdir,
      path,
    });
  }

  async readWorkspaceImageFile(
    workdir: string,
    path: string,
  ): Promise<FsReadWorkspaceImageResponse> {
    return this.request<FsReadWorkspaceImageResponse>("fs.read_workspace_image", {
      workdir,
      path,
    });
  }

  async openChatFile(params: {
    conversationId: string;
    workdir: string;
    path: string;
    source: string;
    line?: number;
    endLine?: number;
    column?: number;
    openInFileManager?: boolean;
  }): Promise<ChatFileOpenResponse> {
    return this.request<ChatFileOpenResponse>("chat.file_open", {
      conversation_id: params.conversationId,
      workdir: params.workdir,
      path: params.path,
      source: params.source,
      line: params.line,
      end_line: params.endLine,
      column: params.column,
      open_in_file_manager: params.openInFileManager,
    });
  }

  async createDir(workdir: string, path: string): Promise<FsCreateDirResponse> {
    return this.request<FsCreateDirResponse>("fs.create_dir", { workdir, path });
  }

  async renamePath(workdir: string, fromPath: string, toPath: string): Promise<FsRenameResponse> {
    return this.request<FsRenameResponse>("fs.rename", {
      workdir,
      from_path: fromPath,
      to_path: toPath,
    });
  }

  async deletePath(workdir: string, path: string): Promise<FsDeleteResponse> {
    return this.request<FsDeleteResponse>("fs.delete", { workdir, path });
  }

  async readUploadedImagePreview(
    workdir: string,
    absolutePath: string,
  ): Promise<UploadedImagePreviewResponse> {
    return this.requestWithRecovery<UploadedImagePreviewResponse>("files.preview", {
      workdir,
      absolute_path: absolutePath,
    });
  }

  async readSkillMetadata(path: string): Promise<SkillMetadataResponse> {
    return this.requestWithRecovery<SkillMetadataResponse>("skills.read-metadata", { path });
  }

  async readSkillText(path: string, offset?: number, length?: number): Promise<SkillTextResponse> {
    return this.requestWithRecovery<SkillTextResponse>("skills.read-text", {
      path,
      offset,
      length,
    });
  }

  async getProviderModels(
    type: string,
    baseUrl: string,
    apiKey: string,
    useSystemProxy = false,
    modelsUrl = "",
    providerId = "",
    isFullUrl?: boolean,
  ): Promise<unknown> {
    return this.requestWithRecovery("provider.models", {
      type,
      base_url: baseUrl,
      api_key: apiKey,
      use_system_proxy: useSystemProxy,
      models_url: modelsUrl,
      provider_id: providerId,
      is_full_url: isFullUrl,
    });
  }

  async providerUsageQuery<T = unknown>(providerId: string, refresh: boolean): Promise<T> {
    return this.requestWithRecovery<T>("provider.usage.query", {
      provider_id: providerId,
      refresh,
    });
  }

  async providerUsageTest<T = unknown>(providerId: string, configJson: string): Promise<T> {
    // 按草稿测试:config_json 非空时桌面端忽略启用开关、不落库不进缓存。
    return this.requestWithRecovery<T>("provider.usage.query", {
      provider_id: providerId,
      refresh: true,
      config_json: configJson,
    });
  }
}
