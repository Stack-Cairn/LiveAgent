import {
  GenerationStoppedNotice,
  LiveAssistantStatus,
} from "@liveagent/ui/components/chat/AssistantStatus";
import {
  AssistantWorkTrace,
  type WorkTraceStats,
} from "@liveagent/ui/components/chat/AssistantWorkTrace";
import { HostedSearchGroupView } from "@liveagent/ui/components/chat/HostedSearchGroupView";
import { useDetailedProgress } from "@liveagent/ui/components/chat/processDisclosure";
import { StreamingSplitMarkdown } from "@liveagent/ui/components/chat/StreamingSplitMarkdown";
import { Markdown } from "@liveagent/ui/components/Markdown";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { UiRound } from "@liveagent/ui/lib/chat/assistantBubbleAdapter";
import {
  isInterruptedByShutdown,
  isStoppedReply,
  normalizeLiveToolStatus,
} from "@liveagent/ui/lib/chat/assistantStatus";
import type { ChatFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import { useStreamingReveal } from "@liveagent/ui/lib/chat/streamingReveal";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { memo, type ReactNode, useMemo } from "react";
import {
  type AssistantTurnLayoutEntry,
  type GroupedRoundBlock,
  hasActiveUserInteraction,
  isBuiltinShareToolName,
  resolveActiveThinkingEntryKey,
  resolveAssistantTurnLayout,
} from "./assistantBubbleUtils";
import { CompactionSeamRow } from "./CompactionSeamRow";
import { resolveReasoningDurationMs, ThinkingDisclosure } from "./ThinkingDisclosure";
import { MemoToolCallItem } from "./ToolCallItem";
import { getNativeDisplayImagePayload, NativeDisplayImageBlock } from "./ToolImages";
import { getRunningToolActivity, ToolTraceGroup } from "./ToolTraceGroup";
import {
  buildWorkTraceItems,
  collectWorkTraceReasoning,
  countWorkTraceToolCalls,
  findLatestRunningToolItem,
  resolveActiveWorkItem,
  trailingReplyTextLength,
  type WorkTraceItem,
} from "./workTraceDisplay";

const EMPTY_RUNNING_TOOL_CALL_IDS: string[] = [];

export type WorkTraceModel = {
  items: WorkTraceItem[];
  activeThinkingKey: string | null;
  /** The item the turn is busy with, for the collapsed-trace tail (detailed view only). */
  activeItem: WorkTraceItem | null;
  /** Key of the last tool activity group, the one the live status row speaks for. */
  latestActivityKey: string | null;
  /** Key of the trailing item while running (the next call may still join it). */
  trailingKey: string | null;
  stats: WorkTraceStats;
};

/**
 * Presentation model of a turn's processing trace. Also the one place that
 * times reasoning: every segment's clock is advanced here, in a parent that
 * stays mounted while the trace and its rows are folded, so durations are
 * measured even when no reasoning row is on screen.
 */
export function useWorkTraceModel(
  entries: readonly AssistantTurnLayoutEntry[],
  running: boolean,
): WorkTraceModel {
  const items = useMemo(() => buildWorkTraceItems(entries), [entries]);
  const reasoning = useMemo(() => collectWorkTraceReasoning(entries), [entries]);
  const toolCount = useMemo(() => countWorkTraceToolCalls(entries), [entries]);
  const activeThinkingKey = running ? resolveActiveThinkingEntryKey(entries) : null;
  const thinkingMs = resolveReasoningDurationMs(reasoning, activeThinkingKey);
  let latestActivityKey: string | null = null;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "activity") {
      latestActivityKey = item.key;
      break;
    }
  }
  return {
    items,
    activeThinkingKey,
    activeItem: running ? resolveActiveWorkItem(items, entries, activeThinkingKey) : null,
    latestActivityKey: running ? latestActivityKey : null,
    trailingKey: running ? (items.at(-1)?.key ?? null) : null,
    stats: { toolCount, thinkingMs },
  };
}

/** Names the latest running call ("正在运行 pnpm test") for the turn's status row. */
export function useRunningToolActivity(entries: readonly AssistantTurnLayoutEntry[] | undefined) {
  const { t } = useLocale();
  return useMemo(() => {
    const item = entries ? findLatestRunningToolItem(entries) : null;
    if (!item) return null;
    const { label, title } = getRunningToolActivity(item, t);
    return { label, title };
  }, [entries, t]);
}

