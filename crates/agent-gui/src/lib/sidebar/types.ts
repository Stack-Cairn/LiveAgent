// Shared, end-agnostic shapes for the sidebar state layer. This file is
// byte-mirrored between agent-gui and agent-gateway/web (see
// scripts/mirror-manifest.json); platform differences belong in the per-end
// backend adapters, never here. All timestamps are epoch milliseconds — the
// web adapter normalizes the gateway's second-based fields before they reach
// this layer.

export type SidebarConversation = {
  id: string;
  title: string;
  providerId: string;
  model: string;
  sessionId?: string;
  cwd?: string;
  messageCount?: number;
  createdAt: number;
  updatedAt: number;
  isPinned?: boolean;
  pinnedAt?: number | null;
  isShared?: boolean;
  // Local-only draft/persisting row; survives authoritative reconciles until
  // the backend confirms (an upsert event clears it) or it is removed locally.
  isPending?: boolean;
};

export type SidebarWorkdirSummary = {
  path: string;
  conversationCount: number;
  updatedAt: number;
};

// "none" means agent mode with no project selected: it resolves to an empty
// list locally, without a backend round-trip and without a wire sentinel.
export type SidebarScope =
  | { kind: "workdir"; cwd: string }
  | { kind: "unscoped" }
  | { kind: "none" };

export type SidebarListStatus = "initial" | "loading" | "syncing" | "ready";

export type SidebarErrorCode =
  | "listFailed"
  | "loadMoreFailed"
  | "renameFailed"
  | "renameBlockedRunning"
  | "pinFailed"
  | "deleteFailed"
  | "deleteBlockedRunning";

export type SidebarMutationKind = "rename" | "pin" | "delete";

export type SidebarRunningItem = {
  conversationId: string;
  workdir?: string | null;
  updatedAt?: number;
};

export type SidebarBackendEvent =
  | { kind: "upsert"; conversationId: string; conversation: SidebarConversation }
  | { kind: "delete"; conversationId: string }
  | {
      kind: "running";
      conversationId: string;
      workdir?: string | null;
      updatedAt?: number;
    }
  | { kind: "idle"; conversationId: string };
