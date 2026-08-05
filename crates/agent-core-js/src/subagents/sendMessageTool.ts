import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { type BuiltinToolBundle, createBuiltinMetadataMap } from "../tools/builtinTypes";
import { displayRecipientLabel } from "./bus";
import { toolErrorResult } from "./errors";
import type { SubagentMessageDetails } from "./protocol";
import type { SubagentConversationStore } from "./store";
import {
  SEND_MESSAGE_TOOL_NAME,
  SUBAGENT_BROADCAST_RECIPIENT,
  SUBAGENT_PARENT_ID,
  type SubagentMessageChannel,
  type SubagentMessageRecord,
} from "./types";
import { asObject, normalizeErrorMessage, optionalString } from "./utils";
import { validateRecipient } from "./validate";

const CHANNELS = new Set<SubagentMessageChannel>(["direct", "shared", "decision", "question"]);

function normalizeChannel(value: string | undefined, recipientId: string): SubagentMessageChannel {
  const raw = (value ?? "") as SubagentMessageChannel;
  if (recipientId === SUBAGENT_BROADCAST_RECIPIENT) {
    if (!raw || raw === "direct") return "shared";
    return CHANNELS.has(raw) ? raw : "shared";
  }
  if (raw === "shared") return "direct";
  return CHANNELS.has(raw) ? raw : "direct";
}

function buildMessageDetails(record: SubagentMessageRecord): SubagentMessageDetails {
  return {
    kind: "subagent_message",
    parentConversationId: record.parentConversationId,
    seq: record.seq,
    senderId: record.senderId,
    senderName: record.senderName,
    recipientId: record.recipientId,
    recipientName: record.recipientName,
    channel: record.channel,
    subject: record.subject,
    sourceRunId: record.sourceRunId,
    sourceToolCallId: record.sourceToolCallId,
    bodyPreview:
      record.bodyMarkdown.length > 800
        ? `${record.bodyMarkdown.slice(0, 800)}...`
        : record.bodyMarkdown,
  };
}

export type SendMessageStore = Pick<
  SubagentConversationStore,
  "conversationId" | "ready" | "knownAgentIds" | "appendBusMessage"
>;

/**
 * SendMessage tool bundle. One instance exists for the parent agent and one
 * per running subagent; recipients are validated against the live roster so a
 * typo can never create an unreadable message.
 */
export function createSendMessageTools(params: {
  store: SendMessageStore;
  senderId: string;
  senderName?: string;
  currentRunId?: string;
}): BuiltinToolBundle {
  const toolSendMessage: Tool = {
    name: SEND_MESSAGE_TOOL_NAME,
    description: [
      "Send a Markdown message through the LiveAgent Message Bus to the parent agent, all agents, or one stable delegated-agent id.",
      "Use to=parent for the main agent, to=* for a shared broadcast, or to=<stable_agent_id> for a direct inbox message. Unknown recipients are rejected.",
      "Messages sent to parent are private to the parent. If other agents need to read the report, send a concise Markdown copy or summary to to=*.",
      "Use channel=question for questions that need a reply and channel=decision for durable shared decisions. The message body must be concise Markdown.",
      "This tool records the message for delivery at the next model turn boundary; it does not wake idle agents immediately.",
    ].join("\n"),
    parameters: Type.Object(
      {
        to: Type.Optional(
          Type.String({
            minLength: 1,
            description:
              "Recipient: parent, *, or a stable delegated-agent id. Optional only when channel=shared; then it defaults to *.",
          }),
        ),
        message: Type.String({
          minLength: 1,
          description: "Markdown message body to deliver.",
        }),
        channel: Type.Optional(
          Type.Union(
            [
              Type.Literal("direct"),
              Type.Literal("shared"),
              Type.Literal("decision"),
              Type.Literal("question"),
            ],
            {
              description: "Optional bus channel. Defaults to direct, or shared when to=*.",
            },
          ),
        ),
        subject: Type.Optional(
          Type.String({
            description: "Short optional subject line.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
  };

  async function executeToolCall(
    toolCall: ToolCall,
    signal?: AbortSignal,
  ): Promise<ToolResultMessage> {
    if (toolCall.name !== SEND_MESSAGE_TOOL_NAME) {
      return toolErrorResult(toolCall, `Unknown tool: ${toolCall.name}`);
    }
    if (signal?.aborted) {
      return toolErrorResult(toolCall, "Cancelled");
    }
    const senderId = params.senderId.trim();
    if (!params.store.conversationId || !senderId) {
      return toolErrorResult(
        toolCall,
        "SendMessage is unavailable because the current conversation or agent identity is missing.",
      );
    }

    const args = asObject(toolCall.arguments);
    const bodyMarkdown = optionalString(args.message);
    if (!bodyMarkdown) {
      return toolErrorResult(toolCall, "SendMessage requires a non-empty message field.");
    }
    const rawChannel = optionalString(args.channel)?.toLowerCase();

    try {
      await params.store.ready();
    } catch (error) {
      return toolErrorResult(
        toolCall,
        normalizeErrorMessage(error, "SendMessage could not load the agent roster."),
      );
    }
    const recipient = validateRecipient({
      to: args.to,
      channel: rawChannel,
      senderId,
      knownAgentIds: params.store.knownAgentIds(),
    });
    if (!recipient.ok) {
      return toolErrorResult(toolCall, recipient.message);
    }

    const channel = normalizeChannel(rawChannel, recipient.recipientId);
    let record: SubagentMessageRecord;
    try {
      record = await params.store.appendBusMessage({
        senderId,
        senderName: params.senderName?.trim() || undefined,
        recipientId: recipient.recipientId,
        recipientName:
          recipient.recipientId === SUBAGENT_PARENT_ID
            ? "Parent Agent"
            : recipient.recipientId === SUBAGENT_BROADCAST_RECIPIENT
              ? "All Agents"
              : undefined,
        channel,
        subject: optionalString(args.subject),
        bodyMarkdown,
        sourceRunId: params.currentRunId,
        sourceToolCallId: toolCall.id,
      });
    } catch (error) {
      return toolErrorResult(
        toolCall,
        normalizeErrorMessage(error, "SendMessage did not persist the message."),
      );
    }

    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [
        {
          type: "text",
          text: [
            `Message sent to ${displayRecipientLabel(record.recipientId)} via LiveAgent Message Bus.`,
            `seq=${record.seq}`,
            `channel=${record.channel}`,
          ].join("\n"),
        },
      ],
      details: buildMessageDetails(record),
      isError: false,
      timestamp: Date.now(),
    };
  }

  return {
    groupId: "subagent",
    tools: [toolSendMessage],
    executeToolCall,
    metadataByName: createBuiltinMetadataMap([
      [
        SEND_MESSAGE_TOOL_NAME,
        {
          groupId: "subagent",
          kind: "subagent_message",
          isReadOnly: true,
          displayCategory: "system",
        },
      ],
    ]),
  };
}
