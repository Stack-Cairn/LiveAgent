import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { AskUserQuestionCard } from "../../../components/chat/AskUserQuestionCard";
import { FileChangeBadge } from "../../../components/chat/FileChangeBadge";
import { ChevronRight } from "../../../components/icons";
import { useLocale } from "../../../i18n";
import type { ToolResultMessage } from "../../../lib/agentTypes";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  type AskUserQuestionAnswer,
  parseAskUserQuestionResultDetails,
  readAskUserQuestionDeadlineAt,
  sanitizeAskUserQuestionItems,
} from "../../../lib/chat/askUserQuestion";
import { submitAskUserQuestionAnswer } from "../../../lib/chat/askUserQuestionBridge";
import { deriveFileChangeStats } from "../../../lib/chat/fileChangeStats";
import { FILE_TOOL_TEXT_FIELDS } from "../../../lib/chat/toolPreview";
import {
  previewText,
  summarizeToolCall,
  type ToolTraceItem,
  toolResultMessageToText,
} from "../../../lib/chat/uiMessages";
import { cn } from "../../../lib/shared/utils";
import { sanitizeTodoItems } from "../TodoListView";
import { ToolScrollablePre, ToolSection } from "../ToolSurfaces";
import {
  areStableValuesEqual,
  getBuiltinResultKind,
  getSubagentInlineSummary,
  getToolDisplayName,
  getToolDisplayTitle,
  getToolMeta,
  isBuiltinShareToolName,
  isSubagentCardToolCall,
} from "./assistantBubbleUtils";
import { LazyCollapse } from "./LazyCollapse";
import { AssistantStatus } from "./StatusText";
import { ToolArgsDisplay, ToolResultDisplay } from "./ToolResultDisplay";

