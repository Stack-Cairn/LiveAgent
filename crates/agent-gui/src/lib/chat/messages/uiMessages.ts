import type {
  AssistantMessage,
  Message,
  ToolCall,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import {
  enrichHostedSearchContentWithText,
  type HostedSearchBlock,
  mergeHostedSearchBlocks,
  normalizeHostedSearchBlock,
  resolveHostedSearchTextBoundary,
  splitTextAroundHostedSearch,
} from "@liveagent/ui/lib/chat/hostedSearch";
import {
  getUserMessageAttachments,
  type PendingUploadedFile,
} from "@liveagent/ui/lib/chat/uploadedFiles";
import {
  type AppliedPluginPromptContext,
  readAppliedPluginPromptContext,
} from "@liveagent/ui/lib/plugins/provenance";
import {
  buildSubagentCardToolCallId,
  type SubagentBatchDetails,
  type SubagentCardDetails,
} from "@liveagent/ui/lib/subagents/protocol";
import { isSubagentCardToolCall } from "../../subagents/card";
import { readMessageContextUsage } from "../compaction/contextUsageMetadata";

export type ToolTraceItem = {
  toolCall: ToolCall;
  toolResult?: ToolResultMessage;
};

export type UiRoundContentBlock =
  | {
      kind: "thinking";
      // Stable render key: assigned when the block is created and never
      // shifted by later inserts, unlike an array index.
      id: string;
      text: string;
    }
  | {
      kind: "tool";
      item: ToolTraceItem;
    }
  | {
      kind: "hostedSearch";
      item: HostedSearchBlock;
    }
  | {
      kind: "text";
      id: string;
      text: string;
    };

export type UiRound = {
  round: number;
  // Stable render key. History-built rounds use `r<n>`; merge paths re-stamp
  // the `r<n>` pattern when round numbers shift so keys stay collision-free.
  key: string;
  blocks: UiRoundContentBlock[];
  meta?: {
    provider?: string;
    model?: string;
    api?: string;
    stopReason?: string;
    usage?: Usage;
    usageTotalTokens?: number;
    contextUsageTokens?: number;
    contextRelevant?: boolean;
    pluginContext?: AppliedPluginPromptContext;
  };
};

export type LiveRound = UiRound & {
  runningToolCallIds: string[];
  thinkingOpen: boolean;
};

export type UiMessage = {
  key: string;
  role: "user" | "assistant";
  text: string;
  attachments?: PendingUploadedFile[];
  rounds?: UiRound[];
  messageIndex?: number;
  /** 助手分组：本组最后一条 assistant 消息的时间戳（回复时间） */
  timestamp?: number;
};

import {
  appendTextDeltaToRound,
  appendTextLikeBlock,
  appendThinkingDeltaToRound,
  assistantMessageToThinkingText,
  buildSubagentPlaceholderToolCalls,
  collapseThinking,
  getMessageText,
  getRoundHostedSearches,
  getRoundText,
  getRoundThinkingText,
  getRoundToolTrace,
  hasRoundContent,
  markToolCallRunningInRound,
  nextTextLikeBlockId,
  previewText,
  safeStringify,
  shouldDisplayToolTraceItem,
  snapshotToolCallForTrace,
  summarizeToolCall,
  toolCallArgsForDisplay,
  toolResultMessageToText,
  updateLiveRound,
} from "@liveagent/ui/lib/chat/uiMessages";

export {
  appendTextDeltaToRound,
  appendTextLikeBlock,
  appendThinkingDeltaToRound,
  assistantMessageToThinkingText,
  buildSubagentPlaceholderToolCalls,
  collapseThinking,
  getMessageText,
  getRoundHostedSearches,
  getRoundText,
  getRoundThinkingText,
  getRoundToolTrace,
  hasRoundContent,
  markToolCallRunningInRound,
  nextTextLikeBlockId,
  previewText,
  safeStringify,
  shouldDisplayToolTraceItem,
  snapshotToolCallForTrace,
  summarizeToolCall,
  toolCallArgsForDisplay,
  toolResultMessageToText,
  updateLiveRound,
};

function rebalanceHostedSearchTextBoundaries(blocks: UiRoundContentBlock[]): UiRoundContentBlock[] {
  // Boundary rebalancing only matters around hostedSearch blocks; the common
  // round has none, and this runs on every streamed text delta.
  if (!blocks.some((block) => block.kind === "hostedSearch")) {
    return blocks;
  }
  const out: UiRoundContentBlock[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const current = blocks[index];
    if (current?.kind === "text") {
      const hostedStart = index + 1;
      let hostedEnd = hostedStart;
      while (blocks[hostedEnd]?.kind === "hostedSearch") {
        hostedEnd += 1;
      }
      const following = blocks[hostedEnd];
      if (hostedEnd > hostedStart && following?.kind === "text") {
        const combinedText = current.text + following.text;
        const boundary = resolveHostedSearchTextBoundary(combinedText, current.text.length);
        if (boundary > current.text.length) {
          const before = combinedText.slice(0, boundary);
          const after = combinedText.slice(boundary);
          if (before) {
            out.push({ kind: "text", id: current.id, text: before });
          }
          out.push(...blocks.slice(hostedStart, hostedEnd));
          if (after) {
            out.push({ kind: "text", id: following.id, text: after });
          }
          index = hostedEnd;
          continue;
        }
      }
    }
    out.push(current);
  }
  return out;
}

function isParentAgentToolCall(toolCall: ToolCall) {
  return toolCall.name === "Agent" && !isSubagentCardToolCall(toolCall);
}

function shouldDisplayToolBlock(
  toolCall: ToolCall,
  toolResult: ToolResultMessage | undefined,
  blocks: UiRoundContentBlock[],
  options?: { contentHasHostedSearch?: boolean },
) {
  return shouldDisplayToolTraceItem(toolResult ? { toolCall, toolResult } : { toolCall }, {
    hasHostedSearch:
      options?.contentHasHostedSearch || blocks.some((block) => block.kind === "hostedSearch"),
  });
}

function isSubagentBatchResult(
  toolResult: ToolResultMessage | undefined,
): toolResult is ToolResultMessage & { details: SubagentBatchDetails } {
  const details = toolResult?.details as Partial<SubagentBatchDetails> | undefined;
  return details?.kind === "subagent_batch" && Array.isArray(details.agents);
}

function buildSubagentCardToolCallFromReport(params: {
  parentToolCall: ToolCall;
  details: SubagentBatchDetails;
  index: number;
  agent: SubagentBatchDetails["agents"][number];
}): ToolCall {
  return {
    type: "toolCall",
    id: buildSubagentCardToolCallId(params.parentToolCall.id, params.index + 1),
    name: "Agent",
    arguments: {
      subagent_card: true,
      parent_tool_call_id: params.parentToolCall.id,
      index: params.index + 1,
      total: params.details.agentCount,
      concurrency: params.details.concurrency,
      id: params.agent.id,
      name: params.agent.name,
      role: params.agent.role,
      prompt: params.agent.prompt,
      mode: params.agent.mode,
    },
  };
}

function buildSubagentCardToolResultFromReport(params: {
  parentToolResult: ToolResultMessage;
  toolCall: ToolCall;
  details: SubagentBatchDetails;
  index: number;
  agent: SubagentBatchDetails["agents"][number];
}): ToolResultMessage {
  const details: SubagentCardDetails = {
    kind: "subagent_card",
    parentToolCallId: params.parentToolResult.toolCallId,
    index: params.index,
    total: params.details.agentCount,
    concurrency: params.details.concurrency,
    agent: params.agent,
  };
  return {
    role: "toolResult",
    toolCallId: params.toolCall.id,
    toolName: params.toolCall.name,
    content: [
      {
        type: "text",
        text:
          params.agent.error ||
          params.agent.applyError ||
          params.agent.summary ||
          params.agent.prompt ||
          "",
      },
    ],
    details,
    isError: params.agent.status !== "completed",
    timestamp: params.parentToolResult.timestamp,
  };
}

function appendSubagentCardBlocks(
  blocks: UiRoundContentBlock[],
  parentToolCall: ToolCall,
  parentToolResult: ToolResultMessage | undefined,
) {
  if (!isSubagentBatchResult(parentToolResult)) return blocks;

  let next = blocks;
  const details = parentToolResult.details as SubagentBatchDetails;
  details.agents.forEach((agent, index: number) => {
    const toolCall = buildSubagentCardToolCallFromReport({
      parentToolCall,
      details,
      index,
      agent,
    });
    const toolResult = buildSubagentCardToolResultFromReport({
      parentToolResult,
      toolCall,
      details,
      index,
      agent,
    });
    next = upsertToolBlock(next, toolCall, toolResult);
  });
  return next;
}

function upsertToolBlock(
  blocks: UiRoundContentBlock[],
  toolCall: ToolCall,
  toolResult?: ToolResultMessage,
  options?: { contentHasHostedSearch?: boolean },
): UiRoundContentBlock[] {
  // The parent Agent call is suppressed in favor of per-agent cards, except
  // when it failed — a rejected batch must stay visible.
  if (isParentAgentToolCall(toolCall) && toolResult?.isError !== true) return blocks;
  const toolCallSnapshot = snapshotToolCallForTrace(toolCall);

  const existingIdx = blocks.findIndex(
    (block) => block.kind === "tool" && block.item.toolCall.id === toolCallSnapshot.id,
  );
  if (!shouldDisplayToolBlock(toolCallSnapshot, toolResult, blocks, options)) {
    return existingIdx >= 0
      ? blocks.filter(
          (block) => !(block.kind === "tool" && block.item.toolCall.id === toolCallSnapshot.id),
        )
      : blocks;
  }
  if (existingIdx >= 0) {
    const existing = blocks[existingIdx];
    if (existing.kind !== "tool") return blocks;
    const next = blocks.slice();
    next[existingIdx] = {
      kind: "tool",
      item: {
        ...existing.item,
        toolCall: toolCallSnapshot,
        toolResult: toolResult ?? existing.item.toolResult,
      },
    };
    return next;
  }

  const nextBlock: UiRoundContentBlock = {
    kind: "tool",
    item: toolResult ? { toolCall: toolCallSnapshot, toolResult } : { toolCall: toolCallSnapshot },
  };
  return [...blocks, nextBlock];
}

export function upsertToolCallToRound<TRound extends Pick<UiRound, "blocks">>(
  round: TRound,
  toolCall: ToolCall,
): TRound {
  return {
    ...round,
    blocks: upsertToolBlock(round.blocks, toolCall),
  };
}

export function attachToolResultToRound<TRound extends Pick<UiRound, "blocks">>(
  round: TRound,
  toolCall: ToolCall,
  toolResult: ToolResultMessage,
): TRound {
  return {
    ...round,
    blocks: upsertToolBlock(round.blocks, toolCall, toolResult),
  };
}

function findLastTextBlockIndex(blocks: UiRoundContentBlock[]) {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index]?.kind === "text") return index;
  }
  return -1;
}

