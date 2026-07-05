// Web-only SidebarBackend adapter over the gateway WebSocket client. NOT
// byte-mirrored: everything gateway-specific (snake_case summaries, epoch
// units, the activity-store bridge) is normalized here so the mirrored store
// never sees a wire shape.
//
// Timestamp units (verified against the Go handler + desktop writers):
// `history.list` / `history.event` / `history.workdirs` pass the desktop
// SQLite `updated_at` values through untouched (Go
// websocket_history_handlers.go + websocket_payloads.go do no conversion;
// the Rust bridge in gateway_bridge.rs is a pass-through of `MAX(updated_at)`
// et al.), and the desktop writes epoch **milliseconds** (`Date.now()` in the
// GUI history layer, `now_ms()` fallbacks in Rust). Legacy rows and any
// second-based producer are still normalized defensively: values below the
// seconds ceiling are multiplied to ms, everything else passes through.
// `chat.activity` / `running_conversations` use `UnixMilli()` explicitly.

import type { ActivityStore } from "@/lib/chat/stream/activityStore";
import { formatConversationTitle } from "@/lib/chatUi";
import type {
  ConversationSummary,
  GatewayHistoryEvent,
  HistoryList,
  HistoryListFilter,
  HistoryWorkdirsResponse,
} from "@/lib/gatewayTypes";
import type { SidebarBackend, SidebarListPage } from "./backend";
import type { SidebarBackendEvent, SidebarConversation, SidebarScope } from "./types";

// Epoch values below this are seconds (up to year 2286); at or above, they
// are already milliseconds.
const SECONDS_EPOCH_CEILING = 10_000_000_000;

export function normalizeGatewayEpochMs(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value < SECONDS_EPOCH_CEILING ? value * 1000 : value;
}

// snake_case gateway ConversationSummary → SidebarConversation (all ms).
// provider/model intentionally fall back to "" instead of the selected model:
// sidebar rows must not rebuild when the user switches models.
export function normalizeGatewayConversationSummary(
  summary: ConversationSummary,
): SidebarConversation {
  const pinnedAt = normalizeGatewayEpochMs(summary.pinned_at);
  return {
    id: summary.id,
    title: formatConversationTitle(summary, summary.id),
    providerId: summary.provider_id ?? "",
    model: summary.model ?? "",
    sessionId: summary.session_id?.trim() ? summary.session_id : undefined,
    cwd: summary.cwd?.trim() ? summary.cwd : undefined,
    messageCount: summary.message_count,
    createdAt: normalizeGatewayEpochMs(summary.created_at),
    updatedAt: normalizeGatewayEpochMs(summary.updated_at),
    isPinned: summary.is_pinned === true,
    pinnedAt: summary.is_pinned === true && pinnedAt > 0 ? pinnedAt : null,
    isShared: summary.is_shared === true,
  };
}

// history.list `running_conversations` items → activity-store hydration shape.
export function normalizeRunningConversationItems(items: readonly unknown[] | undefined) {
  const normalized: Array<{
    conversationId: string;
    runId: string;
    state?: string;
    workdir?: string | null;
    updatedAt?: number;
  }> = [];
  for (const value of items ?? []) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const source = value as Record<string, unknown>;
    const conversationId =
      typeof source.conversation_id === "string" ? source.conversation_id.trim() : "";
    const runId = typeof source.run_id === "string" ? source.run_id.trim() : "";
    if (!conversationId || !runId) {
      continue;
    }
    normalized.push({
      conversationId,
      runId,
      state: typeof source.state === "string" ? source.state : undefined,
      workdir: typeof source.cwd === "string" ? source.cwd : null,
      updatedAt:
        typeof source.updated_at === "number" && Number.isFinite(source.updated_at)
          ? source.updated_at
          : undefined,
    });
  }
  return normalized;
}

function scopeToHistoryListFilter(scope: SidebarScope): HistoryListFilter | null {
  switch (scope.kind) {
    case "workdir": {
      const cwd = scope.cwd.trim();
      return cwd ? { cwd } : null;
    }
    case "unscoped":
      return { cwdEmpty: true };
    case "none":
      return null;
  }
}

type WebSidebarApi = {
  listHistory(page: number, pageSize: number, filter?: HistoryListFilter): Promise<HistoryList>;
  listHistoryWorkdirs(): Promise<HistoryWorkdirsResponse>;
  renameHistory(conversationId: string, title: string): Promise<ConversationSummary>;
  pinHistory(conversationId: string, isPinned: boolean): Promise<ConversationSummary>;
  deleteHistory(conversationId: string): Promise<void>;
  subscribeHistory(listener: (event: GatewayHistoryEvent) => void): () => void;
  subscribeConnection(listener: (connected: boolean) => void): () => void;
};

