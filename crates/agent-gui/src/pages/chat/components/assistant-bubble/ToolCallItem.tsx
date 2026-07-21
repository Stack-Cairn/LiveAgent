import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import { AskUserQuestionCard } from "../../../../components/chat/AskUserQuestionCard";
import { FileChangeBadge } from "../../../../components/chat/FileChangeBadge";
import { ChevronRight, Search } from "../../../../components/icons";
import { useLocale } from "../../../../i18n";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  type AskUserQuestionAnswer,
  parseAskUserQuestionResultDetails,
  sanitizeAskUserQuestionItems,
} from "../../../../lib/chat/askUserQuestion";
import { deriveFileChangeStats } from "../../../../lib/chat/messages/fileChangeStats";
import {
  deriveFileToolPreview,
  FILE_TOOL_TEXT_FIELDS,
} from "../../../../lib/chat/messages/toolPreview";
import {
  previewText,
  safeStringify,
  summarizeToolCall,
  type ToolTraceItem,
  toolCallArgsForDisplay,
  toolResultMessageToText,
} from "../../../../lib/chat/messages/uiMessages";
import { cn } from "../../../../lib/shared/utils";
import { isSubagentCardToolCall } from "../../../../lib/subagents/card";
import {
  answerAskUserQuestion,
  getAskUserQuestionDeadlineAt,
} from "../../../../lib/tools/askUserQuestionTools";
import {
  areStableValuesEqual,
  displayString,
  getBuiltinResultKind,
  getSubagentInlineSummary,
  getToolDisplayTitle,
  getToolMeta,
  type MetaTag,
} from "./assistantBubbleUtils";
import { FileToolArgsDisplay } from "./FileToolArgs";
import { LazyCollapse } from "./LazyCollapse";
import { AssistantStatus } from "./StatusText";
import { sanitizeTodoItems, TodoListView } from "./TodoListView";
import {
  MetaTags,
  PathDisplay,
  ToolFactGrid,
  ToolResultDisplay,
  ToolScrollablePre,
  ToolSection,
  ToolSurface,
  ToolSurfaceLabel,
} from "./ToolResultDisplay";

