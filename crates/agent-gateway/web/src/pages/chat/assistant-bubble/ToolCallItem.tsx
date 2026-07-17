import { memo, useEffect, useMemo, useState } from "react";
import { FileChangeBadge } from "../../../components/chat/FileChangeBadge";
import { ChevronRight } from "../../../components/icons";
import { useLocale } from "../../../i18n";
import type { ToolResultMessage } from "../../../lib/agentTypes";
import { deriveFileChangeStats } from "../../../lib/chat/fileChangeStats";
import { FILE_TOOL_TEXT_FIELDS } from "../../../lib/chat/toolPreview";
import {
  previewText,
  summarizeToolCall,
  type ToolTraceItem,
  toolResultMessageToText,
} from "../../../lib/chat/uiMessages";
import { cn } from "../../../lib/shared/utils";
import { BUILTIN_TOOL_CATALOG } from "../../../lib/tools/builtinToolCatalog";
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
import { ToolArgsDisplay, ToolResultDisplay } from "./ToolResultDisplay";

const DESKTOP_ONLY_TOOL_NAMES = new Set(
  BUILTIN_TOOL_CATALOG.filter((tool) => tool.desktopOnly).map((tool) => tool.toolName),
);

function ToolCallItem({
  item,
  isRunning,
  variant = "standalone",
  readOnly = false,
  redactToolContent = false,
}: {
  item: ToolTraceItem;
  isRunning?: boolean;
  variant?: "standalone" | "grouped";
  readOnly?: boolean;
  redactToolContent?: boolean;
}) {
  const { t } = useLocale();
  const result = item.toolResult;
  const isDesktopOnlyTool = DESKTOP_ONLY_TOOL_NAMES.has(item.toolCall.name);
  const builtinResultKind = getBuiltinResultKind(result);
  const isRedactedToolContent = redactToolContent && isBuiltinShareToolName(item.toolCall.name);
  const shouldAutoOpen =
    !isRedactedToolContent &&
    (item.toolCall.name === "Image" ||
      item.toolCall.name === "TodoWrite" ||
      builtinResultKind === "display_image");
  const [open, setOpen] = useState(readOnly || isRedactedToolContent ? false : shouldAutoOpen);
  const isSubagentCard = isSubagentCardToolCall(item.toolCall);
  const hasArgs = Object.keys(item.toolCall.arguments || {}).length > 0;
  const isStreamingFilePreviewTool = FILE_TOOL_TEXT_FIELDS[item.toolCall.name] !== undefined;
  const shouldShowArgs =
    !isDesktopOnlyTool &&
    !isRedactedToolContent &&
    (!isSubagentCard || !result) &&
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
  const title = isRedactedToolContent
    ? { name: getToolDisplayName(item.toolCall.name), action: "" }
    : getToolDisplayTitle(item.toolCall);

  const dotClass = isRunning
    ? "bg-[hsl(var(--chat-running))] animate-pulse"
    : result
      ? result.isError
        ? "bg-[hsl(var(--chat-error))]"
        : "bg-[hsl(var(--chat-success))]"
      : "bg-zinc-400";

  const statusLabel = isRunning
    ? t("chat.tool.running")
    : result
      ? result.isError
        ? t("chat.tool.failed")
        : t("chat.tool.success")
      : t("chat.tool.waiting");

  const statusBgClass = isRunning
    ? "bg-[hsl(var(--chat-running)/0.1)] text-[hsl(var(--chat-running))]"
    : result
      ? result.isError
        ? "bg-[hsl(var(--chat-error)/0.1)] text-[hsl(var(--chat-error))]"
        : "bg-[hsl(var(--chat-success)/0.1)] text-[hsl(var(--chat-success))]"
      : "bg-black/[0.05] text-muted-foreground dark:bg-white/[0.08]";

  useEffect(() => {
    if (!readOnly && !isRedactedToolContent && shouldAutoOpen) {
      setOpen(true);
    }
  }, [isRedactedToolContent, readOnly, shouldAutoOpen]);

  const canExpand = !isRedactedToolContent && !isDesktopOnlyTool;
  const effectiveOpen = isDesktopOnlyTool || (canExpand && open);
  const summaryClassName = cn(
    "flex select-none items-center gap-2",
    canExpand
      ? "cursor-pointer hover:bg-black/[0.015] dark:hover:bg-white/[0.025]"
      : "cursor-default",
    variant === "grouped" ? "px-2 py-[6px]" : "px-2.5 py-[7px]",
  );
  const summaryContent = (
    <>
      <div
        className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px]"
        style={{
          background: `linear-gradient(135deg, hsl(${meta.accent} / 0.13), hsl(${meta.accent} / 0.06))`,
        }}
      >
        <ToolIcon className="h-3 w-3" style={{ color: `hsl(${meta.accent})` }} />
      </div>

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
          <span className="font-sans text-[calc(12.5px*var(--zone-font-scale,1))] font-semibold tracking-[-0.01em] text-foreground/90">
            {title.name}
            {title.action ? (
              <span className="font-mono font-semibold text-muted-foreground/70">
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

      <div className="flex shrink-0 items-center gap-1.5">
        <span className={cn("inline-block h-1.5 w-1.5 rounded-full", dotClass)} />
        <span
          className={cn(
            "inline-flex items-center rounded-full px-1.5 py-[1px] text-[calc(10px*var(--zone-font-scale,1))] font-semibold",
            statusBgClass,
          )}
        >
          {statusLabel}
        </span>
        {canExpand ? (
          <ChevronRight className="h-3 w-3 text-muted-foreground/35 transition-transform duration-200 ease-out group-open/tool:rotate-90" />
        ) : null}
      </div>
    </>
  );
  const body = effectiveOpen ? (
    <div className="space-y-3 border-t border-black/[0.04] px-2.5 py-2.5 dark:border-white/[0.05]">
      {isDesktopOnlyTool ? (
        <div className="rounded-[8px] border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-[calc(12px*var(--zone-font-scale,1))] text-amber-800 dark:text-amber-200">
          {t("chat.tool.desktopOnly")}
        </div>
      ) : null}
      {shouldShowArgs ? (
        <ToolSection label={isBash || inlineCommand ? t("chat.tool.command") : t("chat.tool.args")}>
          <ToolArgsDisplay item={item} />
        </ToolSection>
      ) : null}

      {result && !isDesktopOnlyTool ? (
        <ToolSection
          label={t("chat.tool.return")}
          trailing={
            result.isError ? (
              <span className="inline-flex items-center rounded-full bg-red-500/10 px-2 py-[1px] text-[calc(10px*var(--zone-font-scale,1))] font-bold text-red-500 dark:bg-red-500/15">
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
                        ? "bg-zinc-950/85 text-zinc-300/90 shadow-[inset_0_1px_2px_rgba(0,0,0,0.25)] dark:bg-zinc-900/80"
                        : "bg-black/[0.02] dark:bg-white/[0.03]",
                    )}
                  >
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
  ) : null;
  const containerClassName = cn(
    "group/tool overflow-hidden",
    variant === "grouped" ? "tool-card-grouped rounded-[10px]" : "tool-card-enter rounded-[12px]",
    "border border-black/[0.06] bg-white/[0.72] backdrop-blur-xl backdrop-saturate-[1.8]",
    variant === "grouped"
      ? "shadow-none"
      : [
          "shadow-[0_0_0_0.5px_rgba(0,0,0,0.03),0_1px_2px_rgba(0,0,0,0.03),0_2px_6px_rgba(0,0,0,0.02)]",
          "transition-shadow duration-200",
          !readOnly &&
            "hover:shadow-[0_0_0_0.5px_rgba(0,0,0,0.04),0_1px_3px_rgba(0,0,0,0.05),0_4px_14px_rgba(0,0,0,0.04)]",
        ],
    "dark:border-white/[0.1] dark:bg-white/[0.06] dark:backdrop-saturate-[1.4]",
    variant === "grouped"
      ? "dark:shadow-none"
      : [
          "dark:shadow-[0_0_0_0.5px_rgba(255,255,255,0.04),0_1px_2px_rgba(0,0,0,0.2),0_3px_8px_rgba(0,0,0,0.12)]",
          !readOnly &&
            "dark:hover:shadow-[0_0_0_0.5px_rgba(255,255,255,0.06),0_1px_3px_rgba(0,0,0,0.25),0_4px_14px_rgba(0,0,0,0.18)]",
        ],
  );

  if (!canExpand) {
    return (
      <div className={containerClassName}>
        <div className={summaryClassName}>{summaryContent}</div>
      </div>
    );
  }

  return (
    <details
      open={effectiveOpen}
      className={containerClassName}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className={summaryClassName}>{summaryContent}</summary>
      {body}
    </details>
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

function areToolTraceItemsEqual(previous: ToolTraceItem, next: ToolTraceItem) {
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
    previousProps.variant === nextProps.variant &&
    previousProps.readOnly === nextProps.readOnly &&
    previousProps.redactToolContent === nextProps.redactToolContent &&
    areToolTraceItemsEqual(previousProps.item, nextProps.item),
);
