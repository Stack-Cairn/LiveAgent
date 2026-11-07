// The MCP elicitation forms of one tool call, rendered below its row and outside the
// collapse so a waiting form is always visible. Entries come from the tool result details
// (authoritative, also on history reload) merged with the live synthetic arguments; whether
// this side can answer, and how, comes from the host adapter.

import {
  submitMcpElicitation,
  useMcpElicitationAnswerable,
} from "@liveagent/adapters/assistantBubble";
import {
  McpElicitationForm,
  McpElicitationSummary,
} from "@liveagent/ui/components/chat/McpElicitationCard";
import {
  collectMcpElicitationEntries,
  type McpElicitationAction,
  type McpElicitationContent,
  type McpElicitationRequest,
} from "@liveagent/ui/lib/chat/mcpElicitation";
import { useCallback, useMemo } from "react";

function PendingElicitation({
  toolCallId,
  request,
  args,
  canAnswer,
}: {
  toolCallId: string;
  request: McpElicitationRequest;
  args: Record<string, unknown> | undefined;
  canAnswer: boolean;
}) {
  const answerable = useMcpElicitationAnswerable(toolCallId, request.elicitationId, args);
  const onSubmit = useCallback(
    (action: McpElicitationAction, content?: McpElicitationContent) =>
      submitMcpElicitation(toolCallId, request.elicitationId, action, content),
    [toolCallId, request.elicitationId],
  );
  return (
    <McpElicitationForm
      request={request}
      interactive={canAnswer && answerable}
      onSubmit={onSubmit}
    />
  );
}

export function ToolElicitations({
  toolCallId,
  args,
  details,
  canAnswer,
}: {
  toolCallId: string;
  args: Record<string, unknown> | undefined;
  details: unknown;
  /** False for read-only transcripts and finished calls. */
  canAnswer: boolean;
}) {
  const entries = useMemo(() => collectMcpElicitationEntries({ args, details }), [args, details]);
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 py-1.5" data-tool-elicitations={toolCallId}>
      {entries.map((entry, index) =>
        entry.kind === "pending" ? (
          <PendingElicitation
            key={entry.request.elicitationId}
            toolCallId={toolCallId}
            request={entry.request}
            args={args}
            canAnswer={canAnswer}
          />
        ) : (
          <McpElicitationSummary
            key={entry.record.elicitationId ?? `auto-${index}`}
            record={entry.record}
          />
        ),
      )}
    </div>
  );
}
