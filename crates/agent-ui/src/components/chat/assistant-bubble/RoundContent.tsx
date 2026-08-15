import {
  AssistantStatus,
  CompactingText,
  VibingText,
} from "@liveagent/ui/components/chat/AssistantStatus";
import { HostedSearchGroupView } from "@liveagent/ui/components/chat/HostedSearchGroupView";
import { PluginContextBadge } from "@liveagent/ui/components/chat/PluginContextBadge";
import { ThinkingActivity } from "@liveagent/ui/components/chat/ThinkingActivity";
import { UsagePanel } from "@liveagent/ui/components/chat/UsagePanel";
import { Markdown } from "@liveagent/ui/components/Markdown";
import type { UiRound } from "@liveagent/ui/lib/chat/assistantBubbleAdapter";
import { normalizeLiveToolStatus, VIBING_STATUS } from "@liveagent/ui/lib/chat/assistantStatus";
import type { ChatFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import { isTaskToolBlock } from "@liveagent/ui/lib/chat/taskProgress";
import { memo, type ReactNode, useMemo } from "react";
import {
  type GroupedRoundBlock,
  groupRoundBlocks,
  isBuiltinShareToolName,
} from "./assistantBubbleUtils";
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
    workdir,
    onOpenFileLink,
  } = props;

  let content: ReactNode;
  if (block.kind === "thinking") {
    const isRunning = isLive && thinkingOpen && isLatestThinking;
    content = (
      <ThinkingActivity
        text={block.text}
        open={isRunning}
        isRunning={isRunning}
        renderMode={renderMode}
        workdir={workdir}
        onOpenFileLink={onOpenFileLink}
      />
    );
  } else if (block.kind === "tool") {
    const displayImagePayload = getNativeDisplayImagePayload(block.item);
    if (displayImagePayload) {
      content = <NativeDisplayImageBlock payload={displayImagePayload} />;
    } else if (block.item.toolCall.name === "Image" && !block.item.toolResult?.isError) {
      content = null;
    } else {
      content = (
        <MemoToolCallItem
          item={block.item}
          isRunning={Boolean(
            isLive && block.item.toolCall.id && runningToolCallIds.includes(block.item.toolCall.id),
          )}
        />
      );
    }
  } else if (block.kind === "toolGroup") {
    content = (
      <ToolTraceGroup items={block.items} runningToolCallIds={isLive ? runningToolCallIds : []} />
    );
  } else if (block.kind === "hostedSearch" || block.kind === "hostedSearchGroup") {
    content = (
      <HostedSearchGroupView
        items={block.kind === "hostedSearch" ? [block.item] : block.items}
        isLive={isLive}
      />
    );
  } else if (block.text.trim()) {
    content = (
      <Markdown
        content={block.text}
        className="font-chat"
        renderMode={renderMode}
        workdir={workdir}
        onOpenFileLink={onOpenFileLink}
      />
    );
  } else {
    content = null;
  }

  if (!content) return null;

  return <div className={isLive ? undefined : "w-full"}>{content}</div>;
});

