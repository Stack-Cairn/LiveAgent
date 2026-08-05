import type { HookEvent } from "../../../automation";

export type ConversationHookLifecycle = {
  startAgent: () => void;
  startTurn: (round: number) => void;
  assistantMessageCompleted: (round: number, toolCallCount: number) => void;
  toolExecutionStarted: () => void;
  toolResultReceived: (round: number) => void;
  ensureMessageEnded: () => void;
  endTurn: (round: number) => void;
  endAgent: () => void;
};

export function createConversationHookLifecycle(
  dispatch: (event: HookEvent) => void,
): ConversationHookLifecycle {
  let agentStarted = false;
  let agentEnded = false;
  let activeRound = 0;
  let turnStarted = false;
  let turnEnded = false;
  let messageStarted = false;
  let messageEnded = false;
  const pendingToolExecutions = new Map<number, number>();

  const ensureMessageEnded = () => {
    if (!messageStarted || messageEnded) return;
    messageEnded = true;
    dispatch("message_end");
  };

  const endTurn = (round: number) => {
    if (!turnStarted || turnEnded || activeRound !== round) return;
    ensureMessageEnded();
    turnEnded = true;
    pendingToolExecutions.delete(round);
    dispatch("turn_end");
  };

  return {
    startAgent() {
      if (agentStarted) return;
      agentStarted = true;
      dispatch("agent_start");
    },
    startTurn(round: number) {
      activeRound = round;
      turnStarted = true;
      turnEnded = false;
      messageStarted = true;
      messageEnded = false;
      dispatch("turn_start");
      dispatch("message_start");
    },
    assistantMessageCompleted(round: number, toolCallCount: number) {
      ensureMessageEnded();
      pendingToolExecutions.set(round, toolCallCount);
      if (toolCallCount === 0) {
        endTurn(round);
      }
    },
    toolExecutionStarted() {
      dispatch("tool_execution_start");
    },
    toolResultReceived(round: number) {
      dispatch("tool_execution_end");
      const remaining = (pendingToolExecutions.get(round) ?? 1) - 1;
      if (remaining <= 0) {
        endTurn(round);
      } else {
        pendingToolExecutions.set(round, remaining);
      }
    },
    ensureMessageEnded,
    endTurn,
    endAgent() {
      if (!agentStarted || agentEnded) return;
      if (turnStarted && !turnEnded) {
        endTurn(activeRound);
      }
      agentEnded = true;
      dispatch("agent_end");
    },
  };
}
