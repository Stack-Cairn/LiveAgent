import type { HistoryMessageRef } from "@liveagent/ui/lib/chat/historyMessageRef";
import { getHistoryMessageContentHash } from "../../../lib/chat/conversation/conversationState";
import {
  branchChatHistory,
  deleteChatHistory,
  getChatHistoryShare,
  getChatHistoryWindow,
  listChatHistory,
  listChatHistoryWorkdirs,
  renameChatHistory,
  setChatHistoryCwd,
  setChatHistoryPinned,
  setChatHistoryShare,
} from "../../../lib/chat/history/chatHistory";
import { kBrainCheckpointClient } from "../../../lib/kbrain/checkpoints";
import { resolveKBrainHistoryShare } from "../../../lib/kbrain/history";
import { getKBrainConversationId, getKBrainSessionId } from "../../../lib/kbrain/mapping";
import { kBrainSidebarSync } from "../../../lib/kbrain/sidebarSync";
import { createKBrainTrajectoryHost } from "../../../lib/kbrain/trajectory";
import type { GatewayComposerActionEvent } from "./gatewayBridgeTypes";

export async function runGatewayHistoryAction(event: GatewayComposerActionEvent): Promise<unknown> {
  const data = event.data ?? {};
  const target = event.conversationId.trim();
  // A target may be a backend session id the desktop already knows; translate it
  // to its local alias. Never mint one here: a WebUI-created conversation sends
  // trajectory/checkpoint reads before its first turn binds a session, and a
  // minted alias would shadow that local id and misroute every later turn.
  const id = (target && !getKBrainSessionId(target) && getKBrainConversationId(target)) || target;
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
    case "branch":
      return { conversation: await branchChatHistory(id, messageRef(data.baseMessageRef)) };
    case "share_get":
      return { share: await getChatHistoryShare(id) };
    case "share_set": {
      const share = await setChatHistoryShare(id, data.enabled === true, {
        ...(typeof data.redactToolContent === "boolean"
          ? { redactToolContent: data.redactToolContent }
          : {}),
      });
      // The share flag is part of the sidebar summary; hand it back so the
      // bridge can publish the same history upsert the local store path did.
      const conversation = await getChatHistoryWindow({
        id,
        maxMessages: 1,
        includeActiveSegment: false,
      }).then(
        (window) => window.conversation,
        () => undefined,
      );
      return { share, ...(conversation ? { conversation } : {}) };
    }
    case "share_resolve": {
      const shared = await resolveKBrainHistoryShare(String(data.token ?? ""));
      return {
        conversationId: shared.conversationId,
        messagesJson: JSON.stringify(shared.messages),
        totalMessageCount: shared.messages.length,
        conversation: { id: shared.conversationId, title: shared.title, isShared: true },
        redactToolContent: shared.redactToolContent,
      };
    }
    case "trajectory":
      return runTrajectoryFetch(id, data);
    case "checkpoint_list":
      return { result: await kBrainCheckpointClient.list(id) };
    case "checkpoint_diff":
      return {
        result: await kBrainCheckpointClient.preview({
          conversationId: id,
          turnSeq: turnSeq(data.turnSeq),
          authorizedRoots: stringList(data.authorizedRoots),
        }),
      };
    case "checkpoint_rewind":
      return {
        result: await kBrainCheckpointClient.rewind({
          conversationId: id,
          turnSeq: turnSeq(data.turnSeq),
          authorizedRoots: stringList(data.authorizedRoots),
          expected: (Array.isArray(data.expected) ? data.expected : []).map((entry) => ({
            key: String((entry as { key?: unknown })?.key ?? ""),
            currentHash: String((entry as { currentHash?: unknown })?.currentHash ?? ""),
          })),
        }),
      };
    default:
      throw new Error(`Unsupported gateway history action: ${event.action}`);
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function turnSeq(value: unknown): number {
  const seq = Number(value);
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error("Invalid checkpoint turn sequence");
  return seq;
}

function messageRef(value: unknown): HistoryMessageRef {
  if (!value || typeof value !== "object")
    throw new Error("history.branch requires base_message_ref");
  const ref = value as Record<string, unknown>;
  return {
    segmentIndex: Number(ref.segmentIndex) || 0,
    messageIndex: Number(ref.messageIndex) || 0,
    segmentId: String(ref.segmentId ?? ""),
    messageId: String(ref.messageId ?? ""),
    role: String(ref.role ?? ""),
    contentHash: String(ref.contentHash ?? ""),
  };
}

async function runTrajectoryFetch(id: string, data: Record<string, unknown>) {
  const host = createKBrainTrajectoryHost();
  const empty = {
    eventsJson: "",
    truncated: false,
    sections: [],
    oldestSegmentIndex: 0,
    returnedSegmentCount: 0,
    totalSegmentCount: 0,
    hasMoreBefore: false,
    subagentRunsJson: "",
  };
  if (data.includeSubagentRuns === true) {
    const runs = (await host.loadSubagentRuns?.(id, stringList(data.subagentRunIds))) ?? [];
    return { ...empty, subagentRunsJson: JSON.stringify(runs) };
  }
  const sectionIds = stringList(data.sectionIds);
  if (sectionIds.length > 0) {
    return { ...empty, sections: await host.loadSections(id, sectionIds) };
  }
  const before = data.beforeSegmentIndex;
  const window = await host.loadWindow(
    id,
    typeof before === "number" ? before : undefined,
    Number(data.maxSegments) || undefined,
  );
  return {
    ...empty,
    eventsJson: window.eventsJson,
    truncated: window.truncated,
    oldestSegmentIndex: window.oldestSegmentIndex,
    returnedSegmentCount: window.returnedSegmentCount,
    totalSegmentCount: window.totalSegmentCount,
    hasMoreBefore: window.hasMoreBefore,
  };
}