export const RoundContent = memo(function RoundContent(props: {
  round: UiRound;
  showUsage?: boolean;
  usageContextWindow?: number;
  isLive?: boolean;
  isStreaming?: boolean;
  isActive?: boolean;
  toolStatus?: string | null;
  toolStatusVariant?: "default" | "compaction";
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
    showUsage,
    usageContextWindow,
    isLive,
    isStreaming = isLive,
    isActive,
    toolStatus,
    toolStatusVariant,
    runningToolCallIds,
    thinkingOpen,
    renderMode,
    readOnly = false,
    redactToolContent = false,
    workdir,
    onOpenFileLink,
  } = props;
  const groupedBlocks = useMemo(() => groupRoundBlocks(round.blocks), [round.blocks]);
  const visibleGroupedBlocks = useMemo(
    () => groupedBlocks.filter((block) => !isTaskToolBlock(block)),
    [groupedBlocks],
  );
  const hasContent =
    visibleGroupedBlocks.some((block) => {
      if (
        block.kind === "tool" ||
        block.kind === "toolGroup" ||
        block.kind === "hostedSearch" ||
        block.kind === "hostedSearchGroup"
      ) {
        return true;
      }
      return block.text.trim().length > 0;
    }) ||
    (isActive && isLive);
  const normalizedToolStatus =
    isActive && isLive ? normalizeLiveToolStatus(toolStatus ?? null) : null;
  const isCompactionStatus = toolStatusVariant === "compaction";
  const isVibingStatus = normalizedToolStatus === VIBING_STATUS;
  const hasRunningToolCall = useMemo(() => {
    const runningIds = new Set(runningToolCallIds ?? []);
    return visibleGroupedBlocks.some((block) => {
      if (block.kind === "tool")
        return Boolean(block.item.toolCall.id && runningIds.has(block.item.toolCall.id));
      if (block.kind === "toolGroup") {
        return block.items.some((item) =>
          Boolean(item.toolCall.id && runningIds.has(item.toolCall.id)),
        );
      }
      return false;
    });
  }, [runningToolCallIds, visibleGroupedBlocks]);
  const latestThinkingKey = useMemo(() => {
    for (let index = visibleGroupedBlocks.length - 1; index >= 0; index -= 1) {
      const block = visibleGroupedBlocks[index];
      if (block?.kind === "thinking") return block.key;
    }
    return null;
  }, [visibleGroupedBlocks]);
  const autoOpenThinking = isLive ? Boolean(isActive && thinkingOpen) : false;

  if (!hasContent) return null;

  return (
    <div className="space-y-2">
      {!redactToolContent && round.meta?.pluginContext ? (
        <PluginContextBadge context={round.meta.pluginContext} />
      ) : null}

      {isActive &&
      isLive &&
      normalizedToolStatus &&
      (!hasRunningToolCall || isCompactionStatus || isVibingStatus) ? (
        <div className="py-1.5">
          {isCompactionStatus ? (
            <CompactingText />
          ) : isVibingStatus ? (
            <VibingText />
          ) : (
            <AssistantStatus>{normalizedToolStatus}</AssistantStatus>
          )}
        </div>
      ) : null}

      {visibleGroupedBlocks.map((block) => {
        if (block.kind === "thinking") {
          return (
            <ThinkingActivity
              key={block.key}
              text={block.text}
              open={autoOpenThinking && block.key === latestThinkingKey}
              isRunning={autoOpenThinking && block.key === latestThinkingKey}
              renderMode={renderMode ?? (isStreaming ? "streaming" : "static")}
              workdir={workdir}
              onOpenFileLink={onOpenFileLink}
            />
          );
        }

        if (block.kind === "tool") {
          const isRedactedToolContent =
            redactToolContent && isBuiltinShareToolName(block.item.toolCall.name);
          const displayImagePayload = getNativeDisplayImagePayload(block.item);
          if (!isRedactedToolContent && displayImagePayload) {
            return (
              <NativeDisplayImageBlock
                key={block.key}
                payload={displayImagePayload}
                readOnly={readOnly}
              />
            );
          }

          if (
            !isRedactedToolContent &&
            block.item.toolCall.name === "Image" &&
            !block.item.toolResult?.isError
          ) {
            return null;
          }

          return (
            <MemoToolCallItem
              key={block.key}
              item={block.item}
              isRunning={Boolean(
                isLive &&
                  block.item.toolCall.id &&
                  (runningToolCallIds || []).includes(block.item.toolCall.id),
              )}
              readOnly={readOnly}
              redactToolContent={redactToolContent}
            />
          );
        }

        if (block.kind === "toolGroup") {
          return (
            <ToolTraceGroup
              key={block.key}
              items={block.items}
              runningToolCallIds={
                isLive
                  ? (runningToolCallIds ?? EMPTY_RUNNING_TOOL_CALL_IDS)
                  : EMPTY_RUNNING_TOOL_CALL_IDS
              }
              readOnly={readOnly}
              redactToolContent={redactToolContent}
            />
          );
        }

        if (block.kind === "hostedSearch" || block.kind === "hostedSearchGroup") {
          return (
            <HostedSearchGroupView
              key={block.key}
              items={block.kind === "hostedSearch" ? [block.item] : block.items}
              readOnly={readOnly}
            />
          );
        }

        if (!block.text.trim()) return null;

        return (
          <Markdown
            key={block.key}
            content={block.text}
            className="font-chat"
            renderMode={renderMode}
            readOnly={readOnly}
            workdir={workdir}
            onOpenFileLink={onOpenFileLink}
          />
        );
      })}

      {showUsage ? (
        <UsagePanel usage={round.meta?.usage} contextWindow={usageContextWindow} />
      ) : null}
    </div>
  );
});
