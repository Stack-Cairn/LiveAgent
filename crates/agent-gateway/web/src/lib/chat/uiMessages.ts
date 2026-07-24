import type { AssistantMessage, Message, ToolCall, ToolResultMessage, Usage } from "../agentTypes";
import { assistantMessageToText } from "../providers/llm";
import {
  buildSubagentCardToolCallId,
  isSubagentCardArguments,
  type SubagentBatchDetails,
  type SubagentCardDetails,
} from "../subagents/protocol";
import {
  enrichHostedSearchContentWithText,
  type HostedSearchBlock,
  mergeHostedSearchBlocks,
  normalizeHostedSearchBlock,
  resolveHostedSearchTextBoundary,
  splitTextAroundHostedSearch,
} from "./hostedSearch";
import { fileToolFieldChars, LIVE_TOOL_PREVIEW_META_KEY } from "./toolPreview";
import {
  getUserMessageAttachments,
  getUserMessageDisplayText,
  type PendingUploadedFile,
} from "./uploadedFiles";

const MIN_BASH_TIMEOUT_MS = 1_000;
const GLOBAL_BASH_MAX_TIMEOUT_MS = 600_000;

export type ToolTraceItem = {
  toolCall: ToolCall;
  toolResult?: ToolResultMessage;
};

export type UiRoundContentBlock =
  | {
      kind: "thinking";
      // Stable render key: assigned when the block is created and never
      // shifted by later inserts, unlike an array index.
      id: string;
      text: string;
    }
  | {
      kind: "tool";
      item: ToolTraceItem;
    }
  | {
      kind: "hostedSearch";
      item: HostedSearchBlock;
    }
  | {
      kind: "text";
      id: string;
      text: string;
    };

export type UiRound = {
  round: number;
  blocks: UiRoundContentBlock[];
  meta?: {
    provider?: string;
    model?: string;
    api?: string;
    stopReason?: string;
    usage?: Usage;
    usageTotalTokens?: number;
  };
};

export type UiMessage = {
  key: string;
  role: "user" | "assistant";
  text: string;
  attachments?: PendingUploadedFile[];
  rounds?: UiRound[];
  messageIndex?: number;
};

function cloneToolArgumentValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneToolArgumentValue(item));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      out[key] = cloneToolArgumentValue(nestedValue);
    }
    return out;
  }
  return value;
}

function snapshotToolCallForTrace(toolCall: ToolCall): ToolCall {
  const args =
    toolCall.arguments &&
    typeof toolCall.arguments === "object" &&
    !Array.isArray(toolCall.arguments)
      ? (cloneToolArgumentValue(toolCall.arguments) as Record<string, unknown>)
      : {};
  return {
    ...toolCall,
    arguments: args,
  } as ToolCall;
}

export function getMessageText(message: Message) {
  if (message.role === "user") {
    return getUserMessageDisplayText(message as Message & Record<string, unknown>);
  }
  if (message.role === "assistant") {
    return assistantMessageToText(message);
  }
  return "";
}

export function assistantMessageToThinkingText(message: AssistantMessage) {
  let text = "";
  for (const block of message.content) {
    if (block.type === "thinking") text += block.thinking;
  }
  return text;
}

export function toolResultMessageToText(message: ToolResultMessage) {
  let text = "";
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
  }
  return text;
}

export function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncateMiddle(input: string, maxLen: number) {
  const text = input.replace(/\s+/g, " ").trim();
  if (text.length <= maxLen) return text;
  const head = Math.max(0, Math.floor((maxLen - 3) / 2));
  const tail = Math.max(0, maxLen - 3 - head);
  return `${text.slice(0, head)}...${text.slice(text.length - tail)}`;
}

function summarizeToolArg(value: unknown, maxLen = 80) {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return truncateMiddle(value, maxLen);
  return null;
}

function summarizeBashTimeout(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const requested = Math.floor(value);
  const effective = Math.min(GLOBAL_BASH_MAX_TIMEOUT_MS, Math.max(MIN_BASH_TIMEOUT_MS, requested));
  return requested === effective
    ? `timeout_ms=${effective}`
    : `timeout_ms=${effective} (requested ${requested})`;
}