function getToolDisplay(toolCall: { name: string; arguments?: Record<string, unknown> }) {
  const args = toolCall.arguments || {};
  const name = toolCall.name;
  const path = typeof args.path === "string" ? (args.path as string) : null;
  const pattern = typeof args.pattern === "string" ? (args.pattern as string) : null;
  const tags: MetaTag[] = [];

  switch (name) {
    case "Read":
      if (typeof args.start_line === "number")
        tags.push({ label: "start", value: String(args.start_line) });
      if (typeof args.limit === "number") tags.push({ label: "limit", value: String(args.limit) });
      if (typeof args.page_start === "number")
        tags.push({ label: "page", value: String(args.page_start) });
      if (typeof args.page_limit === "number")
        tags.push({ label: "pages", value: String(args.page_limit) });
      if (typeof args.cell_start === "number")
        tags.push({ label: "cell", value: String(args.cell_start) });
      if (typeof args.cell_limit === "number")
        tags.push({ label: "cells", value: String(args.cell_limit) });
      return { type: "file" as const, path, tags };
    case "SkillsManager":
      if (typeof args.offset === "number")
        tags.push({ label: "start", value: String(args.offset + 1) });
      if (typeof args.length === "number")
        tags.push({ label: "limit", value: String(args.length) });
      return { type: "file" as const, path, tags };
    case "MemoryManager":
      if (typeof args.action === "string")
        tags.push({ label: "action", value: args.action as string });
      if (typeof args.slug === "string") tags.push({ label: "slug", value: args.slug as string });
      if (typeof args.scope === "string")
        tags.push({ label: "scope", value: args.scope as string });
      if (typeof args.type === "string") tags.push({ label: "type", value: args.type as string });
      return { type: "generic" as const, path: null, pattern: null, tags };
    case "McpManager":
      if (typeof args.action === "string")
        tags.push({ label: "action", value: args.action as string });
      if (typeof args.server_id === "string")
        tags.push({ label: "server", value: args.server_id as string });
      if (Array.isArray(args.server_ids))
        tags.push({ label: "servers", value: String(args.server_ids.length) });
      if (typeof args.conflict === "string")
        tags.push({ label: "conflict", value: args.conflict as string });
      if (args.include_schema === true) tags.push({ label: "schema", value: "true" });
      return { type: "generic" as const, path: null, pattern: null, tags };
    case "SendMessage":
      if (typeof args.to === "string") tags.push({ label: "to", value: args.to as string });
      if (typeof args.channel === "string")
        tags.push({ label: "channel", value: args.channel as string });
      if (typeof args.subject === "string")
        tags.push({ label: "subject", value: args.subject as string });
      if (typeof args.summary === "string" && typeof args.subject !== "string")
        tags.push({ label: "subject", value: args.summary as string });
      if (typeof args.message === "string")
        tags.push({ label: "message", value: `${(args.message as string).length} chars` });
      return { type: "generic" as const, path: null, pattern: null, tags };
    case "Delete":
      return { type: "file" as const, path, tags };
    case "List":
      if (typeof args.depth === "number") tags.push({ label: "depth", value: String(args.depth) });
      if (typeof args.offset === "number")
        tags.push({ label: "offset", value: String(args.offset) });
      if (typeof args.max_results === "number")
        tags.push({ label: "max", value: String(args.max_results) });
      return { type: "file" as const, path: path || "/", tags };
    case "Glob":
      if (typeof args.offset === "number")
        tags.push({ label: "offset", value: String(args.offset) });
      if (typeof args.max_results === "number")
        tags.push({ label: "max", value: String(args.max_results) });
      return { type: "search" as const, path, pattern, tags };
    case "Grep":
      if (typeof args.file_pattern === "string")
        tags.push({ label: "filter", value: args.file_pattern as string });
      if (typeof args.output_mode === "string")
        tags.push({ label: "mode", value: args.output_mode as string });
      if (typeof args.ignore_case === "boolean" && args.ignore_case)
        tags.push({ label: "flag", value: "-i" });
      if (typeof args.context === "number" && args.context > 0)
        tags.push({ label: "ctx", value: String(args.context) });
      if (typeof args.head_limit === "number")
        tags.push({ label: "head", value: String(args.head_limit) });
      if (args.multiline === true) tags.push({ label: "multi", value: "true" });
      return { type: "search" as const, path, pattern, tags };
    case "Bash":
      return { type: "bash" as const, path: null, pattern: null, tags };
    case "ManagedProcess": {
      if (typeof args.action === "string") tags.push({ label: "action", value: args.action });
      if (typeof args.process_id === "string")
        tags.push({ label: "process", value: args.process_id as string });
      if (typeof args.label === "string")
        tags.push({ label: "label", value: args.label as string });
      if (typeof args.cwd === "string") tags.push({ label: "cwd", value: args.cwd as string });
      if (args.isolated === true) tags.push({ label: "isolated", value: "true" });
      if (typeof args.max_bytes === "number")
        tags.push({ label: "max_bytes", value: String(args.max_bytes) });
      const command = typeof args.command === "string" ? (args.command as string).trim() : "";
      return command
        ? { type: "bash" as const, path: null, pattern: null, tags }
        : { type: "generic" as const, path: null, pattern: null, tags };
    }
    default: {
      // Generic: collect all string/number/boolean args
      const entries: MetaTag[] = [];
      for (const [k, v] of Object.entries(args)) {
        if (typeof v === "string")
          entries.push({ label: k, value: v.length > 60 ? `${v.slice(0, 60)}…` : v });
        else if (typeof v === "number" || typeof v === "boolean")
          entries.push({ label: k, value: String(v) });
      }
      return { type: "generic" as const, path: null, pattern: null, tags: entries };
    }
  }
}

