import type { MentionComposerDraft } from "../../components/chat/MentionComposerInternals";
import type { ComposerCommandPanelState } from "./composerCommands";

type Recovery = { draft: MentionComposerDraft; panel: ComposerCommandPanelState };
const recoveries = new Map<string, Recovery>();
const conversationIds = new Map<string, string>();
const listeners = new Set<() => void>();
const resolveConversationId = (id: string) => conversationIds.get(id) ?? id;

export const subscribeCommandRecovery = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const getCommandRecovery = (id: string) => recoveries.get(resolveConversationId(id));
export function moveCommandRecovery(from: string, to: string) {
  if (from === to) return;
  for (const [id, target] of conversationIds) {
    if (target === from) conversationIds.set(id, to);
  }
  conversationIds.set(from, to);
  while (conversationIds.size > 100)
    conversationIds.delete(conversationIds.keys().next().value as string);
  const recovery = recoveries.get(from);
  recoveries.delete(from);
  if (recovery) recoveries.set(to, recovery);
  for (const listener of listeners) listener();
}
export function saveCommandRecovery(id: string, recovery: Recovery) {
  id = resolveConversationId(id);
  recoveries.delete(id);
  recoveries.set(id, recovery);
  while (recoveries.size > 100) recoveries.delete(recoveries.keys().next().value as string);
  for (const listener of listeners) listener();
}
export function clearCommandRecovery(id: string) {
  if (!recoveries.delete(resolveConversationId(id))) return;
  for (const listener of listeners) listener();
}
export function clearCommandRecoveries() {
  recoveries.clear();
  conversationIds.clear();
  for (const listener of listeners) listener();
}
