import type { GatewaySettingsSyncPayload } from "@liveagent/ui/lib/settings/sync";
import {
  normalizeSftpTransferEvent,
  type RawSftpTransferEvent,
} from "@liveagent/ui/lib/sftp/normalization";
import type { SftpTransferEvent } from "@liveagent/ui/lib/sftp/types";
import { normalizeTerminalEvent } from "@liveagent/ui/lib/terminal/normalization";
import { normalizeSshLocalForwardEvent } from "@liveagent/ui/lib/terminal/sshLocalForwardTypes";
import type { TerminalEvent, TerminalSession } from "@liveagent/ui/lib/terminal/types";
import type { TunnelStateSnapshot } from "@liveagent/ui/lib/tunnels/constants";
import type {
  WorkspaceActivity,
  WorkspaceActivityEventPayload,
} from "@liveagent/ui/lib/workspace-activity/types";
import { ConversationStreamClient } from "@/lib/chat/stream/conversationStreamClient";
import { normalizeActivityEvent, normalizeCommandUpdate } from "@/lib/chat/stream/streamTypes";
import { BrowserGatewayTerminalStreamClient } from "@/lib/terminal/gatewayTerminalStreamClient";
import {
  applyTerminalSnapshotEvent,
  asErrorMessage,
  buildWebSocketUrl,
  CHAT_PREPARE_REQUEST_TIMEOUT_MS,
  type ChatActivityListener,
  type ChatCommandUpdateListener,
  type ChatQueueListener,
  DEFAULT_REQUEST_TIMEOUT_MS,
  FOREGROUND_SOCKET_RECYCLE_IDLE_MS,
  FOREGROUND_WAKEUP_RECENCY_MS,
  type GatewayRequestOptions,
  getRuntimeHost,
  type HistoryListener,
  isDocumentHidden,
  isForegroundWakeupEvent,
  isRecoverableGatewayTransportError,
  isRequestTimeoutError,
  isUnsupportedChatPrepareError,
  loadPersistedActiveAgent,
  type ManagedProcessStateListener,
  type ManagedProcessStatePayload,
  normalizeChatQueueEvent,
  normalizeManagedProcessState,
  normalizeTunnelStateSnapshot,
  normalizeWorkspaceActivity,
  type PendingRequest,
  persistActiveAgent,
  type RawChatQueueEvent,
  type RawManagedProcessStatePayload,
  type RawTerminalEvent,
  type RawTunnelStatePayload,
  type RawWorkspaceActivityPayload,
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  RECONNECT_NOTICE_DELAY_MS,
  replayTerminalSnapshot,
  requestRequiresAgentId,
  type SettingsListener,
  type SftpTransferListener,
  SOCKET_AUTH_TIMEOUT_MS,
  SOCKET_CONNECT_TIMEOUT_MS,
  SOCKET_INBOUND_STALL_MS,
  STATUS_POLL_INTERVAL_MS,
  STATUS_POLL_OFFLINE_INTERVAL_MS,
  type StatusListener,
  type TerminalListener,
  type TunnelStateListener,
  type WorkspaceActivityListener,
} from "./gatewaySocketShared";
import type { DecodedServerFrame } from "./gatewaySocketV2/adapters";
import {
  decodeServerFrame,
  decodeServerFrameBinary,
  encodeHelloFrame,
  encodePongFrame,
  encodeRequestFrame,
  GATEWAY_V2_SUBPROTOCOL,
} from "./gatewaySocketV2/adapters";
import type { AgentStatus, ChatQueueSnapshot, GatewayHistoryEvent } from "./gatewayTypes";

export class GatewayWebSocketTransport {
  readonly terminalStream: BrowserGatewayTerminalStreamClient;
  protected socket: WebSocket | null = null;
  protected connectPromise: Promise<void> | null = null;
  protected authenticated = false;
  protected requestSeq = 0;
  protected pending = new Map<string, PendingRequest>();
  protected disposed = false;
  protected statusListeners = new Set<StatusListener>();
  protected historyListeners = new Set<HistoryListener>();
  protected settingsListeners = new Set<SettingsListener>();
  protected terminalListeners = new Set<TerminalListener>();
  protected sftpTransferListeners = new Set<SftpTransferListener>();
  protected chatQueueListeners = new Set<ChatQueueListener>();
  protected chatActivityListeners = new Set<ChatActivityListener>();
  protected chatCommandUpdateListeners = new Set<ChatCommandUpdateListener>();
  protected connectionListeners = new Set<(connected: boolean) => void>();
  protected connectionState = false;
  protected tunnelStateListeners = new Set<TunnelStateListener>();
  protected workspaceActivityListeners = new Map<string, Set<WorkspaceActivityListener>>();
  protected lastTunnelState: TunnelStateSnapshot | null = null;
  // Server tunnel.state revisions are only monotonic within one gateway
  // process; this guard is reset on disconnect so a restarted gateway's
  // snapshots are not dropped. Subscribers see a client-side monotonic
  // revision instead.
  protected lastTunnelStateServerRevision = 0;
  protected tunnelStateRevisionCounter = 0;
  protected processStateListeners = new Set<ManagedProcessStateListener>();
  protected lastProcessState: ManagedProcessStatePayload | null = null;
  readonly conversationStreams = new ConversationStreamClient({
    request: (type, payload, options) => this.request(type, payload, options),
  });
  protected terminalSessionSnapshot = new Map<string, TerminalSession>();
  protected statusPollTimer: number | null = null;
  protected statusPollingActive = false;
  protected statusRefreshInFlight = false;
  protected lastStatus: AgentStatus | null = null;
  protected lastStatusError: string | null = null;
  protected lastInboundAt = 0;
  protected reconnectTimer: number | null = null;
  protected reconnectNoticeTimer: number | null = null;
  protected reconnectAttempt = 0;
  protected reconnecting = false;
  // hello 判定鉴权失败（随后 4401 关闭）：置位抑制自动重连，显式新连接尝试会清除。
  protected authRejected = false;
  protected lastForegroundWakeupAt = 0;
  // A hidden tab must not paint offline state the user cannot see from
  // throttled timers; the verdict is deferred until a foreground recheck.
  protected offlineReassessmentPending = false;
  protected prepareRuntimePromise: Promise<AgentStatus> | null = null;
  protected readonly reconnectWakeup = (event?: Event) => {
    this.noteForegroundWakeup(event);
  };

