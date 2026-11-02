import { getHistoryMessageContentHash } from "../../../lib/chat/conversation/conversationState";
import {
  deleteChatHistory,
  getChatHistoryWindow,
  listChatHistory,
  listChatHistoryWorkdirs,
  renameChatHistory,
  setChatHistoryCwd,
  setChatHistoryPinned,
} from "../../../lib/chat/history/chatHistory";
import { resolveKBrainLocalId } from "../../../lib/kbrain/history";
import { getKBrainSessionId, setKBrainSessionId } from "../../../lib/kbrain/mapping";
import { kBrainSidebarSync } from "../../../lib/kbrain/sidebarSync";
import type { GatewayComposerActionEvent } from "./gatewayBridgeTypes";

export async function runGatewayHistoryAction(event: GatewayComposerActionEvent): Promise<unknown> {
  const data = event.data ?? {};
  const target = event.conversationId.trim();
  const id = target && !getKBrainSessionId(target) ? resolveKBrainLocalId(target) : target;
  if (target && id !== target) setKBrainSessionId(id, target);
  switch (event.action) {
    case "list": {
      if (kBrainSidebarSync.isHealthy()) {
        return kBrainSidebarSync.list(
          Number(data.page) || 1,
          Number(data.pageSize) || 80,
          typeof data.cwd === "string" && data.cwd.trim()
            ? { kind: "workdir", cwd: data.cwd }
            : data.cwdEmpty === true
              ? { kind: "unscoped" }
              : { kind: "all" },
        );
      }
      return listChatHistory(Number(data.page) || 1, Number(data.pageSize) || 80, {
        cwd: typeof data.cwd === "string" && data.cwd.trim() ? data.cwd : undefined,
        cwdEmpty: data.cwdEmpty === true,
      });
    }
    case "workdirs":
      if (kBrainSidebarSync.isHealthy()) return { workdirs: kBrainSidebarSync.workdirs() };
      return listChatHistoryWorkdirs();
    case "get": {
      const window = await getChatHistoryWindow({
        id,
        maxMessages: Number(data.maxMessages) || 360,
        includeActiveSegment: false,
      });
      const messages = window.segments.flatMap((segment) =>
        segment.messages.map((message, index) => ({
          ...message,
          liveAgentHistoryRef: {
            segmentIndex: segment.segmentIndex,
            segmentId: segment.segmentId,
            messageIndex: segment.startMessageIndex + index,
            messageId: (message as { id?: string }).id,
            role: message.role,
            timestamp: message.timestamp,
            contentHash: getHistoryMessageContentHash(message),
          },
        })),
      );
      return {
        conversation: window.conversation,
        messagesJson: JSON.stringify(messages),
        totalMessageCount: window.conversation.messageCount ?? messages.length,
        returnedMessageCount: messages.length,
        hasMore: window.hasMoreBefore,
      };
    }
    case "rename":
      return { conversation: await renameChatHistory(id, String(data.title ?? "")) };
    case "pin":
      return { conversation: await setChatHistoryPinned(id, data.isPinned === true) };
    case "cwd":
      return { conversation: await setChatHistoryCwd(id, String(data.cwd ?? "")) };
    case "delete":
      await deleteChatHistory(id);
      return {};
    default:
      throw new Error(`Unsupported gateway history action: ${event.action}`);
  }
}
