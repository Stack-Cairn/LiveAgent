import type { Context } from "@liveagent/app/lib/agentTypes";
import { positiveTokenCount } from "@liveagent/ui/lib/chat/contextUsage";
import { type ConversationViewState, getActiveSegment } from "../conversation/conversationState";
import { TokenLedger } from "./tokenLedger";

// Historical token accounting only. K-brain owns compaction and model execution.
export class CompactionController {
  private readonly ledger = new TokenLedger();

  beginRequest(context: Context, state: ConversationViewState) {
    const fixedTokens = positiveTokenCount(
      getActiveSegment(state)?.summary?.summaryMeta.stats?.contextTokensAfter,
    );
    this.ledger.rebase(context, { fixedTokens });
    return this.ledger.total();
  }

  observeContextMessages(
    messages: readonly Context["messages"][number][],
    options?: { suppressUsageAnchors?: boolean },
  ) {
    this.ledger.addMessages(messages, options);
    return this.ledger.total();
  }

  get contextUsageTokens() {
    const total = this.ledger.total();
    return total > 0 ? total : undefined;
  }

  get contextFixedTokens() {
    const { fixedTokens } = this.ledger.snapshot();
    return fixedTokens > 0 ? fixedTokens : undefined;
  }
}

export type CompactionControllerRegistry = {
  get: (conversationId: string) => CompactionController;
  dispose: (conversationId: string) => void;
};

export function createCompactionControllerRegistry(): CompactionControllerRegistry {
  const controllers = new Map<string, CompactionController>();
  return {
    get(conversationId) {
      const key = conversationId.trim();
      let controller = controllers.get(key);
      if (!controller) {
        controller = new CompactionController();
        controllers.set(key, controller);
      }
      return controller;
    },
    dispose(conversationId) {
      controllers.delete(conversationId.trim());
    },
  };
}