  // activeAgentId 始终是明确目标；首次连接从 Agent 目录自动选择并持久化。
  protected activeAgentId = "";
  protected activeAgentSelectionPromise: Promise<string> | null = null;
  // agents 目录：由打标 status 事件与 agent_list 响应维护，含离线条目。
  protected agents = new Map<string, AgentStatus>();
  protected agentsListeners = new Set<(agents: AgentStatus[]) => void>();
  protected pendingAgentEvents = new Map<string, Array<{ type: string; payload: unknown }>>();

  constructor(protected readonly token: string) {
    this.activeAgentId = loadPersistedActiveAgent();
    this.terminalStream = new BrowserGatewayTerminalStreamClient(token, () => this.activeAgentId);
    this.installReconnectWakeups();
  }

  getActiveAgent(): string {
    return this.activeAgentId;
  }

  // setActiveAgent 只接受明确目标；切换后重连，以目标 Agent 的快照重画状态。
  setActiveAgent(agentId: string): void {
    const next = agentId.trim();
    if (!next) {
      throw new Error("agent_id is required");
    }
    this.switchActiveAgent(next, true);
  }

  protected switchActiveAgent(agentId: string, reconnect: boolean): void {
    if (agentId === this.activeAgentId) {
      return;
    }
    this.activeAgentId = agentId;
    persistActiveAgent(agentId);
    if (reconnect && this.socket && this.authenticated) {
      this.handleDisconnect(new Error("active agent switched"));
    } else if (!reconnect && this.socket && this.authenticated) {
      this.flushPendingAgentEvents(agentId);
      this.conversationStreams.handleConnected();
      this.handleWorkspaceActivityConnected();
    }
  }

  // listAgents 拉取 Agent 目录（含离线与仅签发凭证的条目）。
  async listAgents(): Promise<AgentStatus[]> {
    if (!this.activeAgentId) {
      await this.ensureConnected();
      await this.ensureActiveAgent();
      await this.ensureConnected();
      return this.snapshotAgents();
    }
    const result = await this.requestWithRecovery<{ agents: AgentStatus[] }>("agent.list", {});
    const agents = Array.isArray(result?.agents) ? result.agents : [];
    this.updateAgentDirectory(agents);
    this.reconcileActiveAgent(agents);
    return this.snapshotAgents();
  }

  subscribeAgents(listener: (agents: AgentStatus[]) => void): () => void {
    this.agentsListeners.add(listener);
    if (this.agents.size > 0) {
      listener(this.snapshotAgents());
    }
    return () => {
      this.agentsListeners.delete(listener);
    };
  }

  protected updateAgentDirectory(agents: AgentStatus[]): void {
    this.agents.clear();
    for (const agent of agents) {
      const agentId = (agent.agent_id ?? "").trim();
      if (agentId) {
        this.agents.set(agentId, agent);
      }
    }
    this.emitAgents();
  }

  protected reconcileActiveAgent(agents: AgentStatus[], reconnect = true): string {
    const current = this.activeAgentId;
    if (current && agents.some((agent) => (agent.agent_id ?? "").trim() === current)) {
      return current;
    }
    const preferred = [...agents]
      .filter((agent) => (agent.agent_id ?? "").trim() !== "")
      .sort((left, right) => {
        if (left.online !== right.online) {
          return left.online ? -1 : 1;
        }
        return (left.agent_id ?? "").localeCompare(right.agent_id ?? "");
      })[0];
    const agentId = (preferred?.agent_id ?? "").trim();
    if (agentId) {
      this.switchActiveAgent(agentId, reconnect);
    } else if (current) {
      this.switchActiveAgent("", reconnect);
    }
    return agentId;
  }

  protected async ensureActiveAgent(): Promise<string> {
    if (this.activeAgentId) {
      return this.activeAgentId;
    }
    if (this.activeAgentSelectionPromise) {
      return this.activeAgentSelectionPromise;
    }
    this.activeAgentSelectionPromise = (async () => {
      const result = await this.sendConnectedRequest<{ agents: AgentStatus[] }>(
        "agent.list",
        {},
        undefined,
        "",
      );
      const agents = Array.isArray(result?.agents) ? result.agents : [];
      this.updateAgentDirectory(agents);
      const agentId = this.reconcileActiveAgent(agents, false);
      if (!agentId) {
        throw new Error("No Agent is available");
      }
      return agentId;
    })().finally(() => {
      this.activeAgentSelectionPromise = null;
    });
    return this.activeAgentSelectionPromise;
  }

  protected matchesActiveAgent(agentId: string): boolean {
    return this.activeAgentId !== "" && agentId === this.activeAgentId;
  }

  protected bufferAgentEvent(agentId: string, type: string, payload: unknown): void {
    const buffered = this.pendingAgentEvents.get(agentId) ?? [];
    if (buffered.length >= 256) {
      buffered.shift();
    }
    buffered.push({ type, payload });
    this.pendingAgentEvents.set(agentId, buffered);
  }

