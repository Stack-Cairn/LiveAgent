import {
  AssistantStatus,
  CompactingText,
  VibingText,
} from "@liveagent/ui/components/chat/AssistantStatus";
import { HostedSearchGroupView } from "@liveagent/ui/components/chat/HostedSearchGroupView";
import { LazyCollapse } from "@liveagent/ui/components/chat/LazyCollapse";
import { ThinkingActivity } from "@liveagent/ui/components/chat/ThinkingActivity";
import { UsagePanel } from "@liveagent/ui/components/chat/UsagePanel";
import { Markdown } from "@liveagent/ui/components/Markdown";
import { useLocale } from "@liveagent/ui/i18n/index";
import { isTaskToolBlock } from "@liveagent/ui/lib/chat/taskProgress";
import { memo, useMemo, useState } from "react";
import { ChevronRight, RefreshCw } from "../../../components/icons";
import type { ChatFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import { normalizeLiveToolStatus, VIBING_STATUS } from "../../../lib/chat/chatPageHelpers";
import type { RetryAttemptRecord } from "../../../lib/chat/transcript/types";
import type { UiRound } from "../../../lib/chat/uiMessages";
import { groupRoundBlocks, isBuiltinShareToolName } from "./assistantBubbleUtils";
import { MemoToolCallItem } from "./ToolCallItem";
import { getNativeDisplayImagePayload, NativeDisplayImageBlock } from "./ToolImages";
import { ToolTraceGroup } from "./ToolTraceGroup";

const EMPTY_RUNNING_TOOL_CALL_IDS: string[] = [];

// Expandable per-attempt stream-retry history for the live run, mirrored
// from the desktop app's RetryDetailsBlock (agent-gui RoundContent.tsx).
export const RetryDetailsBlock = memo(function RetryDetailsBlock({
  attempts,
}: {
  attempts: readonly RetryAttemptRecord[];
}) {
  const { t } = useLocale();
  const [isOpen, setIsOpen] = useState(false);

  if (attempts.length === 0) return null;

  return (
    <div className="group/retry w-full">
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((prev) => !prev)}
        className="retry-details-toggle flex w-full cursor-pointer select-none items-center gap-2 py-1.5 text-left text-[calc(13px*var(--zone-font-scale,1))] font-normal text-muted-foreground/80 hover:text-foreground"
      >
        <RefreshCw className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        <span>{t("chat.retryDetailsToggle").replace("{count}", String(attempts.length))}</span>
        <ChevronRight
          className={`ml-auto h-3.5 w-3.5 text-muted-foreground/60 transition-transform duration-200 ease-out ${isOpen ? "rotate-90" : ""}`}
        />
      </button>
      <LazyCollapse open={isOpen}>
        {() => (
          <div className="space-y-1 pb-1 pt-1.5">
            {/* Index-keyed: attempt ordinals can repeat within one list (text
                mode's tool-recovery loop restarts each wrapper's counter at 1)
                and the list is append-only, so the index is the stable key. */}
            {attempts.map((entry, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: retry attempts are append-only and their reported ordinals can repeat.
                key={`${index}-${entry.attempt}-${entry.maxAttempts}`}
                className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5 text-[calc(12px*var(--zone-font-scale,1))] text-muted-foreground"
              >
                <div className="font-medium text-foreground/80">
                  {t("chat.retryAttemptLabel")
                    .replace("{attempt}", String(entry.attempt))
                    .replace("{maxAttempts}", String(entry.maxAttempts))}
                </div>
                <div className="whitespace-pre-wrap break-words">{entry.errorMessage}</div>
              </div>
            ))}
          </div>
        )}
      </LazyCollapse>
    </div>
  );
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