function findHostedSearchGroupInsertIndex(blocks: UiRoundContentBlock[]) {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (!block) continue;
    if (block.kind === "tool") break;
    if (block.kind === "hostedSearch") return index + 1;
  }
  return -1;
}

function upsertHostedSearchBlock(blocks: UiRoundContentBlock[], hostedSearch: HostedSearchBlock) {
  const idx = blocks.findIndex(
    (block) => block.kind === "hostedSearch" && block.item.id === hostedSearch.id,
  );
  if (idx < 0) {
    const nextBlock = { kind: "hostedSearch" as const, item: hostedSearch };
    const lastTextIndex = findLastTextBlockIndex(blocks);
    const lastTextBlock = lastTextIndex >= 0 ? blocks[lastTextIndex] : null;
    if (lastTextBlock?.kind === "text") {
      const split = splitTextAroundHostedSearch(lastTextBlock.text, hostedSearch);
      if (split) {
        // The before-half keeps the original id (its rendered prefix is
        // unchanged); only the after-half is a genuinely new block.
        return [
          ...blocks.slice(0, lastTextIndex),
          { kind: "text" as const, id: lastTextBlock.id, text: split.before },
          nextBlock,
          ...(split.after
            ? [
                {
                  kind: "text" as const,
                  id: nextTextLikeBlockId(blocks, "text"),
                  text: split.after,
                },
              ]
            : []),
          ...blocks.slice(lastTextIndex + 1),
        ];
      }
    }
    const groupedSearchInsertIndex = findHostedSearchGroupInsertIndex(blocks);
    if (groupedSearchInsertIndex >= 0) {
      return rebalanceHostedSearchTextBoundaries([
        ...blocks.slice(0, groupedSearchInsertIndex),
        nextBlock,
        ...blocks.slice(groupedSearchInsertIndex),
      ]);
    }
    return rebalanceHostedSearchTextBoundaries([...blocks, nextBlock]);
  }
  const next = blocks.slice();
  const existing = next[idx];
  if (existing?.kind !== "hostedSearch") return blocks;
  next[idx] = {
    kind: "hostedSearch",
    item: mergeHostedSearchBlocks(existing.item, hostedSearch),
  };
  return next;
}