  protected flushPendingAgentEvents(agentId: string): void {
    const buffered = this.pendingAgentEvents.get(agentId) ?? [];
    this.pendingAgentEvents.clear();
    for (const event of buffered) {
      this.handleEvent(event.type, event.payload);
    }
  }

  protected snapshotAgents(): AgentStatus[] {
    return [...this.agents.values()].sort((a, b) =>
      (a.agent_id ?? "").localeCompare(b.agent_id ?? ""),
    );
  }

  protected emitAgents() {
    if (this.agentsListeners.size === 0) {
      return;
    }
    const snapshot = this.snapshotAgents();
    for (const listener of this.agentsListeners) {
      listener(snapshot);
    }
  }

  noteForegroundWakeup(event?: Event) {
    if (this.disposed || !isForegroundWakeupEvent(event)) {
      return;
    }
    const now = Date.now();
    this.lastForegroundWakeupAt = now;
    const reassess = this.offlineReassessmentPending;
    this.offlineReassessmentPending = false;
    if (
      this.socket?.readyState === WebSocket.OPEN &&
      this.authenticated &&
      this.shouldRecycleAuthenticatedSocket(now)
    ) {
      this.handleDisconnect(this.buildTransportStallError("after page restore"));
      this.scheduleReconnectNotice();
      return;
    }
    if (this.socket?.readyState === WebSocket.OPEN && this.authenticated) {
      // Healthy socket: reconcile the status truth immediately so a verdict
      // deferred while hidden resolves to fresh state, not a stale banner.
      if (this.statusListeners.size > 0) {
        void this.refreshStatus();
      }
      return;
    }
    if (reassess || this.reconnectNoticeTimer !== null) {
      // The existing notice delay doubles as the post-wake grace: nothing
      // paints offline until a reconnect attempt has had its 15s to settle.
      // A notice armed before (or while) hidden restarts from wake — it must
      // not fire seconds after refocus with most of its window pre-spent.
      this.clearReconnectNoticeTimer();
      this.scheduleReconnectNotice();
    }
    this.scheduleReconnect(0);
  }

  async getStatus(): Promise<AgentStatus> {
    const status = await this.requestWithRecovery<AgentStatus>("status.get", {});
    this.lastStatus = status;
    this.lastStatusError = null;
    return status;
  }

  async prepareChatRuntime(reason?: string): Promise<AgentStatus> {
    if (this.prepareRuntimePromise) {
      return this.prepareRuntimePromise;
    }
    this.noteForegroundWakeup();
    this.prepareRuntimePromise = (async () => {
      await this.ensureConnected();
      let status: AgentStatus;
      try {
        status = await this.request<AgentStatus>(
          "chat.prepare",
          {
            reason: reason?.trim() || "",
          },
          { timeoutMs: CHAT_PREPARE_REQUEST_TIMEOUT_MS },
        );
      } catch (error) {
        if (!isUnsupportedChatPrepareError(error)) {
          throw error;
        }
        // Rolling-upgrade compatibility: old gateways do not expose the real
        // prepare route. A status read preserves the old behavior until the
        // server is upgraded, while new gateways actively wake the runtime.
        status = await this.getStatus();
      }
      this.emitStatus(status, null);
      return status;
    })().finally(() => {
      this.prepareRuntimePromise = null;
    });
    return this.prepareRuntimePromise;
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    if (this.lastStatus || this.lastStatusError) {
      listener(this.lastStatus, this.lastStatusError);
    }
    if (this.statusListeners.size === 1) {
      this.startStatusPolling();
    }
    return () => {
      this.statusListeners.delete(listener);
      if (this.statusListeners.size === 0) {
        this.stopStatusPolling();
      }
    };
  }

  subscribeHistory(listener: HistoryListener): () => void {
    this.historyListeners.add(listener);
    return () => {
      this.historyListeners.delete(listener);
    };
  }

  subscribeSettings(listener: SettingsListener): () => void {
    this.settingsListeners.add(listener);
    return () => {
      this.settingsListeners.delete(listener);
    };
  }

  subscribeTerminal(listener: TerminalListener): () => void {
    this.terminalListeners.add(listener);
    replayTerminalSnapshot(this.terminalSessionSnapshot, listener);
    return () => {
      this.terminalListeners.delete(listener);
    };
  }

  subscribeTunnelState(listener: TunnelStateListener): () => void {
    this.tunnelStateListeners.add(listener);
    if (this.lastTunnelState) {
      listener(this.lastTunnelState);
    }
    return () => {
      this.tunnelStateListeners.delete(listener);
    };
  }

  subscribeProcessState(listener: ManagedProcessStateListener): () => void {
    this.processStateListeners.add(listener);
    if (this.lastProcessState) {
      listener(this.lastProcessState);
    }
    return () => {
      this.processStateListeners.delete(listener);
    };
  }

  subscribeSftpTransfers(listener: SftpTransferListener): () => void {
    this.sftpTransferListeners.add(listener);
    return () => {
      this.sftpTransferListeners.delete(listener);
    };
  }