export function summarizeToolCall(
  toolCall: ToolCall,
  options?: { includeName?: boolean; includeManagerAction?: boolean },
) {
  const includeName = options?.includeName ?? true;
  const includeManagerAction = options?.includeManagerAction ?? true;
  const args = toolCall.arguments || {};
  const name = toolCall.name;
  const path = summarizeToolArg(args.path);
  const displayScope = displayFileToolScope(args);
  const scope = displayScope ? `scope=${summarizeToolArg(displayScope)}` : null;
  const imagePaths = Array.isArray(args.paths)
    ? args.paths
        .map((value) => summarizeToolArg(value))
        .filter((value): value is string => Boolean(value))
    : [];
  const imageSources = Array.isArray(args.sources)
    ? args.sources
        .map((value) => summarizeImageSourceArg(value))
        .filter((value): value is string => Boolean(value))
    : [];
  const imageUrls = Array.isArray(args.urls)
    ? args.urls
        .map((value) => summarizeToolArg(value))
        .filter((value): value is string => Boolean(value))
    : [];
  const imageBase64s = Array.isArray(args.base64s)
    ? args.base64s.filter((value) => typeof value === "string" && value.trim()).length
    : 0;
  const defaultPath = "path=.";
  const defaultCwd = "cwd=.";

  const parts =
    name === "Image"
      ? [
          scope,
          imageSources.length > 0
            ? `sources=${imageSources.length}${imageSources[0] ? ` first=${imageSources[0]}` : ""}`
            : imagePaths.length > 0
              ? `paths=${imagePaths.length}${imagePaths[0] ? ` first=${imagePaths[0]}` : ""}`
              : imageUrls.length > 0
                ? `urls=${imageUrls.length}${imageUrls[0] ? ` first=${imageUrls[0]}` : ""}`
                : imageBase64s > 0
                  ? `base64s=${imageBase64s}`
                  : typeof args.source === "string" && args.source.trim()
                    ? `source=${summarizeImageSourceArg(args.source)}`
                    : typeof args.url === "string" && args.url.trim()
                      ? `url=${summarizeToolArg(args.url)}`
                      : typeof args.base64 === "string" && args.base64.trim()
                        ? `base64Chars=${args.base64.length}`
                        : path
                          ? `path=${path}`
                          : null,
        ]
      : name === "Read"
        ? [
            scope,
            path ? `path=${path}` : null,
            typeof args.start_line === "number" ? `start=${args.start_line}` : null,
            typeof args.limit === "number" ? `limit=${args.limit}` : null,
            typeof args.page_start === "number" ? `pageStart=${args.page_start}` : null,
            typeof args.page_limit === "number" ? `pageLimit=${args.page_limit}` : null,
            typeof args.cell_start === "number" ? `cellStart=${args.cell_start}` : null,
            typeof args.cell_limit === "number" ? `cellLimit=${args.cell_limit}` : null,
          ]
        : name === "SkillsManager"
          ? [
              includeManagerAction && typeof args.action === "string"
                ? `action=${args.action}`
                : null,
              path ? `path=${path}` : null,
              typeof args.offset === "number" ? `start=${args.offset + 1}` : null,
              typeof args.length === "number" ? `limit=${args.length}` : null,
              typeof args.source === "string" ? `source=${summarizeToolArg(args.source)}` : null,
              typeof args.name === "string" ? `name=${summarizeToolArg(args.name)}` : null,
              typeof args.conflict === "string"
                ? `conflict=${summarizeToolArg(args.conflict)}`
                : null,
            ]
          : name === "CronTaskManager"
            ? [
                includeManagerAction && typeof args.action === "string"
                  ? `action=${args.action}`
                  : null,
                typeof args.task_id === "string" ? `task=${summarizeToolArg(args.task_id)}` : null,
                typeof args.name === "string" ? `name=${summarizeToolArg(args.name)}` : null,
                typeof args.type === "string" ? `type=${summarizeToolArg(args.type)}` : null,
              ]
            : name === "MemoryManager"
              ? [
                  includeManagerAction && typeof args.action === "string"
                    ? `action=${args.action}`
                    : null,
                  typeof args.slug === "string" ? `slug=${summarizeToolArg(args.slug)}` : null,
                  typeof args.scope === "string" ? `scope=${summarizeToolArg(args.scope)}` : null,
                  typeof args.type === "string" ? `type=${summarizeToolArg(args.type)}` : null,
                  typeof args.query === "string" ? `query=${summarizeToolArg(args.query)}` : null,
                ]
              : name === "McpManager"
                ? [
                    includeManagerAction && typeof args.action === "string"
                      ? `action=${args.action}`
                      : null,
                    typeof args.server_id === "string"
                      ? `server=${summarizeToolArg(args.server_id)}`
                      : null,
                    Array.isArray(args.server_ids) ? `servers=${args.server_ids.length}` : null,
                    typeof args.conflict === "string"
                      ? `conflict=${summarizeToolArg(args.conflict)}`
                      : null,
                    args.include_schema === true ? "includeSchema=true" : null,
                  ]
                : name === "TunnelManager"
                  ? [
                      includeManagerAction && typeof args.action === "string"
                        ? `action=${args.action}`
                        : null,
                      typeof args.targetUrl === "string"
                        ? `target=${summarizeToolArg(args.targetUrl)}`
                        : null,
                      typeof args.slug === "string" ? `slug=${summarizeToolArg(args.slug)}` : null,
                      typeof args.id === "string" ? `id=${summarizeToolArg(args.id)}` : null,
                    ]
                  : name === "SSHManager" || name === "SshManager"
                    ? [
                        includeManagerAction && typeof args.action === "string"
                          ? `action=${args.action}`
                          : null,
                        typeof args.host_id === "string"
                          ? `host=${summarizeToolArg(args.host_id)}`
                          : null,
                        typeof args.session_id === "string"
                          ? `session=${summarizeToolArg(args.session_id)}`
                          : null,
                        typeof args.path === "string" ? `path=${path}` : null,
                        typeof args.command === "string"
                          ? `command=${summarizeToolArg(args.command)}`
                          : null,
                      ]
                    : name === "Agent"
                      ? [
                          typeof args.id === "string" ? `agent=${summarizeToolArg(args.id)}` : null,
                          typeof args.name === "string"
                            ? `name=${summarizeToolArg(args.name)}`
                            : null,
                          typeof args.prompt === "string"
                            ? `prompt=${summarizeToolArg(args.prompt)}`
                            : null,
                          Array.isArray(args.agents) ? `agents=${args.agents.length}` : null,
                          typeof args.mode === "string"
                            ? `mode=${summarizeToolArg(args.mode)}`
                            : null,
                          typeof args.concurrency === "number"
                            ? `concurrency=${args.concurrency}`
                            : null,
                        ]
                      : name === "SendMessage"
                        ? [
                            typeof args.to === "string" ? `to=${summarizeToolArg(args.to)}` : null,
                            typeof args.channel === "string"
                              ? `channel=${summarizeToolArg(args.channel)}`
                              : null,
                            typeof args.subject === "string"
                              ? `subject=${summarizeToolArg(args.subject)}`
                              : null,
                            typeof args.summary === "string" && typeof args.subject !== "string"
                              ? `summary=${summarizeToolArg(args.summary)}`
                              : null,
                            typeof args.message === "string"
                              ? `messageChars=${args.message.length}`
                              : null,
                          ]
                        : name === "Write"
                          ? [scope, path ? `path=${path}` : null, "mode=rewrite"]
                          : name === "Edit"
                            ? [
                                scope,
                                path ? `path=${path}` : null,
                                typeof args.expected_replacements === "number"
                                  ? `expected=${args.expected_replacements}`
                                  : null,
                                args.replace_all === true ? "replaceAll=true" : null,
                              ]
                            : name === "List"
                              ? [
                                  scope,
                                  path ? `path=${path}` : defaultPath,
                                  typeof args.depth === "number" ? `depth=${args.depth}` : null,
                                  typeof args.offset === "number" ? `offset=${args.offset}` : null,
                                  typeof args.max_results === "number"
                                    ? `max=${args.max_results}`
                                    : null,
                                ]
                              : name === "Glob"
                                ? [
                                    scope,
                                    typeof args.pattern === "string"
                                      ? `pattern=${summarizeToolArg(args.pattern)}`
                                      : null,
                                    path ? `path=${path}` : defaultPath,
                                    typeof args.offset === "number"
                                      ? `offset=${args.offset}`
                                      : null,
                                    typeof args.max_results === "number"
                                      ? `max=${args.max_results}`
                                      : null,
                                  ]
                                : name === "Grep"
                                  ? [
                                      scope,
                                      typeof args.pattern === "string"
                                        ? `pattern=${summarizeToolArg(args.pattern)}`
                                        : null,
                                      path ? `path=${path}` : defaultPath,
                                      typeof args.file_pattern === "string"
                                        ? `filePattern=${summarizeToolArg(args.file_pattern)}`
                                        : null,
                                      typeof args.output_mode === "string"
                                        ? `mode=${args.output_mode}`
                                        : null,
                                      typeof args.ignore_case === "boolean"
                                        ? `ignoreCase=${args.ignore_case}`
                                        : null,
                                      typeof args.context === "number"
                                        ? `context=${args.context}`
                                        : null,
                                      typeof args.head_limit === "number"
                                        ? `head=${args.head_limit}`
                                        : null,
                                      args.multiline === true ? "multiline=true" : null,
                                      typeof args.offset === "number"
                                        ? `offset=${args.offset}`
                                        : null,
                                    ]
                                  : name === "Delete"
                                    ? [scope, path ? `path=${path}` : null]
                                    : name === "Bash"
                                      ? [
                                          scope,
                                          typeof args.cwd === "string"
                                            ? `cwd=${summarizeToolArg(args.cwd)}`
                                            : defaultCwd,
                                          summarizeBashTimeout(args.timeout_ms),
                                          typeof args.command === "string"
                                            ? `command=${summarizeToolArg(args.command)}`
                                            : null,
                                        ]
                                      : name === "ManagedProcess"
                                        ? [
                                            includeManagerAction && typeof args.action === "string"
                                              ? `action=${args.action}`
                                              : null,
                                            typeof args.process_id === "string"
                                              ? `process=${summarizeToolArg(args.process_id)}`
                                              : null,
                                            typeof args.label === "string"
                                              ? `label=${summarizeToolArg(args.label)}`
                                              : null,
                                            typeof args.cwd === "string"
                                              ? `cwd=${summarizeToolArg(args.cwd)}`
                                              : null,
                                            args.isolated === true ? "isolated=true" : null,
                                            typeof args.max_bytes === "number"
                                              ? `maxBytes=${args.max_bytes}`
                                              : null,
                                          ]
                                        : [];

  const summary = parts.filter(Boolean).join(" ");
  if (!summary) return includeName ? name : "";
  return includeName ? `${name} ${summary}` : summary;
}

