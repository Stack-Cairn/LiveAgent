// Sandboxed content attached to one tool call: the MCP App view of its result, or the HTML
// preview K-brain made from a Write to an .html file. Both sit below the row, outside the
// collapse, next to the text output they enrich (which stays the fallback).

import { HtmlPreviewCard } from "@liveagent/ui/components/sandboxed-ui/HtmlPreviewCard";
import { useSandboxedUiTranscriptHost } from "@liveagent/ui/components/sandboxed-ui/SandboxedUiHostContext";
import {
  type ToolResultMessage,
  toolResultMessageToText,
} from "@liveagent/ui/lib/chat/assistantBubbleAdapter";
import {
  findHtmlPreviewForToolCall,
  useHtmlPreviewsVersion,
} from "@liveagent/ui/lib/chat/htmlPreviews";
import { readMcpUiResource } from "@liveagent/ui/lib/chat/mcpApps";
import { useMemo } from "react";
import { McpAppView } from "./McpAppView";

export type ToolSandboxedViewsProps = {
  toolCallId: string;
  toolName: string;
  args: unknown;
  result: ToolResultMessage;
};

function argsRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

export function ToolSandboxedViews(props: ToolSandboxedViewsProps) {
  const { result } = props;
  const failed = Boolean(result.isError);
  const resource = useMemo(() => readMcpUiResource(result.details), [result.details]);
  const toolInput = useMemo(() => argsRecord(props.args), [props.args]);
  const outputText = useMemo(
    () => (resource ? toolResultMessageToText(result) : ""),
    [resource, result],
  );
  return (
    <>
      {resource && !failed ? (
        <McpAppView
          resource={resource}
          toolName={props.toolName}
          toolInput={toolInput}
          toolOutput={outputText}
          toolFailed={failed}
        />
      ) : null}
      <ToolHtmlPreview toolCallId={props.toolCallId} />
    </>
  );
}

function ToolHtmlPreview({ toolCallId }: { toolCallId: string }) {
  const host = useSandboxedUiTranscriptHost();
  const enabled = Boolean(host?.htmlPreviews);
  const version = useHtmlPreviewsVersion(enabled ? host?.conversationId : undefined);
  const preview = useMemo(() => {
    void version;
    return enabled && host
      ? findHtmlPreviewForToolCall(host.conversationId, toolCallId)
      : undefined;
  }, [enabled, host, toolCallId, version]);
  if (!preview) return null;
  return <HtmlPreviewCard preview={preview} />;
}
