import { createUuid } from "@liveagent/ui/lib/shared/id";

const LOCAL_DRAFT_PREFIX = "__local_draft__:";

export function createLocalDraftConversationId() {
  return `${LOCAL_DRAFT_PREFIX}${createUuid()}`;
}

export type GatewayHomeConversationState = {
  conversationId: string;
  selectedHistoryId: string;
};

/**
 * A fresh Web homepage is an unsaved conversation, not an empty conversation
 * identity. Keeping one stable local-draft id for both selectors makes the
 * workbench root a valid conversation pane while preserving the existing
 * homepage UI and draft-promotion pipeline.
 */
export function createGatewayHomeConversationState(): GatewayHomeConversationState {
  const conversationId = createLocalDraftConversationId();
  return { conversationId, selectedHistoryId: conversationId };
}

export function isLocalDraftConversationId(id: string) {
  return id.trim().startsWith(LOCAL_DRAFT_PREFIX);
}
