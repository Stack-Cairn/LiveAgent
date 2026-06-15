import type { Tool } from "@earendil-works/pi-ai";

import type { BuiltinToolMetadata } from "../builtinTypes";
import { DELEGATE_TOOL_NAME } from "./constants";
import { SEND_MESSAGE_TOOL_NAME } from "./messageTools";

function isCrateBaySandboxTool(metadata: BuiltinToolMetadata | undefined) {
  return metadata?.groupId === "system" && metadata.kind.startsWith("cratebay_");
}

export function selectReadOnlyTools(params: {
  tools: Tool[];
  metadataByName: Map<string, BuiltinToolMetadata>;
}) {
  return params.tools.filter((tool) => {
    if (tool.name === DELEGATE_TOOL_NAME) return false;
    if (tool.name === SEND_MESSAGE_TOOL_NAME) return true;
    const metadata = params.metadataByName.get(tool.name);
    if (metadata?.groupId === "system") {
      return metadata.isReadOnly === true && isCrateBaySandboxTool(metadata);
    }
    return (
      metadata?.isReadOnly === true || (metadata?.groupId === "mcp" && metadata.kind === "mcp")
    );
  });
}

export function selectWorktreeTools(params: {
  tools: Tool[];
  metadataByName: Map<string, BuiltinToolMetadata>;
}) {
  return params.tools.filter((tool) => {
    if (tool.name === DELEGATE_TOOL_NAME) return false;
    if (tool.name === SEND_MESSAGE_TOOL_NAME) return true;
    const metadata = params.metadataByName.get(tool.name);
    return (
      metadata?.groupId === "fs" ||
      metadata?.groupId === "shell" ||
      (metadata?.groupId === "memory" && metadata.isReadOnly === true) ||
      isCrateBaySandboxTool(metadata) ||
      (metadata?.groupId === "mcp" && metadata.kind === "mcp")
    );
  });
}
