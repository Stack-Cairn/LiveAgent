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
  currentRevision: () => number;
  conversationMatchesProject: (conversationId: string) => boolean;
  paneIdForConversation: (conversationId: string) => string | null;
  openConversation: (
    input: { conversationId: string; project: ProjectRef },
    target: WorkbenchOpenTarget,
  ) => unknown | null;
};

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
