import type { UserMessage } from "@liveagent/app/lib/agentTypes";
import {
  appendMessagesToConversation,
  type ConversationViewState,
} from "../chat/conversation/conversationState";

// Protect individual inputs, not the history reader: an older background run can
// still commit results after a newer POST was rejected or its outcome is unknown.
const unacceptedInputs = new Map<
  string,
  Map<string | UserMessage, { message: UserMessage; attempt: symbol }>
>();

export function protectKBrainInput(conversationId: string, message: UserMessage): () => void {
  const key = message.id || message;
  const attempt = Symbol();
  const inputs = unacceptedInputs.get(conversationId) ?? new Map();
  inputs.set(key, { message, attempt });
  unacceptedInputs.set(conversationId, inputs);
  return () => {
    if (inputs.get(key)?.attempt !== attempt) return;
    inputs.delete(key);
    if (inputs.size === 0 && unacceptedInputs.get(conversationId) === inputs) {
      unacceptedInputs.delete(conversationId);
    }
  };
}

export function clearUnacceptedKBrainInputs(conversationId: string): void {
  unacceptedInputs.get(conversationId)?.clear();
  unacceptedInputs.delete(conversationId);
}

export function hasUnacceptedKBrainInput(conversationId: string): boolean {
  return unacceptedInputs.has(conversationId);
}

export function mergeUnacceptedKBrainInputs(
  conversationId: string,
  state: ConversationViewState,
): ConversationViewState {
  const inputs = unacceptedInputs.get(conversationId);
  if (!inputs) return state;
  const committedIds = new Set(
    state.segments.flatMap((segment) =>
      segment.messages.flatMap((message) =>
        message.role === "user" && message.id ? [message.id] : [],
      ),
    ),
  );
  // Match identity only: identical text may belong to distinct rejected sends.
  const pending = [...inputs.values()]
    .map((input) => input.message)
    .filter((message) => !message.id || !committedIds.has(message.id));
  const merged = appendMessagesToConversation(state, pending);
  // Local overlays do not change the backend CAS token used by history actions.
  return merged === state
    ? state
    : { ...merged, transcript: { ...merged.transcript, revision: state.transcript.revision } };
}
