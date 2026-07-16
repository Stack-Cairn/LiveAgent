import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ExecutionMode } from "../settings";
import { AGENT_TOOL_NAME, SEND_MESSAGE_TOOL_NAME } from "../subagents/types";
import type { BuiltinToolRegistry } from "./builtinRegistry";
import type { BuiltinToolMetadata } from "./builtinTypes";

export type ToolAccessMode = "none" | "readonly" | "full";

export function toolAccessModeForExecutionMode(mode: ExecutionMode): ToolAccessMode {
  if (mode === "text") return "none";
  if (mode === "readonly") return "readonly";
  return "full";
}

export function isToolAllowedInMode(
  mode: ToolAccessMode,
  toolName: string,
  metadata?: BuiltinToolMetadata,
) {
  if (mode === "full") return true;
  if (mode === "none") return false;
  if (toolName === AGENT_TOOL_NAME || toolName === SEND_MESSAGE_TOOL_NAME) return true;
  return metadata?.isReadOnly === true;
}

function deniedToolResult(toolCall: ToolCall, mode: ToolAccessMode): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [
      {
        type: "text",
        text: `Tool access denied: ${toolCall.name} is unavailable in ${mode} mode.`,
      },
    ],
    details: { kind: "tool_access_denied", accessMode: mode },
    isError: true,
    timestamp: Date.now(),
  };
}

/** Filter model-visible schemas and guard dispatch with the same allowlist. */
export function restrictBuiltinToolRegistry(
  registry: BuiltinToolRegistry,
  mode: ToolAccessMode,
): BuiltinToolRegistry {
  if (mode === "full") return registry;

  const tools = registry.tools.filter((tool) =>
    isToolAllowedInMode(mode, tool.name, registry.metadataByName.get(tool.name)),
  );
  const canonicalByLookupKey = new Map(tools.map((tool) => [tool.name.toLowerCase(), tool.name]));
  const metadataByName = new Map<string, BuiltinToolMetadata>();
  for (const tool of tools) {
    const metadata = registry.metadataByName.get(tool.name);
    if (metadata) metadataByName.set(tool.name, metadata);
  }

  const resolveAllowedName = (toolName: string) =>
    canonicalByLookupKey.get(toolName.trim().toLowerCase()) ?? null;

  return {
    tools,
    metadataByName,
    hasTool: (toolName) => resolveAllowedName(toolName) !== null,
    executeToolCall: (toolCall, signal, context) => {
      const canonicalName = resolveAllowedName(toolCall.name);
      if (!canonicalName) return Promise.resolve(deniedToolResult(toolCall, mode));
      return registry.executeToolCall(
        canonicalName === toolCall.name ? toolCall : { ...toolCall, name: canonicalName },
        signal,
        context,
      );
    },
  };
}