  // Per-workdir workspace activity subscription. The first listener of a
  // workdir sends workspace.subscribe; the last one leaving sends
  // workspace.unsubscribe. On reconnect every registered workdir is
  // re-subscribed and its listeners receive `{ kind: "reset" }` because
  // events may have been missed while the socket was down.
  subscribeWorkspaceActivity(workdir: string, listener: WorkspaceActivityListener): () => void {
    const normalized = workdir.trim();
    if (!normalized) {
      return () => {};
    }
    let listeners = this.workspaceActivityListeners.get(normalized);
    const isFirst = !listeners;
    if (!listeners) {
      listeners = new Set();
      this.workspaceActivityListeners.set(normalized, listeners);
    }
    listeners.add(listener);
    if (isFirst) {
      if (this.socket?.readyState === WebSocket.OPEN && this.authenticated) {
        void this.sendWorkspaceSubscribe(normalized);
      } else {
        // The post-auth replay issues the subscribe for every registered
        // workdir, this one included.
        void this.ensureConnected().catch(() => {
          this.scheduleReconnect();
        });
      }
    }
    return () => {
      const current = this.workspaceActivityListeners.get(normalized);
      if (!current?.delete(listener)) {
        return;
      }
      if (current.size === 0) {
        this.workspaceActivityListeners.delete(normalized);
        void this.sendWorkspaceUnsubscribe(normalized);
      }
    };
  }

  protected async sendWorkspaceSubscribe(workdir: string) {
    try {
      await this.request("workspace.subscribe", { workdir });
    } catch {
      // The post-auth replay retries every registered subscription.
    }
  }

  protected async sendWorkspaceUnsubscribe(workdir: string) {
    // Never resurrect a connection just to unsubscribe: a dead socket already
    // dropped the server-side subscription.
    if (this.socket?.readyState !== WebSocket.OPEN || !this.authenticated) {
      return;
    }
    try {
      await this.request("workspace.unsubscribe", { workdir });
    } catch {
      // Connection loss clears server-side subscriptions anyway.
    }
  }

  protected handleWorkspaceActivityConnected() {
    const reset: WorkspaceActivityEventPayload = { kind: "reset" };
    for (const [workdir, listeners] of this.workspaceActivityListeners) {
      void this.sendWorkspaceSubscribe(workdir);
      for (const listener of [...listeners]) {
        listener(reset);
      }
    }
  }

  protected emitWorkspaceActivity(activity: WorkspaceActivity) {
    const listeners = this.workspaceActivityListeners.get(activity.workdir);
    if (!listeners) {
      return;
    }
    for (const listener of [...listeners]) {
      listener(activity);
    }
  }

  dispose() {
    this.disposed = true;
    this.terminalStream.dispose();
    this.uninstallReconnectWakeups();
    this.clearReconnectTimer();
    this.clearReconnectNoticeTimer();
    this.stopStatusPolling();
    this.handleDisconnect(new Error("Gateway WebSocket client disposed"));
  }

  protected startStatusPolling() {
    this.stopStatusPolling();
    this.statusPollingActive = true;
    void this.refreshStatus();
    this.scheduleNextStatusPoll();
  }

  protected stopStatusPolling() {
    this.statusPollingActive = false;
    if (this.statusPollTimer !== null) {
      const host = getRuntimeHost();
      host.clearTimeout(this.statusPollTimer);
      this.statusPollTimer = null;
    }
  }

  protected scheduleNextStatusPoll() {
    if (this.disposed || !this.statusPollingActive || this.statusPollTimer !== null) {
      return;
    }
    const host = getRuntimeHost();
    const delay =
      this.lastStatus !== null && this.lastStatus.online === false
        ? STATUS_POLL_OFFLINE_INTERVAL_MS
        : STATUS_POLL_INTERVAL_MS;
    this.statusPollTimer = host.setTimeout(() => {
      this.statusPollTimer = null;
      void this.refreshStatus().finally(() => this.scheduleNextStatusPoll());
    }, delay);
  }