function ToolCallItem({
  item,
  isRunning,
  readOnly = false,
  redactToolContent = false,
}: {
  item: ToolTraceItem;
  isRunning?: boolean;
  readOnly?: boolean;
  redactToolContent?: boolean;
}) {
  const { t } = useLocale();
  const result = item.toolResult;
  const builtinResultKind = getBuiltinResultKind(result);
  const isRedactedToolContent = redactToolContent && isBuiltinShareToolName(item.toolCall.name);
  const isTodo = !isRedactedToolContent && item.toolCall.name === "TodoWrite";
  const todoItems = isTodo
    ? sanitizeTodoItems(
        builtinResultKind === "todo_write"
          ? (result?.details as { todos?: unknown } | undefined)?.todos
          : item.toolCall.arguments?.todos,
      )
    : [];
  const hasIncompleteTodo = todoItems.some((todo) => todo.status !== "completed");
  const shouldKeepTodoOpen =
    isTodo && (Boolean(isRunning) || !result || Boolean(result.isError) || hasIncompleteTodo);
  const shouldCloseCompletedTodo =
    isTodo && Boolean(result && !result.isError) && todoItems.length > 0 && !hasIncompleteTodo;
  const isAskUser = !isRedactedToolContent && item.toolCall.name === ASK_USER_QUESTION_TOOL_NAME;
  const askDetails = isAskUser ? parseAskUserQuestionResultDetails(result?.details) : null;
  // 参数生成完毕（桌面端仅在 onToolCall 后才发 tool_call 事件）才渲染卡片；
  // 对历史/降级数据再以 isRunning/result 兜底，绝不展示半截问题。
  const askSettled = isAskUser && (Boolean(isRunning) || Boolean(result));
  const askQuestions =
    isAskUser && askSettled
      ? askDetails && askDetails.questions.length > 0
        ? askDetails.questions
        : sanitizeAskUserQuestionItems(item.toolCall.arguments?.questions)
      : [];
  // 提问卡运行期强制展开等待作答；应答落定后自动收起（同 Todo 完成收起）。
  const shouldKeepAskOpen = !readOnly && isAskUser && (Boolean(isRunning) || !result);
  const shouldCloseAnsweredAsk = isAskUser && Boolean(result);
  // 权威应答截止时间：桌面端在网关上报的工具参数上盖章，倒计时与桌面计时
  // 同源；重连/迟开页面也显示真实剩余时间。
  const askDeadlineAt =
    isAskUser && isRunning && !result
      ? (readAskUserQuestionDeadlineAt(item.toolCall.arguments) ?? undefined)
      : undefined;
  const submitAskAnswers = useCallback(
    (answers: AskUserQuestionAnswer[]) => submitAskUserQuestionAnswer(item.toolCall.id, answers),
    [item.toolCall.id],
  );
  const shouldAutoOpen =
    !isRedactedToolContent &&
    (item.toolCall.name === "Image" ||
      builtinResultKind === "display_image" ||
      shouldKeepTodoOpen ||
      shouldKeepAskOpen);
  const [open, setOpen] = useState(readOnly || isRedactedToolContent ? false : shouldAutoOpen);
  const isSubagentCard = isSubagentCardToolCall(item.toolCall);
  const hasArgs = Object.keys(item.toolCall.arguments || {}).length > 0;
  const isStreamingFilePreviewTool = FILE_TOOL_TEXT_FIELDS[item.toolCall.name] !== undefined;
  const shouldShowArgs =
    !isRedactedToolContent &&
    !isAskUser &&
    (!isSubagentCard || !result) &&
    (item.toolCall.name !== "TodoWrite" || !result) &&
    (isStreamingFilePreviewTool ? !result : hasArgs);
  const isBash = item.toolCall.name === "Bash";
  const isManagedProcess = item.toolCall.name === "ManagedProcess";
  const inlineCommand =
    !isRedactedToolContent &&
    (isBash || isManagedProcess) &&
    typeof item.toolCall.arguments?.command === "string"
      ? item.toolCall.arguments.command.trim()
      : "";
  const firstLine = inlineCommand ? inlineCommand.split("\n")[0] : "";
  const toolArgsSummary =
    isRedactedToolContent || isBash || inlineCommand
      ? ""
      : isAskUser
        ? (askQuestions[0]?.prompt ?? "")
        : isSubagentCard
          ? getSubagentInlineSummary(item)
          : summarizeToolCall(item.toolCall, {
              includeName: false,
              includeManagerAction: false,
            });
  const fileChangeStats = useMemo(
    () => (isRedactedToolContent ? undefined : deriveFileChangeStats(item.toolCall)),
    [isRedactedToolContent, item.toolCall],
  );
  const meta = getToolMeta(item.toolCall.name);
  const ToolIcon = meta.Icon;
  const title =
    item.toolCall.name === "TodoWrite"
      ? { name: t("chat.tool.todoTitle"), action: "" }
      : isAskUser
        ? { name: t("chat.tool.askUserTitle"), action: "" }
        : isRedactedToolContent
          ? { name: getToolDisplayName(item.toolCall.name), action: "" }
          : getToolDisplayTitle(item.toolCall);

  const statusLabel = isRunning
    ? isAskUser
      ? askQuestions.length > 0
        ? t("chat.askUser.waiting")
        : t("chat.askUser.preparing")
      : t("chat.tool.running")
    : result
      ? result.isError
        ? t("chat.tool.failed")
        : t("chat.tool.success")
      : t("chat.tool.waiting");

  const statusTextClass = result?.isError
    ? "text-[hsl(var(--chat-error))]"
    : "text-muted-foreground/60";

  useEffect(() => {
    if (readOnly || isRedactedToolContent) return;
    if (shouldKeepTodoOpen || shouldKeepAskOpen) {
      setOpen(true);
    } else if (shouldCloseCompletedTodo || shouldCloseAnsweredAsk) {
      setOpen(false);
    } else if (shouldAutoOpen) {
      setOpen(true);
    }
  }, [
    isRedactedToolContent,
    readOnly,
    shouldAutoOpen,
    shouldCloseAnsweredAsk,
    shouldCloseCompletedTodo,
    shouldKeepAskOpen,
    shouldKeepTodoOpen,
  ]);

  const canExpand =
    !isRedactedToolContent &&
    (shouldShowArgs || Boolean(result) || (isAskUser && askQuestions.length > 0));
  const effectiveOpen = canExpand && open;
  const summaryClassName = cn(
    "flex w-full select-none items-center gap-2 text-left",
    canExpand ? "cursor-pointer" : "cursor-default",
    "py-1.5",
  );
  const summaryContent = (
    <>
      <ToolIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 group-hover/tool:text-foreground/75" />

      {/* Tool name + inline summary on same line. Name and summary must stay in
          one inline context (shared baseline): centering them as separate flex
          boxes drifts up to ~1.5px per device with the resolved font metrics. */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {/* Container carries the summary styling so the truncation ellipsis
            (styled per the block container) matches the summary text */}
        <div
          className="min-w-0 truncate font-mono text-[calc(11px*var(--zone-font-scale,1))] leading-5 text-muted-foreground/55"
          title={!isBash && !inlineCommand && toolArgsSummary ? toolArgsSummary : undefined}
        >
          <span className="font-sans text-[calc(13px*var(--zone-font-scale,1))] font-normal text-muted-foreground/80 group-hover/tool:text-foreground">
            {title.name}
            {title.action ? (
              <span className="font-mono text-[calc(11px*var(--zone-font-scale,1))] font-normal text-muted-foreground/60">
                {" · "}
                {title.action}
              </span>
            ) : null}
          </span>

          {firstLine ? (
            <span className="ml-1.5">
              <span className="text-muted-foreground/30">$</span>{" "}
              {firstLine.length > 48 ? `${firstLine.slice(0, 48)}…` : firstLine}
            </span>
          ) : toolArgsSummary ? (
            <span className="ml-1.5">{toolArgsSummary}</span>
          ) : null}
        </div>

        {fileChangeStats ? (
          <FileChangeBadge added={fileChangeStats.added} removed={fileChangeStats.removed} />
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {isRunning ? (
          <AssistantStatus
            className="min-h-0 gap-1.5 text-[calc(11px*var(--zone-font-scale,1))] text-muted-foreground/60"
            iconClassName="h-3 w-3"
          >
            {statusLabel}
          </AssistantStatus>
        ) : (
          <span className={cn("text-[calc(11px*var(--zone-font-scale,1))]", statusTextClass)}>
            {statusLabel}
          </span>
        )}
        {canExpand ? (
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 text-muted-foreground/60 transition-transform duration-200 ease-out",
              effectiveOpen ? "rotate-90" : "",
            )}
          />
        ) : null}
      </div>
    </>
  );
  const body = (
    <LazyCollapse open={effectiveOpen}>
      {() => (
        <div className="space-y-3 pb-2 pl-[22px] pt-1">
          {shouldShowArgs ? (
            <ToolSection
              label={isBash || inlineCommand ? t("chat.tool.command") : t("chat.tool.args")}
            >
              <ToolArgsDisplay item={item} />
            </ToolSection>
          ) : null}

          {isAskUser && askQuestions.length > 0 ? (
            <AskUserQuestionCard
              questions={askQuestions}
              answers={askDetails?.answers}
              cancelled={askDetails?.cancelled === true}
              timedOut={askDetails?.timedOut === true}
              interactive={Boolean(isRunning) && !result && !readOnly}
              deadlineAt={askDeadlineAt}
              onSubmit={submitAskAnswers}
            />
          ) : null}

          {/* 提问卡自带应答态展示；仅参数校验失败（无 details）时回落默认错误区。 */}
          {result && (!isAskUser || !askDetails) ? (
            <ToolSection
              label={isTodo ? undefined : t("chat.tool.return")}
              trailing={
                result.isError ? (
                  <span className="text-[calc(11px*var(--zone-font-scale,1))] font-medium text-red-500">
                    {t("chat.tool.error")}
                  </span>
                ) : null
              }
            >
              <div className="space-y-1.5">
                <ToolResultDisplay item={item} result={result} readOnly={readOnly} />

                {(() => {
                  const resultText = toolResultMessageToText(result);
                  if (!/\S/.test(resultText)) return null;
                  if (builtinResultKind && builtinResultKind !== "read_image") return null;

                  if (isBash || readOnly) {
                    return (
                      <ToolScrollablePre
                        className={cn(
                          "max-h-56",
                          isBash
                            ? "bg-zinc-950/85 text-zinc-300/90 dark:bg-zinc-900/80"
                            : "bg-black/[0.02] dark:bg-white/[0.03]",
                        )}
                      >
                        {previewText(resultText, 6000)}
                      </ToolScrollablePre>
                    );
                  }

                  // Errors must be readable at a glance — never behind the
                  // collapsed "view return" toggle.
                  if (result.isError) {
                    return (
                      <ToolScrollablePre className="max-h-56 bg-red-500/[0.05] text-red-700/90 dark:bg-red-500/[0.08] dark:text-red-300/90">
                        {previewText(resultText, 6000)}
                      </ToolScrollablePre>
                    );
                  }

                  return (
                    <details className="group/result">
                      <summary className="flex cursor-pointer select-none items-center gap-1 text-[calc(10.5px*var(--zone-font-scale,1))] text-muted-foreground/50 transition-colors duration-150 hover:text-foreground/60">
                        <ChevronRight className="h-2.5 w-2.5 transition-transform duration-200 group-open/result:rotate-90" />
                        {t("chat.tool.viewReturn")}
                      </summary>
                      <ToolScrollablePre className="mt-1.5 max-h-56 bg-black/[0.02] dark:bg-white/[0.03]">
                        {previewText(resultText, 6000)}
                      </ToolScrollablePre>
                    </details>
                  );
                })()}
              </div>
            </ToolSection>
          ) : null}
        </div>
      )}
    </LazyCollapse>
  );
  const containerClassName = "group/tool min-w-0 max-w-full";

  if (!canExpand) {
    return (
      <div className={containerClassName}>
        <div className={summaryClassName}>{summaryContent}</div>
      </div>
    );
  }

  return (
    <div className={containerClassName}>
      <button
        type="button"
        aria-expanded={effectiveOpen}
        className={summaryClassName}
        onClick={() => setOpen((prev) => !prev)}
      >
        {summaryContent}
      </button>
      {body}
    </div>
  );
}

function areToolResultsEqual(
  previous: ToolResultMessage | undefined,
  next: ToolResultMessage | undefined,
) {
  if (previous === next) {
    return true;
  }
  if (!previous || !next) {
    return previous === next;
  }

  return (
    previous.toolCallId === next.toolCallId &&
    previous.toolName === next.toolName &&
    previous.isError === next.isError &&
    areStableValuesEqual(previous.content, next.content) &&
    areStableValuesEqual(previous.details, next.details)
  );
}

export function areToolTraceItemsEqual(previous: ToolTraceItem, next: ToolTraceItem) {
  if (previous === next) {
    return true;
  }
  return (
    previous.toolCall.id === next.toolCall.id &&
    previous.toolCall.name === next.toolCall.name &&
    areStableValuesEqual(previous.toolCall.arguments, next.toolCall.arguments) &&
    areToolResultsEqual(previous.toolResult, next.toolResult)
  );
}

export const MemoToolCallItem = memo(
  ToolCallItem,
  (previousProps, nextProps) =>
    previousProps.isRunning === nextProps.isRunning &&
    previousProps.readOnly === nextProps.readOnly &&
    previousProps.redactToolContent === nextProps.redactToolContent &&
    areToolTraceItemsEqual(previousProps.item, nextProps.item),
);
