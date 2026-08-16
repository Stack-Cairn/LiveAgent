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

export function getToolDisplayName(name: string) {
  if (name === "SshManager") return "SSHManager";
  return name;
}

type ShellSessionDisplayDetails = {
  sessionId: string;
  status: string;
  waitCount: number;
  stopCount: number;
  /**
   * 仅 mergeShellSessionRounds 产出的聚合卡为 true。原始逐条结果里的
   * status 是当次调用返回时的快照（Bash 首响应恒为 running），不能作为
   * “会话仍在运行”的实时依据。
   */
  mergedDisplay: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function shellSessionIdFromItem(item: ToolTraceItem) {
  if (item.toolCall.name === "Bash") {
    const details = asRecord(item.toolResult?.details);
    return typeof details?.session_id === "string" ? details.session_id.trim() : "";
  }
  if (item.toolCall.name === "ProcessWait" || item.toolCall.name === "ProcessStop") {
    const sessionId = item.toolCall.arguments?.session_id;
    return typeof sessionId === "string" ? sessionId.trim() : "";
  }
  return "";
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
    waitCount:
      typeof details?.wait_count === "number" && Number.isFinite(details.wait_count)
        ? Math.max(0, Math.floor(details.wait_count))
        : 0,
    stopCount:
      typeof details?.stop_count === "number" && Number.isFinite(details.stop_count)
        ? Math.max(0, Math.floor(details.stop_count))
        : 0,
    mergedDisplay: details?.shell_session_display === true,
  };
}

export function mergeShellSessionRounds<T extends UiRound>(rounds: readonly T[]): T[] {
  type ShellSessionGroup = {
    anchor?: ToolTraceItem;
    items: ToolTraceItem[];
  };
  const groups = new Map<string, ShellSessionGroup>();

  for (const round of rounds) {
    for (const block of round.blocks) {
      if (block.kind !== "tool") continue;
      const sessionId = shellSessionIdFromItem(block.item);
      if (!sessionId) continue;
      const group = groups.get(sessionId) ?? { items: [] };
      group.items.push(block.item);
      if (block.item.toolCall.name === "Bash" && !group.anchor) {
        group.anchor = block.item;
      }
      groups.set(sessionId, group);
    }
  }

  const replacements = new Map<string, ToolTraceItem>();
  const hiddenToolCallIds = new Set<string>();
  for (const [sessionId, group] of groups) {
    const anchor = group.anchor;
    if (!anchor) continue;
    const anchorId = anchor.toolCall.id?.trim();
    if (!anchorId) continue;

    let latestResult = anchor.toolResult;
    let status = getShellSessionDisplayDetails(anchor.toolResult)?.status || "running";
    let waitCount = 0;
    let stopCount = 0;
    let output = "";
    let outputTruncated = false;
    let displayTruncated = false;
    let lastStream = "";
    for (const item of group.items) {
      const isSessionControl =
        item.toolCall.name === "ProcessWait" || item.toolCall.name === "ProcessStop";
      const itemSessionDetails = getShellSessionDisplayDetails(item.toolResult);
      if (isSessionControl && item.toolResult && !itemSessionDetails) {
        continue;
      }
      if (item.toolCall.name === "ProcessWait") waitCount += 1;
      if (item.toolCall.name === "ProcessStop") stopCount += 1;
      if (item.toolResult) {
        latestResult = item.toolResult;
        status = itemSessionDetails?.status || status;
        const details = asRecord(item.toolResult.details);
        if (details?.output_truncated === true) outputTruncated = true;
        if (Array.isArray(details?.output)) {
          for (const rawChunk of details.output) {
            const chunk = asRecord(rawChunk);
            const stream = chunk?.stream === "stderr" ? "stderr" : "stdout";
            const text = typeof chunk?.text === "string" ? chunk.text : "";
            if (!text) continue;
            if (lastStream && lastStream !== stream) {
              output += `\n[${stream}]\n`;
            }
            output += text;
            lastStream = stream;
          }
        }
      }
      const itemId = item.toolCall.id?.trim();
      if (itemId && itemId !== anchorId) hiddenToolCallIds.add(itemId);
    }

    if (output.length > 64 * 1024) {
      output = output.slice(-(64 * 1024));
      displayTruncated = true;
    }
    if (!latestResult) continue;
    const latestDetails = asRecord(latestResult.details) ?? {};
    const duration =
      typeof latestDetails.duration_ms === "number" ? latestDetails.duration_ms : undefined;
    const summary = [
      "# Shell Session",
      `status: ${status}`,
      `session_id: ${sessionId}`,
      `wait_count: ${waitCount}`,
      stopCount > 0 ? `stop_count: ${stopCount}` : null,
      duration !== undefined ? `session_duration_ms: ${duration}` : null,
      outputTruncated ? "output_truncated: true" : null,
      displayTruncated ? "display_truncated: true" : null,
      "",
      "output:",
      output,
    ]
      .filter((line) => line !== null)
      .join("\n");
    replacements.set(anchorId, {
      toolCall: anchor.toolCall,
      toolResult: {
        ...latestResult,
        toolCallId: anchorId,
        toolName: "Bash",
        content: [{ type: "text", text: summary }],
        details: {
          ...latestDetails,
          session_id: sessionId,
          status,
          wait_count: waitCount,
          stop_count: stopCount,
          shell_session_display: true,
          output_truncated: outputTruncated,
          display_truncated: displayTruncated,
        },
        isError: status === "failed" || status === "timed_out",
      },
    });
  }

  if (replacements.size === 0) return rounds.slice();
  return rounds.map((round) => {
    const blocks: UiRound["blocks"] = [];
    for (const block of round.blocks) {
      if (block.kind !== "tool") {
        blocks.push(block);
        continue;
      }
      const id = block.item.toolCall.id?.trim();
      if (!id) {
        blocks.push(block);
        continue;
      }
      if (hiddenToolCallIds.has(id)) continue;
      const replacement = replacements.get(id);
      blocks.push(replacement ? { ...block, item: replacement } : block);
    }
    return { ...round, blocks };
  });
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
    "CronTaskManager",
    "Delete",
    "Edit",
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
    "SSHManager",
    "SshManager",
    "TunnelManager",
    "Write",
  ].includes(trimmed);
}
