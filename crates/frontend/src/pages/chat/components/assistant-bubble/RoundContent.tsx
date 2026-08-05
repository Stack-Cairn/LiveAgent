import { memo, type ReactNode, useEffect, useRef, useState } from "react";

import { ChevronRight, Lightbulb, RefreshCw } from "../../../../components/icons";
import { Markdown } from "../../../../components/Markdown";
import { useLocale } from "../../../../i18n";
import type { ChatFileLink } from "../../../../lib/chat/chatFileLinks";
import type { RetryAttemptRecord } from "../../../../lib/chat/conversation/liveTranscriptStore";
import type { GroupedRoundBlock } from "./assistantBubbleUtils";
import { HostedSearchGroupView } from "./HostedSearchGroupView";
import { LazyCollapse } from "./LazyCollapse";
import { AssistantStatus } from "./StatusText";
import { MemoToolCallItem } from "./ToolCallItem";
import { getNativeDisplayImagePayload, NativeDisplayImageBlock } from "./ToolImages";
import { ToolTraceGroup } from "./ToolTraceGroup";

const ThinkingBlock = memo(function ThinkingBlock({
  text,
  open,
  isRunning,
  renderMode,
  workdir,
  onOpenFileLink,
}: {
  text: string;
  open?: boolean;
  isRunning?: boolean;
  renderMode: "streaming" | "static";
  workdir?: string;
  onOpenFileLink?: (link: ChatFileLink) => void;
}) {
  const hasText = /\S/.test(text || "");
  const { t } = useLocale();
  const [isOpen, setIsOpen] = useState(typeof open === "boolean" ? open : false);
  const userInteractedRef = useRef(false);
  useEffect(() => {
    if (!userInteractedRef.current && typeof open === "boolean") {
      setIsOpen(open);
    }
  }, [open]);

  if (!hasText) return null;

  return (
    <div className="group/think w-full">
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => {
          userInteractedRef.current = true;
          setIsOpen((previous) => !previous);
        }}
        className="thinking-block-toggle flex w-full cursor-pointer select-none items-center gap-2 py-1.5 text-left text-[calc(13px*var(--zone-font-scale,1))] font-normal text-muted-foreground/80 hover:text-foreground"
      >
        {isRunning ? (
          <AssistantStatus className="min-h-0">{t("chat.thinking")}</AssistantStatus>
        ) : (
          <>
            <Lightbulb className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
            <span className="thinking-block-label">{t("chat.thinkingProcess")}</span>
          </>
        )}
        <ChevronRight
          className={`ml-auto h-3.5 w-3.5 text-muted-foreground/60 transition-transform duration-200 ease-out ${isOpen ? "rotate-90" : ""}`}
        />
      </button>
      <LazyCollapse open={isOpen}>
        {() => (
          <div className="pb-1 pt-1.5">
            <Markdown
              content={text}
              className="thinking-markdown space-y-1.5"
              renderMode={renderMode}
              showCaret={false}
              workdir={workdir}
              onOpenFileLink={onOpenFileLink}
            />
          </div>
        )}
      </LazyCollapse>
    </div>
  );
});

export const RetryDetailsBlock = memo(function RetryDetailsBlock({
  attempts,
}: {
  attempts: RetryAttemptRecord[];
}) {
  const { t } = useLocale();
  const [isOpen, setIsOpen] = useState(false);

  if (attempts.length === 0) return null;

  return (
    <div className="group/retry w-full">
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((previous) => !previous)}
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

export const RoundBlockContent = memo(function RoundBlockContent(props: {
  block: GroupedRoundBlock;
  isLive: boolean;
  isMutable: boolean;
  renderMode: "streaming" | "static";
  runningToolCallIds: string[];
  thinkingOpen: boolean;
  isLatestThinking: boolean;
  isAborted: boolean;
  workdir?: string;
  onOpenFileLink?: (link: ChatFileLink) => void;
}) {
  const {
    block,
    isLive,
    isMutable,
    renderMode,
    runningToolCallIds,
    thinkingOpen,
    isLatestThinking,
    isAborted,
    workdir,
    onOpenFileLink,
  } = props;

  let content: ReactNode;
  if (block.kind === "thinking") {
    const isRunning = isLive && thinkingOpen && isLatestThinking;
    content = (
      <ThinkingBlock
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
          isAborted={isAborted}
          isRunning={Boolean(
            isLive && block.item.toolCall.id && runningToolCallIds.includes(block.item.toolCall.id),
          )}
        />
      );
    }
  } else if (block.kind === "toolGroup") {
    content = (
      <ToolTraceGroup
        items={block.items}
        isAborted={isAborted}
        runningToolCallIds={isLive ? runningToolCallIds : []}
      />
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
        showCaret={Boolean(isLive && isMutable)}
        workdir={workdir}
        onOpenFileLink={onOpenFileLink}
      />
    );
  } else {
    content = null;
  }

  if (!content) return null;

  return (
    <div
      className={
        isLive
          ? undefined
          : `w-full [&_.todo-list-view_.animate-spin]:!animate-none [&_.todo-list-view_.shimmer]:!animate-none${
              isAborted
                ? " [&_.todo-list-view_[data-todo-incomplete]>span:last-child]:!text-muted-foreground/40 [&_.todo-list-view_[data-todo-incomplete]>span:last-child]:line-through"
                : ""
            }`
      }
    >
      {content}
    </div>
  );
});