/** Expanded args display — tool-aware layout */
function ToolArgsDisplay({ item }: { item: ToolTraceItem }) {
  const toolCall = item.toolCall;

  const filePreview = deriveFileToolPreview(toolCall);
  if (filePreview) {
    return <FileToolArgsDisplay preview={filePreview} />;
  }

  // TodoWrite args ARE the checklist — render them with the same view as the
  // result instead of dumping raw JSON (shown only until the result lands).
  if (toolCall.name === "TodoWrite") {
    return <TodoListView todos={sanitizeTodoItems(toolCall.arguments?.todos)} />;
  }

  const display = getToolDisplay(toolCall);

  if (isSubagentCardToolCall(toolCall)) {
    const args = toolCall.arguments || {};
    const name = displayString(args.name) || displayString(args.id);
    const role = displayString(args.role);
    const task = displayString(args.prompt);

    return (
      <div className="tool-expand flex flex-col gap-2">
        {name ? (
          <ToolSurface>
            <ToolSurfaceLabel label="agent" />
            <div className="break-words text-[calc(11.5px*var(--zone-font-scale,1))] font-semibold leading-[1.55] text-foreground/86">
              {name}
            </div>
          </ToolSurface>
        ) : null}
        {role ? (
          <ToolSurface>
            <ToolSurfaceLabel label="role" />
            <div className="break-words text-[calc(11.5px*var(--zone-font-scale,1))] leading-[1.55] text-foreground/78">
              {role}
            </div>
          </ToolSurface>
        ) : null}
        {task ? (
          <ToolSurface>
            <ToolSurfaceLabel label="task" />
            <div className="break-words text-[calc(11.5px*var(--zone-font-scale,1))] leading-[1.6] text-foreground/82">
              {task}
            </div>
          </ToolSurface>
        ) : null}
      </div>
    );
  }

  // Bash / ManagedProcess(start): terminal block
  if (display.type === "bash") {
    const cmd =
      typeof toolCall.arguments?.command === "string"
        ? (toolCall.arguments.command as string).trim()
        : "";
    if (!cmd) return null;
    return (
      <div className="tool-expand flex flex-col gap-2">
        <ToolScrollablePre className="max-h-44 bg-zinc-950/90 text-emerald-300/90 dark:bg-zinc-950/90">
          <span className="mr-1 select-none text-emerald-500/30">$</span>
          {cmd}
        </ToolScrollablePre>
        {display.tags.length > 0 ? <MetaTags tags={display.tags} /> : null}
      </div>
    );
  }

  // File tools: target path + compact request facts
  if (display.type === "file" && (display.path || display.tags.length > 0)) {
    return (
      <div className="tool-expand flex flex-col gap-2">
        {display.path ? (
          <ToolSurface>
            <ToolSurfaceLabel label="path" />
            <PathDisplay
              path={display.path}
              className="block min-w-0 break-all font-mono text-[calc(11.5px*var(--zone-font-scale,1))] leading-[1.6]"
            />
          </ToolSurface>
        ) : null}
        {display.tags.length > 0 ? <MetaTags tags={display.tags} /> : null}
      </div>
    );
  }

  // Search tools: query, scope, and request facts
  if (display.type === "search" && (display.pattern || display.path || display.tags.length > 0)) {
    return (
      <div className="tool-expand flex flex-col gap-2">
        {display.pattern ? (
          <ToolSurface>
            <ToolSurfaceLabel label="query" />
            <div className="flex items-start gap-2">
              <Search className="mt-[2px] h-3.5 w-3.5 shrink-0 text-muted-foreground/35" />
              <span className="min-w-0 break-all font-mono text-[calc(11.5px*var(--zone-font-scale,1))] leading-[1.6] text-foreground/82">
                {display.pattern}
              </span>
            </div>
          </ToolSurface>
        ) : null}
        {display.path ? (
          <ToolSurface>
            <ToolSurfaceLabel label="scope" />
            <PathDisplay
              path={display.path}
              className="block min-w-0 break-all font-mono text-[calc(11.5px*var(--zone-font-scale,1))] leading-[1.6]"
            />
          </ToolSurface>
        ) : null}
        {display.tags.length > 0 ? <MetaTags tags={display.tags} /> : null}
      </div>
    );
  }

  // Generic: key-value grid
  if (display.type === "generic" && display.tags.length > 0) {
    return <ToolFactGrid tags={display.tags} />;
  }

  // Fallback: raw JSON, cached by argument identity — settled tool args are
  // immutable, so virtualizer remounts reuse the stringified form.
  return (
    <ToolSurface className="overflow-hidden px-0 py-0">
      <ToolScrollablePre className="max-h-44 rounded-none">
        {getRawArgsDisplayText(toolCall)}
      </ToolScrollablePre>
    </ToolSurface>
  );
}

const rawArgsDisplayCache = new WeakMap<object, string>();

function getRawArgsDisplayText(toolCall: ToolTraceItem["toolCall"]) {
  const cacheKey = toolCall.arguments;
  if (!cacheKey || typeof cacheKey !== "object") {
    return safeStringify(toolCallArgsForDisplay(toolCall));
  }
  const cached = rawArgsDisplayCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const text = safeStringify(toolCallArgsForDisplay(toolCall));
  rawArgsDisplayCache.set(cacheKey, text);
  return text;
}