/** Reasoning shorter than this stays out of the trace (it would only add noise). */
const MIN_VISIBLE_REASONING_MS = 1_000;

/**
 * Whether the turn's merged reasoning row is worth a row. A settled turn shows
 * it unless its measured total is under a second (an unmeasured history turn
 * shows it untimed). While the turn runs it appears once a second of reasoning
 * has settled, so the status row stays the only live indicator; the detailed
 * view also shows it while it streams.
 */
export function shouldShowReasoningRow(options: {
  running: boolean;
  active: boolean;
  detailed: boolean;
  settledMs: number | null;
}) {
  const { running, active, detailed, settledMs } = options;
  if (running && active && detailed) return true;
  if (settledMs === null) return !running;
  return settledMs >= MIN_VISIBLE_REASONING_MS;
}

/** One row of the processing trace (see buildWorkTraceItems for the merge rule). */
export function WorkTraceItemView(props: {
  item: WorkTraceItem;
  model: WorkTraceModel;
  running: boolean;
  renderMode: "streaming" | "static";
  readOnly?: boolean;
  redactToolContent?: boolean;
  workdir?: string;
  onOpenFileLink?: (link: ChatFileLink) => void;
}) {
  const {
    item,
    model,
    running,
    renderMode,
    readOnly = false,
    redactToolContent = false,
    workdir,
    onOpenFileLink,
  } = props;
  const detailed = useDetailedProgress();
  if (item.kind === "entry") {
    const { entry } = item;
    return (
      <RoundBlockContent
        block={entry.block}
        isLive={running}
        renderMode={renderMode}
        runningToolCallIds={entry.runningToolCallIds}
        thinkingOpen={running ? entry.thinkingOpen : false}
        isLatestThinking={entry.key === model.activeThinkingKey}
        traceKey={entry.key}
        isTrailingWork={entry.key === model.trailingKey}
        revealText={running}
        readOnly={readOnly}
        redactToolContent={redactToolContent}
        workdir={workdir}
        onOpenFileLink={onOpenFileLink}
      />
    );
  }
  // Shared/redacted views hide tool internals; model reasoning is at least as
  // sensitive, so it disappears entirely there.
  if (item.kind === "reasoning") {
    if (redactToolContent) return null;
    const active = item.segments.some((segment) => segment.key === model.activeThinkingKey);
    const visible = shouldShowReasoningRow({
      running,
      active,
      detailed,
      settledMs: model.stats.thinkingMs,
    });
    if (!visible) return null;
    return (
      <div data-assistant-operation="">
        <ThinkingDisclosure
          segments={item.segments}
          activeKey={model.activeThinkingKey}
          renderMode={renderMode}
          readOnly={readOnly}
          workdir={workdir}
          onOpenFileLink={onOpenFileLink}
        />
      </div>
    );
  }
  return (
    <div className={running ? undefined : "w-full"} data-assistant-operation="">
      <ToolTraceGroup
        items={item.items}
        runningToolCallIds={running ? item.runningToolCallIds : EMPTY_RUNNING_TOOL_CALL_IDS}
        live={running && item.key === model.trailingKey}
        showTurnStatus={running && item.key === model.latestActivityKey}
        readOnly={readOnly}
        redactToolContent={redactToolContent}
        onOpenFileLink={onOpenFileLink}
      />
    </div>
  );
}

/** All rows of the processing trace plus the collapsed-trace tail. */
export function useWorkTraceRows(
  model: WorkTraceModel,
  options: Omit<Parameters<typeof WorkTraceItemView>[0], "item" | "model">,
): { rows: ReactNode; collapsedTail: ReactNode } {
  const detailed = useDetailedProgress();
  const rows = model.items.map((item) => (
    <WorkTraceItemView key={item.key} item={item} model={model} {...options} />
  ));
  // The quiet view leaves the collapsed trace collapsed: the live status row
  // already names what is happening.
  const collapsedTail =
    detailed && model.activeItem ? (
      <WorkTraceItemView item={model.activeItem} model={model} {...options} />
    ) : null;
  return { rows, collapsedTail };
}

