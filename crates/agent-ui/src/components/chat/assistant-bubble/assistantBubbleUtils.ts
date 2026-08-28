import { isCuaDriverServerId } from "@liveagent/ui/contracts/mcpServerDefaults";
import { isTaskToolName } from "@liveagent/ui/contracts/task";
import type {
  HostedSearchBlock,
  ToolResultMessage,
  ToolTraceItem,
  UiRound,
} from "@liveagent/ui/lib/chat/assistantBubbleAdapter";
import {
  isDynamicMcpToolName,
  safeStringify,
  shouldDisplayToolTraceItem,
} from "@liveagent/ui/lib/chat/assistantBubbleAdapter";
import type {
  SubagentCardDetails,
  SubagentReportDetails,
} from "@liveagent/ui/lib/subagents/protocol";
import {
  Bot,
  Brain,
  CircleHelp,
  Clock3,
  Eye,
  FilePenLine,
  FileText,
  FolderTree,
  Hand,
  type IconComponent,
  ImageIcon,
  Link2,
  ListChecks,
  Plug,
  Search,
  Server,
  Terminal,
  Trash2,
  Wrench,
} from "../../IconSet";

export function getToolMeta(name: string): {
  Icon: IconComponent;
  accent: string;
  category: string;
} {
  if (isTaskToolName(name)) {
    return { Icon: ListChecks, accent: "var(--tool-list-accent)", category: "system" };
  }
  // 动态 MCP 工具此前全落进 default 分支（扳手 / other），与内置工具混在
  // 一起看不出来源。给它们一个专属图标；cua-driver 再单独区分——它的工具
  // 是在真实点击、输入、关闭应用，值得比「又一个 MCP 工具」更醒目。
  if (isDynamicMcpToolName(name)) {
    return isCuaDriverToolName(name)
      ? { Icon: Hand, accent: "var(--tool-bash-accent)", category: "cua" }
      : { Icon: Plug, accent: "var(--tool-list-accent)", category: "mcp" };
  }
  switch (name) {
    case "Bash":
    case "ManagedProcess":
    case "ProcessWait":
    case "ProcessStop":
      return { Icon: Terminal, accent: "var(--tool-bash-accent)", category: "terminal" };
    case "Read":
      return { Icon: Eye, accent: "var(--tool-file-accent)", category: "file" };
    case "Image":
      return { Icon: ImageIcon, accent: "var(--tool-file-accent)", category: "file" };
    case "SkillsManager":
      return { Icon: Eye, accent: "var(--tool-file-accent)", category: "file" };
    case "CronTaskManager":
      return { Icon: Clock3, accent: "var(--tool-list-accent)", category: "system" };
    case "MemoryManager":
      return { Icon: Brain, accent: "var(--tool-list-accent)", category: "system" };
    case "McpManager":
      return { Icon: Plug, accent: "var(--tool-list-accent)", category: "mcp" };
    case "TunnelManager":
      return { Icon: Link2, accent: "var(--tool-list-accent)", category: "system" };
    case "SSHManager":
    case "SshManager":
      return { Icon: Server, accent: "var(--tool-bash-accent)", category: "terminal" };
    case "Agent":
      return { Icon: Bot, accent: "var(--tool-list-accent)", category: "system" };
    case "SendMessage":
      return { Icon: Bot, accent: "var(--tool-list-accent)", category: "system" };
    case "Write":
      return { Icon: FileText, accent: "var(--tool-file-accent)", category: "file" };
    case "Edit":
      return { Icon: FilePenLine, accent: "var(--tool-file-accent)", category: "file" };
    case "Delete":
      return { Icon: Trash2, accent: "var(--tool-file-accent)", category: "file" };
    case "Glob":
      return { Icon: Search, accent: "var(--tool-search-accent)", category: "search" };
    case "Grep":
      return { Icon: Search, accent: "var(--tool-search-accent)", category: "search" };
    case "List":
      return { Icon: FolderTree, accent: "var(--tool-list-accent)", category: "list" };
    case "AskUserQuestion":
      return { Icon: CircleHelp, accent: "var(--tool-list-accent)", category: "system" };
    case "ExitPlanMode":
      return { Icon: ListChecks, accent: "var(--tool-list-accent)", category: "system" };
    case "ToolSearch":
      return { Icon: Search, accent: "var(--tool-search-accent)", category: "search" };
    default:
      return { Icon: Wrench, accent: "var(--tool-file-accent)", category: "other" };
  }
}