function ToolCallItem({ item, isRunning }: { item: ToolTraceItem; isRunning?: boolean }) {
  const { t } = useLocale();
  const result = item.toolResult;
  const builtinResultKind = getBuiltinResultKind(result);
  const isTodo = item.toolCall.name === "TodoWrite";
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
  const isAskUser = item.toolCall.name === ASK_USER_QUESTION_TOOL_NAME;
  const askDetails = isAskUser ? parseAskUserQuestionResultDetails(result?.details) : null;
  // 参数生成完毕（onToolCall 之后才会入回合）才渲染卡片；对历史/降级数据
  // 再以 isRunning/result 兜底，绝不展示半截问题。
  const askSettled = isAskUser && (Boolean(isRunning) || Boolean(result));
  const askQuestions =
    isAskUser && askSettled
      ? askDetails && askDetails.questions.length > 0
        ? askDetails.questions
        : sanitizeAskUserQuestionItems(item.toolCall.arguments?.questions)
      : [];
  // 提问卡运行期强制展开等待作答；应答落定后自动收起（同 Todo 完成收起）。
  const shouldKeepAskOpen = isAskUser && (Boolean(isRunning) || !result);
  const shouldCloseAnsweredAsk = isAskUser && Boolean(result);
  // 权威应答截止时间来自工具挂起表；卡片倒计时与超时兜底同源，
  // 会话切换重挂载也不会重置。
  const askDeadlineAt =
    isAskUser && isRunning && !result
      ? (getAskUserQuestionDeadlineAt(item.toolCall.id) ?? undefined)
      : undefined;
  const submitAskAnswers = useCallback(
    (answers: AskUserQuestionAnswer[]) =>
      Promise.resolve(answerAskUserQuestion(item.toolCall.id, answers)),
    [item.toolCall.id],
  );
  const shouldAutoOpen =
    item.toolCall.name === "Image" ||
    builtinResultKind === "display_image" ||
    shouldKeepTodoOpen ||
    shouldKeepAskOpen;
  const [open, setOpen] = useState(shouldAutoOpen);
  const isSubagentCard = isSubagentCardToolCall(item.toolCall);
  const hasArgs = Object.keys(item.toolCall.arguments || {}).length > 0;
  const isStreamingFilePreviewTool = FILE_TOOL_TEXT_FIELDS[item.toolCall.name] !== undefined;
  const shouldShowArgs =
    !isAskUser &&
    (!isSubagentCard || !result) &&
    (item.toolCall.name !== "TodoWrite" || !result) &&
    (isStreamingFilePreviewTool ? !result : hasArgs);
  const isBash = item.toolCall.name === "Bash";
  const isManagedProcess = item.toolCall.name === "ManagedProcess";
  const inlineCommand =
    (isBash || isManagedProcess) && typeof item.toolCall.arguments?.command === "string"
      ? item.toolCall.arguments.command.trim()
      : "";
  const firstLine = inlineCommand ? inlineCommand.split("\n")[0] : "";
  const toolArgsSummary =
    isBash || inlineCommand
      ? ""
      : isAskUser
        ? (askQuestions[0]?.prompt ?? "")
        : isSubagentCard
          ? getSubagentInlineSummary(item)
          : summarizeToolCall(item.toolCall, {
              includeName: false,
              includeManagerAction: false,
            });
  const fileChangeStats = useMemo(() => deriveFileChangeStats(item.toolCall), [item.toolCall]);
  const meta = getToolMeta(item.toolCall.name);
  const ToolIcon = meta.Icon;
  const title =
    item.toolCall.name === "TodoWrite"
      ? { name: t("chat.tool.todoTitle"), action: "" }
      : isAskUser
        ? { name: t("chat.tool.askUserTitle"), action: "" }
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
    if (shouldKeepTodoOpen || shouldKeepAskOpen) {
      setOpen(true);
    } else if (shouldCloseCompletedTodo || shouldCloseAnsweredAsk) {
      setOpen(false);
    } else if (shouldAutoOpen) {
      setOpen(true);
    }
  }, [
    shouldAutoOpen,
    shouldCloseAnsweredAsk,
    shouldCloseCompletedTodo,
    shouldKeepAskOpen,
    shouldKeepTodoOpen,
  ]);

  const canExpand = shouldShowArgs || Boolean(result) || (isAskUser && askQuestions.length > 0);

  return (
    <div className="group/tool min-w-0 max-w-full">
      <button
        type="button"
        aria-expanded={canExpand ? open : undefined}
        className={cn(
          "flex w-full select-none items-center gap-2 text-left",
          canExpand ? "cursor-pointer" : "cursor-default",
          "py-1.5",
        )}
        onClick={() => {
          if (canExpand) setOpen((prev) => !prev);
        }}
      >
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

            {/* Inline summary — ellipsized by the shared container */}
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
                open ? "rotate-90" : "",
              )}
            />
          ) : null}
        </div>
      </button>

      <LazyCollapse open={open && canExpand}>
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
                interactive={Boolean(isRunning) && !result}
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
                  <ToolResultDisplay item={item} result={result} />

                  {(() => {
                    const resultText = toolResultMessageToText(result);
                    if (!/\S/.test(resultText)) return null;
                    if (builtinResultKind && builtinResultKind !== "read_image") return null;

                    if (isBash) {
                      return (
                        <ToolScrollablePre className="max-h-56 bg-zinc-950/85 text-zinc-300/90 dark:bg-zinc-900/80">
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
                        <ToolScrollablePre
                          className={cn(
                            "mt-1.5 max-h-56",
                            isBash
                              ? "bg-zinc-950/85 text-zinc-300/90 dark:bg-zinc-900/80"
                              : "bg-black/[0.02] dark:bg-white/[0.03]",
                          )}
                        >
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
    </div>
  );
}

function areToolResultsEqual(
  previous: ToolResultMessage | undefined,
  next: ToolResultMessage | undefined,
) {
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
    areToolTraceItemsEqual(previousProps.item, nextProps.item),
);
