import type {
  GatewaySettingsSyncPayload,
  GatewaySettingsSyncUpdatePayload,
} from "@liveagent/ui/lib/settings/sync";
import type {
  SftpActionResponse,
  SftpListResponse,
  SftpStatResponse,
  SftpTransferResponse,
} from "@liveagent/ui/lib/sftp/types";
import type {
  SshLocalForwardAction,
  SshLocalForwardEvent,
  SshLocalForwardSnapshot,
} from "@liveagent/ui/lib/terminal/sshLocalForwardTypes";
import type {
  SshTerminalTabKind,
  SshTerminalTabsSnapshot,
  TerminalSession,
  TerminalShellOptions,
  TerminalSnapshot,
  TerminalSshCreateResult,
  TerminalSshLatency,
  TerminalStreamClient,
} from "@liveagent/ui/lib/terminal/types";
import type {
  TunnelCreateInput,
  TunnelStateSnapshot,
  TunnelUpdateInput,
} from "@liveagent/ui/lib/tunnels/constants";
import type { WorkspaceActivityEventPayload } from "@liveagent/ui/lib/workspace-activity/types";
import type { HistoryMessageRef } from "@/lib/chat/conversationState";
import type {
  ChatCommandAccepted,
  ConversationStreamHandlers,
} from "@/lib/chat/stream/streamTypes";
import { GatewayWebSocketRpcClient } from "./gatewaySocketRpc";
import type {
  ChatActivityListener,
  ChatCommandUpdateListener,
  ChatFileOpenResponse,
  ChatQueueListener,
  FsCreateDirResponse,
  FsDeleteResponse,
  FsListDirsResponse,
  FsListResponse,
  FsReadEditableTextResponse,
  FsReadWorkspaceImageResponse,
  FsRenameResponse,
  FsRootsResponse,
  FsWriteTextResponse,
  GatewayChatCommandInput,
  HistoryGetOptions,
  HistoryListener,
  ManagedProcessLogPayload,
  ManagedProcessStatePayload,
  MentionListResponse,
  SettingsListener,
  SftpTransferListener,
  SkillListResponse,
  SkillManagePayload,
  SkillMetadataResponse,
  SkillTextResponse,
  SshKnownHostResetResult,
  StatusListener,
  TerminalListener,
  UploadedImagePreviewResponse,
} from "./gatewaySocketShared";
import type {
  AgentStatus,
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

export type {
  LocalTunnelClient,
  TunnelCreateInput,
  TunnelHealth,
  TunnelStateSnapshot,
  TunnelStatus,
  TunnelTtlSeconds,
  TunnelUpdateInput,
} from "@liveagent/ui/lib/tunnels/constants";
// Curated public surface, matching the pre-split monolith: everything else in
// gatewaySocketShared/Transport/Rpc is an internal wiring detail. A symbol
// dropped from the shared module fails compilation here, at the contract file,
// instead of at scattered caller import sites.
export type {
  ChatFileOpenResponse,
  GatewayChatCommandInput,
  ManagedProcessLogPayload,
  ManagedProcessRecordPayload,
  ManagedProcessStatePayload,
  SshKnownHostResetResult,
  UploadedImagePreviewResponse,
} from "./gatewaySocketShared";

export class GatewayWebSocketClient extends GatewayWebSocketRpcClient {}

export type GatewayWebSocketClientLike = {
  terminalStream: TerminalStreamClient;
  getStatus(): Promise<AgentStatus>;
  prepareChatRuntime(reason?: string): Promise<AgentStatus>;
  // 多 Agent 寻址：活跃 Agent 选择、目录查询与目录订阅。
  getActiveAgent(): string;
  setActiveAgent(agentId: string): void;
  listAgents(): Promise<AgentStatus[]>;
  subscribeAgents(listener: (agents: AgentStatus[]) => void): () => void;
  subscribeStatus(listener: StatusListener): () => void;
  subscribeHistory(listener: HistoryListener): () => void;
  subscribeSettings(listener: SettingsListener): () => void;
  subscribeTerminal(listener: TerminalListener): () => void;
  subscribeSftpTransfers(listener: SftpTransferListener): () => void;
  subscribeChatQueue(listener: ChatQueueListener): () => void;
  subscribeChatActivity(listener: ChatActivityListener): () => void;
  subscribeChatCommandUpdates(listener: ChatCommandUpdateListener): () => void;
  subscribeConnection(listener: (connected: boolean) => void): () => void;
  listChatActivities(): Promise<RunningConversationSummary[]>;
  resyncConversation(conversationId: string): void;
  subscribeConversationStream(
    conversationId: string,
    handlers: ConversationStreamHandlers,
  ): () => void;
  chatCommand(input: GatewayChatCommandInput): Promise<ChatCommandAccepted>;
  cancelChat(conversationId: string, runId?: string): Promise<void>;
  chatQueueGet(conversationId: string): Promise<ChatQueueResponse>;
  chatQueueGetItem(conversationId: string, itemId: string): Promise<ChatQueueResponse>;
  chatQueueRunNow(conversationId: string, itemId: string): Promise<ChatQueueResponse>;
  chatQueueCompactNow(conversationId: string, operationId: string): Promise<ChatQueueResponse>;
  chatQueueMove(
    conversationId: string,
    itemId: string,
    direction: "up" | "down",
  ): Promise<ChatQueueResponse>;
  chatQueueRemove(conversationId: string, itemId: string): Promise<ChatQueueResponse>;
  chatQueueEditBegin(conversationId: string, itemId: string): Promise<ChatQueueResponse>;
  chatQueueEditCommit(input: {
    conversationId: string;
    itemId: string;
    revision: number;
    draftJson: string;
    uploadedFilesJson: string;
  }): Promise<ChatQueueResponse>;
  chatQueueEditCancel(conversationId: string, itemId: string): Promise<ChatQueueResponse>;
  cronManage(payload: CronManagePayload): Promise<CronManageResponse>;
  memoryManage<T = unknown>(payload: MemoryManagePayload): Promise<T>;
  gitRequest<T = unknown>(
    action: string,
    workdir: string,
    args?: Record<string, unknown>,
  ): Promise<T>;
  sftpList(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    side: "local" | "remote";
    path?: string;
  }): Promise<SftpListResponse>;
  sftpStat(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    side: "local" | "remote";
    path?: string;
  }): Promise<SftpStatResponse>;
  sftpMkdir(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    side: "local" | "remote";
    path: string;
  }): Promise<SftpActionResponse>;
  sftpRename(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    side: "local" | "remote";
    fromPath: string;
    toPath: string;
  }): Promise<SftpActionResponse>;
  sftpDelete(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    side: "local" | "remote";
    path: string;
    recursive?: boolean;
  }): Promise<SftpActionResponse>;
  sftpTransfer(params: {
    sessionId: string;
    projectPathKey: string;
    workdir: string;
    direction: "upload" | "download";
    sourcePath: string;
    targetPath: string;
    recursive?: boolean;
    overwrite?: boolean;
  }): Promise<SftpTransferResponse>;
  sftpCancelTransfer(params: { sessionId: string; transferId: string }): Promise<void>;
  terminalShellOptions(): Promise<TerminalShellOptions>;
  listTerminals(projectPathKey?: string): Promise<TerminalSession[]>;
  createTerminal(params: {
    cwd: string;
    projectPathKey: string;
    shell?: string;
    title?: string;
    cols?: number;
    rows?: number;
  }): Promise<TerminalSnapshot>;
  createSshTerminal(params: {
    cwd: string;
    projectPathKey: string;
    hostId: string;
    title?: string;
    cols?: number;
    rows?: number;
    sftpEnabled?: boolean;
  }): Promise<TerminalSshCreateResult>;
  answerSshTerminalPrompt(params: {
    promptId: string;
    answer?: string;
    trustHostKey?: boolean;
  }): Promise<TerminalSshCreateResult>;
  cancelSshTerminalPrompt(promptId: string): Promise<void>;
  reconnectSshTerminal(sessionId: string, projectPathKey?: string): Promise<TerminalSession>;
  sshTerminalLatency(sessionId: string, projectPathKey?: string): Promise<TerminalSshLatency>;
  listSshTerminalTabs(projectPathKey: string): Promise<SshTerminalTabsSnapshot>;
  openSshTerminalTab(params: {
    sessionId: string;
    kind: SshTerminalTabKind;
  }): Promise<SshTerminalTabsSnapshot>;
  closeSshTerminalTab(tabId: string): Promise<SshTerminalTabsSnapshot>;
  listSshLocalForwards(params?: {
    sessionId?: string;
    projectPathKey?: string;
  }): Promise<SshLocalForwardSnapshot>;
  startSshLocalForward(params: {
    sessionId: string;
    projectPathKey?: string;
    remoteHost: string;
    remotePort: number;
    localPort?: number;
  }): Promise<SshLocalForwardAction>;
  stopSshLocalForward(params: {
    forwardId: string;
    sessionId?: string;
  }): Promise<SshLocalForwardAction>;
  checkSshLocalForwardPort(localPort: number): Promise<boolean>;
  subscribeSshLocalForward(listener: (event: SshLocalForwardEvent) => void): () => void;
  renameTerminal(
    sessionId: string,
    title: string,
    projectPathKey?: string,
  ): Promise<TerminalSession>;
  closeTerminal(sessionId: string, projectPathKey?: string): Promise<TerminalSession>;
  closeProjectTerminals(projectPathKey: string): Promise<TerminalSession[]>;
  subscribeTunnelState(listener: (snapshot: TunnelStateSnapshot) => void): () => void;
  subscribeProcessState(listener: (state: ManagedProcessStatePayload) => void): () => void;
  processSnapshot(): Promise<ManagedProcessStatePayload>;
  processStop(processId: string): Promise<ManagedProcessStatePayload | null>;
  processClear(processId?: string): Promise<ManagedProcessStatePayload | null>;
  processReadLog(processId: string, maxBytes?: number): Promise<ManagedProcessLogPayload>;
  subscribeWorkspaceActivity(
    workdir: string,
    listener: (event: WorkspaceActivityEventPayload) => void,
  ): () => void;
  createTunnel(input: TunnelCreateInput): Promise<void>;
  updateTunnel(input: TunnelUpdateInput): Promise<void>;
  closeTunnel(id: string): Promise<void>;
  checkTunnel(id?: string): Promise<void>;
  listHistory(page: number, pageSize: number, filter?: HistoryListFilter): Promise<HistoryList>;
  listHistoryWorkdirs(): Promise<HistoryWorkdirsResponse>;
  listSharedHistory(page: number, pageSize: number): Promise<HistoryList>;
  getHistory(conversationId: string, options?: HistoryGetOptions): Promise<HistoryDetail>;
  getHistoryPrefix(
    conversationId: string,
    baseMessageRef: HistoryMessageRef,
    options?: HistoryGetOptions,
  ): Promise<HistoryDetail>;
  renameHistory(conversationId: string, title: string): Promise<ConversationSummary>;
  branchHistory(
    conversationId: string,
    baseMessageRef: HistoryMessageRef,
  ): Promise<ConversationSummary>;
  pinHistory(conversationId: string, isPinned: boolean): Promise<ConversationSummary>;
  setHistoryCwd(conversationId: string, cwd: string): Promise<ConversationSummary>;
  getHistoryShare(conversationId: string): Promise<HistoryShareStatus>;
  setHistoryShare(
    conversationId: string,
    enabled: boolean,
    options?: { redactToolContent?: boolean },
  ): Promise<HistoryShareStatus>;
  deleteHistory(conversationId: string): Promise<void>;
  listProviders(): Promise<GatewayProviderSummary[]>;
  getSettings(): Promise<GatewaySettingsSyncPayload>;
  updateSettings(payload: GatewaySettingsSyncUpdatePayload): Promise<void>;
  resetSshKnownHost(params: { host: string; port: number }): Promise<SshKnownHostResetResult>;
  listSkillFiles(): Promise<SkillListResponse>;
  manageSkill<T = unknown>(payload: SkillManagePayload): Promise<T>;
  listMentionFiles(
    workdir: string,
    maxResults?: number,
    query?: string,
    showHidden?: boolean,
  ): Promise<MentionListResponse>;
  listFsRoots(): Promise<FsRootsResponse>;
  listDirs(path: string, maxResults?: number): Promise<FsListDirsResponse>;
  createProjectFolder(parent: string, name: string): Promise<CreateProjectFolderResponse>;
  listFiles(
    workdir: string,
    path?: string,
    depth?: number,
    offset?: number,
    maxResults?: number,
    showHidden?: boolean,
  ): Promise<FsListResponse>;
  writeTextFile(params: {
    workdir: string;
    path: string;
    content: string;
    mode?: string;
    expectedMtimeMs?: number;
    expectedContentHash?: string;
  }): Promise<FsWriteTextResponse>;
  readEditableTextFile(workdir: string, path: string): Promise<FsReadEditableTextResponse>;
  readWorkspaceImageFile(workdir: string, path: string): Promise<FsReadWorkspaceImageResponse>;
  openChatFile(params: {
    conversationId: string;
    workdir: string;
    path: string;
    source: string;
    line?: number;
    endLine?: number;
    column?: number;
    openInFileManager?: boolean;
  }): Promise<ChatFileOpenResponse>;
  createDir(workdir: string, path: string): Promise<FsCreateDirResponse>;
  renamePath(workdir: string, fromPath: string, toPath: string): Promise<FsRenameResponse>;
  deletePath(workdir: string, path: string): Promise<FsDeleteResponse>;
  readUploadedImagePreview(
    workdir: string,
    absolutePath: string,
  ): Promise<UploadedImagePreviewResponse>;
  readSkillMetadata(path: string): Promise<SkillMetadataResponse>;
  readSkillText(path: string, offset?: number, length?: number): Promise<SkillTextResponse>;
  getProviderModels(
    type: string,
    baseUrl: string,
    apiKey: string,
    useSystemProxy?: boolean,
    modelsUrl?: string,
    providerId?: string,
    isFullUrl?: boolean,
  ): Promise<unknown>;
  providerUsageQuery<T = unknown>(providerId: string, refresh: boolean): Promise<T>;
  providerUsageTest<T = unknown>(providerId: string, configJson: string): Promise<T>;
  dispose(): void;
};

