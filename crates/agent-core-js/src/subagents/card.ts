import type { ToolCall } from "@earendil-works/pi-ai";

import { isSubagentCardArguments, type SubagentCardArguments } from "./protocol";
import { AGENT_TOOL_NAME } from "./types";

export type SubagentCardToolCall = ToolCall & {
  name: typeof AGENT_TOOL_NAME;
  arguments: SubagentCardArguments;
};

export function isSubagentCardToolCall(value: unknown): value is SubagentCardToolCall {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const toolCall = value as Record<string, unknown>;
  return (
    toolCall.type === "toolCall" &&
    toolCall.name === AGENT_TOOL_NAME &&
    isSubagentCardArguments(toolCall.arguments)
  );
}