function summarizeImageSourceArg(value: unknown) {
  const text = summarizeToolArg(value);
  if (!text) return text;
  if (/^data:image\//i.test(text)) {
    return `dataUrlChars=${String(value).length}`;
  }
  if (/^[A-Za-z0-9+/=\s_-]{200,}$/.test(String(value))) {
    return `base64Chars=${String(value).length}`;
  }
  return text;
}

function summarizeImageArgValue(key: string, value: unknown) {
  if (key === "base64") {
    return typeof value === "string" ? `base64Chars=${value.length}` : value;
  }
  if (key === "base64s" && Array.isArray(value)) {
    return value.map((item) => (typeof item === "string" ? `base64Chars=${item.length}` : item));
  }
  if (key === "source") {
    return summarizeImageSourceArg(value);
  }
  if (key === "sources" && Array.isArray(value)) {
    return value.map((item) => summarizeImageSourceArg(item));
  }
  return value;
}

// Render-layer tolerance for historical messages: current payloads carry
// `scope` ("workspace" | "skill" | "external"), while old sessions may still
// carry the legacy `root` ("workspace" | "skills") or unknown scope values
// such as "temp"/"artifact". Degrade at the read site — unknown values are
// displayed verbatim; "workspace" (the default) is hidden.
function displayFileToolScope(source: unknown) {
  const record =
    source && typeof source === "object" && !Array.isArray(source)
      ? (source as Record<string, unknown>)
      : {};
  const scope =
    typeof record.scope === "string" && record.scope.trim() ? record.scope.trim() : undefined;
  const legacyRoot =
    typeof record.root === "string" && record.root.trim() ? record.root.trim() : undefined;
  const resolved = scope ?? (legacyRoot === "skills" ? "skill" : legacyRoot);
  return resolved && resolved !== "workspace" ? resolved : undefined;
}

