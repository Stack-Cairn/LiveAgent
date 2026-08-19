export type ConversationViewId = "conversation" | "trajectory";

export type ConversationViewState = ReadonlyMap<string, ConversationViewId>;

export function conversationViewForId(
  state: ConversationViewState,
  conversationId: string,
): ConversationViewId {
  const key = conversationId.trim();
  return key === "" ? "conversation" : (state.get(key) ?? "conversation");
}

export function updateConversationViewState(
  state: ConversationViewState,
  conversationId: string,
  view: ConversationViewId,
): ConversationViewState {
  const key = conversationId.trim();
  if (key === "" || conversationViewForId(state, key) === view) return state;
  const next = new Map(state);
  if (view === "conversation") next.delete(key);
  else next.set(key, view);
  return next;
}