export type WebSidebarBackendDeps = {
  api: WebSidebarApi;
  // App-wide running authority (the dots). The adapter hydrates it from
  // history.list responses and bridges its diffs into store events.
  activityStore: ActivityStore;
  getProtectedConversationIds: () => Iterable<string>;
  getActivityKeepConversationIds?: () => ReadonlySet<string>;
};

export function createWebSidebarBackend(deps: WebSidebarBackendDeps): SidebarBackend {
  const { api, activityStore } = deps;

  return {
    async listConversations(page, pageSize, scope): Promise<SidebarListPage> {
      const filter = scopeToHistoryListFilter(scope);
      if (!filter) {
        return { items: [], totalCount: 0 };
      }
      const response = await api.listHistory(page, pageSize, filter);
      // Authoritative running snapshot rides along with every page; keep the
      // activity store in sync exactly like the old reloadHistory did.
      activityStore.hydrate(normalizeRunningConversationItems(response.running_conversations), {
        keepConversationIds: deps.getActivityKeepConversationIds?.(),
      });
      return {
        items: response.conversations.map(normalizeGatewayConversationSummary),
        totalCount: Math.max(0, response.total_count),
      };
    },

    async listWorkdirs() {
      const response = await api.listHistoryWorkdirs();
      return response.workdirs.map((item) => ({
        path: item.path,
        conversationCount: item.conversationCount,
        updatedAt: normalizeGatewayEpochMs(item.updatedAt),
      }));
    },

    async renameConversation(id, title) {
      return normalizeGatewayConversationSummary(await api.renameHistory(id, title));
    },

    async setConversationPinned(id, isPinned) {
      return normalizeGatewayConversationSummary(await api.pinHistory(id, isPinned));
    },

    async deleteConversation(id) {
      await api.deleteHistory(id);
    },

    // The single event subscription: gateway history.event upserts/deletes
    // plus a diff bridge over the activity store (running/idle transitions).
    subscribeEvents(listener: (event: SidebarBackendEvent) => void) {
      const unsubscribeHistory = api.subscribeHistory((event) => {
        const conversationId = event.conversation_id.trim();
        if (!conversationId) {
          return;
        }
        if (event.kind === "delete") {
          listener({ kind: "delete", conversationId });
          return;
        }
        listener({
          kind: "upsert",
          conversationId,
          conversation: normalizeGatewayConversationSummary(event.conversation),
        });
      });

      let runningIds = new Set<string>();
      const emitActivityDiff = () => {
        const snapshot = activityStore.getSnapshot();
        const next = new Set<string>();
        for (const [conversationId, activity] of snapshot.activities) {
          next.add(conversationId);
          if (!runningIds.has(conversationId)) {
            listener({
              kind: "running",
              conversationId,
              workdir: activity.workdir,
              updatedAt: normalizeGatewayEpochMs(activity.updatedAt) || undefined,
            });
          }
        }
        for (const conversationId of runningIds) {
          if (!next.has(conversationId)) {
            listener({ kind: "idle", conversationId });
          }
        }
        runningIds = next;
      };
      const unsubscribeActivity = activityStore.subscribe(emitActivityDiff);
      // Seed the current running set so a store (re)start sees active runs.
      emitActivityDiff();

      return () => {
        unsubscribeHistory();
        unsubscribeActivity();
      };
    },

    subscribeConnection(listener) {
      // The client emits booleans already (true on auth, false on drop) and
      // replays the current state to late subscribers.
      return api.subscribeConnection((connected) => listener(connected === true));
    },

    getProtectedConversationIds: () => deps.getProtectedConversationIds(),
  };
}

// Inert backend for the pre-auth phase (no gateway client yet). The store is
// never started against it; it only has to satisfy the interface.
export function createIdleSidebarBackend(): SidebarBackend {
  const notReady = () => Promise.reject(new Error("Gateway client is not ready"));
  return {
    listConversations: () => Promise.resolve({ items: [], totalCount: 0 }),
    listWorkdirs: () => Promise.resolve([]),
    renameConversation: notReady,
    setConversationPinned: notReady,
    deleteConversation: notReady,
    subscribeEvents: () => () => {},
    getProtectedConversationIds: () => [],
  };
}
