import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ReactNode } from "react";

import { Markdown } from "../../../../components/Markdown";
import {
  previewText,
  type ToolTraceItem,
  toolResultMessageToText,
} from "../../../../lib/chat/messages/uiMessages";
import { cn } from "../../../../lib/shared/utils";
import type {
  SubagentBatchDetails,
  SubagentCardDetails,
  SubagentMessageDetails,
} from "../../../../lib/subagents/protocol";
import type {
  DeleteResultDetails,
  EditResultDetails,
  GlobResultDetails,
  GrepResultDetails,
  ListResultDetails,
  McpManagerResultDetails,
  ReadDocumentResultDetails,
  ReadImageResultDetails,
  ReadNotebookResultDetails,
  ReadPdfResultDetails,
  ReadTextResultDetails,
  SkillsManagerResultDetails,
  TodoWriteResultDetails,
  WriteResultDetails,
} from "../../../../lib/tools/builtinTypes";
import {
  getBuiltinResultKind,
  getStableValueSignature,
  getSubagentTask,
  isShellResultDetails,
  type MetaTag,
  shouldShowSubagentApplyStatus,
  shouldShowSubagentCleanupStatus,
  shouldShowSubagentWorktreeLocation,
  summarizeShellStream,
} from "./assistantBubbleUtils";
import { EditDiffView } from "./EditDiffView";
import { TodoListView } from "./TodoListView";
import { getToolResultImages, ToolResultImagePreview } from "./ToolImages";

