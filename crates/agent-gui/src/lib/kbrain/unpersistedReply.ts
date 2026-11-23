import type { AssistantMessage, Message } from "@liveagent/app/lib/agentTypes";
import { isKBrainErrorMessageId } from "@liveagent/ui/lib/chat/turnError";
import type { ChatHistoryWindowRecord } from "../chat/history/chatHistory";

/**
 * After a turn the transcript is replaced from K-brain's history, but K-brain
 * does not keep everything the turn showed:
 *
 * - a run whose model stream fails mid-reply (dropped connection, provider
 *   error after the first tokens) keeps only a synthetic error message; the
 *   streamed partial reply is dropped;
 * - a run stopped before the model produced anything keeps no assistant
 *   message at all, so the turn would lose its "stopped" state.
 *
 * This puts the live reply back for the turn's first model call: the partial
 * content replaces the synthetic error message's (empty) content in place,
 * keeping its id and offset, and a reply with no stored message at all comes
 * back as a render-only message (mergeUnacceptedKBrainInputs shows it after its
 * user message on every later history read in this app session). Later model calls
 * of a multi-step run are not restored, because the live reply also holds the
 * earlier steps K-brain already stored.
 */
// Restored replies by their synthetic error message id (unique per run), so every
// later read of the history in this app session (reopening the conversation, a
// list refresh) shows them too. Bounded: only recent failures need it.
const restoredReplies = new Map<string, AssistantMessage["content"]>();
const RESTORED_REPLY_LIMIT = 64;

// Stopped replies K-brain stored nothing for, by the id of the user message they
// answer; shown after that message while it still ends the conversation.
const stoppedReplies = new Map<string, AssistantMessage>();

/** The stopped reply to show after this user message, if any. */
export function stoppedReplyAfter(userMessageId: string): AssistantMessage | undefined {
  return stoppedReplies.get(userMessageId);
}

function remember<T>(map: Map<string, T>, key: string, value: T) {
  map.delete(key);
  map.set(key, value);
  if (map.size > RESTORED_REPLY_LIMIT) map.delete(map.keys().next().value as string);
}

/** The reply content restored for a synthetic error message, if any. */
export function restoredReplyContent(messageId: string): AssistantMessage["content"] | undefined {
  return restoredReplies.get(messageId);
}

export function restoreUnpersistedReply(
  window: ChatHistoryWindowRecord,
  reply: AssistantMessage,
): { window: ChatHistoryWindowRecord; renderOnly: AssistantMessage | null } {
  const unchanged = { window, renderOnly: null };
  if (reply.stopReason !== "error" && reply.stopReason !== "aborted") return unchanged;
  const messages = window.segments?.at(-1)?.messages ?? [];
  let userIndex = messages.length - 1;
  while (userIndex >= 0 && messages[userIndex]?.role !== "user") userIndex -= 1;
  if (userIndex < 0) return unchanged;
  const tail = messages.slice(userIndex + 1);
  if (tail.length === 0) {
    const userId = (messages[userIndex] as { id?: unknown }).id;
    if (typeof userId === "string" && userId) remember(stoppedReplies, userId, reply);
    return { window, renderOnly: reply };
  }
  const stored = tail[0];
  if (
    tail.length !== 1 ||
    stored?.role !== "assistant" ||
    !isKBrainErrorMessageId((stored as { id?: unknown }).id) ||
    stored.content.length > 0 ||
    reply.content.length === 0
  ) {
    return unchanged;
  }
  const restored: AssistantMessage = { ...stored, content: reply.content };
  const storedId = (stored as { id?: unknown }).id as string;
  remember(restoredReplies, storedId, reply.content);
  const replace = (list: Message[]) =>
    list.map((message) => (message === stored ? restored : message));
  return {
    window: {
      ...window,
      segments: window.segments.map((segment) => ({
        ...segment,
        messages: replace(segment.messages),
      })),
      ...(window.activeSegment
        ? {
            activeSegment: {
              ...window.activeSegment,
              messages: window.activeSegment.messages.map((message) =>
                message.role === "assistant" && (message as { id?: unknown }).id === storedId
                  ? restored
                  : message,
              ),
            },
          }
        : {}),
    },
    renderOnly: null,
  };
}
