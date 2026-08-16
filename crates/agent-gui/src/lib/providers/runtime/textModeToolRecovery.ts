import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
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