function displayFileToolScopeEntry(source: unknown) {
  const displayScope = displayFileToolScope(source);
  return displayScope ? { scope: displayScope } : {};
}

export function toolCallArgsForDisplay(toolCall: ToolCall) {
  const args = toolCall.arguments || {};
  const name = toolCall.name;

  switch (name) {
    case "Write":
      return {
        ...displayFileToolScopeEntry(args),
        path: args.path,
        mode: "rewrite",
        contentChars: fileToolFieldChars(args, "content"),
      };
    case "Edit":
      return {
        ...displayFileToolScopeEntry(args),
        path: args.path,
        expected_replacements: args.expected_replacements,
        replace_all: args.replace_all,
        oldChars: fileToolFieldChars(args, "old_string"),
        newChars: fileToolFieldChars(args, "new_string"),
      };
    case "Image": {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(args)) {
        out[key] = summarizeImageArgValue(key, value);
      }
      return out;
    }
    case "McpManager":
      return redactMcpManagerArgsForDisplay(args);
    case "MemoryManager":
      return {
        action: args.action,
        slug: args.slug,
        scope: args.scope,
        type: args.type,
        mode: args.mode,
        query: args.query,
        description: args.description,
        bodyChars: typeof args.body === "string" ? args.body.length : undefined,
      };
    case "Agent":
      return summarizeAgentArgsForDisplay(args);
    case "SendMessage":
      return {
        to: args.to,
        channel: args.channel,
        subject: args.subject ?? args.summary,
        messageChars: typeof args.message === "string" ? args.message.length : undefined,
      };
    default: {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(args)) {
        if (key === LIVE_TOOL_PREVIEW_META_KEY) continue;
        if (typeof value === "string" && value.length > 800) {
          out[key] = `${value.slice(0, 800)}...（len=${value.length}）`;
        } else {
          out[key] = value;
        }
      }
      return out;
    }
  }
}

function summarizeAgentArgsForDisplay(args: Record<string, unknown>) {
  const prompt = typeof args.prompt === "string" ? args.prompt : undefined;
  const summary: Record<string, unknown> = {
    id: args.id,
    name: args.name,
    role: args.role,
    prompt:
      typeof prompt === "string" && prompt.length > 800
        ? `${prompt.slice(0, 800)}...（len=${prompt.length}）`
        : prompt,
    mode: args.mode,
    identityChars: typeof args.identity === "string" ? args.identity.length : undefined,
    promptChars: typeof prompt === "string" ? prompt.length : undefined,
    agentCount: Array.isArray(args.agents) ? args.agents.length : undefined,
    concurrency: args.concurrency,
  };
  if (args.template !== undefined) summary.template = args.template;
  if (args.apply_policy !== undefined) summary.apply_policy = args.apply_policy;
  if (args.allowed_output_paths !== undefined) {
    summary.allowed_output_paths = args.allowed_output_paths;
  }
  return summary;
}