  protected installReconnectWakeups() {
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("online", this.reconnectWakeup);
      window.addEventListener("focus", this.reconnectWakeup);
      window.addEventListener("pageshow", this.reconnectWakeup);
      window.addEventListener("pagehide", this.reconnectWakeup);
    }
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", this.reconnectWakeup);
      document.addEventListener("freeze", this.reconnectWakeup as EventListener);
      document.addEventListener("resume", this.reconnectWakeup as EventListener);
    }
  }

  protected uninstallReconnectWakeups() {
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("online", this.reconnectWakeup);
      window.removeEventListener("focus", this.reconnectWakeup);
      window.removeEventListener("pageshow", this.reconnectWakeup);
      window.removeEventListener("pagehide", this.reconnectWakeup);
    }
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", this.reconnectWakeup);
      document.removeEventListener("freeze", this.reconnectWakeup as EventListener);
      document.removeEventListener("resume", this.reconnectWakeup as EventListener);
    }
  }

  protected clearReconnectTimer() {
    if (this.reconnectTimer !== null) {
      const host = getRuntimeHost();
      host.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  protected clearReconnectNoticeTimer() {
    if (this.reconnectNoticeTimer !== null) {
      const host = getRuntimeHost();
      host.clearTimeout(this.reconnectNoticeTimer);
      this.reconnectNoticeTimer = null;
    }
  }

  protected scheduleReconnectNotice() {
    if (this.reconnectNoticeTimer !== null || this.disposed || this.statusListeners.size === 0) {
      return;
    }
    const host = getRuntimeHost();
    this.reconnectNoticeTimer = host.setTimeout(() => {
      this.reconnectNoticeTimer = null;
      if (
        this.disposed ||
        this.statusListeners.size === 0 ||
        (this.socket?.readyState === WebSocket.OPEN && this.authenticated)
      ) {
        return;
      }
      if (isDocumentHidden()) {
        // Deferred: the wakeup handler re-arms this notice and only a failed
        // post-wake reconnect gets to paint the offline banner.
        this.offlineReassessmentPending = true;
        return;
      }
      this.emitStatus(
        this.lastStatus
          ? {
              ...this.lastStatus,
              online: false,
            }
          : null,
        "Gateway 正在重新连接...",
      );
    }, RECONNECT_NOTICE_DELAY_MS);
  }

  protected shouldMaintainConnection() {
    return (
      !this.disposed &&
      this.token.trim() !== "" &&
      (this.pending.size > 0 ||
        this.statusListeners.size > 0 ||
        this.historyListeners.size > 0 ||
        this.settingsListeners.size > 0 ||
        this.terminalListeners.size > 0 ||
        this.sftpTransferListeners.size > 0 ||
        this.chatActivityListeners.size > 0 ||
        this.tunnelStateListeners.size > 0 ||
        this.processStateListeners.size > 0 ||
        this.workspaceActivityListeners.size > 0 ||
        this.conversationStreams.size > 0)
    );
  }

  protected scheduleReconnect(delayMs?: number) {
    if (!this.shouldMaintainConnection()) {
      return;
    }
    // 鉴权已被服务端拒绝：坏 token 的自动重连只会撞上同一个 4401。
    if (this.authRejected) {
      return;
    }
    if (this.socket?.readyState === WebSocket.OPEN && this.authenticated) {
      return;
    }
    if (this.connectPromise || this.reconnecting || this.reconnectTimer !== null) {
      return;
    }

    const baseDelay =
      typeof delayMs === "number"
        ? delayMs
        : Math.min(
            RECONNECT_MAX_DELAY_MS,
            RECONNECT_INITIAL_DELAY_MS * 2 ** Math.min(this.reconnectAttempt, 5),
          );
    const jitter =
      baseDelay > 0 ? Math.floor(Math.random() * Math.min(500, Math.max(1, baseDelay))) : 0;
    const host = getRuntimeHost();
    this.reconnectTimer = host.setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectNow();
    }, baseDelay + jitter);
  }

  protected async reconnectNow() {
    if (!this.shouldMaintainConnection()) {
      return;
    }
    if (this.socket?.readyState === WebSocket.OPEN && this.authenticated) {
      return;
    }
    if (this.reconnecting) {
      return;
    }

    this.reconnecting = true;
    try {
      await this.ensureConnected();
      this.clearReconnectNoticeTimer();
      this.reconnectAttempt = 0;
      if (this.statusListeners.size > 0) {
        void this.refreshStatus();
      }
    } catch {
      this.reconnectAttempt += 1;
      this.scheduleReconnect();
    } finally {
      this.reconnecting = false;
      if (
        this.shouldMaintainConnection() &&
        !(this.socket?.readyState === WebSocket.OPEN && this.authenticated)
      ) {
        this.scheduleReconnect();
      }
    }
  }

  // The transport is demonstrably alive while frames keep arriving; a starved
  // status.get during a chat.event burst must not flip the UI to offline.
  protected hasFreshInboundActivity() {
    return (
      this.socket !== null &&
      this.authenticated &&
      this.socket.readyState === WebSocket.OPEN &&
      this.lastInboundAt > 0 &&
      Date.now() - this.lastInboundAt < SOCKET_INBOUND_STALL_MS
    );
  }

  protected async refreshStatus() {
    if (this.statusRefreshInFlight) {
      return;
    }
    this.statusRefreshInFlight = true;
    try {
      const status = await this.getStatus();
      this.clearReconnectNoticeTimer();
      this.emitStatus(status, null);
    } catch (error) {
      if (isRecoverableGatewayTransportError(error) && this.shouldMaintainConnection()) {
        this.scheduleReconnect();
        this.scheduleReconnectNotice();
        return;
      }
      if (isRequestTimeoutError(error) && this.hasFreshInboundActivity()) {
        // Keep the last known status; the next poll retries.
        return;
      }
      if (isDocumentHidden()) {
        // Keep the last visible status; the foreground wakeup rechecks
        // before any offline verdict is painted.
        this.offlineReassessmentPending = true;
        return;
      }
      const message = asErrorMessage(error, "status request failed");
      const offlineStatus =
        this.lastStatus !== null
          ? {
              ...this.lastStatus,
              online: false,
            }
          : null;
      this.lastStatus = offlineStatus;
      this.lastStatusError = message;
      this.emitStatus(offlineStatus, message);
    } finally {
      this.statusRefreshInFlight = false;
    }
  }

  protected emitStatus(status: AgentStatus | null, error: string | null) {
    // Whatever gets painted is the verdict; any deferred reassessment is moot.
    this.offlineReassessmentPending = false;
    this.lastStatus = status;
    this.lastStatusError = error;
    if (status?.online === false) {
      this.terminalSessionSnapshot.clear();
      // Switch a pending slow poll to the offline fast cadence right away
      // rather than after its remaining (up to 30s) delay.
      if (this.statusPollTimer !== null) {
        const host = getRuntimeHost();
        host.clearTimeout(this.statusPollTimer);
        this.statusPollTimer = null;
        this.scheduleNextStatusPoll();
      }
    }
    for (const listener of this.statusListeners) {
      listener(status, error);
    }
  }

  protected emitHistory(event: GatewayHistoryEvent) {
    for (const listener of this.historyListeners) {
      listener(event);
    }
  }

  protected emitSettings(event: GatewaySettingsSyncPayload) {
    for (const listener of this.settingsListeners) {
      listener(event);
    }
  }

  protected emitTerminal(event: TerminalEvent) {
    applyTerminalSnapshotEvent(this.terminalSessionSnapshot, event);
    for (const listener of this.terminalListeners) {
      listener(event);
    }
  }

  protected emitSftpTransfer(event: SftpTransferEvent) {
    for (const listener of this.sftpTransferListeners) {
      listener(event);
    }
  }

  // No server-revision guard here: managed-process revisions are stamped by
  // the desktop agent and persisted across restarts; the mirrored store does
  // its own monotonic filtering.
  protected emitProcessState(state: ManagedProcessStatePayload) {
    this.lastProcessState = state;
    for (const listener of this.processStateListeners) {
      listener(state);
    }
  }

  protected emitTunnelState(snapshot: TunnelStateSnapshot) {
    // Drop stale/reordered snapshots from the current gateway process.
    if (snapshot.revision <= this.lastTunnelStateServerRevision) {
      return;
    }
    this.lastTunnelStateServerRevision = snapshot.revision;
    this.tunnelStateRevisionCounter += 1;
    const next: TunnelStateSnapshot = {
      ...snapshot,
      revision: this.tunnelStateRevisionCounter,
    };
    this.lastTunnelState = next;
    for (const listener of this.tunnelStateListeners) {
      listener(next);
    }
  }

  protected async requestWithRecovery<T>(
    type: string,
    payload: unknown,
    options?: GatewayRequestOptions,
  ): Promise<T> {
    try {
      return await this.request<T>(type, payload, options);
    } catch (error) {
      if (!isRecoverableGatewayTransportError(error) || this.disposed) {
        throw error;
      }
      await this.recoverTransport();
      return this.request<T>(type, payload, options);
    }
  }

  protected async request<T>(
    type: string,
    payload: unknown,
    options?: GatewayRequestOptions,
  ): Promise<T> {
    await this.ensureConnected();
    let agentId = this.activeAgentId;
    if (requestRequiresAgentId(type)) {
      agentId = await this.ensureActiveAgent();
      // 首次自动选中会主动重连，以便只回放目标 Agent 的快照。
      await this.ensureConnected();
    }
    return this.sendConnectedRequest<T>(type, payload, options, agentId);
  }

  protected sendConnectedRequest<T>(
    type: string,
    payload: unknown,
    options: GatewayRequestOptions | undefined,
    agentId: string,
  ): Promise<T> {
    const requestId = this.nextRequestId(type);
    return new Promise<T>((resolve, reject) => {
      const host = getRuntimeHost();
      const requestStartedAt = Date.now();
      const timeoutId = host.setTimeout(() => {
        const pending = this.pending.get(requestId);
        if (!pending) {
          return;
        }

        if (this.shouldTreatRequestTimeoutAsTransportStall(requestStartedAt)) {
          this.handleDisconnect(this.buildTransportStallError(`while waiting for ${type}`));
          return;
        }

        this.pending.delete(requestId);
        reject(new Error(`Gateway WebSocket request timed out: ${type}`));
      }, options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

      this.pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timeoutId,
        onDelta: options?.onDelta,
      });

      try {
        this.sendFrame(encodeRequestFrame(requestId, type, payload, agentId));
      } catch (error) {
        host.clearTimeout(timeoutId);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  protected async ensureConnected(): Promise<void> {
    if (this.disposed) {
      throw new Error("Gateway WebSocket client has been disposed");
    }
    if (this.token.trim() === "") {
      throw new Error("Gateway token is required");
    }
    if (this.socket && this.authenticated && this.socket.readyState === WebSocket.OPEN) {
      if (this.shouldRecycleAuthenticatedSocket()) {
        this.handleDisconnect(this.buildTransportStallError("before sending a new request"));
      } else {
        return;
      }
    }
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    const socketUrl = buildWebSocketUrl();
    let reconnectAfterTimeout = false;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      // 显式连接尝试清除鉴权失败标记；自动重连循环不会反复敲门坏 token。
      this.authRejected = false;
      const socket = new WebSocket(socketUrl, GATEWAY_V2_SUBPROTOCOL);
      socket.binaryType = "arraybuffer";
      const host = getRuntimeHost();
      let settled = false;
      let authTimeoutId: number | null = null;
      const clearAttemptTimers = () => {
        host.clearTimeout(connectionTimeoutId);
        if (authTimeoutId !== null) {
          host.clearTimeout(authTimeoutId);
          authTimeoutId = null;
        }
      };
      const rejectOnce = (error: Error) => {
        clearAttemptTimers();
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };
      const connectionTimeoutId = host.setTimeout(() => {
        const error = new Error("Gateway WebSocket connection timed out");
        reconnectAfterTimeout = true;
        rejectOnce(error);
        if (this.socket === socket) {
          this.handleDisconnect(error);
          return;
        }
        socket.onopen = null;
        socket.onclose = null;
        socket.onmessage = null;
        socket.onerror = null;
        try {
          socket.close();
        } catch {
          // The browser may reject close() while the handshake is between
          // internal states; the detached attempt is still abandoned.
        }
      }, SOCKET_CONNECT_TIMEOUT_MS);

      socket.onmessage = (event) => {
        this.handleMessage(event.data);
      };
      socket.onerror = () => {
        // onclose will drive the actual error propagation
      };
      socket.onclose = (event) => {
        clearAttemptTimers();
        const reason = event.reason.trim() ? ` reason=${event.reason.trim()}` : "";
        const error = new Error(
          `Gateway WebSocket disconnected (code=${event.code} clean=${event.wasClean}${reason})`,
        );
        // A rejected attempt can close after its caller has already opened a
        // replacement socket. Only the socket still owned by this client may
        // tear down shared state; a detached attempt merely settles itself.
        if (this.socket === socket) {
          this.handleDisconnect(error);
        }
        rejectOnce(error);
      };
      socket.onopen = () => {
        if (settled) {
          socket.close();
          return;
        }
        // The transport phase is over: hand the deadline to the auth timer.
        // Left running, the connect timer would always preempt the (longer)
        // auth timeout and cap connect+auth at the connect budget.
        host.clearTimeout(connectionTimeoutId);
        this.socket = socket;
        this.authenticated = false;
        this.lastInboundAt = 0;
        this.clearReconnectTimer();

        const authId = this.nextRequestId("auth");
        authTimeoutId = host.setTimeout(() => {
          this.pending.delete(authId);
          const error = new Error("Gateway WebSocket auth timed out");
          rejectOnce(error);
          if (this.socket === socket) {
            this.handleDisconnect(error);
          } else {
            socket.close();
          }
        }, SOCKET_AUTH_TIMEOUT_MS);

        this.pending.set(authId, {
          resolve: () => {
            clearAttemptTimers();
            this.authenticated = true;
            this.clearReconnectNoticeTimer();
            this.reconnectAttempt = 0;
            this.setConnectionState(true);
            if (this.activeAgentId) {
              this.conversationStreams.handleConnected();
              this.handleWorkspaceActivityConnected();
            } else {
              void this.ensureActiveAgent().catch(() => {
                // 没有可选 Agent 时由具体业务请求展示错误。
              });
            }
            if (!settled) {
              settled = true;
              resolve();
            }
          },
          reject: (reason) => {
            const error = reason instanceof Error ? reason : new Error(String(reason));
            rejectOnce(error);
            if (this.socket === socket) {
              this.handleDisconnect(error);
            } else {
              socket.onclose = null;
              socket.close();
            }
          },
          timeoutId: authTimeoutId,
        });

        this.sendFrame(encodeHelloFrame(authId, this.token));
      };
    }).finally(() => {
      this.connectPromise = null;
      if (reconnectAfterTimeout && !this.disposed) {
        this.scheduleReconnect(0);
      }
    });

    await this.connectPromise;
  }

  // sendFrame 发送一帧已编码的 v2 二进制帧。
  protected sendFrame(frame: Uint8Array<ArrayBuffer>) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Gateway WebSocket is not connected");
    }
    this.socket.send(frame);
  }

  protected handleMessage(raw: unknown) {
    this.markInboundActivity();
    // v2 链路只承载二进制帧；文本帧仅计入存活。
    if (!(raw instanceof ArrayBuffer) && !ArrayBuffer.isView(raw)) {
      return;
    }
    let decoded: DecodedServerFrame | null;
    try {
      decoded = decodeServerFrame(
        decodeServerFrameBinary(raw instanceof ArrayBuffer ? raw : (raw as Uint8Array)),
        { agentOnline: this.lastStatus?.online === true },
      );
    } catch {
      return;
    }
    if (!decoded) {
      return;
    }

    if (decoded.kind === "hello") {
      const pending = this.pending.get(decoded.requestId);
      if (!pending) {
        return;
      }
      const host = getRuntimeHost();
      host.clearTimeout(pending.timeoutId);
      this.pending.delete(decoded.requestId);
      if (decoded.ok) {
        pending.resolve({ ok: true });
      } else {
        // 服务端将以 4401 关闭：标记鉴权失败并阻断自动重连，交由上层展示鉴权错误。
        this.authRejected = true;
        pending.reject(new Error(decoded.message || "unauthorized"));
      }
      return;
    }

    if (decoded.kind === "ping") {
      // 应用层心跳：回送 protobuf pong。
      try {
        this.sendFrame(encodePongFrame(decoded.timestamp || Date.now()));
      } catch {
        // The close handler will drive reconnect if the socket is already gone.
      }
      return;
    }

    if (decoded.kind === "event") {
      if (decoded.type === "status.event" && decoded.agentId) {
        // 打标状态帧始终更新目录；业务监听只接收当前明确目标。
        const nextStatus = decoded.payload as AgentStatus;
        const name = this.agents.get(decoded.agentId)?.name?.trim();
        this.agents.set(decoded.agentId, name ? { ...nextStatus, name } : nextStatus);
        this.emitAgents();
      }
      if (decoded.agentId && !this.activeAgentId) {
        this.bufferAgentEvent(decoded.agentId, decoded.type, decoded.payload);
        return;
      }
      if (decoded.agentId && !this.matchesActiveAgent(decoded.agentId)) {
        return;
      }
      this.handleEvent(decoded.type, decoded.payload);
      return;
    }

    if (decoded.kind === "progress") {
      const pendingProgress = decoded.requestId ? this.pending.get(decoded.requestId) : null;
      if (decoded.type === "clarify.turn_delta" && decoded.payload.text) {
        pendingProgress?.onDelta?.(decoded.payload.text);
      }
      return;
    }

    const pending = decoded.requestId ? this.pending.get(decoded.requestId) : null;
    if (!pending) {
      return;
    }
    const host = getRuntimeHost();
    host.clearTimeout(pending.timeoutId);
    this.pending.delete(decoded.requestId);
    if (decoded.kind === "error") {
      pending.reject(new Error(decoded.message || "Request failed"));
      return;
    }
    pending.resolve(decoded.payload);
  }

  // 分发广播事件；payload 已由适配层还原为既有归一化器需要的对象形状。
  protected handleEvent(type: string, payload: unknown) {
    if (type === "history.event") {
      const event = payload as GatewayHistoryEvent;
      if (event?.kind === "upsert" || event?.kind === "delete") {
        this.emitHistory(event);
      }
      return;
    }

    if (type === "settings.event") {
      const event = payload as GatewaySettingsSyncPayload;
      if (event && typeof event === "object") {
        this.emitSettings(event);
      }
      return;
    }

    if (type === "terminal.event") {
      const event = normalizeTerminalEvent(
        payload as RawTerminalEvent,
        normalizeSshLocalForwardEvent,
      );
      if (event) {
        this.emitTerminal(event);
      }
      return;
    }

    if (type === "sftp.event") {
      const event = normalizeSftpTransferEvent(payload as RawSftpTransferEvent);
      if (event) {
        this.emitSftpTransfer(event);
      }
      return;
    }

    if (type === "process.state") {
      const statePayload =
        payload && typeof payload === "object" ? (payload as RawManagedProcessStatePayload) : null;
      if (statePayload) {
        this.emitProcessState(normalizeManagedProcessState(statePayload));
      }
      return;
    }

    if (type === "tunnel.state") {
      const statePayload =
        payload && typeof payload === "object" ? (payload as RawTunnelStatePayload) : null;
      if (statePayload) {
        this.emitTunnelState(normalizeTunnelStateSnapshot(statePayload));
      }
      return;
    }

    if (type === "status.event") {
      const statusPayload =
        payload && typeof payload === "object" ? (payload as AgentStatus) : null;
      if (statusPayload && typeof statusPayload.online === "boolean") {
        this.clearReconnectNoticeTimer();
        this.emitStatus(statusPayload, null);
      }
      return;
    }

    if (type === "workspace.activity") {
      const activityPayload =
        payload && typeof payload === "object" ? (payload as RawWorkspaceActivityPayload) : null;
      const activity = activityPayload ? normalizeWorkspaceActivity(activityPayload) : null;
      if (activity) {
        this.emitWorkspaceActivity(activity);
      }
      return;
    }

    if (type === "chat_queue.event") {
      const snapshot = normalizeChatQueueEvent(payload as RawChatQueueEvent);
      if (snapshot) {
        this.emitChatQueue(snapshot);
      }
      return;
    }

    if (type === "chat.event") {
      this.conversationStreams.handleChatEvent(payload);
      return;
    }

    if (type === "chat.subscription_reset") {
      this.conversationStreams.handleSubscriptionReset(payload);
      return;
    }

    if (type === "chat.activity") {
      const event = normalizeActivityEvent(payload);
      if (event) {
        for (const listener of this.chatActivityListeners) {
          listener(event);
        }
      }
      return;
    }

    if (type === "chat.command_update") {
      const update = normalizeCommandUpdate(payload);
      if (update) {
        for (const listener of this.chatCommandUpdateListeners) {
          listener(update);
        }
      }
    }
  }

  protected handleDisconnect(error: Error) {
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.onmessage = null;
      this.socket.onerror = null;
      if (
        this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING
      ) {
        this.socket.close();
      }
    }
    this.socket = null;
    this.authenticated = false;
    this.pendingAgentEvents.clear();
    this.setConnectionState(false);

    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      const host = getRuntimeHost();
      host.clearTimeout(entry.timeoutId);
      entry.reject(error);
    }

    // Conversation stream registrations survive the disconnect; they resume
    // with their seq cursors when the socket re-authenticates.
    this.conversationStreams.handleDisconnected();

    if (!this.disposed && this.statusListeners.size > 0) {
      if (isRecoverableGatewayTransportError(error) && this.shouldMaintainConnection()) {
        this.scheduleReconnectNotice();
      } else if (isDocumentHidden()) {
        this.offlineReassessmentPending = true;
      } else {
        this.emitStatus(
          this.lastStatus
            ? {
                ...this.lastStatus,
                online: false,
              }
            : null,
          error.message,
        );
      }
    }
    this.lastInboundAt = 0;
    // A reconnect may land on a restarted gateway whose tunnel.state
    // revisions start over; accept the fresh post-auth snapshot.
    this.lastTunnelStateServerRevision = 0;
    if (!this.disposed) {
      this.scheduleReconnect();
    }
  }

  protected markInboundActivity() {
    this.lastInboundAt = Date.now();
  }

  protected setConnectionState(connected: boolean) {
    if (this.connectionState === connected) {
      return;
    }
    this.connectionState = connected;
    for (const listener of this.connectionListeners) {
      listener(connected);
    }
  }

  protected emitChatQueue(snapshot: ChatQueueSnapshot) {
    for (const listener of this.chatQueueListeners) {
      listener(snapshot);
    }
  }

  protected shouldRecycleAuthenticatedSocket(now = Date.now()) {
    if (
      this.socket === null ||
      !this.authenticated ||
      this.socket.readyState !== WebSocket.OPEN ||
      this.lastInboundAt <= 0
    ) {
      return false;
    }
    if (now - this.lastInboundAt >= SOCKET_INBOUND_STALL_MS) {
      return true;
    }
    return (
      this.lastForegroundWakeupAt > 0 &&
      now - this.lastForegroundWakeupAt <= FOREGROUND_WAKEUP_RECENCY_MS &&
      this.lastInboundAt < this.lastForegroundWakeupAt &&
      now - this.lastInboundAt >= FOREGROUND_SOCKET_RECYCLE_IDLE_MS
    );
  }

  protected shouldTreatRequestTimeoutAsTransportStall(requestStartedAt: number) {
    return (
      this.socket !== null &&
      this.authenticated &&
      this.socket.readyState === WebSocket.OPEN &&
      this.lastInboundAt <= requestStartedAt
    );
  }

  protected buildTransportStallError(reason: string) {
    return new Error(`Gateway transport stalled ${reason}`.trim());
  }

  protected async recoverTransport() {
    await this.ensureConnected();
  }

  protected nextRequestId(prefix: string) {
    this.requestSeq += 1;
    return `${prefix}-${Date.now()}-${this.requestSeq}`;
  }
}
