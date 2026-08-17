import type { RunAgentConversationTurnParams } from "../turns/runAgentConversationTurn";
import type { RunTextConversationTurnParams } from "../turns/runTextConversationTurn";

export type ChatRuntimeHostTurn =
  | {
      mode: "agent";
      params: RunAgentConversationTurnParams;
    }
  | {
      mode: "text";
      params: RunTextConversationTurnParams;
    };

export type ChatRuntimeHost = {
  runTurn: (turn: ChatRuntimeHostTurn) => Promise<void>;
};

export function createChatRuntimeHost(): ChatRuntimeHost {
  return {
    async runTurn(turn) {
      if (turn.mode === "agent") {
        const { runAgentConversationTurn } = await import("../turns/runAgentConversationTurn");
        await runAgentConversationTurn(turn.params);
        return;
      }
      const { runTextConversationTurn } = await import("../turns/runTextConversationTurn");
      await runTextConversationTurn(turn.params);
    },
  };
}
