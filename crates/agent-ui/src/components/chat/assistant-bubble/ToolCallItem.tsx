import {
  readAskUserQuestionDeadline,
  readPlanDecisionDeadline,
  retainRunningToolContent,
  submitAskUserQuestionAnswers,
  submitPlanDecision,
  usePendingToolApproval,
} from "@liveagent/adapters/assistantBubble";
import { AskUserQuestionCard } from "@liveagent/ui/components/chat/AskUserQuestionCard";
import { AssistantStatus } from "@liveagent/ui/components/chat/AssistantStatus";
import { FileChangeBadge } from "@liveagent/ui/components/chat/FileChangeBadge";
import { LazyCollapse } from "@liveagent/ui/components/chat/LazyCollapse";
import { PlanModeCard } from "@liveagent/ui/components/chat/PlanModeCard";
import { ToolScrollablePre, ToolSection } from "@liveagent/ui/components/chat/ToolSurfaces";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  type AskUserQuestionAnswer,
  parseAskUserQuestionResultDetails,
  sanitizeAskUserQuestionItems,
} from "@liveagent/ui/lib/chat/askUserQuestion";
import {
  deriveFileChangeStats,
  FILE_TOOL_TEXT_FIELDS,
  previewText,
  summarizeToolCall,
  type ToolResultMessage,
  type ToolTraceItem,
  toolResultMessageToText,
} from "@liveagent/ui/lib/chat/assistantBubbleAdapter";
import {
  EXIT_PLAN_MODE_TOOL_NAME,
  type PlanDecisionAnswer,
  parseExitPlanModeResultDetails,
  sanitizePlanMarkdown,
} from "@liveagent/ui/lib/chat/planMode";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight } from "../../IconSet";
import {
  areStableValuesEqual,
  getBuiltinResultKind,
  getShellSessionDisplayDetails,
  getSubagentInlineSummary,
  getToolDisplayName,
  getToolDisplayTitle,
  getToolMeta,
  isBuiltinShareToolName,
  isSubagentCardToolCall,
} from "./assistantBubbleUtils";
import { ToolArgsDisplay, ToolResultDisplay } from "./ToolResultDisplay";

// 折叠摘要里行内命令的展示上限:远超任何实际窗口一行可容纳的字符数,视觉
// 省略仍由 CSS truncate 决定;仅防御超长单行命令(如内联脚本)把常驻 DOM
// 与原生 title 撑爆。完整命令在展开区可查看。
const INLINE_COMMAND_PREVIEW_MAX_CHARS = 600;