let activeClient: GatewayWebSocketClient | null = null;
let activeToken = "";
// True once any client has existed this page lifetime. reset* nulls
// activeClient without notifying, so "activeClient !== null" alone would
// miss the reset→create sequence and leave module-scoped stores subscribed
// to the disposed instance forever.
let everHadClient = false;
const clientReplacedListeners = new Set<() => void>();

/**
 * Fires after the singleton client has been replaced (token change). Module
 * scoped stores that subscribed on the old instance re-attach here — a
 * disposed client never delivers events again.
 */
export function onGatewayWebSocketClientReplaced(listener: () => void): () => void {
  clientReplacedListeners.add(listener);
  return () => {
    clientReplacedListeners.delete(listener);
  };
}

export function getGatewayWebSocketClient(token: string): GatewayWebSocketClient {
  const normalizedToken = token.trim();
  if (activeClient && activeToken === normalizedToken) {
    return activeClient;
  }
  const replaced = everHadClient;
  activeClient?.dispose();
  activeToken = normalizedToken;
  activeClient = new GatewayWebSocketClient(normalizedToken);
  everHadClient = true;
  if (replaced) {
    // The new instance is already installed, so re-entrant
    // getGatewayWebSocketClient calls from listeners hit the fast path.
    for (const listener of clientReplacedListeners) {
      listener();
    }
  }
  return activeClient;
}

export function resetGatewayWebSocketClient() {
  activeClient?.dispose();
  activeClient = null;
  activeToken = "";
}
