import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import {
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  Pencil,
  RefreshCw,
} from "../../../components/icons";
import { Markdown } from "../../../components/Markdown";
import { ConfirmActionPopover } from "../../../components/ui/confirm-action-popover";
import { useLocale } from "../../../i18n";
import type {
  RenderSummaryCard,
  RenderUserMessage,
} from "../../../lib/chat/conversation/conversationState";
import { getRoundText } from "../../../lib/chat/messages/uiMessages";
import {
  buildGitHubCommitUrl,
  type CommitDetailsLoader,
  type CommitDisplayReference,
  UserMessageContent,
} from "../../../lib/chat/messages/userMessageContent";
import { AssistantAvatar, AssistantBubble } from "../components/AssistantBubble";
import { EditableUserMessageBubble } from "./EditableUserMessageBubble";
import type { TranscriptHistoryProps } from "./transcriptTypes";
import { formatMessageTimestamp, splitUserAttachmentsForDisplay } from "./transcriptUtils";
import { UserAttachmentCards } from "./UserAttachmentCards";

const TRANSCRIPT_ROW_ESTIMATED_HEIGHT = 260;
const TRANSCRIPT_ROW_GAP = 24;
const TRANSCRIPT_ROW_OVERSCAN_COUNT = 5;

const SummaryCard = memo(function SummaryCard(props: { item: RenderSummaryCard }) {
  const { item } = props;
  const { locale } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const isEn = locale === "en-US";

  return (
    <div className="flex justify-center px-2">
      <div className="checkpoint-card w-full max-w-3xl overflow-hidden rounded-[14px] border border-black/[0.06] bg-white/[0.72] shadow-[0_1px_3px_rgba(0,0,0,0.04),0_4px_12px_rgba(0,0,0,0.03)] backdrop-blur-xl dark:border-white/[0.1] dark:bg-white/[0.06] dark:shadow-[0_1px_3px_rgba(0,0,0,0.2),0_4px_12px_rgba(0,0,0,0.15)]">
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors duration-150 hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
        >
          {/* Icon */}
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-black/[0.04] dark:bg-white/[0.08]">
            <CheckCircle2 size={16} strokeWidth={1.8} className="text-muted-foreground" />
          </div>

          {/* Text content */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[calc(13px*var(--zone-font-scale,1))] font-medium text-foreground/90">
                {isEn ? "Context Checkpoint" : "上下文检查点"}
              </span>
              <span className="inline-flex items-center rounded-md bg-black/[0.05] px-1.5 py-[1px] text-[calc(11px*var(--zone-font-scale,1))] font-normal tabular-nums text-muted-foreground dark:bg-white/[0.08]">
                {item.coveredMessageCount} {isEn ? "msgs" : "条消息"}
              </span>
            </div>
            <div className="mt-[2px] text-[calc(11px*var(--zone-font-scale,1))] text-muted-foreground/70">
              {item.generatedBy.providerId} · {item.generatedBy.model}
            </div>
          </div>

          {/* Expand/collapse chevron */}
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-200 ${expanded ? "rotate-0" : "-rotate-90"}`}
          />
        </button>

        {/* Expandable content */}
        {expanded ? (
          <div className="checkpoint-expand border-t border-black/[0.05] px-3.5 py-3 dark:border-white/[0.06]">
            <Markdown content={item.content} className="font-openai-chat text-sm" />
          </div>
        ) : null}
      </div>
    </div>
  );
});

export const TranscriptHistory = memo(function TranscriptHistory(props: TranscriptHistoryProps) {
  const {
    conversationId,
    historyItems,
    scrollViewport,
    showUsage,
    usageContextWindow,
    copiedMessageKey,
    setCopiedMessageKey,
    onResendFromEdit,
    workspaceRoot,
    gitClient,
    isSending,
  } = props;
  const { t } = useLocale();
  const [editingMessageKey, setEditingMessageKey] = useState<string | null>(null);
  const copiedResetTimerRef = useRef<number | null>(null);
  const commitDetailsCacheRef = useRef(new Map<string, CommitDisplayReference>());

  const loadCommitDetails = useCallback<CommitDetailsLoader>(
    async (commit) => {
      const workdir = workspaceRoot?.trim() ?? "";
      const sha = commit.sha.trim();
      if (!gitClient || !workdir || !sha) return null;
      const cacheKey = `${workdir}\u0000${sha}`;
      const cached = commitDetailsCacheRef.current.get(cacheKey);
      if (cached) return cached;
      const response = await gitClient.commitDetails(workdir, sha);
      const details = response.commit;
      const resolved: CommitDisplayReference = {
        sha: details.sha,
        shortSha: details.shortSha,
        subject: details.subject,
        body: details.body,
        authorName: details.authorName,
        authorEmail: details.authorEmail,
        authorDate: details.authorDate,
        fileCount: details.fileCount,
        filesChanged: details.filesChanged,
        insertions: details.insertions,
        deletions: details.deletions,
        stat: details.stat,
        remoteName: details.remoteName,
        remoteUrl: details.remoteUrl,
        githubUrl:
          commit.githubUrl ||
          buildGitHubCommitUrl(details.remoteUrl || response.state.remoteUrl, details.sha) ||
          undefined,
      };
      commitDetailsCacheRef.current.set(cacheKey, resolved);
      return resolved;
    },
    [gitClient, workspaceRoot],
  );

  useEffect(() => {
    setEditingMessageKey(null);
    commitDetailsCacheRef.current.clear();
  }, [conversationId]);

  useEffect(
    () => () => {
      if (copiedResetTimerRef.current !== null) {
        window.clearTimeout(copiedResetTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!editingMessageKey) {
      return;
    }
    const hasEditingMessage = historyItems.some(
      (item) => item.kind === "user" && item.key === editingMessageKey,
    );
    if (!hasEditingMessage) {
      setEditingMessageKey(null);
    }
  }, [editingMessageKey, historyItems]);

  const getTranscriptItemKey = useCallback(
    (index: number) => historyItems[index]?.key ?? index,
    [historyItems],
  );
  const transcriptVirtualizer = useVirtualizer({
    count: historyItems.length,
    getScrollElement: () => scrollViewport,
    estimateSize: () => TRANSCRIPT_ROW_ESTIMATED_HEIGHT,
    getItemKey: getTranscriptItemKey,
    gap: TRANSCRIPT_ROW_GAP,
    overscan: TRANSCRIPT_ROW_OVERSCAN_COUNT,
    enabled: scrollViewport !== null,
  });
  const virtualRows = transcriptVirtualizer.getVirtualItems();

  return (
    <div className="relative" style={{ height: transcriptVirtualizer.getTotalSize() }}>
      {virtualRows.map((virtualRow) => {
        const item = historyItems[virtualRow.index];
        if (!item) return null;

        if (item.kind === "summary") {
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={transcriptVirtualizer.measureElement}
              className="absolute left-0 right-0 top-0"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <SummaryCard item={item} />
            </div>
          );
        }

        if (item.kind === "user") {
          const isEditing = editingMessageKey === item.key;
          const isCopied = copiedMessageKey === item.key;
          const effectiveMessageRef = item.messageRef;
          const missingStableRef = !effectiveMessageRef;
          const editDisabled = isSending || missingStableRef;
          const editTitle = missingStableRef
            ? "旧历史缺少稳定消息标识，无法编辑重发"
            : t("chat.edit");
          const compactedClass = item.isFromCompactedSegment ? "opacity-70" : "";
          const { visibleFiles, pastedTextFiles } = splitUserAttachmentsForDisplay(
            item.attachments,
            item.text,
          );
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={transcriptVirtualizer.measureElement}
              className="absolute left-0 right-0 top-0 flex justify-end"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              {isEditing && effectiveMessageRef ? (
                <EditableUserMessageBubble
                  initialText={item.text}
                  attachments={item.attachments}
                  workspaceRoot={workspaceRoot}
                  compactedClass={compactedClass}
                  onCancel={() => setEditingMessageKey(null)}
                  onSubmit={(newText, nextAttachments) => {
                    setEditingMessageKey(null);
                    onResendFromEdit(effectiveMessageRef, newText, nextAttachments);
                  }}
                />
              ) : (
                <div
                  className={`chat-user-bubble-wrap group relative ml-auto max-w-[min(85%,calc(50em+2rem))] ${compactedClass}`}
                >
                  <div className="chat-bubble-enter chat-user-bubble ml-auto w-fit max-w-full rounded-2xl rounded-br-md bg-[hsl(var(--chat-user-bg))] px-4 py-2.5 font-openai-chat text-[calc(14.5px*var(--zone-font-scale,1))] leading-relaxed text-[hsl(var(--chat-user-fg))]">
                    <UserAttachmentCards files={visibleFiles} workspaceRoot={workspaceRoot} />
                    {item.text ? (
                      <UserMessageContent
                        text={item.text}
                        pastedTextFiles={pastedTextFiles}
                        loadCommitDetails={loadCommitDetails}
                      />
                    ) : null}
                  </div>
                  <div className="mt-1 flex items-center justify-end gap-1.5">
                    <div className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        type="button"
                        className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                        title={t("chat.copy")}
                        onClick={() => {
                          navigator.clipboard.writeText(item.text);
                          setCopiedMessageKey(item.key);
                          if (copiedResetTimerRef.current !== null) {
                            window.clearTimeout(copiedResetTimerRef.current);
                          }
                          copiedResetTimerRef.current = window.setTimeout(() => {
                            copiedResetTimerRef.current = null;
                            setCopiedMessageKey(null);
                          }, 1500);
                        }}
                      >
                        {isCopied ? (
                          <Check className="h-3.5 w-3.5" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <button
                        type="button"
                        className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                        title={editTitle}
                        disabled={editDisabled}
                        onClick={() => {
                          if (!effectiveMessageRef) return;
                          setEditingMessageKey(item.key);
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <span className="select-none text-[calc(11px*var(--zone-font-scale,1))] tabular-nums text-muted-foreground/70">
                      {formatMessageTimestamp(item.timestamp)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          );
        }

        const replyText = item.rounds
          .map((round) => getRoundText(round).trim())
          .filter((text) => text.length > 0)
          .join("\n\n");
        // Retry re-sends the nearest preceding user prompt through the
        // edit-resend truncation pipeline: this reply and everything after
        // it are discarded, same as editing that prompt without changes.
        let retryTarget: RenderUserMessage | null = null;
        for (let index = virtualRow.index - 1; index >= 0; index -= 1) {
          const candidate = historyItems[index];
          if (candidate?.kind === "user") {
            retryTarget = candidate;
            break;
          }
        }
        const retryMessageRef = retryTarget?.messageRef;
        const retryDisabled = isSending || !retryMessageRef;
        const retryTitle = retryMessageRef ? t("chat.retry") : "旧历史缺少稳定消息标识，无法重试";
        const isReplyCopied = copiedMessageKey === item.key;
        return (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={transcriptVirtualizer.measureElement}
            className={`absolute left-0 right-0 top-0 flex justify-start ${
              item.isFromCompactedSegment ? "opacity-70" : ""
            }`}
            style={{ transform: `translateY(${virtualRow.start}px)` }}
          >
            {item.rounds.length > 0 ? (
              <div className="group/assistant w-full max-w-full">
                <AssistantBubble
                  rounds={item.rounds}
                  showUsage={showUsage}
                  usageContextWindow={usageContextWindow}
                />
                <div className="mt-1 flex items-center justify-start gap-1.5 pl-10">
                  <span className="select-none text-[calc(11px*var(--zone-font-scale,1))] tabular-nums text-muted-foreground/70">
                    {formatMessageTimestamp(item.timestamp)}
                  </span>
                  <div className="flex gap-0.5 opacity-0 transition-opacity group-focus-within/assistant:opacity-100 group-hover/assistant:opacity-100">
                    <button
                      type="button"
                      className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                      title={t("chat.copy")}
                      disabled={!replyText}
                      onClick={() => {
                        navigator.clipboard.writeText(replyText);
                        setCopiedMessageKey(item.key);
                        if (copiedResetTimerRef.current !== null) {
                          window.clearTimeout(copiedResetTimerRef.current);
                        }
                        copiedResetTimerRef.current = window.setTimeout(() => {
                          copiedResetTimerRef.current = null;
                          setCopiedMessageKey(null);
                        }, 1500);
                      }}
                    >
                      {isReplyCopied ? (
                        <Check className="h-3.5 w-3.5" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                    <ConfirmActionPopover
                      title={t("chat.retryConfirmTitle")}
                      description={t("chat.retryConfirmDescription")}
                      confirmLabel={t("chat.retry")}
                      align="start"
                      side="top"
                      onConfirm={() => {
                        if (!retryTarget || !retryMessageRef) return;
                        onResendFromEdit(
                          retryMessageRef,
                          retryTarget.text,
                          retryTarget.attachments,
                        );
                      }}
                    >
                      {() => (
                        <button
                          type="button"
                          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                          title={retryTitle}
                          disabled={retryDisabled}
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </ConfirmActionPopover>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex w-full max-w-full items-start gap-3">
                <AssistantAvatar />
                <div className="min-w-0 flex-1 pt-0.5">
                  {getRoundText(item.rounds[item.rounds.length - 1] ?? { blocks: [] }).trim() ? (
                    <Markdown
                      content={getRoundText(item.rounds[item.rounds.length - 1] ?? { blocks: [] })}
                      className="font-openai-chat"
                    />
                  ) : null}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});
