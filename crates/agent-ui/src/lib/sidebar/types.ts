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
  /** Backend session ID of the conversation this one was branched from. */
  forkedFromSessionId?: string;
  // Local-only draft/persisting row; survives authoritative reconciles until
  // the backend confirms (an upsert event clears it) or it is removed locally.
  isPending?: boolean;
};

export type SidebarWorkdirSummary = {
  path: string;
  conversationCount: number;
  updatedAt: number;
};

// "all" is used by backends whose sessions are globally scoped; "none" means
// agent mode with no project selected and resolves to an empty list locally.
export type SidebarScope =
  | { kind: "workdir"; cwd: string }
  | { kind: "unscoped" }
  | { kind: "all" }
  | { kind: "none" };

export type SidebarListStatus = "initial" | "loading" | "syncing" | "ready";

export type SidebarErrorCode =
  | "listFailed"
  | "loadMoreFailed"
  | "renameFailed"
  | "renameBlockedRunning"
  | "pinFailed"
  | "moveFailed"
  | "moveBlockedRunning"
  | "deleteFailed"
  | "deleteBlockedRunning";

export type SidebarMutationKind = "rename" | "pin" | "move" | "delete";

export type SidebarRunningItem = {
  conversationId: string;
  workdir?: string | null;
  updatedAt?: number;
};

export type SidebarBackendEvent =
  | {
      kind: "reset";
      conversations: SidebarConversation[];
      workdirs?: SidebarWorkdirSummary[];
      sourceIdentity?: string;
    }
  | {
      kind: "upsert";
      conversationId: string;
      conversation: SidebarConversation;
      /** Complete projection from the ordered snapshot/change stream. */
      authoritative?: boolean;
    }
  | { kind: "delete"; conversationId: string; authoritative?: boolean }
  | { kind: "workdirs"; workdirs: SidebarWorkdirSummary[] }
  | {
      kind: "running";
      conversationId: string;
      workdir?: string | null;
      updatedAt?: number;
    }
  | { kind: "idle"; conversationId: string; updatedAt?: number };