function redactMcpManagerArgsForDisplay(args: Record<string, unknown>) {
  const redactServer = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const server = { ...(value as Record<string, unknown>) };
    if (server.env && typeof server.env === "object" && !Array.isArray(server.env)) {
      server.env = Object.fromEntries(
        Object.keys(server.env as Record<string, unknown>).map((key) => [key, "<redacted>"]),
      );
    }
    if (server.headers && typeof server.headers === "object" && !Array.isArray(server.headers)) {
      server.headers = Object.fromEntries(
        Object.keys(server.headers as Record<string, unknown>).map((key) => [key, "<redacted>"]),
      );
    }
    return server;
  };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === "server" || key === "patch") {
      out[key] = redactServer(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function previewText(input: string, maxChars = 1200) {
  const text = input || "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...（已截断预览，len=${text.length}）...`;
}

// Deterministic next id for a text-like block: one more than the highest
// existing ordinal of the same kind. A pure function of the current array, so
// replays of the same block sequence assign identical ids.
function nextTextLikeBlockId(blocks: UiRoundContentBlock[], kind: "thinking" | "text") {
  let max = 0;
  for (const block of blocks) {
    if (block.kind !== kind) continue;
    const suffix = Number(block.id.slice(kind.length + 1));
    if (Number.isFinite(suffix) && suffix > max) max = suffix;
  }
  return `${kind}-${max + 1}`;
}

function appendTextLikeBlock(
  blocks: UiRoundContentBlock[],
  kind: "thinking" | "text",
  delta: string,
) {
  if (!delta) return blocks;
  const last = blocks[blocks.length - 1];
  if (last?.kind === kind) {
    const next = blocks.slice();
    next[next.length - 1] = {
      kind,
      id: last.id,
      text: last.text + delta,
    };
    return next;
  }
  return [...blocks, { kind, id: nextTextLikeBlockId(blocks, kind), text: delta }];
}

function rebalanceHostedSearchTextBoundaries(blocks: UiRoundContentBlock[]): UiRoundContentBlock[] {
  const out: UiRoundContentBlock[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const current = blocks[index];
    if (current?.kind === "text") {
      const hostedStart = index + 1;
      let hostedEnd = hostedStart;
      while (blocks[hostedEnd]?.kind === "hostedSearch") {
        hostedEnd += 1;
      }
      const following = blocks[hostedEnd];
      if (hostedEnd > hostedStart && following?.kind === "text") {
        const combinedText = current.text + following.text;
        const boundary = resolveHostedSearchTextBoundary(combinedText, current.text.length);
        if (boundary > current.text.length) {
          const before = combinedText.slice(0, boundary);
          const after = combinedText.slice(boundary);
          if (before) {
            out.push({ kind: "text", id: current.id, text: before });
          }
          out.push(...blocks.slice(hostedStart, hostedEnd));
          if (after) {
            out.push({ kind: "text", id: following.id, text: after });
          }
          index = hostedEnd;
          continue;
        }
      }
    }
    out.push(current);
  }
  return out;
}

function isSubagentCardToolCall(toolCall: ToolCall) {
  return toolCall.name === "Agent" && isSubagentCardArguments(toolCall.arguments);
}

function isParentAgentToolCall(toolCall: ToolCall) {
  return toolCall.name === "Agent" && !isSubagentCardToolCall(toolCall);
}

// 与 agent-gui lib/providers/nativeWebSearch.ts 的同名判定保持一致（手动同步）。
function isProviderNativeWebSearchToolName(toolName: string | undefined) {
  const normalized = toolName?.trim().toLowerCase() ?? "";
  return (
    normalized === "builtin_web_search" ||
    normalized === "websearch" ||
    normalized === "web_search" ||
    normalized === "web_search_20250305" ||
    normalized === "web_search_20260209" ||
    normalized === "web_search_20260318" ||
    normalized === "web_search_preview" ||
    normalized.startsWith("web_search_call") ||
    normalized === "x_search" ||
    normalized === "x_keyword_search" ||
    normalized === "x_semantic_search" ||
    normalized.startsWith("x_search_call")
  );
}

function isDsmlRecoveredToolCallId(toolCallId: string | undefined) {
  return toolCallId?.startsWith("dsml-tool-call-") ?? false;
}

function isRecoveredProviderNativeWebSearchResult(toolResult: ToolResultMessage | undefined) {
  const details = toolResult?.details as Record<string, unknown> | undefined;
  return details?.recoveredProviderNativeWebSearch === true;
}

export function shouldDisplayToolTraceItem(
  item: ToolTraceItem,
  options?: { hasHostedSearch?: boolean },
) {
  if (!isProviderNativeWebSearchToolName(item.toolCall.name)) {
    return true;
  }
  if (options?.hasHostedSearch) {
    return false;
  }
  if (isDsmlRecoveredToolCallId(item.toolCall.id)) {
    return false;
  }
  if (isRecoveredProviderNativeWebSearchResult(item.toolResult)) {
    return false;
  }
  return true;
}

function shouldDisplayToolBlock(
  toolCall: ToolCall,
  toolResult: ToolResultMessage | undefined,
  blocks: UiRoundContentBlock[],
  options?: { contentHasHostedSearch?: boolean },
) {
  return shouldDisplayToolTraceItem(toolResult ? { toolCall, toolResult } : { toolCall }, {
    hasHostedSearch:
      options?.contentHasHostedSearch || blocks.some((block) => block.kind === "hostedSearch"),
  });
}

function filterHiddenToolBlocks(blocks: UiRoundContentBlock[]) {
  const hasHostedSearch = blocks.some((block) => block.kind === "hostedSearch");
  return blocks.filter(
    (block) => block.kind !== "tool" || shouldDisplayToolTraceItem(block.item, { hasHostedSearch }),
  );
}

const SUBAGENT_PLACEHOLDER_MAX_AGENTS = 8;

function asPlainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/**
 * Live placeholder cards while the parent Agent call's arguments stream.
 * The streaming JSON parser yields partial `agents` arrays; an element only
 * renders once its `id` and `prompt` fields have started streaming. Indexes
 * follow the raw array so placeholder ids match the authoritative cards
 * emitted when execution starts.
 */
export function buildSubagentPlaceholderToolCalls(parentToolCall: ToolCall): ToolCall[] {
  if (!isParentAgentToolCall(parentToolCall)) return [];
  const args = asPlainObject(parentToolCall.arguments);
  const rawAgents = Array.isArray(args.agents) ? args.agents : [];
  if (rawAgents.length === 0 || rawAgents.length > SUBAGENT_PLACEHOLDER_MAX_AGENTS) return [];
  const concurrency = Math.min(
    rawAgents.length,
    clampInteger(
      args.concurrency,
      SUBAGENT_PLACEHOLDER_MAX_AGENTS,
      1,
      SUBAGENT_PLACEHOLDER_MAX_AGENTS,
    ),
  );

  const placeholders: ToolCall[] = [];
  rawAgents.forEach((rawAgent, index) => {
    const record = asPlainObject(rawAgent);
    const id = optionalText(record.id);
    const prompt = optionalText(record.prompt);
    if (!id || !prompt) return;
    placeholders.push({
      type: "toolCall",
      id: buildSubagentCardToolCallId(parentToolCall.id, index + 1),
      name: "Agent",
      arguments: {
        subagent_card: true,
        parent_tool_call_id: parentToolCall.id,
        index: index + 1,
        total: rawAgents.length,
        concurrency,
        id,
        name: optionalText(record.name),
        role: optionalText(record.role),
        mode: record.mode === "worktree" || record.mode === "readonly" ? record.mode : undefined,
        prompt,
      },
    });
  });
  return placeholders;
}

function isSubagentBatchResult(
  toolResult: ToolResultMessage | undefined,
): toolResult is ToolResultMessage & { details: SubagentBatchDetails } {
  const details = toolResult?.details as Partial<SubagentBatchDetails> | undefined;
  return details?.kind === "subagent_batch" && Array.isArray(details.agents);
}

function buildSubagentCardToolCallFromReport(params: {
  parentToolCall: ToolCall;
  details: SubagentBatchDetails;
  index: number;
  agent: SubagentBatchDetails["agents"][number];
}): ToolCall {
  return {
    type: "toolCall",
    id: buildSubagentCardToolCallId(params.parentToolCall.id, params.index + 1),
    name: "Agent",
    arguments: {
      subagent_card: true,
      parent_tool_call_id: params.parentToolCall.id,
      index: params.index + 1,
      total: params.details.agentCount,
      concurrency: params.details.concurrency,
      id: params.agent.id,
      name: params.agent.name,
      role: params.agent.role,
      prompt: params.agent.prompt,
      mode: params.agent.mode,
    },
  };
}

function buildSubagentCardToolResultFromReport(params: {
  parentToolResult: ToolResultMessage;
  toolCall: ToolCall;
  details: SubagentBatchDetails;
  index: number;
  agent: SubagentBatchDetails["agents"][number];
}): ToolResultMessage {
  const details: SubagentCardDetails = {
    kind: "subagent_card",
    parentToolCallId: params.parentToolResult.toolCallId,
    index: params.index,
    total: params.details.agentCount,
    concurrency: params.details.concurrency,
    agent: params.agent,
  };
  return {
    role: "toolResult",
    toolCallId: params.toolCall.id,
    toolName: params.toolCall.name,
    content: [
      {
        type: "text",
        text:
          params.agent.error ||
          params.agent.applyError ||
          params.agent.summary ||
          params.agent.prompt ||
          "",
      },
    ],
    details,
    isError: params.agent.status !== "completed",
    timestamp: params.parentToolResult.timestamp,
  };
}

function appendSubagentPlaceholderBlocks(blocks: UiRoundContentBlock[], parentToolCall: ToolCall) {
  let next = blocks;
  for (const toolCall of buildSubagentPlaceholderToolCalls(parentToolCall)) {
    next = upsertToolBlock(next, toolCall);
  }
  return next;
}

function appendSubagentCardBlocks(
  blocks: UiRoundContentBlock[],
  parentToolCall: ToolCall,
  parentToolResult: ToolResultMessage | undefined,
) {
  if (!isSubagentBatchResult(parentToolResult)) return blocks;

  let next = blocks;
  const details = parentToolResult.details as SubagentBatchDetails;
  details.agents.forEach((agent, index: number) => {
    const toolCall = buildSubagentCardToolCallFromReport({
      parentToolCall,
      details,
      index,
      agent,
    });
    const toolResult = buildSubagentCardToolResultFromReport({
      parentToolResult,
      toolCall,
      details,
      index,
      agent,
    });
    next = upsertToolBlock(next, toolCall, toolResult);
  });
  return next;
}

// A rejected batch never fans out into result-bearing cards, so streaming
// placeholders that never resolved would linger as forever-pending blocks
// next to the parent's error block. Drop them; resolved cards stay.
function removeUnresolvedSubagentPlaceholderBlocks(
  blocks: UiRoundContentBlock[],
  parentToolCallId: string,
) {
  const placeholderIdPrefix = `${parentToolCallId}:agent:`;
  return blocks.filter(
    (block) =>
      !(
        block.kind === "tool" &&
        !block.item.toolResult &&
        block.item.toolCall.id?.startsWith(placeholderIdPrefix)
      ),
  );
}

function upsertToolBlock(
  blocks: UiRoundContentBlock[],
  toolCall: ToolCall,
  toolResult?: ToolResultMessage,
  options?: { contentHasHostedSearch?: boolean },
): UiRoundContentBlock[] {
  // The parent Agent call is suppressed in favor of per-agent cards, except
  // when it failed — a rejected batch must stay visible. While the parent's
  // arguments stream, structured `agents` entries render as placeholder cards.
  if (isParentAgentToolCall(toolCall) && toolResult?.isError !== true) {
    if (toolResult) return appendSubagentCardBlocks(blocks, toolCall, toolResult);
    return appendSubagentPlaceholderBlocks(blocks, toolCall);
  }
  const baseBlocks = isParentAgentToolCall(toolCall)
    ? removeUnresolvedSubagentPlaceholderBlocks(blocks, toolCall.id)
    : blocks;
  const toolCallSnapshot = snapshotToolCallForTrace(toolCall);

  const existingIdx = baseBlocks.findIndex(
    (block) => block.kind === "tool" && block.item.toolCall.id === toolCallSnapshot.id,
  );
  if (!shouldDisplayToolBlock(toolCallSnapshot, toolResult, baseBlocks, options)) {
    return existingIdx >= 0
      ? baseBlocks.filter(
          (block) => !(block.kind === "tool" && block.item.toolCall.id === toolCallSnapshot.id),
        )
      : baseBlocks;
  }
  if (existingIdx >= 0) {
    const existing = baseBlocks[existingIdx];
    if (existing.kind !== "tool") return baseBlocks;
    const next = baseBlocks.slice();
    next[existingIdx] = {
      kind: "tool",
      item: {
        ...existing.item,
        toolCall: toolCallSnapshot,
        toolResult: toolResult ?? existing.item.toolResult,
      },
    };
    return next;
  }

  const nextBlock: UiRoundContentBlock = {
    kind: "tool",
    item: toolResult ? { toolCall: toolCallSnapshot, toolResult } : { toolCall: toolCallSnapshot },
  };
  return [...baseBlocks, nextBlock];
}

export function getRoundText(round: Pick<UiRound, "blocks">) {
  let text = "";
  for (const block of round.blocks) {
    if (block.kind === "text") text += block.text;
  }
  return text;
}

export function getRoundThinkingText(round: Pick<UiRound, "blocks">) {
  let text = "";
  for (const block of round.blocks) {
    if (block.kind === "thinking") text += block.text;
  }
  return text;
}

export function getRoundToolTrace(round: Pick<UiRound, "blocks">): ToolTraceItem[] {
  const hasHostedSearch = round.blocks.some((block) => block.kind === "hostedSearch");
  return round.blocks.flatMap((block) =>
    block.kind === "tool" && shouldDisplayToolTraceItem(block.item, { hasHostedSearch })
      ? [block.item]
      : [],
  );
}

export function getRoundHostedSearches(round: Pick<UiRound, "blocks">): HostedSearchBlock[] {
  return round.blocks.flatMap((block) => (block.kind === "hostedSearch" ? [block.item] : []));
}

export function hasRoundContent(round: Pick<UiRound, "blocks">) {
  return (
    getRoundText(round).trim().length > 0 ||
    getRoundThinkingText(round).trim().length > 0 ||
    getRoundToolTrace(round).length > 0 ||
    getRoundHostedSearches(round).length > 0
  );
}

export function appendTextDeltaToRound<TRound extends Pick<UiRound, "blocks">>(
  round: TRound,
  delta: string,
): TRound {
  return {
    ...round,
    blocks: rebalanceHostedSearchTextBoundaries(appendTextLikeBlock(round.blocks, "text", delta)),
  };
}

export function appendThinkingDeltaToRound<TRound extends Pick<UiRound, "blocks">>(
  round: TRound,
  delta: string,
): TRound {
  return {
    ...round,
    blocks: appendTextLikeBlock(round.blocks, "thinking", delta),
  };
}

export function upsertToolCallToRound<TRound extends Pick<UiRound, "blocks">>(
  round: TRound,
  toolCall: ToolCall,
): TRound {
  return {
    ...round,
    blocks: upsertToolBlock(round.blocks, toolCall),
  };
}

export function attachToolResultToRound<TRound extends Pick<UiRound, "blocks">>(
  round: TRound,
  toolCall: ToolCall,
  toolResult: ToolResultMessage,
): TRound {
  return {
    ...round,
    blocks: upsertToolBlock(round.blocks, toolCall, toolResult),
  };
}

function findLastTextBlockIndex(blocks: UiRoundContentBlock[]) {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index]?.kind === "text") return index;
  }
  return -1;
}

