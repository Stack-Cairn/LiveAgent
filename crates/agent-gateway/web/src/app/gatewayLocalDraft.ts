import { createUuid } from "@liveagent/ui/lib/shared/id";

const LOCAL_DRAFT_PREFIX = "__local_draft__:";

export function createLocalDraftConversationId() {
  return `${LOCAL_DRAFT_PREFIX}${createUuid()}`;
}

export function isLocalDraftConversationId(id: string) {
  return id.trim().startsWith(LOCAL_DRAFT_PREFIX);
}
