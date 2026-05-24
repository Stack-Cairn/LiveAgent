import type { GatewaySettingsSyncPayload } from "@/lib/settings/sync";
import type { HistoryMessageRef } from "@/lib/chat/conversationState";
import type { PendingUploadedFile } from "@/lib/chat/uploadedFiles";

import { GatewayWebSocketClient } from "./gatewaySocket";
import type {
  AgentStatus,
  ChatEvent,
  CronManagePayload,
  GatewayChatRuntimeControls,
  GatewaySelectedModel,
  MemoryManagePayload,
} from "./gatewayTypes";

type WorkerClientRequest =
  | {
      type: "connect";
      connection_id: string;
      token: string;
    }
  | {
      type: "request";
      connection_id: string;
      request_id: string;
      method: string;
      payload?: unknown;
    }
  | {
      type: "chat.start";
      connection_id: string;
      request_id: string;
      stream_id: string;
      payload: {
        message: string;
        conversation_id?: string;
        client_request_id?: string;
        selected_model?: GatewaySelectedModel;
        runtime_controls?: GatewayChatRuntimeControls;
        system_settings?: {
          executionMode?: string;
          workdir?: string;
          selectedSystemTools?: string[];
        };
        uploaded_files?: PendingUploadedFile[];
      };
    }
  | {
      type: "chat.cancel";
      connection_id: string;
      stream_id: string;
      conversation_id?: string;
    }
  | {
      type: "chat.attach";
      connection_id: string;
      request_id: string;
      stream_id: string;
      conversation_id: string;
      after_seq?: number;
    }
  | {
      type: "chat.detach";
      connection_id: string;
      stream_id: string;
    }
  | {
      type: "dispose";
      connection_id: string;
    };

type ManagedClient = {
  token: string;
  client: GatewayWebSocketClient;
  ports: Set<MessagePort>;
  status: AgentStatus | null;
  statusError: string | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

type PortState = {
  connectionID: string;
  client: ManagedClient;
  streams: Map<string, AbortController>;
};

type SharedWorkerScope = {
  onconnect: ((event: MessageEvent & { ports: MessagePort[] }) => void) | null;
};

const clients = new Map<string, ManagedClient>();
const portStates = new Map<MessagePort, PortState>();

function asErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  const text = String(error ?? "").trim();
  return text || fallback;
}

function postToPort(port: MessagePort, payload: unknown) {
  try {
    port.postMessage(payload);
  } catch {
    disconnectPort(port);
  }
}

function broadcast(client: ManagedClient, payload: Record<string, unknown>) {
  for (const port of [...client.ports]) {
    const state = portStates.get(port);
    if (!state || state.client !== client) {
      client.ports.delete(port);
      continue;
    }
    postToPort(port, {
      ...payload,
      connection_id: state.connectionID,
    });
  }
}

function scheduleManagedClientCleanup(client: ManagedClient) {
  if (client.ports.size > 0 || client.idleTimer !== null) {
    return;
  }
  client.idleTimer = setTimeout(() => {
    client.idleTimer = null;
    if (client.ports.size > 0) {
      return;
    }
    client.client.dispose();
    clients.delete(client.token);
  }, 60_000);
}

function clearManagedClientCleanup(client: ManagedClient) {
  if (client.idleTimer === null) {
    return;
  }
  clearTimeout(client.idleTimer);
  client.idleTimer = null;
}

function getManagedClient(token: string) {
  const normalizedToken = token.trim();
  const existing = clients.get(normalizedToken);
  if (existing) {
    return existing;
  }

  const managed: ManagedClient = {
    token: normalizedToken,
    client: new GatewayWebSocketClient(normalizedToken),
    ports: new Set(),
    status: null,
    statusError: null,
    idleTimer: null,
  };

  managed.client.subscribeStatus((status, error) => {
    managed.status = status;
    managed.statusError = error;
    broadcast(managed, {
      type: "event",
      event_type: "status",
      payload: { status, error },
    });
  });
  managed.client.subscribeHistory((event) => {
    broadcast(managed, {
      type: "event",
      event_type: "history",
      payload: event,
    });
  });
  managed.client.subscribeConversation((event) => {
    broadcast(managed, {
      type: "event",
      event_type: "conversation",
      payload: event,
    });
  });
  managed.client.subscribeSettings((event) => {
    broadcast(managed, {
      type: "event",
      event_type: "settings",
      payload: event,
    });
  });

  clients.set(normalizedToken, managed);
  return managed;
}