function findHostedSearchGroupInsertIndex(blocks: UiRoundContentBlock[]) {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (!block) continue;
    if (block.kind === "tool") break;
    if (block.kind === "hostedSearch") return index + 1;
  }
  return -1;
}

function upsertHostedSearchBlock(blocks: UiRoundContentBlock[], hostedSearch: HostedSearchBlock) {
  const idx = blocks.findIndex(
    (block) => block.kind === "hostedSearch" && block.item.id === hostedSearch.id,
  );
  if (idx < 0) {
    const nextBlock = { kind: "hostedSearch" as const, item: hostedSearch };
    const lastTextIndex = findLastTextBlockIndex(blocks);
    const lastTextBlock = lastTextIndex >= 0 ? blocks[lastTextIndex] : null;
    if (lastTextBlock?.kind === "text") {
      const split = splitTextAroundHostedSearch(lastTextBlock.text, hostedSearch);
      if (split) {
        // The before-half keeps the original id (its rendered prefix is
        // unchanged); only the after-half is a genuinely new block.
        return filterHiddenToolBlocks([
          ...blocks.slice(0, lastTextIndex),
          { kind: "text" as const, id: lastTextBlock.id, text: split.before },
          nextBlock,
          ...(split.after
            ? [
                {
                  kind: "text" as const,
                  id: nextTextLikeBlockId(blocks, "text"),
                  text: split.after,
                },
              ]
            : []),
          ...blocks.slice(lastTextIndex + 1),
        ]);
      }
    }
    const groupedSearchInsertIndex = findHostedSearchGroupInsertIndex(blocks);
    if (groupedSearchInsertIndex >= 0) {
      return filterHiddenToolBlocks(
        rebalanceHostedSearchTextBoundaries([
          ...blocks.slice(0, groupedSearchInsertIndex),
          nextBlock,
          ...blocks.slice(groupedSearchInsertIndex),
        ]),
      );
    }
    return filterHiddenToolBlocks(rebalanceHostedSearchTextBoundaries([...blocks, nextBlock]));
  }
  const next = blocks.slice();
  const existing = next[idx];
  if (existing?.kind !== "hostedSearch") return blocks;
  next[idx] = {
    kind: "hostedSearch",
    item: mergeHostedSearchBlocks(existing.item, hostedSearch),
  };
  return filterHiddenToolBlocks(next);
}