export function upsertHostedSearchToRound<TRound extends Pick<UiRound, "blocks">>(
  round: TRound,
  hostedSearch: HostedSearchBlock,
): TRound {
  return {
    ...round,
    blocks: upsertHostedSearchBlock(round.blocks, hostedSearch),
  };
}

function buildUiRoundBlocks(
  assistant: AssistantMessage,
  toolResultById: Map<string, ToolResultMessage>,
) {
  let blocks: UiRoundContentBlock[] = [];
  const content = enrichHostedSearchContentWithText(
    assistant.content,
  ) as AssistantMessage["content"];
  const contentHasHostedSearch = content.some((block) =>
    Boolean(normalizeHostedSearchBlock(block)),
  );
  for (const block of content) {
    if (block.type === "text") {
      blocks = appendTextLikeBlock(blocks, "text", block.text);
      continue;
    }
    if (block.type === "thinking") {
      blocks = appendTextLikeBlock(blocks, "thinking", block.thinking);
      continue;
    }
    if (block.type === "toolCall") {
      const toolResult = toolResultById.get(block.id);
      if (isParentAgentToolCall(block) && toolResult?.isError !== true) {
        blocks = appendSubagentCardBlocks(blocks, block, toolResult);
        continue;
      }
      blocks = upsertToolBlock(blocks, block, toolResult, { contentHasHostedSearch });
      continue;
    }
    const hostedSearch = normalizeHostedSearchBlock(block);
    if (hostedSearch) {
      blocks = upsertHostedSearchBlock(blocks, hostedSearch);
    }
  }
  return blocks;
}

