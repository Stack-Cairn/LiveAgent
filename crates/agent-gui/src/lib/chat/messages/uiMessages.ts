import type {
  AssistantMessage,
  Message,
  ToolCall,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import { assistantMessageToText } from "../../providers/llm";
import { isProviderNativeWebSearchToolName } from "../../providers/nativeWebSearch";
import { GLOBAL_BASH_MAX_TIMEOUT_MS, MIN_BASH_TIMEOUT_MS } from "../../tools/bashTimeoutPolicy";
import type {
  DelegateAgentCardResultDetails,
  DelegateAgentResultDetails,
} from "../../tools/builtinTypes";
import {
  enrichHostedSearchContentWithText,
  type HostedSearchBlock,
  mergeHostedSearchBlocks,
  normalizeHostedSearchBlock,
  resolveHostedSearchTextBoundary,
  splitTextAroundHostedSearch,
} from "./hostedSearch";
import {
  getUserMessageAttachments,
  getUserMessageDisplayText,
  type PendingUploadedFile,
} from "./uploadedFiles";

export type ToolTraceItem = {
  toolCall: ToolCall;
  toolResult?: ToolResultMessage;
};

export type UiRoundContentBlock =
  | {
      kind: "thinking";
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

export type LiveRound = UiRound & {
  key: string;
  runningToolCallIds: string[];
  thinkingOpen: boolean;
};

export type UiMessage = {
  key: string;
  role: "user" | "assistant";
  text: string;
  attachments?: PendingUploadedFile[];
  rounds?: UiRound[];
  messageIndex?: number;
};

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
                          typeof args.agent_id === "string"
                            ? `agent=${summarizeToolArg(args.agent_id)}`
                            : null,
                          typeof args.name === "string"
                            ? `name=${summarizeToolArg(args.name)}`
                            : null,
                          typeof args.prompt === "string"
                            ? `prompt=${summarizeToolArg(args.prompt)}`
                            : null,
                          typeof args.agent_spec === "string"
                            ? `agentSpecChars=${args.agent_spec.length}`
                            : null,
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
                          ? [
                              path ? `path=${path}` : null,
                              "mode=rewrite",
                              typeof args.content === "string"
                                ? `contentChars=${
                                    streamingPreviewFieldChars(args, "content") ??
                                    args.content.length
                                  }`
                                : null,
                            ]
                          : name === "Edit"
                            ? [
                                path ? `path=${path}` : null,
                                typeof args.expected_replacements === "number"
                                  ? `expected=${args.expected_replacements}`
                                  : null,
                                args.replace_all === true ? "replaceAll=true" : null,
                                typeof args.old_string === "string"
                                  ? `oldChars=${
                                      streamingPreviewFieldChars(args, "old_string") ??
                                      args.old_string.length
                                    }`
                                  : null,
                                typeof args.new_string === "string"
                                  ? `newChars=${
                                      streamingPreviewFieldChars(args, "new_string") ??
                                      args.new_string.length
                                    }`
                                  : null,
                              ]
                            : name === "List"
                              ? [
                                  path ? `path=${path}` : defaultPath,
                                  typeof args.depth === "number" ? `depth=${args.depth}` : null,
                                  typeof args.offset === "number" ? `offset=${args.offset}` : null,
                                  typeof args.max_results === "number"
                                    ? `max=${args.max_results}`
                                    : null,
                                ]
                              : name === "Glob"
                                ? [
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
                                    ? [path ? `path=${path}` : null]
                                    : name === "Bash"
                                      ? [
                                          typeof args.cwd === "string"
                                            ? `cwd=${summarizeToolArg(args.cwd)}`
                                            : defaultCwd,
                                          summarizeBashTimeout(args.timeout_ms),
                                          typeof args.command === "string"
                                            ? `command=${summarizeToolArg(args.command)}`
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

export function toolCallArgsForDisplay(toolCall: ToolCall) {
  const args = toolCall.arguments || {};
  const name = toolCall.name;

  switch (name) {
    case "Write":
      return {
        path: args.path,
        mode: "rewrite",
        contentChars:
          typeof args.content === "string"
            ? (streamingPreviewFieldChars(args, "content") ?? args.content.length)
            : undefined,
      };
    case "Edit":
      return {
        path: args.path,
        expected_replacements: args.expected_replacements,
        replace_all: args.replace_all,
        oldChars:
          typeof args.old_string === "string"
            ? (streamingPreviewFieldChars(args, "old_string") ?? args.old_string.length)
            : undefined,
        newChars:
          typeof args.new_string === "string"
            ? (streamingPreviewFieldChars(args, "new_string") ?? args.new_string.length)
            : undefined,
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
    agent_id: args.agent_id,
    name: args.name,
    role: args.role,
    prompt:
      typeof prompt === "string" && prompt.length > 800
        ? `${prompt.slice(0, 800)}...（len=${prompt.length}）`
        : prompt,
    mode: args.mode,
    identityChars: typeof args.identity === "string" ? args.identity.length : undefined,
    promptChars: typeof prompt === "string" ? prompt.length : undefined,
    agentSpecChars: typeof args.agent_spec === "string" ? args.agent_spec.length : undefined,
    concurrency: args.concurrency,
  };
  if (args.task_intent !== undefined) summary.task_intent = args.task_intent;
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

export const LIVE_TOOL_PREVIEW_META_KEY = "__liveagent_stream_preview";

type StreamingPreviewFieldMetrics = {
  chars?: number;
  lines?: number;
  truncated?: boolean;
};

function asPlainRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStreamingPreviewFieldMetrics(
  args: Record<string, unknown>,
  fieldName: string,
): StreamingPreviewFieldMetrics | undefined {
  const metadata = asPlainRecord(args[LIVE_TOOL_PREVIEW_META_KEY]);
  const fields = asPlainRecord(metadata.fields);
  const field = asPlainRecord(fields[fieldName]);
  if (Object.keys(field).length === 0) return undefined;
  return {
    chars: finiteNumber(field.chars),
    lines: finiteNumber(field.lines),
    truncated: typeof field.truncated === "boolean" ? field.truncated : undefined,
  };
}

function streamingPreviewFieldChars(args: Record<string, unknown>, fieldName: string) {
  return readStreamingPreviewFieldMetrics(args, fieldName)?.chars;
}

export function countTextLines(input: string) {
  if (input.length === 0) return 0;
  let lines = 1;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code === 13) {
      lines += 1;
      if (input.charCodeAt(index + 1) === 10) {
        index += 1;
      }
    } else if (code === 10) {
      lines += 1;
    }
  }
  return lines;
}

export function buildStreamingToolTextPreview(
  input: string,
  maxChars = 4000,
  metrics?: StreamingPreviewFieldMetrics,
) {
  const text = input || "";
  const renderedText = previewText(text, maxChars);
  return {
    text: renderedText,
    chars: metrics?.chars ?? text.length,
    lines: metrics?.lines ?? countTextLines(text),
    truncated: metrics?.truncated ?? text.length > maxChars,
  };
}

export function getStreamingWriteToolPreview(toolCall: {
  name: string;
  arguments?: Record<string, unknown>;
}) {
  if (toolCall.name !== "Write") return null;
  const args = toolCall.arguments || {};
  const hasContent = typeof args.content === "string";
  const content = hasContent ? (args.content as string) : "";
  const contentMetrics = readStreamingPreviewFieldMetrics(args, "content");
  return {
    path: typeof args.path === "string" ? (args.path as string) : "",
    mode: "rewrite" as const,
    hasContent,
    content: buildStreamingToolTextPreview(content, 4000, contentMetrics),
  };
}

export function getStreamingEditToolPreview(toolCall: {
  name: string;
  arguments?: Record<string, unknown>;
}) {
  if (toolCall.name !== "Edit") return null;
  const args = toolCall.arguments || {};
  const hasOldString = typeof args.old_string === "string";
  const hasNewString = typeof args.new_string === "string";
  const oldString = hasOldString ? (args.old_string as string) : "";
  const newString = hasNewString ? (args.new_string as string) : "";
  const oldStringMetrics = readStreamingPreviewFieldMetrics(args, "old_string");
  const newStringMetrics = readStreamingPreviewFieldMetrics(args, "new_string");
  return {
    path: typeof args.path === "string" ? (args.path as string) : "",
    hasOldString,
    hasNewString,
    oldString: buildStreamingToolTextPreview(oldString, 4000, oldStringMetrics),
    newString: buildStreamingToolTextPreview(newString, 4000, newStringMetrics),
    expectedReplacements:
      typeof args.expected_replacements === "number" ? args.expected_replacements : undefined,
    replaceAll: args.replace_all === true,
  };
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
      text: last.text + delta,
    };
    return next;
  }
  return [...blocks, { kind, text: delta }];
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
            out.push({ kind: "text", text: before });
          }
          out.push(...blocks.slice(hostedStart, hostedEnd));
          if (after) {
            out.push({ kind: "text", text: after });
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

function isDelegateAgentCardToolCall(toolCall: ToolCall) {
  return toolCall.name === "Agent" && toolCall.arguments?.delegate_agent_card === true;
}

function isParentDelegateAgentToolCall(toolCall: ToolCall) {
  return toolCall.name === "Agent" && !isDelegateAgentCardToolCall(toolCall);
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

type DelegateAgentPlaceholder = {
  id: string;
  name?: string;
  role?: string;
  prompt: string;
  agentId?: string;
  mode: "readonly" | "worktree";
  taskIntent: "communication" | "research" | "review" | "implementation" | "document_generation";
  applyPolicy: "none" | "explicit" | "auto";
  allowedOutputPaths: string[];
};

const DELEGATE_AGENT_PLACEHOLDER_MAX_AGENTS = 8;
const DELEGATE_AGENT_PLACEHOLDER_DEFAULT_CONCURRENCY = 8;
const DELEGATE_AGENT_PLACEHOLDER_MAX_CONCURRENCY = 8;

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

function normalizePlaceholderMode(value: unknown): DelegateAgentPlaceholder["mode"] | undefined {
  return value === "readonly" || value === "worktree" ? value : undefined;
}

function normalizePlaceholderTaskIntent(
  value: unknown,
): DelegateAgentPlaceholder["taskIntent"] | undefined {
  return value === "communication" ||
    value === "research" ||
    value === "review" ||
    value === "implementation" ||
    value === "document_generation"
    ? value
    : undefined;
}

function normalizePlaceholderApplyPolicy(
  value: unknown,
): DelegateAgentPlaceholder["applyPolicy"] | undefined {
  return value === "none" || value === "explicit" || value === "auto" ? value : undefined;
}

function normalizePlaceholderPathList(value: unknown): string[] {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,\n]/g)
      : [];
  const out: string[] = [];
  for (const raw of rawItems) {
    if (typeof raw !== "string") continue;
    const normalized = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function maybePlaceholderOutputPath(value: string) {
  const text = value.trim().replace(/^[`"'“”‘’]+|[`"'“”‘’，,。.；;:：)）\]]+$/g, "");
  if (!text || /[*?[\]]/.test(text) || /^https?:\/\//i.test(text)) return "";
  if (/\s/.test(text)) return "";
  if (!/\.[a-z0-9]{1,12}$/i.test(text)) return "";
  return text.replace(/\\/g, "/").replace(/^\.\//, "");
}

function inferPlaceholderAllowedOutputPaths(params: { prompt?: string }): string[] {
  const text = params.prompt ?? "";
  const out: string[] = [];
  const pushPath = (value: string) => {
    const normalized = maybePlaceholderOutputPath(value);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  };

  for (const match of text.matchAll(/`([^`\r\n]{1,240})`/g)) {
    pushPath(match[1] ?? "");
  }
  for (const match of text.matchAll(/["“'‘]([^"“”'‘’\r\n]{1,240}\.[a-z0-9]{1,12})["”'’]/gi)) {
    pushPath(match[1] ?? "");
  }
  for (const match of text.matchAll(
    /(?:^|[\s(（])((?:[A-Za-z0-9._\-\u4e00-\u9fff]+\/)+[A-Za-z0-9._\-\u4e00-\u9fff]+\.[A-Za-z0-9]{1,12})(?=$|[\s)）。；;，,])/g,
  )) {
    pushPath(match[1] ?? "");
  }

  return out;
}

function inferPlaceholderTaskIntent(params: {
  prompt?: string;
}): DelegateAgentPlaceholder["taskIntent"] {
  const text = (params.prompt ?? "").toLowerCase();
  if (
    /(\.md\b|\.txt\b|\.markdown\b|\.rst\b|save\s+(it\s+)?to\s+(a\s+)?file|create\s+(a\s+)?(file|document)|write\s+(a\s+)?(file|document)|生成.*(文件|文档)|保存.*(文件|文档)|写(入|到|成).*(文件|文档))/i.test(
      text,
    )
  ) {
    return "document_generation";
  }
  if (
    /(implement|fix|patch|refactor|modify\s+files?|edit\s+files?|write\s+(code|tests?)|run\s+tests?|add\s+(tests?|feature)|update\s+(code|files?)|实现|修复|补丁|重构|修改(代码|文件)?|编辑(代码|文件)?|新增(测试|功能)|补充测试|运行测试)/i.test(
      text,
    )
  ) {
    return "implementation";
  }
  if (/(review|audit|inspect|verify|check|评审|审查|审核|复核|验证|检查)/i.test(text)) {
    return "review";
  }
  if (/(research|investigate|analy[sz]e|analysis|look up|调研|调查|分析|研究|查找)/i.test(text)) {
    return "research";
  }
  if (
    /(discuss|debate|conversation|dialogue|roundtable|reply|respond|brainstorm|role|opinion|talk|讨论|对话|辩论|圆桌|回应|回复|发言|观点|头脑风暴|品鉴|专家团队|生命的意义)/i.test(
      text,
    )
  ) {
    return "communication";
  }
  return "research";
}

function defaultPlaceholderModeForIntent(
  intent: DelegateAgentPlaceholder["taskIntent"],
): DelegateAgentPlaceholder["mode"] {
  return intent === "implementation" || intent === "document_generation" ? "worktree" : "readonly";
}

function defaultPlaceholderApplyPolicyForTask(params: {
  mode: DelegateAgentPlaceholder["mode"];
  taskIntent: DelegateAgentPlaceholder["taskIntent"];
}): DelegateAgentPlaceholder["applyPolicy"] {
  if (params.mode === "readonly") return "none";
  if (params.taskIntent === "implementation") return "auto";
  if (params.taskIntent === "document_generation") return "explicit";
  return "none";
}

function normalizePlaceholderSpecKey(value: string) {
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (key === "id" || key === "agent" || key === "agent_id_for_resume") return "id";
  if (key === "name" || key === "agent_name") return "name";
  if (key === "agent_id" || key === "template" || key === "template_id") return "agent_id";
  if (key === "mode" || key === "execution_mode") return "mode";
  if (key === "task_intent" || key === "intent" || key === "task_type") return "task_intent";
  if (key === "apply_policy" || key === "apply") return "apply_policy";
  if (
    key === "allowed_output_paths" ||
    key === "allowed_paths" ||
    key === "output_paths" ||
    key === "apply_paths"
  ) {
    return "allowed_output_paths";
  }
  if (key === "role" || key === "persona") return "role";
  if (
    key === "prompt" ||
    key === "goal" ||
    key === "instruction" ||
    key === "instructions" ||
    key === "task"
  ) {
    return "prompt";
  }
  return "";
}

function unquotePlaceholderSpecValue(value: string) {
  const text = value.trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function parsePlaceholderSpecScalar(value: string): unknown {
  const text = unquotePlaceholderSpecValue(value);
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === "true";
  return text;
}

function parsePlaceholderSpecAttributes(value: string) {
  const attrs: Record<string, unknown> = {};
  const pattern = /([a-zA-Z_][\w-]*)=("[^"]*"|'[^']*'|[^\s]+)/g;
  let match: RegExpExecArray | null = null;
  match = pattern.exec(value);
  while (match !== null) {
    const key = normalizePlaceholderSpecKey(match[1] ?? "");
    if (key) {
      attrs[key] = parsePlaceholderSpecScalar(match[2] ?? "");
    }
    match = pattern.exec(value);
  }
  return attrs;
}

function appendPlaceholderSpecField(record: Record<string, unknown>, key: string, value: string) {
  const normalizedKey = normalizePlaceholderSpecKey(key);
  if (!normalizedKey) return "";
  if (normalizedKey === "allowed_output_paths") {
    const previous = normalizePlaceholderPathList(record[normalizedKey]);
    record[normalizedKey] = [...previous, ...normalizePlaceholderPathList(value)];
    return normalizedKey;
  }
  const next = unquotePlaceholderSpecValue(value);
  if (normalizedKey === "prompt") {
    const previous = optionalText(record[normalizedKey]);
    record[normalizedKey] = previous ? `${previous}\n${next}` : next;
    return normalizedKey;
  }
  record[normalizedKey] = next;
  return normalizedKey;
}

function splitPlaceholderSpecBlocks(spec: string) {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of spec.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (/^---+$/.test(trimmed)) {
      if (current.some((item) => item.trim())) blocks.push(current);
      current = [];
      continue;
    }
    if (/^@agent\b/i.test(trimmed) && current.some((item) => item.trim())) {
      blocks.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.some((item) => item.trim())) blocks.push(current);
  return blocks;
}

function parsePlaceholderSpecBlock(lines: string[]) {
  const record: Record<string, unknown> = {};
  let activeKey = "";
  const freeText: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (activeKey === "prompt") {
        appendPlaceholderSpecField(record, activeKey, "");
      }
      continue;
    }

    if (/^@agent\b/i.test(trimmed)) {
      Object.assign(record, parsePlaceholderSpecAttributes(trimmed.replace(/^@agent\b/i, "")));
      activeKey = "";
      continue;
    }
    if (/^agent\s+\d+\s*:$/i.test(trimmed) || /^agent\s*:$/i.test(trimmed)) {
      activeKey = "";
      continue;
    }

    const fieldMatch = /^([a-zA-Z_][\w\s-]{0,40})\s*:\s*(.*)$/.exec(trimmed);
    const normalizedField = fieldMatch ? normalizePlaceholderSpecKey(fieldMatch[1] ?? "") : "";
    if (fieldMatch && normalizedField) {
      const rawValue = (fieldMatch[2] ?? "").trim();
      activeKey = normalizedField;
      if (rawValue && rawValue !== "|" && rawValue !== ">") {
        appendPlaceholderSpecField(record, activeKey, rawValue);
      } else if (!(activeKey in record)) {
        record[activeKey] = "";
      }
      continue;
    }
    if (fieldMatch) {
      activeKey = "";
      continue;
    }

    if (activeKey === "prompt") {
      appendPlaceholderSpecField(record, activeKey, line.replace(/^\s{0,4}/, ""));
    } else {
      freeText.push(line);
    }
  }

  if (!optionalText(record.prompt) && freeText.length > 0) {
    record.prompt = freeText.join("\n").trim();
  }
  return record;
}

function parsePlaceholderSpec(spec: string) {
  return splitPlaceholderSpecBlocks(spec).map(parsePlaceholderSpecBlock);
}

function shouldTreatPlaceholderTextAsAgentSpec(value: unknown) {
  const text = optionalText(value);
  if (!text) return false;
  if (/^\s*@agent\b/im.test(text)) return true;
  return /^\s*agent\s+\d+\s*:/im.test(text) && /^\s*(name|role|prompt|task)\s*:/im.test(text);
}

function normalizePlaceholderAgent(
  rawAgent: Record<string, unknown>,
  index: number,
  inheritedAgentId?: string,
  inheritedMode?: DelegateAgentPlaceholder["mode"],
  inheritedTaskIntent?: DelegateAgentPlaceholder["taskIntent"],
  inheritedApplyPolicy?: DelegateAgentPlaceholder["applyPolicy"],
  inheritedAllowedOutputPaths: string[] = [],
): DelegateAgentPlaceholder | null {
  const prompt = optionalText(rawAgent.prompt);
  if (!prompt) return null;
  const id = optionalText(rawAgent.id) ?? `agent-${index + 1}`;
  const taskIntent =
    normalizePlaceholderTaskIntent(rawAgent.task_intent) ??
    inheritedTaskIntent ??
    inferPlaceholderTaskIntent({ prompt });
  const mode =
    normalizePlaceholderMode(rawAgent.mode) ??
    inheritedMode ??
    defaultPlaceholderModeForIntent(taskIntent);
  const applyPolicy =
    normalizePlaceholderApplyPolicy(rawAgent.apply_policy) ??
    inheritedApplyPolicy ??
    defaultPlaceholderApplyPolicyForTask({ mode, taskIntent });
  const inferredAllowedOutputPaths =
    taskIntent === "document_generation" && applyPolicy === "explicit"
      ? inferPlaceholderAllowedOutputPaths({ prompt })
      : [];
  const allowedOutputPaths = [
    ...inheritedAllowedOutputPaths,
    ...normalizePlaceholderPathList(rawAgent.allowed_output_paths),
    ...inferredAllowedOutputPaths,
  ].filter((path, position, paths) => paths.indexOf(path) === position);
  return {
    id,
    name: optionalText(rawAgent.name),
    role: optionalText(rawAgent.role),
    prompt,
    agentId: optionalText(rawAgent.agent_id) ?? inheritedAgentId,
    mode,
    taskIntent,
    applyPolicy,
    allowedOutputPaths,
  };
}

function normalizeDelegateAgentPlaceholders(
  args: Record<string, unknown>,
): DelegateAgentPlaceholder[] {
  const inheritedAgentId = optionalText(args.agent_id);
  const inheritedMode = normalizePlaceholderMode(args.mode);
  const inheritedTaskIntent = normalizePlaceholderTaskIntent(args.task_intent);
  const inheritedApplyPolicy = normalizePlaceholderApplyPolicy(args.apply_policy);
  const inheritedAllowedOutputPaths = normalizePlaceholderPathList(args.allowed_output_paths);
  const explicitAgentSpec = optionalText(args.agent_spec) ?? optionalText(args.spec);
  const promptAgentSpec =
    !explicitAgentSpec && shouldTreatPlaceholderTextAsAgentSpec(args.prompt)
      ? optionalText(args.prompt)
      : undefined;
  const agentSpec = explicitAgentSpec ?? promptAgentSpec;

  if (agentSpec) {
    const specItems = parsePlaceholderSpec(agentSpec).filter((item) => optionalText(item.prompt));
    if (specItems.length === 0 || specItems.length > DELEGATE_AGENT_PLACEHOLDER_MAX_AGENTS) {
      return [];
    }
    return specItems
      .map((item, index) =>
        normalizePlaceholderAgent(
          item,
          index,
          inheritedAgentId,
          inheritedMode,
          inheritedTaskIntent,
          inheritedApplyPolicy,
          inheritedAllowedOutputPaths,
        ),
      )
      .filter((item): item is DelegateAgentPlaceholder => Boolean(item));
  }

  const single = normalizePlaceholderAgent(
    args,
    0,
    inheritedAgentId,
    inheritedMode,
    inheritedTaskIntent,
    inheritedApplyPolicy,
    inheritedAllowedOutputPaths,
  );
  return single ? [single] : [];
}

export function buildDelegateAgentPlaceholderToolCalls(parentToolCall: ToolCall): ToolCall[] {
  if (!isParentDelegateAgentToolCall(parentToolCall)) return [];
  const args = asPlainObject(parentToolCall.arguments);
  const agents = normalizeDelegateAgentPlaceholders(args);
  if (agents.length === 0) return [];
  const concurrency = Math.min(
    agents.length,
    clampInteger(
      args.concurrency,
      DELEGATE_AGENT_PLACEHOLDER_DEFAULT_CONCURRENCY,
      1,
      DELEGATE_AGENT_PLACEHOLDER_MAX_CONCURRENCY,
    ),
  );

  return agents.map((agent, index) => ({
    type: "toolCall",
    id: `${parentToolCall.id}:agent:${index + 1}`,
    name: "Agent",
    arguments: {
      delegate_agent_card: true,
      parent_tool_call_id: parentToolCall.id,
      index: index + 1,
      total: agents.length,
      concurrency,
      id: agent.id,
      name: agent.name,
      role: agent.role,
      agent_id: agent.agentId,
      prompt: agent.prompt,
      mode: agent.mode,
      task_intent: agent.taskIntent,
      apply_policy: agent.applyPolicy,
      allowed_output_paths: agent.allowedOutputPaths,
    },
  }));
}

function isDelegateAgentResult(
  toolResult: ToolResultMessage | undefined,
): toolResult is ToolResultMessage & { details: DelegateAgentResultDetails } {
  const details = toolResult?.details as Partial<DelegateAgentResultDetails> | undefined;
  return details?.kind === "delegate_agent" && Array.isArray(details.agents);
}

function buildDelegateAgentCardToolCall(params: {
  parentToolCall: ToolCall;
  details: DelegateAgentResultDetails;
  index: number;
  agent: DelegateAgentResultDetails["agents"][number];
}): ToolCall {
  return {
    type: "toolCall",
    id: `${params.parentToolCall.id}:agent:${params.index + 1}`,
    name: "Agent",
    arguments: {
      delegate_agent_card: true,
      parent_tool_call_id: params.parentToolCall.id,
      index: params.index + 1,
      total: params.details.agentCount,
      concurrency: params.details.concurrency,
      id: params.agent.id,
      name: params.agent.name,
      role: params.agent.role,
      agent_id: params.agent.agentId,
      prompt: params.agent.prompt,
      mode: params.agent.mode,
    },
  };
}

function buildDelegateAgentCardToolResult(params: {
  parentToolResult: ToolResultMessage;
  toolCall: ToolCall;
  details: DelegateAgentResultDetails;
  index: number;
  agent: DelegateAgentResultDetails["agents"][number];
}): ToolResultMessage {
  const details: DelegateAgentCardResultDetails = {
    kind: "delegate_agent_item",
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
    isError: params.agent.status === "failed",
    timestamp: params.parentToolResult.timestamp,
  };
}

function appendDelegateAgentItemBlocks(
  blocks: UiRoundContentBlock[],
  parentToolCall: ToolCall,
  parentToolResult: ToolResultMessage | undefined,
) {
  if (!isDelegateAgentResult(parentToolResult)) return blocks;

  let next = blocks;
  const details = parentToolResult.details as DelegateAgentResultDetails;
  details.agents.forEach((agent, index: number) => {
    const toolCall = buildDelegateAgentCardToolCall({
      parentToolCall,
      details,
      index,
      agent,
    });
    const toolResult = buildDelegateAgentCardToolResult({
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

function upsertToolBlock(
  blocks: UiRoundContentBlock[],
  toolCall: ToolCall,
  toolResult?: ToolResultMessage,
  options?: { contentHasHostedSearch?: boolean },
): UiRoundContentBlock[] {
  if (isParentDelegateAgentToolCall(toolCall)) return blocks;

  const existingIdx = blocks.findIndex(
    (block) => block.kind === "tool" && block.item.toolCall.id === toolCall.id,
  );
  if (!shouldDisplayToolBlock(toolCall, toolResult, blocks, options)) {
    return existingIdx >= 0
      ? blocks.filter((block) => !(block.kind === "tool" && block.item.toolCall.id === toolCall.id))
      : blocks;
  }
  if (existingIdx >= 0) {
    const existing = blocks[existingIdx];
    if (existing.kind !== "tool") return blocks;
    const next = blocks.slice();
    next[existingIdx] = {
      kind: "tool",
      item: {
        ...existing.item,
        toolCall,
        toolResult: toolResult ?? existing.item.toolResult,
      },
    };
    return next;
  }

  const nextBlock: UiRoundContentBlock = {
    kind: "tool",
    item: toolResult ? { toolCall, toolResult } : { toolCall },
  };
  return [...blocks, nextBlock];
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

export function markToolCallRunningInRound<
  TRound extends Pick<UiRound, "blocks"> & { runningToolCallIds: string[] },
>(round: TRound, toolCall: ToolCall): TRound {
  const visibleToolCalls = buildDelegateAgentPlaceholderToolCalls(toolCall);
  const runningCandidateIds =
    visibleToolCalls.length > 0
      ? visibleToolCalls.map((item) => item.id)
      : toolCall.id
        ? [toolCall.id]
        : [];
  if (runningCandidateIds.length === 0) return round;

  const visibleToolCallIds = new Set(
    getRoundToolTrace(round)
      .map((item) => item.toolCall.id)
      .filter((id): id is string => Boolean(id)),
  );
  let runningToolCallIds = round.runningToolCallIds;
  for (const id of runningCandidateIds) {
    if (!visibleToolCallIds.has(id) || runningToolCallIds.includes(id)) continue;
    if (runningToolCallIds === round.runningToolCallIds) {
      runningToolCallIds = runningToolCallIds.slice();
    }
    runningToolCallIds.push(id);
  }

  return runningToolCallIds === round.runningToolCallIds
    ? round
    : {
        ...round,
        runningToolCallIds,
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
        return [
          ...blocks.slice(0, lastTextIndex),
          { kind: "text" as const, text: split.before },
          nextBlock,
          ...(split.after ? [{ kind: "text" as const, text: split.after }] : []),
          ...blocks.slice(lastTextIndex + 1),
        ];
      }
    }
    const groupedSearchInsertIndex = findHostedSearchGroupInsertIndex(blocks);
    if (groupedSearchInsertIndex >= 0) {
      return rebalanceHostedSearchTextBoundaries([
        ...blocks.slice(0, groupedSearchInsertIndex),
        nextBlock,
        ...blocks.slice(groupedSearchInsertIndex),
      ]);
    }
    return rebalanceHostedSearchTextBoundaries([...blocks, nextBlock]);
  }
  const next = blocks.slice();
  const existing = next[idx];
  if (existing?.kind !== "hostedSearch") return blocks;
  next[idx] = {
    kind: "hostedSearch",
    item: mergeHostedSearchBlocks(existing.item, hostedSearch),
  };
  return next;
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

export function updateLiveRound(
  prev: LiveRound[],
  round: number,
  updater: (target: LiveRound) => LiveRound,
) {
  if (prev.length === 0) return prev;

  const lastIdx = prev.length - 1;
  if (prev[lastIdx].round === round) {
    const next = prev.slice();
    next[lastIdx] = updater(prev[lastIdx]);
    return next;
  }

  const idx = prev.findIndex((item) => item.round === round);
  if (idx < 0) return prev;

  const next = prev.slice();
  next[idx] = updater(prev[idx]);
  return next;
}

export function collapseThinking(target: LiveRound) {
  if (!target.thinkingOpen || !getRoundThinkingText(target).trim()) return target;
  return { ...target, thinkingOpen: false };
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
      if (isParentDelegateAgentToolCall(block)) {
        blocks = appendDelegateAgentItemBlocks(blocks, block, toolResult);
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
