// GUI adapter for the shared sidebar state layer: wraps the Tauri chat-history
// IPC surface and the single CHAT_HISTORY_SYNC_EVENT subscription. This file
// is NOT mirrored — it is the desktop end's platform boundary.

import { listen } from "@tauri-apps/api/event";
import type { ChatHistorySummary } from "../chat/history/chatHistory";
import {
  deleteChatHistory,
  listChatHistory,
  listChatHistoryWorkdirs,
  renameChatHistory,
  setChatHistoryPinned,
} from "../chat/history/chatHistory";
import type { SidebarBackend } from "./backend";
import type { SidebarBackendEvent } from "./types";

// The desktop history sync wire protocol. The Rust side emits one event per
// history mutation / run transition; this adapter is the only listener.
export const CHAT_HISTORY_SYNC_EVENT = "chat-history:changed";

export type ChatHistorySyncEvent =
  | {
      kind: "upsert";
      conversationId: string;
      conversation: ChatHistorySummary;
    }
  | {
      kind: "delete";
      conversationId: string;
      conversation?: undefined;
    }
  | {
      kind: "running" | "idle";
      conversationId: string;
      conversation?: Partial<ChatHistorySummary>;
    };

function toSidebarBackendEvent(event: ChatHistorySyncEvent): SidebarBackendEvent {
  switch (event.kind) {
    case "upsert":
      return {
        kind: "upsert",
        conversationId: event.conversationId,
        // A backend upsert confirms persistence: drop any local pending flag.
        conversation: { ...event.conversation, isPending: undefined },
      };
    case "delete":
      return { kind: "delete", conversationId: event.conversationId };
    case "running":
      return {
        kind: "running",
        conversationId: event.conversationId,
        workdir: event.conversation?.cwd,
        updatedAt: event.conversation?.updatedAt,
      };
    case "idle":
      return { kind: "idle", conversationId: event.conversationId };
  }
}

export function createGuiSidebarBackend(): SidebarBackend {
  return {
    // scope.kind === "none" never reaches the adapter — the store resolves it
    // locally to an empty list without an IPC round-trip.
    listConversations: async (page, pageSize, scope) => {
      const filter = scope.kind === "workdir" ? { cwd: scope.cwd } : { cwdEmpty: true };
      const result = await listChatHistory(page, pageSize, filter);
      // GUI ChatHistorySummary matches SidebarConversation field-for-field
      // (timestamps are already epoch milliseconds) — pass items through.
      return { items: result.items, totalCount: result.totalCount };
    },

    listWorkdirs: async () => {
      const response = await listChatHistoryWorkdirs();
      return response.workdirs;
    },

    renameConversation: (id, title) => renameChatHistory(id, title),
    setConversationPinned: (id, isPinned) => setChatHistoryPinned(id, isPinned),
    deleteConversation: (id) => deleteChatHistory(id),

    subscribeEvents: (listener) => {
      let disposed = false;
      const unlistenPromise = listen<ChatHistorySyncEvent>(CHAT_HISTORY_SYNC_EVENT, (event) => {
        if (disposed) {
          return;
        }
        listener(toSidebarBackendEvent(event.payload));
      });
      return () => {
        disposed = true;
        void unlistenPromise.then((unlisten) => unlisten());
      };
    },

    // Local sqlite is always reachable: no subscribeConnection. Nothing needs
    // protection beyond pending drafts (which reconcile retains by itself).
    getProtectedConversationIds: () => [],
  };
}
