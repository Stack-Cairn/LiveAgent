import { useEffect, useMemo, useRef, useState } from "react";

import { ChevronRight, Loader2, Sparkles } from "../../../../components/icons";
import { LiveMarkdown, Markdown } from "../../../../components/Markdown";
import { useLocale } from "../../../../i18n";
import type { UiRound } from "../../../../lib/chat/messages/uiMessages";
import { normalizeLiveToolStatus, VIBING_STATUS } from "../../../../lib/chat/page/chatPageHelpers";
import { useScrollFollow } from "../../hooks/useScrollFollow";
import { groupRoundBlocks } from "./assistantBubbleUtils";
import { HostedSearchGroupView } from "./HostedSearchGroupView";
import { CompactingText, VibingText } from "./StatusText";
import { MemoToolCallItem } from "./ToolCallItem";
import { getNativeDisplayImagePayload, NativeDisplayImageBlock } from "./ToolImages";
import { ToolTraceGroup } from "./ToolTraceGroup";
import { UsagePanel } from "./UsagePanel";

function ThinkingBlock({ text, open }: { text: string; open?: boolean }) {
  const hasText = /\S/.test(text || "");
  const { t } = useLocale();
  const [isOpen, setIsOpen] = useState(typeof open === "boolean" ? open : false);
  const userInteractedRef = useRef(false);
  const [thinkingPre, setThinkingPre] = useState<HTMLPreElement | null>(null);
  const [thinkingContent, setThinkingContent] = useState<HTMLElement | null>(null);

  // Same engine as the transcript viewport, minus the reattach zone (there is
  // no reserve band inside the <pre>). The ResizeObserver target must be the
  // inner content element: once max-h-64 clamps the <pre>, its border box
  // stops resizing while scrollHeight keeps growing.
  useScrollFollow({
    viewport: thinkingPre,
    content: thinkingContent,
    enabled: isOpen && hasText,
    config: { reattachZonePx: 0 },
  });

  useEffect(() => {
    if (!userInteractedRef.current && typeof open === "boolean") {
      setIsOpen(open);
    }
  }, [open]);

  if (!hasText) return null;

  return (
    <div className="group/think rounded-lg border border-border/40 bg-muted/30">
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => {
          userInteractedRef.current = true;
          setIsOpen((prev) => !prev);
        }}
        className="thinking-block-toggle flex w-full cursor-pointer select-none items-center gap-2 px-3 py-2 text-[calc(13px*var(--zone-font-scale,1))] text-muted-foreground transition-colors hover:text-foreground"
      >
        <Sparkles className="h-3.5 w-3.5 text-muted-foreground/70" />
        <span className="thinking-block-label font-medium">{t("chat.thinkingProcess")}</span>
        <ChevronRight
          className={`ml-auto h-3 w-3 transition-transform ${isOpen ? "rotate-90" : ""}`}
        />
      </button>
      {isOpen ? (
        <div className="border-t border-border/30 px-3 pb-3 pt-2">
          <pre
            ref={setThinkingPre}
            className="thinking-block-pre max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-[calc(12.5px*var(--zone-font-scale,1))] leading-relaxed text-muted-foreground"
          >
            <code ref={setThinkingContent} className="block font-[inherit]">
              {text}
            </code>
          </pre>
        </div>
      ) : null}
    </div>
  );
}

export function RoundContent(props: {
  round: UiRound;
  showLabel: boolean;
  showUsage?: boolean;
  usageContextWindow?: number;
  isLive?: boolean;
  isActive?: boolean;
  toolStatus?: string | null;
  toolStatusVariant?: "default" | "compaction";
  runningToolCallIds?: string[];
  thinkingOpen?: boolean;
}) {
  const {
    round,
    showLabel,
    showUsage,
    usageContextWindow,
    isLive,
    isActive,
    toolStatus,
    toolStatusVariant,
    runningToolCallIds,
    thinkingOpen,
  } = props;
  const hasContent =
    round.blocks.some((block) => {
      if (block.kind === "tool" || block.kind === "hostedSearch") return true;
      return block.text.trim().length > 0;
    }) ||
    (isActive && isLive);
  const normalizedToolStatus =
    isActive && isLive ? normalizeLiveToolStatus(toolStatus ?? null) : null;
  const isCompactionStatus = toolStatusVariant === "compaction";
  const isVibingStatus = normalizedToolStatus === VIBING_STATUS;
  const groupedBlocks = useMemo(() => groupRoundBlocks(round.blocks), [round.blocks]);
  const latestThinkingKey = useMemo(() => {
    for (let index = groupedBlocks.length - 1; index >= 0; index -= 1) {
      const block = groupedBlocks[index];
      if (block?.kind === "thinking") return block.key;
    }
    return null;
  }, [groupedBlocks]);
  const autoOpenThinking = isLive ? Boolean(isActive && thinkingOpen) : false;

  if (!hasContent) return null;

  return (
    <div className="space-y-3">
      {showLabel ? <div className="h-px bg-border/40" /> : null}

      {isActive && isLive && normalizedToolStatus ? (
        <div className="flex items-center gap-2 py-1 text-[calc(13px*var(--zone-font-scale,1))]">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          {isCompactionStatus ? (
            <CompactingText className="font-medium text-muted-foreground" />
          ) : isVibingStatus ? (
            <VibingText className="font-medium text-muted-foreground" />
          ) : (
            <span className="font-medium text-muted-foreground">{normalizedToolStatus}</span>
          )}
        </div>
      ) : null}

      {groupedBlocks.map((block) => {
        if (block.kind === "thinking") {
          return (
            <ThinkingBlock
              key={block.key}
              text={block.text}
              open={autoOpenThinking && block.key === latestThinkingKey}
            />
          );
        }

        if (block.kind === "tool") {
          const displayImagePayload = getNativeDisplayImagePayload(block.item);
          if (displayImagePayload) {
            return <NativeDisplayImageBlock key={block.key} payload={displayImagePayload} />;
          }

          if (block.item.toolCall.name === "Image" && !block.item.toolResult?.isError) {
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
            />
          );
        }

        if (block.kind === "toolGroup") {
          return (
            <ToolTraceGroup
              key={block.key}
              items={block.items}
              runningToolCallIds={isLive ? (runningToolCallIds ?? []) : []}
            />
          );
        }

        if (block.kind === "hostedSearch" || block.kind === "hostedSearchGroup") {
          return (
            <HostedSearchGroupView
              key={block.key}
              items={block.kind === "hostedSearch" ? [block.item] : block.items}
            />
          );
        }

        if (!block.text.trim()) return null;

        return isLive && isActive ? (
          <LiveMarkdown
            key={block.key}
            content={block.text}
            className="font-openai-chat"
            isAnimating
          />
        ) : (
          <Markdown key={block.key} content={block.text} className="font-openai-chat" />
        );
      })}

      {showUsage ? (
        <UsagePanel usage={round.meta?.usage} contextWindow={usageContextWindow} />
      ) : null}
    </div>
  );
}
