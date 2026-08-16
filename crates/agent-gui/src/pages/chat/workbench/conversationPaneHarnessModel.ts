import type { ProjectRef } from "@liveagent/ui/lib/workbench/types";

export type ConversationPaneHarnessSpec = {
  paneId: string;
  conversationId: string;
  project: ProjectRef;
};

export function assertConversationPaneHarnessSpecs(panes: readonly ConversationPaneHarnessSpec[]) {
  const paneIds = new Set<string>();
  const conversationIds = new Set<string>();
  for (const pane of panes) {
    if (!pane.paneId.trim() || !pane.conversationId.trim()) {
      throw new Error("ConversationPaneHarness requires stable pane and conversation ids.");
    }
    if (paneIds.has(pane.paneId)) {
      throw new Error(`ConversationPaneHarness received duplicate pane id: ${pane.paneId}`);
    }
    if (conversationIds.has(pane.conversationId)) {
      throw new Error(
        `ConversationPaneHarness cannot mount one editable conversation twice: ${pane.conversationId}`,
      );
    }
    paneIds.add(pane.paneId);
    conversationIds.add(pane.conversationId);
  }
}
