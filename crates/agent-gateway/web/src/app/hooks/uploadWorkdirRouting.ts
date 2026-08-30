export type ConversationUploadWorkdirInput = {
  targetConversationId: string;
  displayedConversationId: string;
  persistedWorkdir?: string | null;
  runtimeWorkdir?: string | null;
  isAgentMode: boolean;
  activeWorkspacePath: string;
  defaultWorkdir: string;
};

/** Background upload targets never inherit the focused conversation's workspace. */
export function resolveConversationUploadWorkdir(input: ConversationUploadWorkdirInput): string {
  const ownedWorkdir = input.persistedWorkdir?.trim() || input.runtimeWorkdir?.trim() || "";
  if (ownedWorkdir) return ownedWorkdir;
  const targetId = input.targetConversationId.trim();
  if (targetId && targetId !== input.displayedConversationId.trim()) return "";
  return input.isAgentMode ? input.activeWorkspacePath.trim() || input.defaultWorkdir.trim() : "";
}