export function ToolSection(props: { label?: string; trailing?: ReactNode; children: ReactNode }) {
  const { label, trailing, children } = props;
  return (
    <section className="space-y-1.5">
      {label || trailing ? (
        <div className="flex min-h-5 items-center gap-2">
          {label ? (
            <span className="shrink-0 text-[calc(11px*var(--zone-font-scale,1))] font-medium text-muted-foreground/65">
              {label}
            </span>
          ) : null}
          {trailing}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function ToolSurface(props: { children: ReactNode; className?: string }) {
  const { children, className } = props;
  return <div className={cn("min-w-0 py-0.5", className)}>{children}</div>;
}

export function ToolSurfaceLabel({ label }: { label: string }) {
  return (
    <div className="mb-0.5 text-[calc(10.5px*var(--zone-font-scale,1))] font-medium text-muted-foreground/55">
      {label}
    </div>
  );
}

export function ToolFactGrid({ tags }: { tags: MetaTag[] }) {
  if (tags.length === 0) return null;
  return (
    <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
      {tags.map((tag) => (
        <ToolSurface key={`${tag.label}-${tag.value}`}>
          <ToolSurfaceLabel label={tag.label} />
          <div className="break-all font-mono text-[calc(11px*var(--zone-font-scale,1))] leading-[1.55] text-foreground/78">
            {tag.value}
          </div>
        </ToolSurface>
      ))}
    </div>
  );
}

function buildPagedResultTags(params: {
  label: string;
  returned: number;
  total: number;
  offset: number;
  hasMore: boolean;
}) {
  const { label, returned, total, offset, hasMore } = params;
  return [
    { label, value: `${returned}/${total}` },
    ...(offset > 0 ? [{ label: "offset", value: String(offset) }] : []),
    { label: "state", value: hasMore ? "partial" : "complete" },
  ];
}

function filePathTags(details: {
  scope?: string;
  displayPath?: string;
  absolutePath?: string;
}): MetaTag[] {
  return [
    ...(details.scope && details.scope !== "workspace"
      ? [{ label: "scope", value: details.scope }]
      : []),
  ];
}

export function PathDisplay({ path, className }: { path: string; className?: string }) {
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash < 0) {
    return (
      <span
        className={cn(
          className,
          "block max-w-full overflow-hidden text-ellipsis whitespace-nowrap break-normal",
        )}
        title={path}
      >
        {path}
      </span>
    );
  }
  const dir = path.slice(0, lastSlash + 1);
  const file = path.slice(lastSlash + 1);
  return (
    <span
      className={cn(
        className,
        "inline-flex max-w-full min-w-0 items-baseline overflow-hidden whitespace-nowrap break-normal",
      )}
      title={path}
    >
      <span className="min-w-0 flex-1 truncate text-muted-foreground/40">
        {dir.length > 50 ? `…${dir.slice(-50)}` : dir}
      </span>
      <span className="max-w-[70%] truncate text-foreground/85">{file}</span>
    </span>
  );
}

/** Inline meta tags */
export function MetaTags({ tags }: { tags: MetaTag[] }) {
  if (tags.length === 0) return null;
  const labelCounts = new Map<string, number>();
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {tags.map((tag) => {
        const seenCount = labelCounts.get(tag.label) ?? 0;
        labelCounts.set(tag.label, seenCount + 1);
        const stableKey = seenCount === 0 ? tag.label : `${tag.label}-${seenCount}`;
        return (
          <span
            key={stableKey}
            className="inline-flex min-h-5 items-baseline gap-1 text-[calc(11px*var(--zone-font-scale,1))] leading-5"
          >
            <span className="font-medium text-muted-foreground/55">{tag.label}</span>
            <span className="min-w-0 break-all font-mono tabular-nums text-foreground/75">
              {tag.value}
            </span>
          </span>
        );
      })}
    </div>
  );
}

function extractReadBody(text: string) {
  const marker = text.indexOf("\n\n");
  return marker >= 0 ? text.slice(marker + 2) : text;
}

export function ToolScrollablePre(props: { children: ReactNode; className?: string }) {
  const { children, className } = props;
  return (
    <pre
      className={cn(
        "tool-text-scroll overflow-x-auto overflow-y-auto whitespace-pre break-normal rounded-[8px] px-2.5 py-2 text-[calc(11.5px*var(--zone-font-scale,1))] leading-[1.6]",
        className,
      )}
    >
      {children}
    </pre>
  );
}

export function CodePreview(props: { text: string; maxChars?: number }) {
  const { text, maxChars = 4000 } = props;
  if (!/\S/.test(text)) return null;
  return (
    <ToolScrollablePre className="max-h-56 bg-black/[0.02] dark:bg-white/[0.03]">
      {previewText(text, maxChars)}
    </ToolScrollablePre>
  );
}

function extractResultText(result?: ToolResultMessage) {
  return result ? toolResultMessageToText(result) : "";
}

export function ToolResultDisplay({
  item,
  result,
}: {
  item: ToolTraceItem;
  result: ToolResultMessage;
}) {
  const kind = getBuiltinResultKind(result);
  const text = extractResultText(result);
  const images = getToolResultImages(result);
  const shellDetails = isShellResultDetails(result.details) ? result.details : null;

  if (item.toolCall.name === "Bash") {
    if (!shellDetails) return null;

    return (
      <ToolSurface>
        <MetaTags
          tags={[
            { label: "shell", value: shellDetails.shell || "unknown" },
            { label: "exit", value: String(shellDetails.exit_code) },
            { label: "duration", value: `${shellDetails.duration_ms} ms` },
            ...(typeof shellDetails.effective_timeout_ms === "number"
              ? [{ label: "timeout_ms", value: `${shellDetails.effective_timeout_ms}` }]
              : []),
            {
              label: "stdout",
              value: summarizeShellStream(shellDetails.stdout, shellDetails.stdout_truncated),
            },
            {
              label: "stderr",
              value: summarizeShellStream(shellDetails.stderr, shellDetails.stderr_truncated),
            },
            ...(shellDetails.timed_out ? [{ label: "timeout", value: "true" }] : []),
            ...(shellDetails.cancelled ? [{ label: "cancelled", value: "true" }] : []),
          ]}
        />
      </ToolSurface>
    );
  }

  if (kind === "todo_write") {
    const details = result.details as TodoWriteResultDetails;
    return <TodoListView todos={details.todos} />;
  }

  if (kind === "read_text") {
    const details = result.details as ReadTextResultDetails;
    return (
      <div className="space-y-2">
        <ToolSurface>
          <MetaTags
            tags={[
              ...filePathTags(details),
              {
                label: "lines",
                value:
                  details.numLines > 0
                    ? `${details.startLine}-${details.startLine + details.numLines - 1}/${details.totalLines}`
                    : `empty/${details.totalLines}`,
              },
              { label: "view", value: details.isPartialView ? "partial" : "full" },
              ...(details.truncated ? [{ label: "truncated", value: "true" }] : []),
              ...(details.reusedExisting ? [{ label: "cache", value: "unchanged" }] : []),
            ]}
          />
        </ToolSurface>
        {!details.reusedExisting ? (
          <CodePreview text={extractReadBody(text)} maxChars={8000} />
        ) : null}
      </div>
    );
  }

  if (kind === "read_skill") {
    const details = result.details as SkillsManagerResultDetails;
    if (details.kind !== "read_skill") return null;
    return (
      <div className="space-y-2">
        <ToolSurface>
          <MetaTags
            tags={[
              {
                label: "lines",
                value:
                  details.numLines > 0
                    ? `${details.startLine}-${details.startLine + details.numLines - 1}`
                    : `empty @ ${details.startLine}`,
              },
              ...(details.truncated ? [{ label: "truncated", value: "true" }] : []),
            ]}
          />
        </ToolSurface>
        <CodePreview text={extractReadBody(text)} maxChars={8000} />
      </div>
    );
  }

  if (kind === "manage_skill") {
    const details = result.details as Extract<SkillsManagerResultDetails, { kind: "manage_skill" }>;
    return (
      <div className="space-y-2">
        <ToolSurface>
          <MetaTags
            tags={[
              { label: "action", value: details.action },
              { label: "root", value: details.rootDir },
              ...(typeof details.skillsCount === "number"
                ? [{ label: "skills", value: String(details.skillsCount) }]
                : []),
              ...(typeof details.installedCount === "number"
                ? [{ label: "installed", value: String(details.installedCount) }]
                : []),
              ...(details.createdName ? [{ label: "created", value: details.createdName }] : []),
              ...(typeof details.clawhubResultCount === "number"
                ? [{ label: "clawhub", value: String(details.clawhubResultCount) }]
                : []),
              ...(details.clawhubSlug ? [{ label: "slug", value: details.clawhubSlug }] : []),
              ...(typeof details.validationOk === "boolean"
                ? [{ label: "valid", value: details.validationOk ? "true" : "false" }]
                : []),
              ...(details.packageArchive
                ? [{ label: "archive", value: details.packageArchive }]
                : []),
              ...(details.clawhubNextCursor
                ? [{ label: "cursor", value: details.clawhubNextCursor }]
                : []),
              ...(typeof details.invalidCount === "number" && details.invalidCount > 0
                ? [{ label: "invalid", value: String(details.invalidCount) }]
                : []),
              ...(details.backup ? [{ label: "backup", value: details.backup }] : []),
            ]}
          />
        </ToolSurface>
        <CodePreview text={text} maxChars={8000} />
      </div>
    );
  }

  if (kind === "manage_mcp") {
    const details = result.details as McpManagerResultDetails;
    return (
      <div className="space-y-2">
        <ToolSurface>
          <MetaTags
            tags={[
              { label: "action", value: details.action },
              ...(details.serverId ? [{ label: "server", value: details.serverId }] : []),
              ...(details.transport ? [{ label: "transport", value: details.transport }] : []),
              ...(typeof details.ok === "boolean"
                ? [{ label: "ok", value: details.ok ? "true" : "false" }]
                : []),
              ...(details.phase ? [{ label: "phase", value: details.phase }] : []),
              ...(typeof details.serverCount === "number"
                ? [{ label: "servers", value: String(details.serverCount) }]
                : []),
              ...(typeof details.enabledCount === "number"
                ? [{ label: "enabled", value: String(details.enabledCount) }]
                : []),
              ...(typeof details.toolsCount === "number"
                ? [{ label: "tools", value: String(details.toolsCount) }]
                : []),
              ...(typeof details.changed === "boolean"
                ? [{ label: "changed", value: details.changed ? "true" : "false" }]
                : []),
              ...(typeof details.stopped === "boolean"
                ? [{ label: "stopped", value: details.stopped ? "true" : "false" }]
                : []),
            ]}
          />
        </ToolSurface>
        <CodePreview text={text} maxChars={8000} />
      </div>
    );
  }

  if (kind === "read_image") {
    const details = result.details as ReadImageResultDetails;
    return (
      <div className="space-y-2">
        <ToolSurface>
          <MetaTags
            tags={[
              ...filePathTags(details),
              { label: "mime", value: details.mimeType },
              { label: "size", value: `${details.sizeBytes} bytes` },
              ...(details.reusedExisting ? [{ label: "cache", value: "unchanged" }] : []),
            ]}
          />
        </ToolSurface>
        {!details.reusedExisting && images.length > 0 ? (
          <div className="overflow-hidden rounded-[10px] border border-black/[0.06] bg-white/[0.55] p-2 dark:border-white/[0.08] dark:bg-white/[0.04]">
            {images.map((image, index) => (
              <ToolResultImagePreview
                key={`${details.path}-${index}`}
                id={`${details.path}-${index}`}
                image={image}
                alt={details.path}
                sizeBytes={details.sizeBytes}
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  if (kind === "read_pdf") {
    const details = result.details as ReadPdfResultDetails;
    return (
      <div className="space-y-2">
        <ToolSurface>
          <MetaTags
            tags={[
              ...filePathTags(details),
              {
                label: "pages",
                value:
                  details.numPages > 0
                    ? `${details.pageStart}-${details.pageStart + details.numPages - 1}/${details.totalPages}`
                    : `empty/${details.totalPages}`,
              },
              ...(details.truncated ? [{ label: "truncated", value: "true" }] : []),
              ...(details.reusedExisting ? [{ label: "cache", value: "unchanged" }] : []),
            ]}
          />
        </ToolSurface>
        {!details.reusedExisting ? (
          <CodePreview text={extractReadBody(text)} maxChars={8000} />
        ) : null}
      </div>
    );
  }

  if (kind === "read_notebook") {
    const details = result.details as ReadNotebookResultDetails;
    return (
      <div className="space-y-2">
        <ToolSurface>
          <MetaTags
            tags={[
              ...filePathTags(details),
              {
                label: "cells",
                value:
                  details.numCells > 0
                    ? `${details.cellStart}-${details.cellStart + details.numCells - 1}/${details.totalCells}`
                    : `empty/${details.totalCells}`,
              },
              ...(details.truncated ? [{ label: "truncated", value: "true" }] : []),
              ...(details.reusedExisting ? [{ label: "cache", value: "unchanged" }] : []),
            ]}
          />
        </ToolSurface>
        {!details.reusedExisting ? (
          <CodePreview text={extractReadBody(text)} maxChars={8000} />
        ) : null}
      </div>
    );
  }

  if (kind === "read_word" || kind === "read_spreadsheet" || kind === "read_archive") {
    const details = result.details as ReadDocumentResultDetails;
    return (
      <div className="space-y-2">
        <ToolSurface>
          <MetaTags
            tags={[
              ...filePathTags(details),
              ...(details.mimeType ? [{ label: "mime", value: details.mimeType }] : []),
              ...(typeof details.sizeBytes === "number"
                ? [{ label: "size", value: `${details.sizeBytes} bytes` }]
                : []),
              ...(details.truncated ? [{ label: "truncated", value: "true" }] : []),
              ...(details.reusedExisting ? [{ label: "cache", value: "unchanged" }] : []),
            ]}
          />
        </ToolSurface>
        {!details.reusedExisting ? (
          <CodePreview text={extractReadBody(text)} maxChars={8000} />
        ) : null}
      </div>
    );
  }

  if (kind === "write") {
    const details = result.details as WriteResultDetails;
    return (
      <div className="space-y-2">
        <ToolSurface>
          <MetaTags
            tags={[
              ...filePathTags(details),
              { label: "target", value: details.existedBefore ? "existing" : "new" },
              { label: "bytes", value: String(details.bytesWritten) },
              { label: "lines", value: String(details.totalLines) },
            ]}
          />
        </ToolSurface>
        <CodePreview text={details.preview} />
      </div>
    );
  }

  if (kind === "edit") {
    const details = result.details as EditResultDetails;
    return (
      <EditDiffView
        beforeText={details.oldPreview}
        afterText={details.newPreview}
        filePath={details.displayPath || details.path}
      />
    );
  }

  if (kind === "delete") {
    const details = result.details as DeleteResultDetails;
    return (
      <ToolSurface>
        <MetaTags tags={[...filePathTags(details), { label: "kind", value: details.targetKind }]} />
      </ToolSurface>
    );
  }

  if (kind === "list") {
    const details = result.details as ListResultDetails;
    return (
      <div className="space-y-2">
        <ToolSurface>
          <MetaTags
            tags={buildPagedResultTags({
              label: "items",
              returned: details.entries.length,
              total: details.total,
              offset: details.offset,
              hasMore: details.hasMore,
            }).concat(filePathTags(details))}
          />
        </ToolSurface>
        <ToolSurface className="max-h-56 overflow-auto">
          <div className="space-y-1">
            {details.entries.map((entry) => (
              <div
                key={`${entry.kind}-${entry.path}`}
                className="flex items-start gap-2 rounded-[8px] px-1.5 py-1 text-[calc(11px*var(--zone-font-scale,1))] leading-[1.5] even:bg-black/[0.02] dark:even:bg-white/[0.03]"
              >
                <span className="mt-[1px] shrink-0 text-[calc(10px*var(--zone-font-scale,1))] font-semibold uppercase text-muted-foreground/35">
                  {entry.kind}
                </span>
                <PathDisplay
                  path={entry.path}
                  className="min-w-0 break-all font-mono text-[calc(11px*var(--zone-font-scale,1))]"
                />
              </div>
            ))}
          </div>
        </ToolSurface>
      </div>
    );
  }

  if (kind === "glob") {
    const details = result.details as GlobResultDetails;
    return (
      <div className="space-y-2">
        <ToolSurface>
          <MetaTags
            tags={buildPagedResultTags({
              label: "matches",
              returned: details.paths.length,
              total: details.total,
              offset: details.offset,
              hasMore: details.hasMore,
            }).concat(filePathTags(details))}
          />
        </ToolSurface>
        <ToolSurface className="max-h-56 overflow-auto">
          <div className="space-y-1">
            {details.paths.map((entry) => (
              <PathDisplay
                key={entry}
                path={entry}
                className="block rounded-[8px] px-1.5 py-1 break-all font-mono text-[calc(11px*var(--zone-font-scale,1))] leading-[1.5] even:bg-black/[0.02] dark:even:bg-white/[0.03]"
              />
            ))}
          </div>
        </ToolSurface>
      </div>
    );
  }

  if (kind === "grep") {
    const details = result.details as GrepResultDetails;
    return (
      <div className="space-y-2">
        <ToolSurface>
          <MetaTags
            tags={[
              ...filePathTags(details),
              { label: "mode", value: details.outputMode },
              { label: "matches", value: String(details.matchCount) },
              { label: "files", value: String(details.fileCount) },
              ...(details.offset > 0 ? [{ label: "offset", value: String(details.offset) }] : []),
              { label: "state", value: details.hasMore ? "partial" : "complete" },
            ]}
          />
        </ToolSurface>
        {details.outputMode === "count" ? null : details.outputMode === "files" ? (
          <ToolSurface className="max-h-56 overflow-auto">
            <div className="space-y-1.5">
              {details.files.map((file) => (
                <div
                  key={file.path}
                  className="space-y-1 rounded-[8px] px-1.5 py-1 even:bg-black/[0.02] dark:even:bg-white/[0.03]"
                >
                  <PathDisplay
                    path={file.path}
                    className="block break-all font-mono text-[calc(11px*var(--zone-font-scale,1))] leading-[1.5]"
                  />
                  <MetaTags
                    tags={[
                      { label: "count", value: String(file.count) },
                      ...(typeof file.firstLine === "number"
                        ? [{ label: "first", value: String(file.firstLine) }]
                        : []),
                    ]}
                  />
                </div>
              ))}
            </div>
          </ToolSurface>
        ) : (
          <ToolSurface className="max-h-64 overflow-auto space-y-2">
            {details.matches.map((match, index) => (
              <div
                key={`${match.path}:${match.line}:${index}`}
                className="rounded-[8px] border border-black/[0.05] bg-white/[0.55] p-2 dark:border-white/[0.06] dark:bg-white/[0.03]"
              >
                <div className="flex items-start gap-2">
                  <PathDisplay
                    path={match.path}
                    className="min-w-0 break-all font-mono text-[calc(11px*var(--zone-font-scale,1))] leading-[1.5]"
                  />
                  <span className="shrink-0 rounded bg-black/[0.04] px-1.5 py-[1px] text-[calc(10px*var(--zone-font-scale,1))] font-semibold text-muted-foreground/60 dark:bg-white/[0.05]">
                    line {match.line}
                  </span>
                </div>
                {match.before.length > 0 ? (
                  <CodePreview text={match.before.join("\n")} maxChars={1500} />
                ) : null}
                <CodePreview text={match.text} maxChars={1500} />
                {match.after.length > 0 ? (
                  <CodePreview text={match.after.join("\n")} maxChars={1500} />
                ) : null}
              </div>
            ))}
          </ToolSurface>
        )}
      </div>
    );
  }

  if (kind === "subagent_batch") {
    const details = result.details as SubagentBatchDetails;
    if (details.status !== "rejected" && result.isError !== true) {
      // The successful parent batch is rendered as per-agent cards.
      return null;
    }
    const issues = details.issues ?? [];
    return (
      <ToolSurface className="space-y-2">
        <MetaTags
          tags={[
            { label: "agent", value: "rejected" },
            { label: "issues", value: String(issues.length) },
          ]}
        />
        <div className="text-[calc(12px*var(--zone-font-scale,1))] font-semibold leading-[1.45] text-foreground/90">
          Agent call rejected — no subagents were started
        </div>
        {issues.length > 0 ? (
          <CodePreview
            text={issues
              .map(
                (item, index) =>
                  `${index + 1}. [${item.code}]${item.agentId ? ` agent=${item.agentId}` : ""} ${item.message}`,
              )
              .join("\n")}
            maxChars={2400}
          />
        ) : (
          <CodePreview
            text={result.content
              .map((block) => (block.type === "text" ? block.text : ""))
              .join("\n")}
            maxChars={2400}
          />
        )}
      </ToolSurface>
    );
  }

  if (kind === "subagent_card") {
    const details = result.details as SubagentCardDetails;
    const agent = details.agent;
    const agentDisplayName = agent.name || agent.id;
    const agentTask = getSubagentTask(agent);
    const tags: MetaTag[] = [
      { label: "agent", value: `${details.index + 1}/${details.total}` },
      { label: "status", value: agent.status },
    ];
    if (agent.mode === "worktree") {
      tags.push({ label: "mode", value: agent.mode });
    }
    if (shouldShowSubagentApplyStatus(agent) && agent.applyStatus) {
      tags.push({ label: "apply", value: agent.applyStatus });
    }
    if (shouldShowSubagentCleanupStatus(agent) && agent.worktreeCleanupStatus) {
      tags.push({ label: "cleanup", value: agent.worktreeCleanupStatus });
    }

    const untrackedFiles = agent.untrackedFiles ?? [];
    const candidateArtifacts = agent.candidateArtifacts ?? [];
    const showUntrackedFiles = agent.applyStatus !== "applied" && untrackedFiles.length > 0;
    const showCandidateArtifacts = Boolean(
      candidateArtifacts.length > 0 &&
        agent.applySkippedReason &&
        agent.applySkippedReason !== "no_changes",
    );

    return (
      <ToolSurface className="space-y-2">
        <MetaTags tags={tags} />
        <div className="space-y-2">
          <div className="text-[calc(12px*var(--zone-font-scale,1))] font-semibold leading-[1.45] text-foreground/90">
            {agentDisplayName}
          </div>
          {agent.role ? (
            <div className="text-[calc(11px*var(--zone-font-scale,1))] font-medium leading-[1.55] text-foreground/78">
              <span className="text-muted-foreground">role</span> {agent.role}
            </div>
          ) : null}
          {agentTask ? (
            <div className="break-words text-[calc(11px*var(--zone-font-scale,1))] font-medium leading-[1.6] text-foreground/80">
              <span className="text-muted-foreground">task</span> {agentTask}
            </div>
          ) : null}
          {shouldShowSubagentWorktreeLocation(agent) ? (
            <div className="break-all text-[calc(10px*var(--zone-font-scale,1))] text-muted-foreground/70">
              {agent.branchName ? `${agent.branchName} | ` : ""}
              {agent.worktreeRoot}
            </div>
          ) : null}
          {agent.diffStat ? <CodePreview text={agent.diffStat} maxChars={1200} /> : null}
          {showUntrackedFiles ? (
            <CodePreview
              text={`untracked:\n${untrackedFiles.map((file) => `- ${file}`).join("\n")}`}
              maxChars={1200}
            />
          ) : null}
          {agent.worktreeStatusError ? (
            <CodePreview text={agent.worktreeStatusError} maxChars={1200} />
          ) : null}
          {agent.applyError ? (
            <CodePreview text={`apply failed:\n${agent.applyError}`} maxChars={1200} />
          ) : agent.applySkippedReason && agent.applySkippedReason !== "no_changes" ? (
            <CodePreview text={`apply skipped: ${agent.applySkippedReason}`} maxChars={1200} />
          ) : null}
          {agent.applyFallbackReason ? (
            <CodePreview text={`fallback reason:\n${agent.applyFallbackReason}`} maxChars={1200} />
          ) : null}
          {agent.applyCopiedFiles && agent.applyCopiedFiles.length > 0 ? (
            <CodePreview
              text={`copied:\n${agent.applyCopiedFiles.map((file) => `- ${file}`).join("\n")}`}
              maxChars={1200}
            />
          ) : null}
          {agent.applyDeletedFiles && agent.applyDeletedFiles.length > 0 ? (
            <CodePreview
              text={`deleted:\n${agent.applyDeletedFiles.map((file) => `- ${file}`).join("\n")}`}
              maxChars={1200}
            />
          ) : null}
          {agent.applyConflictFiles && agent.applyConflictFiles.length > 0 ? (
            <CodePreview
              text={`apply conflicts:\n${agent.applyConflictFiles.map((file) => `- ${file}`).join("\n")}`}
              maxChars={1200}
            />
          ) : null}
          {agent.worktreeCleanupError ? (
            <CodePreview
              text={`worktree cleanup failed:\n${agent.worktreeCleanupError}`}
              maxChars={1200}
            />
          ) : agent.worktreeCleanupReason && agent.worktreeCleanupStatus === "retained" ? (
            <CodePreview
              text={`worktree retained: ${agent.worktreeCleanupReason}`}
              maxChars={1200}
            />
          ) : null}
          {showCandidateArtifacts ? (
            <CodePreview
              text={`candidate artifacts:\n${candidateArtifacts.map((file) => `- ${file}`).join("\n")}`}
              maxChars={1200}
            />
          ) : null}
          {agent.persistenceWarnings && agent.persistenceWarnings.length > 0 ? (
            <CodePreview
              text={`persistence warning:\n${agent.persistenceWarnings.map((item) => `- ${item}`).join("\n")}`}
              maxChars={1200}
            />
          ) : null}
          {agent.error ? (
            <CodePreview text={agent.error} maxChars={1200} />
          ) : agent.summary ? (
            <CodePreview text={agent.summary} maxChars={2400} />
          ) : null}
        </div>
      </ToolSurface>
    );
  }

  if (kind === "subagent_message") {
    const details = result.details as SubagentMessageDetails;
    const from = details.senderName || details.senderId;
    const to = details.recipientName || details.recipientId;
    return (
      <ToolSurface className="space-y-2">
        <MetaTags
          tags={[
            { label: "seq", value: String(details.seq) },
            { label: "channel", value: details.channel },
            { label: "from", value: from },
            { label: "to", value: to },
          ]}
        />
        {details.subject ? (
          <div className="break-words text-[calc(11.5px*var(--zone-font-scale,1))] font-semibold leading-[1.5] text-foreground/86">
            {details.subject}
          </div>
        ) : null}
        {details.bodyPreview ? (
          <div className="rounded-[8px] border border-black/[0.05] bg-white/[0.45] px-2.5 py-2 text-[calc(11.5px*var(--zone-font-scale,1))] leading-[1.6] dark:border-white/[0.07] dark:bg-white/[0.03]">
            <Markdown content={details.bodyPreview} />
          </div>
        ) : null}
      </ToolSurface>
    );
  }

  if (images.length > 0) {
    return (
      <div className="space-y-2">
        <div className="overflow-hidden rounded-[10px] border border-black/[0.06] bg-white/[0.55] p-2 dark:border-white/[0.08] dark:bg-white/[0.04]">
          {images.map((image, index) => (
            <ToolResultImagePreview
              key={`${item.toolCall.id}-${index}`}
              id={`${item.toolCall.id}-${index}`}
              image={image}
              alt={item.toolCall.name}
            />
          ))}
        </div>
        {/\S/.test(text) ? <CodePreview text={text} maxChars={3000} /> : null}
      </div>
    );
  }

  // Error results (and blocked calls) carry an empty details object — showing
  // a literal "{}" would bury the actual error text, which renders below.
  if (
    result.details &&
    typeof result.details === "object" &&
    Object.keys(result.details).length > 0
  ) {
    return (
      <ToolSurface className="overflow-hidden px-0 py-0">
        <ToolScrollablePre className="max-h-32 rounded-none">
          {getStableValueSignature(result.details)}
        </ToolScrollablePre>
      </ToolSurface>
    );
  }

  return null;
}