function RevealedStreamingMarkdown(
  props: { reveal: boolean } & Parameters<typeof StreamingSplitMarkdown>[0],
) {
  const { reveal, content, ...rest } = props;
  return <StreamingSplitMarkdown content={useStreamingReveal(content, reveal)} {...rest} />;
}

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
  /** The block is the last activity of the running work trace (see ToolTraceGroup `live`). */
  isTrailingWork?: boolean;
  /** The turn is still streaming: type newly arrived reply text out character by character. */
  revealText?: boolean;
  readOnly?: boolean;
  redactToolContent?: boolean;
  workdir?: string;
  onOpenFileLink?: (link: ChatFileLink) => void;
}) {
  const {
    block,
    isLive,
    renderMode,
    revealText = false,
    runningToolCallIds,
    thinkingOpen,
    isLatestThinking,
    traceKey,
    showTurnStatus = false,
    isTrailingWork = false,
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
    const segmentKey = traceKey ?? block.key;
    content = redactToolContent ? null : (
      <ThinkingDisclosure
        segments={[{ key: segmentKey, text: block.text }]}
        activeKey={isLive && thinkingOpen && isLatestThinking ? segmentKey : null}
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
        live={isLive && isTrailingWork}
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
    // 流式模式下把已完成段落冻结为 static 实例，每帧只重解析活跃尾部；
    // 落定孪生行保持 renderMode="streaming"（零 remount 设计），此时文本静止，
    // 切分状态不再变化，成本为零。
    content =
      renderMode === "streaming" ? (
        <RevealedStreamingMarkdown
          content={block.text}
          reveal={revealText}
          className="font-chat"
          readOnly={readOnly}
          workdir={workdir}
          onOpenFileLink={onOpenFileLink}
        />
      ) : (
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
      className={cn(!isLive && "w-full")}
      data-assistant-operation={isOperationBlock ? "" : undefined}
      // Reply prose is quotable into the composer; tool traces, thinking and
      // other operation blocks are not (see lib/chat/transcriptQuote).
      data-quote-source={isOperationBlock ? undefined : "assistant"}
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
  startedAtMs?: number;
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
    startedAtMs,
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
  const attentionRequired =
    running && hasInteractionRequiringAttention([...layout.work, ...layout.interaction]);
  const model = useWorkTraceModel(layout.work, running);
  const toolActivity = useRunningToolActivity(running ? layout.work : undefined);
  const { rows, collapsedTail } = useWorkTraceRows(model, {
    running,
    renderMode,
    readOnly,
    redactToolContent,
    workdir,
    onOpenFileLink,
  });
  const showWorkTrace = running || layout.work.length > 0;
  const stopped = !running && isStoppedReply(rounds);

  if (!showWorkTrace && !stopped && layout.interaction.length === 0 && layout.answer.length === 0)
    return null;

  const renderEntry = (entry: AssistantTurnLayoutEntry, liveInteraction: boolean) => (
    <RoundBlockContent
      key={entry.key}
      block={entry.block}
      isLive={running && liveInteraction}
      renderMode={renderMode}
      runningToolCallIds={entry.runningToolCallIds}
      thinkingOpen={false}
      isLatestThinking={false}
      traceKey={entry.key}
      revealText={running}
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
          collapseAfterAnswer={layout.answer.length > 0}
          collapsedTail={collapsedTail}
          durationMs={durationMs}
          hasDetails={layout.work.length > 0}
          running={running}
          startedAtMs={startedAtMs}
          stats={model.stats}
        >
          {rows}
        </AssistantWorkTrace>
      ) : null}

      {layout.interaction.map((entry) => renderEntry(entry, true))}
      {layout.answer.map((entry) => renderEntry(entry, false))}
      {stopped ? <GenerationStoppedNotice interrupted={isInterruptedByShutdown(rounds)} /> : null}
      {/* The turn's one live status row: phase, elapsed time, nothing else. */}
      {running ? (
        <LiveAssistantStatus
          status={normalizedToolStatus}
          isCompaction={toolStatusVariant === "compaction"}
          awaitingDecision={attentionRequired}
          startedAtMs={startedAtMs}
          toolActivity={toolActivity}
          replyTextLength={trailingReplyTextLength(layout.work)}
        />
      ) : null}
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