// `indexOffset` lets callers build UI messages for a suffix of a larger list
// (incremental timeline appends) while keeping keys and messageIndex values
// identical to a full build: pass `messages.slice(offset)` plus the offset.
export function buildUiMessages(messages: Message[], indexOffset = 0): UiMessage[] {
  const out: UiMessage[] = [];
  let i = 0;

  while (i < messages.length) {
    const message = messages[i];

    if (message.role === "user") {
      out.push({
        key: `user-${indexOffset + i}-${message.timestamp}`,
        role: "user",
        text: getMessageText(message),
        attachments: getUserMessageAttachments(message as Message & Record<string, unknown>),
        messageIndex: indexOffset + i,
      });
      i += 1;
      continue;
    }

    const groupStartIndex = i;
    const rounds: UiRound[] = [];
    let roundNum = 0;
    let lastAssistantTimestamp = 0;

    while (i < messages.length && messages[i].role !== "user") {
      if (messages[i].role === "assistant") {
        roundNum += 1;
        const assistant = messages[i] as AssistantMessage;
        const contextUsage = readMessageContextUsage(assistant);
        lastAssistantTimestamp = assistant.timestamp ?? lastAssistantTimestamp;

        const toolResults: ToolResultMessage[] = [];
        let j = i + 1;
        while (j < messages.length && messages[j].role === "toolResult") {
          toolResults.push(messages[j] as ToolResultMessage);
          j += 1;
        }
        i = j;

        const toolResultById = new Map<string, ToolResultMessage>();
        for (const toolResult of toolResults) {
          toolResultById.set(toolResult.toolCallId, toolResult);
        }

        const blocks = buildUiRoundBlocks(assistant, toolResultById);
        const hasContent = hasRoundContent({ blocks });

        if (!hasContent) continue;

        rounds.push({
          round: roundNum,
          key: `r${roundNum}`,
          blocks,
          meta: {
            provider: String(assistant.provider ?? ""),
            model: String(assistant.model ?? ""),
            api: String(assistant.api ?? ""),
            stopReason: String(assistant.stopReason ?? ""),
            usage: assistant.usage as Usage | undefined,
            usageTotalTokens: assistant.usage?.totalTokens,
            contextUsageTokens: contextUsage?.totalTokens,
            pluginContext: readAppliedPluginPromptContext(assistant),
          },
        });
      } else {
        i += 1;
      }
    }

    if (rounds.length > 0) {
      const lastText = getRoundText(rounds[rounds.length - 1]);
      out.push({
        key: `assistant-${indexOffset + groupStartIndex}-${indexOffset + i}-${lastAssistantTimestamp}`,
        role: "assistant",
        text: lastText,
        rounds,
        timestamp: lastAssistantTimestamp > 0 ? lastAssistantTimestamp : undefined,
      });
    }
  }

  return out;
}
