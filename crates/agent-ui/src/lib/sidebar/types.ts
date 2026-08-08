// Sidebar 状态层的端无关结构。平台差异只能进入各端 backend adapter。
// 时间戳统一为 epoch milliseconds；Web adapter 会先归一化网关的秒级字段。

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
  selectedModelJson?: string;
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
  | { kind: "idle"; conversationId: string; updatedAt?: number };