export function upsertHostedSearchToRound<TRound extends Pick<UiRound, "blocks">>(
  round: TRound,
  hostedSearch: HostedSearchBlock,
): TRound {
  return {
    ...round,
    blocks: upsertHostedSearchBlock(round.blocks, hostedSearch),
  };
}

function buildUiRoundBlocks(
  assistant: AssistantMessage,
  toolResultById: Map<string, ToolResultMessage>,
) {
  let blocks: UiRoundContentBlock[] = [];
  const content = enrichHostedSearchContentWithText(
    assistant.content,
  ) as AssistantMessage["content"];
  const contentHasHostedSearch = content.some((block) =>
    Boolean(normalizeHostedSearchBlock(block)),
  );
  for (const block of content) {
    if (block.type === "text") {
      blocks = appendTextLikeBlock(blocks, "text", block.text);
      continue;
    }
    if (block.type === "thinking") {
      blocks = appendTextLikeBlock(blocks, "thinking", block.thinking);
      continue;
    }
    if (block.type === "toolCall") {
      const toolResult = toolResultById.get(block.id);
      if (isParentAgentToolCall(block) && toolResult?.isError !== true) {
        blocks = appendSubagentCardBlocks(blocks, block, toolResult);
        continue;
      }
      blocks = upsertToolBlock(blocks, block, toolResult, { contentHasHostedSearch });
      continue;
    }
    const hostedSearch = normalizeHostedSearchBlock(block);
    if (hostedSearch) {
      blocks = upsertHostedSearchBlock(blocks, hostedSearch);
    }
  }
  return blocks;
}

