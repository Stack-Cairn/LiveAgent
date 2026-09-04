import { CompactingText } from "@liveagent/ui/components/chat/AssistantStatus";
import { AssistantWorkTrace } from "@liveagent/ui/components/chat/AssistantWorkTrace";
import { HostedSearchGroupView } from "@liveagent/ui/components/chat/HostedSearchGroupView";
import { LiveSparkle } from "@liveagent/ui/components/chat/LiveSparkle";
import { Markdown } from "@liveagent/ui/components/Markdown";
import type { UiRound } from "@liveagent/ui/lib/chat/assistantBubbleAdapter";
import { normalizeLiveToolStatus } from "@liveagent/ui/lib/chat/assistantStatus";
import type { ChatFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { memo, type ReactNode, useMemo } from "react";
import {
  type AssistantTurnLayoutEntry,
  type GroupedRoundBlock,
  hasActiveUserInteraction,
  isBuiltinShareToolName,
  resolveActiveThinkingEntryKey,
  resolveActiveWorkEntry,
  resolveAssistantTurnLayout,
} from "./assistantBubbleUtils";
import { CompactionSeamRow } from "./CompactionSeamRow";
import { ThinkingDisclosure } from "./ThinkingDisclosure";
import { MemoToolCallItem } from "./ToolCallItem";
import { getNativeDisplayImagePayload, NativeDisplayImageBlock } from "./ToolImages";
import { ToolTraceGroup } from "./ToolTraceGroup";

const EMPTY_RUNNING_TOOL_CALL_IDS: string[] = [];

export const RoundBlockContent = memo(function RoundBlockContent(props: {
  block: GroupedRoundBlock;
  isLive: boolean;
  renderMode: "streaming" | "static";
  runningToolCallIds: string[];
  thinkingOpen: boolean;
  isLatestThinking: boolean;
  /** Transcript-stable entry key; block ids alone repeat across rounds. */
  traceKey?: string;
  showTurnStatus?: boolean;
  /**
   * True when the block renders as its own transcript row outside the work
   * trace (interaction cards, answer-layer results). Standalone rows get
   * their vertical rhythm from the layout layer, so the operation wrapper
   * must not stack its own my-1 on top of it.
   */
  standalone?: boolean;
  readOnly?: boolean;
  redactToolContent?: boolean;
  workdir?: string;
  onOpenFileLink?: (link: ChatFileLink) => void;
}) {
  const {
    block,
    isLive,
    renderMode,
    runningToolCallIds,
    thinkingOpen,
    isLatestThinking,
    traceKey,
    showTurnStatus = false,
    standalone = false,
    readOnly = false,
    redactToolContent = false,
    workdir,
    onOpenFileLink,
  } = props;

  let content: ReactNode;
  if (block.kind === "thinking") {
    // Shared/redacted views hide tool internals; model reasoning is at least
    // as sensitive, so it disappears entirely there instead of rendering a
    // teasing header without a body.
    content = redactToolContent ? null : (
      <ThinkingDisclosure
        text={block.text}
        trackKey={traceKey ?? block.key}
        active={Boolean(isLive && thinkingOpen && isLatestThinking)}
        renderMode={renderMode}
        readOnly={readOnly}
        workdir={workdir}
        onOpenFileLink={onOpenFileLink}
      />
    );
  } else if (block.kind === "tool") {
    const isRedactedToolContent =
      redactToolContent && isBuiltinShareToolName(block.item.toolCall.name);
    const displayImagePayload = getNativeDisplayImagePayload(block.item);
    if (!isRedactedToolContent && displayImagePayload) {
      content = <NativeDisplayImageBlock payload={displayImagePayload} readOnly={readOnly} />;
    } else if (
      !isRedactedToolContent &&
      block.item.toolCall.name === "Image" &&
      !block.item.toolResult?.isError
    ) {
      content = null;
    } else {
      content = (
        <MemoToolCallItem
          item={block.item}
          isRunning={Boolean(
            isLive && block.item.toolCall.id && runningToolCallIds.includes(block.item.toolCall.id),
          )}
          readOnly={readOnly}
          redactToolContent={redactToolContent}
          onOpenFileLink={onOpenFileLink}
        />
      );
    }
  } else if (block.kind === "toolGroup") {
    content = (
      <ToolTraceGroup
        items={block.items}
        runningToolCallIds={isLive ? runningToolCallIds : []}
        readOnly={readOnly}
        redactToolContent={redactToolContent}
        onOpenFileLink={onOpenFileLink}
        showTurnStatus={showTurnStatus}
      />
    );
  } else if (block.kind === "hostedSearch" || block.kind === "hostedSearchGroup") {
    content = (
      <HostedSearchGroupView
        items={block.kind === "hostedSearch" ? [block.item] : block.items}
        isLive={isLive}
        readOnly={readOnly}
      />
    );
  } else if (block.kind === "checkpoint") {
    content = <CompactionSeamRow seam={block.seam} readOnly={readOnly} workdir={workdir} />;
  } else if (block.text.trim()) {
    content = (
      <Markdown
        content={block.text}
        className="font-chat"
        renderMode={renderMode}
        readOnly={readOnly}
        workdir={workdir}
        onOpenFileLink={onOpenFileLink}
      />
    );
  } else {
    content = null;
  }

  if (!content) return null;

  const isOperationBlock = block.kind !== "text";
  return (
    <div
      className={cn(!isLive && "w-full", isOperationBlock && !standalone && "my-1")}
      data-assistant-operation={isOperationBlock ? "" : undefined}
    >
      {content}
    </div>
  );
});

type AssistantTurnRound = UiRound & {
  key?: string;
  runningToolCallIds?: string[];
  thinkingOpen?: boolean;
};

function hasRunningToolCall(entries: AssistantTurnLayoutEntry[]) {
  return entries.some((entry) => {
    const runningIds = new Set(entry.runningToolCallIds);
    if (entry.block.kind === "tool") {
      return Boolean(entry.block.item.toolCall.id && runningIds.has(entry.block.item.toolCall.id));
    }
    if (entry.block.kind === "toolGroup") {
      return entry.block.items.some((item) =>
        Boolean(item.toolCall.id && runningIds.has(item.toolCall.id)),
      );
    }
    return false;
  });
}

function hasInteractionRequiringAttention(entries: AssistantTurnLayoutEntry[]) {
  return entries.some((entry) => {
    if (entry.block.kind === "tool") {
      return hasActiveUserInteraction([entry.block.item], entry.runningToolCallIds);
    }
    if (entry.block.kind === "toolGroup") {
      return hasActiveUserInteraction(entry.block.items, entry.runningToolCallIds);
    }
    return false;
  });
}

export const AssistantTurnContent = memo(function AssistantTurnContent(props: {
  rounds: AssistantTurnRound[];
  isLive?: boolean;
  isStreaming?: boolean;
  toolStatus?: string | null;
  toolStatusVariant?: "default" | "compaction";
  durationMs?: number;
  renderMode?: "streaming" | "static";
  readOnly?: boolean;
  redactToolContent?: boolean;
  workdir?: string;
  onOpenFileLink?: (link: ChatFileLink) => void;
}) {
  const {
    rounds,
    isLive = false,
    isStreaming = isLive,
    toolStatus,
    toolStatusVariant,
    durationMs,
    renderMode = isStreaming ? "streaming" : "static",
    readOnly = false,
    redactToolContent = false,
    workdir,
    onOpenFileLink,
  } = props;
  const layout = useMemo(
    () => resolveAssistantTurnLayout(rounds, { live: isLive }),
    [isLive, rounds],
  );
  const running = Boolean(isLive && isStreaming);
  const normalizedToolStatus = running ? normalizeLiveToolStatus(toolStatus ?? null) : null;
  const isCompactionStatus = toolStatusVariant === "compaction";
  const showDetailedStatus = Boolean(
    normalizedToolStatus && isCompactionStatus && !hasRunningToolCall(layout.work),
  );
  const attentionRequired =
    running && hasInteractionRequiringAttention([...layout.work, ...layout.interaction]);
  const latestToolGroupKey = useMemo(() => {
    for (let index = layout.work.length - 1; index >= 0; index -= 1) {
      const entry = layout.work[index];
      if (entry?.block.kind === "toolGroup") return entry.key;
    }
    return null;
  }, [layout.work]);
  const activeThinkingKey = running ? resolveActiveThinkingEntryKey(layout.work) : null;
  const collapsedTailEntry = running ? resolveActiveWorkEntry(layout.work) : null;
  const showWorkTrace = running || layout.work.length > 0;

  if (!showWorkTrace && layout.interaction.length === 0 && layout.answer.length === 0) return null;

  const renderEntry = (
    entry: AssistantTurnLayoutEntry,
    insideWorkTrace: boolean,
    liveInteraction = false,
  ) => (
    <RoundBlockContent
      key={entry.key}
      block={entry.block}
      isLive={running && (insideWorkTrace || liveInteraction)}
      renderMode={renderMode}
      runningToolCallIds={entry.runningToolCallIds}
      thinkingOpen={insideWorkTrace && running ? entry.thinkingOpen : false}
      isLatestThinking={entry.key === activeThinkingKey}
      traceKey={entry.key}
      showTurnStatus={insideWorkTrace && running && entry.key === latestToolGroupKey}
      standalone={!insideWorkTrace}
      readOnly={readOnly}
      redactToolContent={redactToolContent}
      workdir={workdir}
      onOpenFileLink={onOpenFileLink}
    />
  );

  return (
    <div className="space-y-2">
      {showWorkTrace ? (
        <AssistantWorkTrace
          attentionRequired={attentionRequired}
          awaitingDecision={attentionRequired}
          collapseAfterAnswer={layout.answer.length > 0}
          collapsedTail={collapsedTailEntry ? renderEntry(collapsedTailEntry, true) : null}
          durationMs={durationMs}
          hasDetails={layout.work.length > 0 || showDetailedStatus}
          running={running}
        >
          {layout.work.map((entry) => renderEntry(entry, true))}
          {showDetailedStatus ? (
            <div className="py-1.5">
              <CompactingText />
            </div>
          ) : null}
        </AssistantWorkTrace>
      ) : null}

      {layout.interaction.map((entry) => renderEntry(entry, false, true))}
      {layout.answer.map((entry) => renderEntry(entry, false))}
      {running ? <LiveSparkle paused={attentionRequired} /> : null}
    </div>
  );
});

export const RoundContent = memo(function RoundContent(props: {
  round: UiRound;
  isLive?: boolean;
  isStreaming?: boolean;
  isActive?: boolean;
  toolStatus?: string | null;
  toolStatusVariant?: "default" | "compaction";
  durationMs?: number;
  runningToolCallIds?: string[];
  thinkingOpen?: boolean;
  renderMode?: "streaming" | "static";
  readOnly?: boolean;
  redactToolContent?: boolean;
  workdir?: string;
  onOpenFileLink?: (link: ChatFileLink) => void;
}) {
  const {
    round,
    isLive,
    isStreaming = isLive,
    isActive,
    toolStatus,
    toolStatusVariant,
    durationMs,
    runningToolCallIds,
    thinkingOpen,
    renderMode,
    readOnly = false,
    redactToolContent = false,
    workdir,
    onOpenFileLink,
  } = props;
  const activeLive = Boolean(isLive && (isActive ?? true));
  const decoratedRound = useMemo<AssistantTurnRound>(
    () => ({
      ...round,
      runningToolCallIds: runningToolCallIds ?? EMPTY_RUNNING_TOOL_CALL_IDS,
      thinkingOpen: thinkingOpen ?? false,
    }),
    [round, runningToolCallIds, thinkingOpen],
  );
  const rounds = useMemo(() => [decoratedRound], [decoratedRound]);

  return (
    <AssistantTurnContent
      rounds={rounds}
      isLive={activeLive}
      isStreaming={isStreaming}
      toolStatus={toolStatus}
      toolStatusVariant={toolStatusVariant}
      durationMs={durationMs}
      renderMode={renderMode}
      readOnly={readOnly}
      redactToolContent={redactToolContent}
      workdir={workdir}
      onOpenFileLink={onOpenFileLink}
    />
  );
});