export function displayString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function compactInlineText(value: unknown, maxChars = 120) {
  const text = displayString(value).replace(/\s+/g, " ");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

export function isSubagentCardToolCall(toolCall: {
  name: string;
  arguments?: Record<string, unknown>;
}) {
  return toolCall.name === "Agent" && toolCall.arguments?.subagent_card === true;
}

export function getSubagentTask(agent: { prompt?: unknown }) {
  return displayString(agent.prompt);
}

export function getSubagentInlineSummary(item: ToolTraceItem) {
  const details = item.toolResult?.details as Partial<SubagentCardDetails> | undefined;
  const agent = details?.kind === "subagent_card" ? details.agent : undefined;
  const args = item.toolCall.arguments || {};
  const name = displayString(agent?.name) || displayString(args.name) || displayString(args.id);
  const task = agent ? getSubagentTask(agent) : displayString(args.prompt);

  if (name && task) return `${name} - ${compactInlineText(task, 96)}`;
  return name || compactInlineText(task, 120);
}

export function shouldShowSubagentApplyStatus(agent: SubagentReportDetails) {
  if (!agent.applyStatus) return false;
  if (agent.applyStatus === "applied" || agent.applyStatus === "failed") return true;
  return Boolean(agent.applySkippedReason && agent.applySkippedReason !== "no_changes");
}

export function shouldShowSubagentCleanupStatus(agent: SubagentReportDetails) {
  return Boolean(
    agent.worktreeCleanupStatus &&
      agent.worktreeCleanupStatus !== "removed" &&
      agent.worktreeCleanupStatus !== "skipped",
  );
}

export function shouldShowSubagentWorktreeLocation(agent: SubagentReportDetails) {
  return Boolean(
    agent.worktreeRoot &&
      (agent.status !== "completed" ||
        agent.worktreeCleanupStatus === "retained" ||
        agent.worktreeCleanupStatus === "failed"),
  );
}

export type GroupedRoundBlock =
  | {
      kind: "thinking";
      key: string;
      text: string;
    }
  | {
      kind: "text";
      key: string;
      text: string;
    }
  | {
      kind: "tool";
      key: string;
      item: ToolTraceItem;
    }
  | {
      kind: "hostedSearch";
      key: string;
      item: HostedSearchBlock;
    }
  | {
      kind: "hostedSearchGroup";
      key: string;
      items: HostedSearchBlock[];
    }
  | {
      kind: "toolGroup";
      key: string;
      items: ToolTraceItem[];
    };

const stableValueSignatureCache = new WeakMap<object, string>();

export function getStableValueSignature(value: unknown) {
  if (value && typeof value === "object") {
    const cached = stableValueSignatureCache.get(value);
    if (cached !== undefined) {
      return cached;
    }
    const signature = safeStringify(value);
    stableValueSignatureCache.set(value, signature);
    return signature;
  }
  return safeStringify(value);
}

export function areStableValuesEqual(previous: unknown, next: unknown) {
  return previous === next || getStableValueSignature(previous) === getStableValueSignature(next);
}

export function getToolTraceKey(item: ToolTraceItem, index: number) {
  const id = item.toolCall.id?.trim();
  if (id) return id;
  return `${item.toolCall.name}-${index}-${getStableValueSignature(item.toolCall.arguments)}`;
}

export function isAgentToolName(name: string) {
  return name === "Agent";
}

/**
 * 拆开动态 MCP 工具名。命名规则见 `mcpTools.ts`：
 * `mcp_<sanitizedServerId>_<sanitizedToolName>`。
 *
 * 两段本身都可能含下划线，所以按第一个 `_` 切分是启发式而非精确解析。
 * 实践中 server id 是 kebab-case（sanitize 保留 `-`），切分正确；即便切
 * 错也只影响标题渲染，不参与任何判定或 key。
 */
export function parseDynamicMcpToolName(name: string): { serverId: string; tool: string } | null {
  const trimmed = name.trim();
  if (!isDynamicMcpToolName(trimmed)) return null;
  const rest = trimmed.slice("mcp_".length);
  const separator = rest.indexOf("_");
  if (separator <= 0 || separator === rest.length - 1) return null;
  return { serverId: rest.slice(0, separator), tool: rest.slice(separator + 1) };
}

/**
 * cua-driver 的工具会真实操作用户的机器，值得在气泡里一眼可辨。
 *
 * 走 `isCuaDriverServerId` 而不是直接比字符串：工具名里的 server id 段是
 * 从配置原文 sanitize 出来的，大小写照抄。这里只影响图标，但同一个判断在
 * 别处关系到审批缺省，口径不该有两套。
 */
export function isCuaDriverToolName(name: string) {
  const parsed = parseDynamicMcpToolName(name);
  return parsed ? isCuaDriverServerId(parsed.serverId) : false;
}

export function getToolDisplayName(name: string) {
  if (name === "SshManager") return "SSHManager";
  // `mcp_cua-driver_get_desktop_state` 这样的原始名在气泡标题里又长又
  // 难读。拆成 `cua-driver · get_desktop_state`：server 仍然可见（同时
  // 挂多个 MCP 时需要区分），但工具本身成为视觉重心。
  const parsed = parseDynamicMcpToolName(name);
  if (parsed) return `${parsed.serverId} · ${parsed.tool}`;
  return name;
}

type ShellSessionDisplayDetails = {
  sessionId: string;
  status: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function getShellSessionDisplayDetails(
  result?: ToolResultMessage,
): ShellSessionDisplayDetails | null {
  const details = asRecord(result?.details);
  const sessionId = typeof details?.session_id === "string" ? details.session_id.trim() : "";
  const status = typeof details?.status === "string" ? details.status.trim() : "";
  if (!sessionId || !status) return null;
  return {
    sessionId,
    status,
  };
}

const TOOL_CARD_ACTION_NAMES = new Set([
  "SkillsManager",
  "CronTaskManager",
  "McpManager",
  "MemoryManager",
  "TunnelManager",
  "SSHManager",
  "ManagedProcess",
]);

export function getManagerToolActionName(toolCall: {
  name: string;
  arguments?: Record<string, unknown>;
}) {
  const name = getToolDisplayName(toolCall.name);
  if (!TOOL_CARD_ACTION_NAMES.has(name)) return "";
  const args = toolCall.arguments || {};
  const action = displayString(args.action);
  if (action) return action;
  if (name === "SkillsManager") {
    return displayString(args.path) ? "read" : "list";
  }
  return "";
}

export function getToolDisplayTitle(toolCall: {
  name: string;
  arguments?: Record<string, unknown>;
}) {
  const name = getToolDisplayName(toolCall.name);
  const action = getManagerToolActionName(toolCall);
  return { name, action };
}

export function groupRoundBlocks(blocks: UiRound["blocks"]): GroupedRoundBlock[] {
  const groupedBlocks: GroupedRoundBlock[] = [];
  let pendingTools: ToolTraceItem[] = [];
  let pendingStartIndex = 0;
  let pendingSearches: HostedSearchBlock[] = [];
  let pendingSearchStartIndex = 0;
  const hasHostedSearch = blocks.some((block) => block.kind === "hostedSearch");

  const flushPendingTools = () => {
    if (pendingTools.length === 0) return;
    groupedBlocks.push({
      kind: "toolGroup",
      // The wrapper exists from the first ordinary tool onward. Appending a
      // second tool therefore updates one activity in place instead of
      // replacing a `tool` row with a differently keyed `toolGroup` row.
      key: `tool-group-${getToolTraceKey(pendingTools[0], pendingStartIndex)}`,
      items: pendingTools,
    });
    pendingTools = [];
  };

  const flushPendingSearches = () => {
    if (pendingSearches.length === 0) return;
    const firstSearch = pendingSearches[0];
    groupedBlocks.push({
      kind: "hostedSearchGroup",
      key: `hosted-search-group-${firstSearch?.id || pendingSearchStartIndex}`,
      items: pendingSearches,
    });
    pendingSearches = [];
  };

  blocks.forEach((block, index) => {
    if (block.kind === "tool") {
      if (!shouldDisplayToolTraceItem(block.item, { hasHostedSearch })) {
        return;
      }
      flushPendingSearches();
      if (
        block.item.toolCall.name === "Image" ||
        isTaskToolName(block.item.toolCall.name) ||
        block.item.toolCall.name === "AskUserQuestion" ||
        block.item.toolCall.name === "ProcessWait" ||
        block.item.toolCall.name === "ProcessStop" ||
        isAgentToolName(block.item.toolCall.name)
      ) {
        flushPendingTools();
        groupedBlocks.push({
          kind: "tool",
          key: `tool-${getToolTraceKey(block.item, index)}`,
          item: block.item,
        });
        return;
      }
      if (pendingTools.length === 0) {
        pendingStartIndex = index;
      }
      pendingTools.push(block.item);
      return;
    }

    flushPendingTools();
    if (block.kind === "hostedSearch") {
      if (pendingSearches.length === 0) {
        pendingSearchStartIndex = index;
      }
      pendingSearches.push(block.item);
      return;
    }
    flushPendingSearches();
    if (block.kind === "thinking") {
      groupedBlocks.push({ kind: "thinking", key: block.id, text: block.text });
      return;
    }
    groupedBlocks.push({ kind: "text", key: block.id, text: block.text });
  });

  flushPendingTools();
  flushPendingSearches();
  return groupedBlocks;
}

export function getBuiltinResultKind(result?: ToolResultMessage) {
  if (!result?.details || typeof result.details !== "object") return null;
  const kind = (result.details as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : null;
}

export function isBuiltinShareToolName(name: string) {
  const trimmed = name.trim();
  if (isDynamicMcpToolName(trimmed)) {
    return true;
  }
  if (isTaskToolName(trimmed)) {
    return true;
  }
  return [
    "Agent",
    "AskUserQuestion",
    "Bash",
    "Browser",
    "CronTaskManager",
    "Delete",
    "Edit",
    "ExitPlanMode",
    "Glob",
    "Grep",
    "Image",
    "List",
    "ManagedProcess",
    "ProcessStop",
    "ProcessWait",
    "McpManager",
    "MemoryManager",
    "Read",
    "ReadTerminal",
    "SendMessage",
    "SkillsManager",
    "ToolSearch",
    "SSHManager",
    "SshManager",
    "TunnelManager",
    "Write",
  ].includes(trimmed);
}