function connectPort(port: MessagePort, message: Extract<WorkerClientRequest, { type: "connect" }>) {
  const client = getManagedClient(message.token);
  clearManagedClientCleanup(client);
  client.ports.add(port);
  portStates.set(port, {
    connectionID: message.connection_id,
    client,
    streams: new Map(),
  });
  postToPort(port, {
    type: "ready",
    connection_id: message.connection_id,
    payload: {
      status: client.status,
      error: client.statusError,
    },
  });
}

function disconnectPort(port: MessagePort) {
  const state = portStates.get(port);
  if (!state) {
    return;
  }
  for (const controller of state.streams.values()) {
    controller.abort();
  }
  state.streams.clear();
  state.client.ports.delete(port);
  portStates.delete(port);
  scheduleManagedClientCleanup(state.client);
}

async function resolveRequest(client: GatewayWebSocketClient, method: string, payload: unknown) {
  const body = (payload ?? {}) as Record<string, unknown>;
  switch (method) {
    case "status.get":
      return client.getStatus();
    case "fs.roots":
      return client.listFsRoots();
    case "fs.list_dirs":
      return client.listDirs(
        String(body.path ?? ""),
        typeof body.max_results === "number" ? body.max_results : undefined,
      );
    case "history.list":
      return client.listHistory(
        typeof body.limit === "number" ? body.limit : 0,
        typeof body.offset === "number" ? body.offset : 0,
      );
    case "history.get":
      return client.getHistory(String(body.conversation_id ?? ""), {
        maxMessages: typeof body.max_messages === "number" ? body.max_messages : undefined,
      });
    case "history.rename":
      return client.renameHistory(
        String(body.conversation_id ?? ""),
        String(body.title ?? ""),
      );
    case "history.pin":
      return client.pinHistory(
        String(body.conversation_id ?? ""),
        body.is_pinned === true,
      );
    case "history.share.get":
      return client.getHistoryShare(String(body.conversation_id ?? ""));
    case "history.share.set":
      return client.setHistoryShare(
        String(body.conversation_id ?? ""),
        body.enabled === true,
        typeof body.redact_tool_content === "boolean"
          ? { redactToolContent: body.redact_tool_content }
          : undefined,
      );
    case "history.delete":
      await client.deleteHistory(String(body.conversation_id ?? ""));
      return undefined;
    case "history.truncate":
      return client.truncateHistory(
        String(body.conversation_id ?? ""),
        {
          segmentIndex: typeof body.segment_index === "number" ? body.segment_index : 0,
          messageIndex: typeof body.message_index === "number" ? body.message_index : 0,
        } satisfies HistoryMessageRef,
        { omitMessagesJson: body.omit_messages_json === true },
      );
    case "providers.list":
      return client.listProviders();
    case "settings.get":
      return client.getSettings();
    case "settings.update":
      await client.updateSettings(payload as GatewaySettingsSyncPayload);
      return undefined;
    case "skills.list":
      return client.listSkillFiles();
    case "skills.manage":
      return client.manageSkill(payload as Record<string, unknown>);
    case "mentions.list":
      return client.listMentionFiles(
        String(body.workdir ?? ""),
        typeof body.max_results === "number" ? body.max_results : undefined,
        typeof body.query === "string" ? body.query : undefined,
      );
    case "skills.read-metadata":
      return client.readSkillMetadata(String(body.path ?? ""));
    case "skills.read-text":
      return client.readSkillText(
        String(body.path ?? ""),
        typeof body.offset === "number" ? body.offset : undefined,
        typeof body.length === "number" ? body.length : undefined,
      );
    case "files.preview":
      return client.readUploadedImagePreview(
        String(body.workdir ?? ""),
        String(body.absolute_path ?? ""),
      );
    case "cron.manage":
      return client.cronManage(payload as CronManagePayload);
    case "memory.manage":
      return client.memoryManage(payload as MemoryManagePayload);
    case "provider.models":
      return client.getProviderModels(
        String(body.type ?? ""),
        String(body.base_url ?? ""),
        String(body.api_key ?? ""),
      );
    default:
      throw new Error(`Unsupported Gateway SharedWorker method: ${method}`);
  }
}

function respond(
  port: MessagePort,
  connectionID: string,
  requestID: string,
  payload?: unknown,
  error?: string,
) {
  postToPort(port, {
    type: "response",
    connection_id: connectionID,
    request_id: requestID,
    payload,
    error,
  });
}

