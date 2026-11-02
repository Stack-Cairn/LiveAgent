const SELECTED_CONVERSATION_STORAGE_KEY = "liveagent.gateway.selectedConversation.v2";

type StoredConversationSelections = Record<string, string>;

function normalizeAgentId(agentId: string): string {
  return agentId.trim();
}

function readSelections(): StoredConversationSelections {
  try {
    const raw = window.sessionStorage.getItem(SELECTED_CONVERSATION_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const selections: StoredConversationSelections = {};
    for (const [agentId, conversationId] of Object.entries(parsed)) {
      if (typeof conversationId !== "string" || !conversationId.trim()) continue;
      const normalizedAgentId = normalizeAgentId(agentId);
      if (normalizedAgentId) selections[normalizedAgentId] = conversationId.trim();
    }
    return selections;
  } catch {
    return {};
  }
}

function writeSelections(selections: StoredConversationSelections): void {
  try {
    window.sessionStorage.setItem(SELECTED_CONVERSATION_STORAGE_KEY, JSON.stringify(selections));
  } catch {
    // Session storage is an optional enhancement; private browsing may disable writes.
  }
}

export function loadGatewayConversationSelection(agentId: string): string {
  const normalizedAgentId = normalizeAgentId(agentId);
  return normalizedAgentId ? (readSelections()[normalizedAgentId] ?? "") : "";
}

export type GatewayConversationRestoreIdentity = {
  conversationId: string;
  historyConversationId?: string | null;
  historySessionId?: string | null;
  sidebarSessionId?: string | null;
};

/** Prefer backend identity; durable relay mappings also resolve active conversation aliases. */
export function resolveGatewayConversationRestoreTarget(
  identity: GatewayConversationRestoreIdentity,
): string {
  const conversationId = identity.conversationId.trim();
  const historyConversationId = identity.historyConversationId?.trim() ?? "";
  const historySessionId = identity.historySessionId?.trim() ?? "";
  if (historySessionId && (!historyConversationId || historyConversationId === conversationId)) {
    return historySessionId;
  }
  return identity.sidebarSessionId?.trim() || conversationId;
}

export function saveGatewayConversationSelection(agentId: string, conversationId: string): void {
  const normalizedAgentId = normalizeAgentId(agentId);
  const normalizedConversationId = conversationId.trim();
  if (!normalizedAgentId || !normalizedConversationId) return;
  writeSelections({ ...readSelections(), [normalizedAgentId]: normalizedConversationId });
}

export function clearGatewayConversationSelection(agentId: string): void {
  const normalizedAgentId = normalizeAgentId(agentId);
  if (!normalizedAgentId) return;
  const selections = readSelections();
  if (!(normalizedAgentId in selections)) return;
  delete selections[normalizedAgentId];
  writeSelections(selections);
}