function capInlineCommandPreview(text: string) {
  return text.length > INLINE_COMMAND_PREVIEW_MAX_CHARS
    ? `${text.slice(0, INLINE_COMMAND_PREVIEW_MAX_CHARS)}…`
    : text;
}

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
  const isBash = item.toolCall.name === "Bash";
  const isShellSessionControl =
    item.toolCall.name === "ProcessWait" || item.toolCall.name === "ProcessStop";
  const isShellSessionTool = isBash || isShellSessionControl;
  const shellSessionDetails = isShellSessionTool ? getShellSessionDisplayDetails(result) : null;
  const shellSessionStatus = shellSessionDetails?.status;
  const shellSessionFailed = shellSessionStatus === "failed" || shellSessionStatus === "timed_out";
  const displayIsRunning = Boolean(isRunning);
  const isRedactedToolContent = redactToolContent && isBuiltinShareToolName(item.toolCall.name);
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
  // 提问卡运行期强制展开等待作答；应答落定后自动收起。
  const shouldKeepAskOpen = !readOnly && isAskUser && (Boolean(isRunning) || !result);
  const shouldCloseAnsweredAsk = isAskUser && Boolean(result);
  // 截止时间和提交动作由宿主适配器提供，确保两端都使用各自的权威服务。
  const askDeadlineAt =
    isAskUser && isRunning && !result
      ? readAskUserQuestionDeadline(item.toolCall.id, item.toolCall.arguments)
      : undefined;
  const submitAskAnswers = useCallback(
    (answers: AskUserQuestionAnswer[]) => submitAskUserQuestionAnswers(item.toolCall.id, answers),
    [item.toolCall.id],
  );
  // ExitPlanMode 计划卡：分派方式同 AskUserQuestion(按工具名),details 优先、
  // 流式参数兜底;执行中(无 result)即渲染,批准/拒绝动作由宿主适配器提供。
  const isPlanCard = !isRedactedToolContent && item.toolCall.name === EXIT_PLAN_MODE_TOOL_NAME;
  const planDetails = isPlanCard ? parseExitPlanModeResultDetails(result?.details) : null;
  const planMarkdown = isPlanCard
    ? (planDetails?.plan ?? sanitizePlanMarkdown(item.toolCall.arguments?.plan))
    : "";
  const planSettled = isPlanCard && (Boolean(isRunning) || Boolean(result));
  const planDeadlineAt =
    isPlanCard && isRunning && !result
      ? readPlanDecisionDeadline(item.toolCall.id, item.toolCall.arguments)
      : undefined;
  const submitPlanAnswer = useCallback(
    (answer: PlanDecisionAnswer) => submitPlanDecision(item.toolCall.id, answer),
    [item.toolCall.id],
  );
  // 工具审批由宿主适配器读取。审批发生在工具执行前，不能用 isRunning 作门。
  const pendingApproval = usePendingToolApproval(item.toolCall.id, item.toolCall.arguments);
  const isApprovalPending = !readOnly && !isRedactedToolContent && !result && pendingApproval;
  const shouldAutoOpen =
    !isRedactedToolContent &&
    (item.toolCall.name === "Image" || builtinResultKind === "display_image" || shouldKeepAskOpen);
  const [open, setOpen] = useState(readOnly || isRedactedToolContent ? false : shouldAutoOpen);
  const isSubagentCard = isSubagentCardToolCall(item.toolCall);
  const hasArgs = Object.keys(item.toolCall.arguments || {}).length > 0;
  const isStreamingFilePreviewTool = FILE_TOOL_TEXT_FIELDS[item.toolCall.name] !== undefined;
  const shouldShowArgs =
    !isRedactedToolContent &&
    !isAskUser &&
    !isPlanCard &&
    (!isSubagentCard || !result) &&
    (isStreamingFilePreviewTool ? !result : hasArgs);
  const isManagedProcess = item.toolCall.name === "ManagedProcess";
  const inlineCommand =
    !isRedactedToolContent &&
    (isBash || isManagedProcess) &&
    typeof item.toolCall.arguments?.command === "string"
      ? item.toolCall.arguments.command.trim()
      : "";
  const firstLine = inlineCommand ? inlineCommand.split("\n")[0] : "";
  // 折叠行的行内命令:视觉截断交给 CSS(truncate 按实际可用宽度出省略号),
  // 不再按固定字符数硬切(#444)。DOM 文本与原生 title 各留一个远超可视宽度
  // 的上限,防止超长单行命令把常驻摘要行与悬浮提示撑到不可用。
  const firstLinePreview = capInlineCommandPreview(firstLine);
  const inlineCommandTitle = inlineCommand ? capInlineCommandPreview(inlineCommand) : "";
  const toolArgsSummary =
    isRedactedToolContent || isBash || inlineCommand || isPlanCard
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
  const title = isAskUser
    ? { name: t("chat.tool.askUserTitle"), action: "" }
    : isPlanCard
      ? { name: t("chat.planMode.cardTitle"), action: "" }
      : isRedactedToolContent
        ? { name: getToolDisplayName(item.toolCall.name), action: "" }
        : getToolDisplayTitle(item.toolCall);

  const statusLabel = isApprovalPending
    ? t("chat.toolApproval.waitingStatus")
    : isRunning
      ? isAskUser
        ? askQuestions.length > 0
          ? t("chat.askUser.waiting")
          : t("chat.askUser.preparing")
        : isPlanCard
          ? planMarkdown
            ? t("chat.planMode.waiting")
            : t("chat.planMode.preparing")
          : t("chat.tool.running")
      : shellSessionStatus === "running"
        ? t("chat.tool.running")
        : shellSessionStatus === "cancelled"
          ? t("chat.tool.stopped")
          : shellSessionStatus === "completed"
            ? t("chat.tool.success")
            : shellSessionFailed
              ? t("chat.tool.failed")
              : result
                ? result.isError
                  ? t("chat.tool.failed")
                  : t("chat.tool.success")
                : t("chat.tool.waiting");

  const statusTextClass =
    result?.isError || shellSessionFailed
      ? "text-[hsl(var(--chat-error))]"
      : "text-muted-foreground/60";

  useEffect(() => {
    if (readOnly || isRedactedToolContent) return;
    if (shouldKeepAskOpen) {
      setOpen(true);
    } else if (shouldCloseAnsweredAsk) {
      setOpen(false);
    } else if (shouldAutoOpen) {
      setOpen(true);
    }
  }, [isRedactedToolContent, readOnly, shouldAutoOpen, shouldCloseAnsweredAsk, shouldKeepAskOpen]);

  const canExpand =
    !isRedactedToolContent &&
    !isPlanCard &&
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
          title={inlineCommandTitle || toolArgsSummary || undefined}
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

          {firstLinePreview ? (
            <span className="ml-1.5">
              <span className="text-muted-foreground/30">$</span> {firstLinePreview}
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
        {displayIsRunning ? (
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
    <LazyCollapse
      open={effectiveOpen}
      retainWhileClosed={retainRunningToolContent && displayIsRunning}
    >
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

          {/* 提问卡/计划卡自带应答态展示；仅参数校验失败（无 details）时回落默认错误区。 */}
          {result && (!isAskUser || !askDetails) && (!isPlanCard || !planDetails) ? (
            <ToolSection
              label={t("chat.tool.return")}
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

                  if (isShellSessionTool || readOnly) {
                    return (
                      <ToolScrollablePre
                        className={cn(
                          "max-h-56",
                          isShellSessionTool
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

  // 计划卡直出(任务卡风格):不进折叠壳、无摘要行,整卡直接展示——
  // 卡片自带「实施计划」头部与状态,正文不限高(与消息正文同滚动上下文)。
  if (isPlanCard && planSettled && planMarkdown) {
    return (
      <div className={containerClassName}>
        <div className="py-1.5">
          <PlanModeCard
            plan={planMarkdown}
            decision={planDetails?.decision}
            feedback={planDetails?.feedback}
            cancelled={planDetails?.cancelled === true}
            timedOut={planDetails?.timedOut === true}
            interactive={Boolean(isRunning) && !result && !readOnly}
            deadlineAt={planDeadlineAt}
            readOnly={readOnly}
            onSubmit={submitPlanAnswer}
          />
        </div>
      </div>
    );
  }

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
