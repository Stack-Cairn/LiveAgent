import type { AssistantMessage, Context, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { HostedSearchBlock } from "@liveagent/ui/lib/chat/hostedSearch";
import {
  buildProviderNativeWebFetchBridgeResult,
  buildProviderNativeWebSearchBridgeResult,
  isProviderNativeWebFetchToolName as isProviderNativeWebFetchToolCallName,
  isProviderNativeWebSearchToolName as isProviderNativeWebSearchToolCallName,
} from "../nativeWebSearch";

function buildTextModeUnsupportedToolResult(toolCall: ToolCall): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [
      {
        type: "text",
        text: "Tool execution result is unavailable for this recovered tool call. Continue without using this tool and do not repeat raw tool-call markup.",
      },
    ],
    details: { unsupportedTextModeTool: true },
    isError: true,
    timestamp: Date.now(),
  };
}

export function buildTextModeToolResultsForAssistant(
  assistant: AssistantMessage,
  hostedSearchBlocks: HostedSearchBlock[],
): ToolResultMessage[] {
  if (assistant.stopReason !== "toolUse") return [];
  const toolCalls = assistant.content.filter(
    (block): block is ToolCall => block.type === "toolCall",
  );
  return toolCalls.map((toolCall) =>
    buildTextModeToolResultForToolCall(toolCall, hostedSearchBlocks),
  );
}

function buildTextModeToolResultForToolCall(
  toolCall: ToolCall,
  hostedSearchBlocks: HostedSearchBlock[],
): ToolResultMessage {
  if (isProviderNativeWebSearchToolCallName(toolCall.name)) {
    return buildProviderNativeWebSearchBridgeResult({
      toolCall,
      hostedSearchBlocks,
      sourcesIntro: "Hosted search sources already captured in this response:",
      fallbackText:
        "No hosted search result was returned for this recovered request. Continue from existing context without repeating raw tool-call markup.",
    });
  }
  if (isProviderNativeWebFetchToolCallName(toolCall.name)) {
    return buildProviderNativeWebFetchBridgeResult({
      toolCall,
      hostedSearchBlocks,
      sourcesIntro: "Hosted search sources already captured in this response:",
      fallbackText:
        "No hosted search sources were captured for this response. Continue from existing context without repeating raw tool-call markup.",
    });
  }
  return buildTextModeUnsupportedToolResult(toolCall);
}

function findNextNonToolResultMessageIndex(messages: Context["messages"], startIndex: number) {
  let index = startIndex;
  while (index < messages.length && messages[index]?.role === "toolResult") {
    index += 1;
  }
  return index;
}

export function normalizeStructuredToolCallHistoryForDeepSeek(context: Context): Context {
  const messages: Context["messages"] = [];
  let changed = false;

  for (let index = 0; index < context.messages.length; index += 1) {
    const message = context.messages[index];
    if (message.role !== "assistant") {
      messages.push(message);
      continue;
    }

    const toolCalls = message.content.filter(
      (block): block is ToolCall => block.type === "toolCall",
    );
    if (toolCalls.length === 0) {
      messages.push(message);
      continue;
    }

    if (message.stopReason === "error" || message.stopReason === "aborted") {
      const assistantContent = message.content.filter((block) => block.type !== "toolCall");
      changed = true;
      if (assistantContent.length > 0) {
        messages.push({
          ...message,
          content: assistantContent,
          stopReason: "stop",
        } as AssistantMessage);
      }
      const afterToolResults = findNextNonToolResultMessageIndex(context.messages, index + 1);
      index = afterToolResults - 1;
      continue;
    }

    messages.push(message);
    const afterToolResults = findNextNonToolResultMessageIndex(context.messages, index + 1);
    const consumedToolResults = context.messages
      .slice(index + 1, afterToolResults)
      .filter((candidate): candidate is ToolResultMessage => candidate.role === "toolResult");
    const consumedToolResultsById = new Map<string, ToolResultMessage>();
    for (const toolResult of consumedToolResults) {
      if (!consumedToolResultsById.has(toolResult.toolCallId)) {
        consumedToolResultsById.set(toolResult.toolCallId, toolResult);
      } else {
        changed = true;
      }
    }

    const orderedToolResults = toolCalls.map((toolCall) => {
      const existing = consumedToolResultsById.get(toolCall.id);
      if (existing) return existing;
      changed = true;
      return buildTextModeToolResultForToolCall(toolCall, []);
    });
    messages.push(...orderedToolResults);

    const retainedIds = new Set(toolCalls.map((toolCall) => toolCall.id));
    for (const toolResult of consumedToolResults) {
      if (!retainedIds.has(toolResult.toolCallId)) {
        changed = true;
      }
    }

    const alreadyAdjacent = orderedToolResults.every(
      (toolResult, offset) => context.messages[index + 1 + offset] === toolResult,
    );
    if (!alreadyAdjacent || consumedToolResults.length !== orderedToolResults.length) {
      changed = true;
    }
    index = afterToolResults - 1;
  }

  return changed ? { ...context, messages } : context;
}