export function buildUiMessages(messages: Message[]): UiMessage[] {
  const out: UiMessage[] = [];
  let i = 0;

  while (i < messages.length) {
    const message = messages[i];

    if (message.role === "user") {
      out.push({
        key: `user-${i}-${message.timestamp}`,
        role: "user",
        text: getMessageText(message),
        attachments: getUserMessageAttachments(message as Message & Record<string, unknown>),
        messageIndex: i,
      });
      i += 1;
      continue;
    }

    const groupStartIndex = i;
    const rounds: UiRound[] = [];
    let roundNum = 0;
    let lastAssistantTimestamp = 0;

    while (i < messages.length && messages[i].role !== "user") {
      if (messages[i].role === "assistant") {
        roundNum += 1;
        const assistant = messages[i] as AssistantMessage;
        lastAssistantTimestamp = assistant.timestamp ?? lastAssistantTimestamp;

        const toolResults: ToolResultMessage[] = [];
        let j = i + 1;
        while (j < messages.length && messages[j].role === "toolResult") {
          toolResults.push(messages[j] as ToolResultMessage);
          j += 1;
        }
        i = j;

        const toolResultById = new Map<string, ToolResultMessage>();
        for (const toolResult of toolResults) {
          toolResultById.set(toolResult.toolCallId, toolResult);
        }

        const blocks = buildUiRoundBlocks(assistant, toolResultById);
        const hasContent = hasRoundContent({ blocks });

        if (!hasContent) continue;

        rounds.push({
          round: roundNum,
          blocks,
          meta: {
            provider: String(assistant.provider ?? ""),
            model: String(assistant.model ?? ""),
            api: String(assistant.api ?? ""),
            stopReason: String(assistant.stopReason ?? ""),
            usage: assistant.usage as Usage | undefined,
            usageTotalTokens: assistant.usage?.totalTokens,
          },
        });
      } else {
        i += 1;
      }
    }

    if (rounds.length > 0) {
      const lastText = getRoundText(rounds[rounds.length - 1]);
      out.push({
        key: `assistant-${groupStartIndex}-${i}-${lastAssistantTimestamp}`,
        role: "assistant",
        text: lastText,
        rounds,
      });
    }
  }

  return out;
}
