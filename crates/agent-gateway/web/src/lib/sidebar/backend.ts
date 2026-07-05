// The platform boundary of the sidebar state layer. Each end implements this
// once (GUI: Tauri IPC + CHAT_HISTORY_SYNC_EVENT; web: gateway WebSocket +
// activity-store bridge); the store never touches a transport directly.
// Byte-mirrored between agent-gui and agent-gateway/web.

import type {
  SidebarBackendEvent,
  SidebarConversation,
  SidebarScope,
  SidebarWorkdirSummary,
} from "./types";

export type SidebarListPage = {
  items: SidebarConversation[];
  totalCount: number;
};

export type SidebarBackend = {
  listConversations(page: number, pageSize: number, scope: SidebarScope): Promise<SidebarListPage>;
  listWorkdirs(): Promise<SidebarWorkdirSummary[]>;
  renameConversation(id: string, title: string): Promise<SidebarConversation>;
  setConversationPinned(id: string, isPinned: boolean): Promise<SidebarConversation>;
  deleteConversation(id: string): Promise<void>;
  // The single event subscription for this end. The store subscribes exactly
  // once per start() and applies every event through the reconcile reducers.
  subscribeEvents(listener: (event: SidebarBackendEvent) => void): () => void;
  // Emits true/false on transport connectivity changes; a false→true
  // transition triggers an authoritative refresh. Omitted on ends whose
  // backend is always reachable (GUI local sqlite).
  subscribeConnection?(listener: (connected: boolean) => void): () => void;
  // Ids an authoritative reconcile must never drop even when the server list
  // omits them (e.g. web command-pipeline pending conversations).
  getProtectedConversationIds?(): Iterable<string>;
};