async function handleRequest(
  port: MessagePort,
  state: PortState,
  message: Extract<WorkerClientRequest, { type: "request" }>,
) {
  try {
    const payload = await resolveRequest(state.client.client, message.method, message.payload);
    respond(port, state.connectionID, message.request_id, payload);
  } catch (error) {
    respond(
      port,
      state.connectionID,
      message.request_id,
      undefined,
      asErrorMessage(error, "Gateway SharedWorker request failed"),
    );
  }
}

function handleChatStart(
  port: MessagePort,
  state: PortState,
  message: Extract<WorkerClientRequest, { type: "chat.start" }>,
) {
  const controller = new AbortController();
  state.streams.set(message.stream_id, controller);
  respond(port, state.connectionID, message.request_id, { ok: true });

  void (async () => {
    try {
      const stream = state.client.client.chat(
        message.payload.message,
        message.payload.conversation_id,
        message.payload.selected_model,
        message.payload.system_settings,
        controller.signal,
        message.payload.uploaded_files,
        message.payload.client_request_id,
        message.payload.runtime_controls,
      );
      for await (const event of stream) {
        postToPort(port, {
          type: "chat-event",
          connection_id: state.connectionID,
          stream_id: message.stream_id,
          payload: event,
        });
      }
      postToPort(port, {
        type: "chat-closed",
        connection_id: state.connectionID,
        stream_id: message.stream_id,
      });
    } catch (error) {
      postToPort(port, {
        type: "chat-error",
        connection_id: state.connectionID,
        stream_id: message.stream_id,
        error: asErrorMessage(error, "Gateway SharedWorker chat stream failed"),
      });
    } finally {
      state.streams.delete(message.stream_id);
    }
  })();
}

function handleChatAttach(
  port: MessagePort,
  state: PortState,
  message: Extract<WorkerClientRequest, { type: "chat.attach" }>,
) {
  const controller = new AbortController();
  state.streams.set(message.stream_id, controller);
  respond(port, state.connectionID, message.request_id, { ok: true });

  void (async () => {
    try {
      const stream = state.client.client.attachChat(message.conversation_id, {
        afterSeq: message.after_seq,
        signal: controller.signal,
      });
      for await (const event of stream) {
        postToPort(port, {
          type: "chat-event",
          connection_id: state.connectionID,
          stream_id: message.stream_id,
          payload: event,
        });
      }
      postToPort(port, {
        type: "chat-closed",
        connection_id: state.connectionID,
        stream_id: message.stream_id,
      });
    } catch (error) {
      postToPort(port, {
        type: "chat-error",
        connection_id: state.connectionID,
        stream_id: message.stream_id,
        error: asErrorMessage(error, "Gateway SharedWorker chat attach failed"),
      });
    } finally {
      state.streams.delete(message.stream_id);
    }
  })();
}

function handleChatCancel(
  state: PortState,
  message: Extract<WorkerClientRequest, { type: "chat.cancel" }>,
) {
  const controller = state.streams.get(message.stream_id);
  controller?.abort();
  state.streams.delete(message.stream_id);
  const conversationID = message.conversation_id?.trim();
  if (conversationID) {
    void state.client.client.cancelChat(conversationID).catch(() => undefined);
  }
}

function handleChatDetach(
  state: PortState,
  message: Extract<WorkerClientRequest, { type: "chat.detach" }>,
) {
  const controller = state.streams.get(message.stream_id);
  controller?.abort();
  state.streams.delete(message.stream_id);
}

function handlePortMessage(port: MessagePort, raw: unknown) {
  const message = raw as WorkerClientRequest;
  if (!message || typeof message !== "object") {
    return;
  }
  if (message.type === "connect") {
    connectPort(port, message);
    return;
  }
  if (message.type === "dispose") {
    disconnectPort(port);
    port.close();
    return;
  }

  const state = portStates.get(port);
  if (!state || state.connectionID !== message.connection_id) {
    return;
  }
  switch (message.type) {
    case "request":
      void handleRequest(port, state, message);
      return;
    case "chat.start":
      handleChatStart(port, state, message);
      return;
    case "chat.cancel":
      handleChatCancel(state, message);
      return;
    case "chat.attach":
      handleChatAttach(port, state, message);
      return;
    case "chat.detach":
      handleChatDetach(state, message);
      return;
  }
}

const workerScope = globalThis as unknown as SharedWorkerScope;
workerScope.onconnect = (event) => {
  const port = event.ports[0];
  if (!port) {
    return;
  }
  port.onmessage = (message) => handlePortMessage(port, message.data);
  port.onmessageerror = () => disconnectPort(port);
  port.start();
};
