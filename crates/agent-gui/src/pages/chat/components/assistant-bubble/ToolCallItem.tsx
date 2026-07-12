import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { memo, useEffect, useMemo, useState } from "react";

import { FileChangeBadge } from "../../../../components/chat/FileChangeBadge";
import { ChevronRight, Search } from "../../../../components/icons";
import { useLocale } from "../../../../i18n";
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
import {
  areStableValuesEqual,
  displayString,
  getBuiltinResultKind,
  getSubagentInlineSummary,
  getToolDisplayTitle,
  getToolMeta,
  isSubagentCardToolCall,
  type MetaTag,
} from "./assistantBubbleUtils";
import { FileToolArgsDisplay } from "./FileToolArgs";
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
        <ToolSurface className="overflow-hidden border-emerald-500/15 bg-zinc-950/90 px-0 py-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] dark:border-white/[0.08] dark:bg-zinc-950/90">
          <ToolScrollablePre className="max-h-44 rounded-none text-emerald-300/90">
            <span className="mr-1 select-none text-emerald-500/30">$</span>
            {cmd}
          </ToolScrollablePre>
        </ToolSurface>
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

  // Fallback: raw JSON
  return (
    <ToolSurface className="overflow-hidden px-0 py-0">
      <ToolScrollablePre className="max-h-44 rounded-none">
        {safeStringify(toolCallArgsForDisplay(toolCall))}
      </ToolScrollablePre>
    </ToolSurface>
  );
}

function ToolCallItem({
  item,
  isRunning,
  variant = "standalone",
}: {
  item: ToolTraceItem;
  isRunning?: boolean;
  variant?: "standalone" | "grouped";
}) {
  const { t } = useLocale();
  const result = item.toolResult;
  const builtinResultKind = getBuiltinResultKind(result);
  const shouldAutoOpen = item.toolCall.name === "Image" || builtinResultKind === "display_image";
  const [open, setOpen] = useState(shouldAutoOpen);
  const isSubagentCard = isSubagentCardToolCall(item.toolCall);
  const hasArgs = Object.keys(item.toolCall.arguments || {}).length > 0;
  const isStreamingFilePreviewTool = FILE_TOOL_TEXT_FIELDS[item.toolCall.name] !== undefined;
  const shouldShowArgs =
    (!isSubagentCard || !result) && (isStreamingFilePreviewTool ? !result : hasArgs);
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
      : isSubagentCard
        ? getSubagentInlineSummary(item)
        : summarizeToolCall(item.toolCall, {
            includeName: false,
            includeManagerAction: false,
          });
  const fileChangeStats = useMemo(() => deriveFileChangeStats(item.toolCall), [item.toolCall]);
  const meta = getToolMeta(item.toolCall.name);
  const ToolIcon = meta.Icon;
  const title = getToolDisplayTitle(item.toolCall);

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
    if (shouldAutoOpen) {
      setOpen(true);
    }
  }, [shouldAutoOpen]);

  return (
    <details
      open={open}
      className={cn(
        "group/tool overflow-hidden",
        variant === "grouped"
          ? "tool-card-grouped rounded-[10px]"
          : "tool-card-enter rounded-[12px]",
        // Frosted glass with saturate
        "border border-black/[0.06] bg-white/[0.72] backdrop-blur-xl backdrop-saturate-[1.8]",
        variant === "grouped"
          ? "shadow-none"
          : [
              // Subtle layered shadow
              "shadow-[0_0_0_0.5px_rgba(0,0,0,0.03),0_1px_2px_rgba(0,0,0,0.03),0_2px_6px_rgba(0,0,0,0.02)]",
              // Hover lift
              "transition-shadow duration-200",
              "hover:shadow-[0_0_0_0.5px_rgba(0,0,0,0.04),0_1px_3px_rgba(0,0,0,0.05),0_4px_14px_rgba(0,0,0,0.04)]",
            ],
        // Dark
        "dark:border-white/[0.1] dark:bg-white/[0.06] dark:backdrop-saturate-[1.4]",
        variant === "grouped"
          ? "dark:shadow-none"
          : [
              "dark:shadow-[0_0_0_0.5px_rgba(255,255,255,0.04),0_1px_2px_rgba(0,0,0,0.2),0_3px_8px_rgba(0,0,0,0.12)]",
              "dark:hover:shadow-[0_0_0_0.5px_rgba(255,255,255,0.06),0_1px_3px_rgba(0,0,0,0.25),0_4px_14px_rgba(0,0,0,0.18)]",
            ],
      )}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      {/* Compact single-line summary */}
      <summary
        className={cn(
          "flex cursor-pointer select-none items-center gap-2 hover:bg-black/[0.015] dark:hover:bg-white/[0.025]",
          variant === "grouped" ? "px-2 py-[6px]" : "px-2.5 py-[7px]",
        )}
      >
        {/* Small icon with accent tint */}
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

        {/* Status badge + dot + chevron */}
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
          <ChevronRight className="h-3 w-3 text-muted-foreground/35 transition-transform duration-200 ease-out group-open/tool:rotate-90" />
        </div>
      </summary>

      {open ? (
        <div className="space-y-3 border-t border-black/[0.04] px-2.5 py-2.5 dark:border-white/[0.05]">
          {shouldShowArgs ? (
            <ToolSection
              label={isBash || inlineCommand ? t("chat.tool.command") : t("chat.tool.args")}
            >
              <ToolArgsDisplay item={item} />
            </ToolSection>
          ) : null}

          {result ? (
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
                <ToolResultDisplay item={item} result={result} />

                {(() => {
                  const resultText = toolResultMessageToText(result);
                  if (!/\S/.test(resultText)) return null;
                  if (builtinResultKind && builtinResultKind !== "read_image") return null;

                  if (isBash) {
                    return (
                      <ToolScrollablePre className="max-h-56 bg-zinc-950/85 text-zinc-300/90 shadow-[inset_0_1px_2px_rgba(0,0,0,0.25)] dark:bg-zinc-900/80">
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
                            ? "bg-zinc-950/85 text-zinc-300/90 shadow-[inset_0_1px_2px_rgba(0,0,0,0.25)] dark:bg-zinc-900/80"
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
      ) : null}
    </details>
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

function areToolTraceItemsEqual(previous: ToolTraceItem, next: ToolTraceItem) {
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
    areToolTraceItemsEqual(previousProps.item, nextProps.item),
);
