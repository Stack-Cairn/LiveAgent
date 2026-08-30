import type { WorkbenchOpenTarget } from "./commands";
import type { ProjectRef } from "./types";

export type WorkspaceDropCommitResult =
  | { kind: "opened"; conversationId: string }
  | { kind: "not-created" }
  | { kind: "stale"; conversationId: string }
  | { kind: "identity-mismatch"; conversationId: string }
  | { kind: "already-open"; conversationId: string }
  | { kind: "rejected"; conversationId: string };

export type CommitWorkspaceDropConversationParams = {
  revision: number;
  target: WorkbenchOpenTarget;
  project: ProjectRef;
  startConversation: () => Promise<string | null | undefined>;
  /** Capture the exact draft id before any later observer syncs it. */
  onConversationCreated?: (conversationId: string) => void;
  currentRevision: () => number;
  conversationMatchesProject: (conversationId: string) => boolean;
  paneIdForConversation: (conversationId: string) => string | null;
  openConversation: (
    input: { conversationId: string; project: ProjectRef },
    target: WorkbenchOpenTarget,
  ) => unknown | null;
};

export type PendingWorkspaceDropOperation = {
  operationId: number;
  projectPathKey: string;
  conversationId: string | null;
};

/** Keep normal current-conversation sync paused for the in-flight drop only. */
export function shouldDeferWorkspaceDropConversationSync(
  pending: PendingWorkspaceDropOperation | null,
  currentConversationId: string,
  currentProjectPathKey: string,
): boolean {
  if (!pending) return false;
  const currentId = currentConversationId.trim();
  if (!currentId) return false;
  const exactId = pending.conversationId?.trim() || "";
  if (exactId) return exactId === currentId;
  return (
    Boolean(currentProjectPathKey.trim()) &&
    currentProjectPathKey.trim() === pending.projectPathKey.trim()
  );
}

/**
 * Complete a workspace drag as one explicit transaction. The legacy workspace
 * action still owns directory validation and draft creation, but it returns
 * the exact draft id to this coordinator. That removes the previous
 * "remember a target and guess on the next current-conversation effect" race.
 */
export async function commitWorkspaceDropConversation(
  params: CommitWorkspaceDropConversationParams,
): Promise<WorkspaceDropCommitResult> {
  const conversationId = (await params.startConversation())?.trim() || "";
  if (!conversationId) return { kind: "not-created" };
  params.onConversationCreated?.(conversationId);
  if (params.currentRevision() !== params.revision) {
    return { kind: "stale", conversationId };
  }
  if (!params.conversationMatchesProject(conversationId)) {
    return { kind: "identity-mismatch", conversationId };
  }
  if (params.paneIdForConversation(conversationId)) {
    return { kind: "already-open", conversationId };
  }
  const opened = params.openConversation(
    { conversationId, project: params.project },
    params.target,
  );
  return opened ? { kind: "opened", conversationId } : { kind: "rejected", conversationId };
}
