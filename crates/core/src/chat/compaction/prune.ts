import type { ToolResultMessage } from "@earendil-works/pi-ai";

import { sanitizeMessageForModelContext } from "../context/requestContextSanitizer";
import {
  type ConversationViewState,
  getActiveSegment,
  replaceActiveSegmentMessages,
} from "../conversation/conversationState";
import { flattenContentBlocks, toPlainText } from "./payload";
import type { PruneOptions } from "./policy";
import { estimateTextTokens } from "./tokenLedger";

const PRUNED_TOOL_OUTPUT_TEXT = "[output pruned to preserve context budget]";

export type PruneConversationResult = {
  applied: boolean;
  state: ConversationViewState;
  prunedMessageCount: number;
  releasedTokens: number;
};

/**
 * 非 LLM 降级：从旧到新裁剪工具输出正文（保留最近 N 个用户轮次与一段保护额度），
 * 直到释放到 minimumReleasedTokens。裁剪力度由 policy 的压力阶梯给出。
 */
export function pruneConversationState(
  state: ConversationViewState,
  options: PruneOptions,
): PruneConversationResult {
  const activeSegment = getActiveSegment(state);
  if (!activeSegment || activeSegment.messages.length === 0) {
    return { applied: false, state, prunedMessageCount: 0, releasedTokens: 0 };
  }

  const minimumReleasedTokens = Math.max(0, Math.floor(options.minimumReleasedTokens));
  const protectedToolTokens = Math.max(0, Math.floor(options.protectedToolTokens));
  const protectedRecentUserTurns = Math.max(1, Math.floor(options.protectedRecentUserTurns));

  const nextMessages = activeSegment.messages.slice();
  let userTurnsSeen = 0;
  let traversedToolTokens = 0;
  let releasedTokens = 0;
  let prunedMessageCount = 0;

  for (let index = nextMessages.length - 1; index >= 0; index -= 1) {
    const message = nextMessages[index];
    if (message.role === "user") {
      userTurnsSeen += 1;
      continue;
    }
    if (message.role !== "toolResult") continue;
    if (userTurnsSeen < protectedRecentUserTurns) continue;

    const modelMessage = sanitizeMessageForModelContext(message) as ToolResultMessage;
    const toolText = flattenContentBlocks(modelMessage.content);
    const detailsText = modelMessage.details ? toPlainText(modelMessage.details) : "";
    const estimated = estimateTextTokens(toolText) + estimateTextTokens(detailsText);
    if (estimated <= 0) continue;
    traversedToolTokens += estimated;
    if (traversedToolTokens <= protectedToolTokens) continue;

    nextMessages[index] = {
      ...message,
      content: [{ type: "text", text: PRUNED_TOOL_OUTPUT_TEXT }],
      details: {
        pruned: true,
        originalToolName: message.toolName,
        estimatedReleasedTokens: estimated,
      },
    };
    releasedTokens += estimated;
    prunedMessageCount += 1;
    if (releasedTokens >= minimumReleasedTokens) {
      break;
    }
  }

  if (prunedMessageCount === 0) {
    return { applied: false, state, prunedMessageCount: 0, releasedTokens: 0 };
  }

  return {
    applied: true,
    state: replaceActiveSegmentMessages(state, nextMessages),
    prunedMessageCount,
    releasedTokens,
  };
}
