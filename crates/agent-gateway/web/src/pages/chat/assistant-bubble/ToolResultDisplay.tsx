import { Search } from "../../../components/icons";
import { Markdown } from "../../../components/Markdown";
import type { ToolResultMessage } from "../../../lib/agentTypes";
import { deriveFileToolPreview } from "../../../lib/chat/toolPreview";
import {
  previewText,
  safeStringify,
  type ToolTraceItem,
  toolCallArgsForDisplay,
  toolResultMessageToText,
} from "../../../lib/chat/uiMessages";
import type {
  SubagentBatchDetails,
  SubagentCardDetails,
  SubagentMessageDetails,
} from "../../../lib/subagents/protocol";
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
} from "../../../lib/tools/builtinTypes";
import { EditDiffView } from "../EditDiffView";
import { FileToolArgsDisplay } from "../FileToolArgs";
import { sanitizeTodoItems, TodoListView } from "../TodoListView";
import {
  type MetaTag,
  MetaTags,
  PathDisplay,
  ToolFactGrid,
  ToolScrollablePre,
  ToolSurface,
  ToolSurfaceLabel,
} from "../ToolSurfaces";
import {
  displayString,
  getBuiltinResultKind,
  getStableValueSignature,
  getSubagentTask,
  isSubagentCardToolCall,
  shouldShowSubagentApplyStatus,
  shouldShowSubagentCleanupStatus,
  shouldShowSubagentWorktreeLocation,
} from "./assistantBubbleUtils";
import { getToolResultImages, ToolResultImagePreview } from "./ToolImages";

type ShellResultDetails = {
  exit_code: number;
  shell: string;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  timed_out: boolean;
  cancelled?: boolean;
  effective_timeout_ms?: number;
  duration_ms: number;
};

function isShellResultDetails(value: unknown): value is ShellResultDetails {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.exit_code === "number" &&
    typeof candidate.shell === "string" &&
    typeof candidate.stdout === "string" &&
    typeof candidate.stderr === "string" &&
    typeof candidate.stdout_truncated === "boolean" &&
    typeof candidate.stderr_truncated === "boolean" &&
    typeof candidate.timed_out === "boolean" &&
    typeof candidate.duration_ms === "number"
  );
}

function summarizeShellStream(text: string, truncated: boolean) {
  const length = text.length;
  if (length === 0) return "empty";
  return truncated ? `${length} chars, truncated` : `${length} chars`;
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

/** Extract tool-specific display info */
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
export function ToolArgsDisplay({ item }: { item: ToolTraceItem }) {
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

function extractResultText(result?: ToolResultMessage) {
  return result ? toolResultMessageToText(result) : "";
}

function extractReadBody(text: string) {
  const marker = text.indexOf("\n\n");
  return marker >= 0 ? text.slice(marker + 2) : text;
}

function CodePreview(props: { text: string; maxChars?: number }) {
  const { text, maxChars = 4000 } = props;
  if (!/\S/.test(text)) return null;
  return (
    <ToolScrollablePre className="max-h-56 bg-black/[0.02] dark:bg-white/[0.03]">
      {previewText(text, maxChars)}
    </ToolScrollablePre>
  );
}

// Render-layer tolerance for historical messages: current details carry
// `scope` ("workspace" | "skill" | "external"), while old sessions may still
// carry the legacy `root` ("workspace" | "skills") or unknown scope values
// such as "temp"/"artifact". Degrade at the read site — unknown values are
// displayed verbatim; "workspace" (the default) is hidden.
function resolveFileToolScope(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const record = details as Record<string, unknown>;
  const scope =
    typeof record.scope === "string" && record.scope.trim() ? record.scope.trim() : undefined;
  const legacyRoot =
    typeof record.root === "string" && record.root.trim() ? record.root.trim() : undefined;
  const resolved = scope ?? (legacyRoot === "skills" ? "skill" : legacyRoot);
  return resolved && resolved !== "workspace" ? resolved : undefined;
}

function fileScopeTags(details: unknown): MetaTag[] {
  const scope = resolveFileToolScope(details);
  return scope ? [{ label: "scope", value: scope }] : [];
}

export function ToolResultDisplay({
  item,
  result,
  readOnly = false,
}: {
  item: ToolTraceItem;
  result: ToolResultMessage;
  readOnly?: boolean;
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
              ...fileScopeTags(details),
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
              ...fileScopeTags(details),
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
                readOnly={readOnly}
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
              ...fileScopeTags(details),
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
              ...fileScopeTags(details),
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
              ...fileScopeTags(details),
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
              ...fileScopeTags(details),
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
        filePath={
          details.displayPath ||
          (resolveFileToolScope(details) === "skill" ? `skills:${details.path}` : details.path)
        }
      />
    );
  }

  if (kind === "delete") {
    const details = result.details as DeleteResultDetails;
    return (
      <ToolSurface>
        <MetaTags
          tags={[...fileScopeTags(details), { label: "kind", value: details.targetKind }]}
        />
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
            }).concat(fileScopeTags(details))}
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
            }).concat(fileScopeTags(details))}
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
              ...fileScopeTags(details),
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
              readOnly={readOnly}
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
