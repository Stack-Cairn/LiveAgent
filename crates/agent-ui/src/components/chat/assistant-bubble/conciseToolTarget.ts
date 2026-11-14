import {
  summarizeToolCall,
  type ToolTraceItem,
} from "@liveagent/ui/lib/chat/assistantBubbleAdapter";
import {
  collapseWhitespace,
  conciseCommand,
  conciseUrl,
  truncateColumns,
  truncatePathStart,
} from "@liveagent/ui/lib/chat/conciseText";
import { summarizeKBrainToolLine } from "@liveagent/ui/lib/chat/kbrainToolSummaries";
import {
  isSshManagerToolName,
  summarizeSshManagerCall,
} from "@liveagent/ui/lib/chat/sshManagerDisplay";
import {
  getFileOperationDisplay,
  getToolDisplayName,
  isWebFetchToolName,
  isWebSearchToolName,
  LSP_TOOL_NAME,
} from "./assistantBubbleUtils";

/**
 * What a tool row or a collapsed batch header names after its verb: a command's
 * first line, a file's name, a search pattern, a URL's host and path. `full`
 * keeps what the short form leaves out for the tooltip; `lossy` tells the row
 * to show the request in its expanded body so nothing lives only in a tooltip.
 */
export type ConciseToolTarget = {
  text: string;
  full: string;
  lossy: boolean;
};

const COMMAND_TOOL_NAMES = new Set(["Bash", "ManagedProcess", "TerminalSession"]);

function stringArgument(args: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function target(text: string, full: string): ConciseToolTarget {
  const fullText = full.trim() || text;
  return { text, full: fullText, lossy: collapseWhitespace(fullText) !== text };
}

export function getConciseToolTarget(item: ToolTraceItem): ConciseToolTarget {
  const file = getFileOperationDisplay(item);
  if (file) return { text: truncateColumns(file.fileName), full: file.path, lossy: false };

  const rawName = item.toolCall.name;
  const name = getToolDisplayName(rawName);
  const args = item.toolCall.arguments || {};
  const summary = () =>
    summarizeToolCall(item.toolCall, { includeName: false, includeManagerAction: false });

  if (COMMAND_TOOL_NAMES.has(name)) {
    const command = stringArgument(args, "command");
    if (command) return target(conciseCommand(command), command);
  }
  if (name === "Glob" || name === "Grep") {
    const pattern = stringArgument(args, "pattern", "query");
    if (pattern) return target(truncateColumns(collapseWhitespace(pattern)), summary());
  }
  if (name === "ToolSearch") {
    const query = stringArgument(args, "query", "pattern", "name");
    if (query) return target(truncateColumns(collapseWhitespace(query)), summary());
  }
  if (name === "List") {
    const path = stringArgument(args, "path") || ".";
    return target(truncatePathStart(path), summary() || path);
  }
  if (name === "Agent") {
    const agent = stringArgument(args, "name", "id", "prompt");
    if (agent) return target(truncateColumns(collapseWhitespace(agent)), summary() || agent);
  }
  if (name === "SendMessage") {
    const recipient = stringArgument(args, "to", "channel", "subject");
    if (recipient) return target(truncateColumns(collapseWhitespace(recipient)), summary());
  }
  if (isWebFetchToolName(rawName)) {
    const url = stringArgument(args, "url", "uri");
    if (url) return target(conciseUrl(url), summary() || url);
  }
  if (isWebSearchToolName(rawName)) {
    const query = stringArgument(args, "query");
    if (query) return target(truncateColumns(collapseWhitespace(query)), summary() || query);
  }
  if (isSshManagerToolName(rawName)) {
    const ssh = summarizeSshManagerCall(args);
    if (ssh) return { text: ssh.text, full: ssh.full, lossy: ssh.full !== ssh.text };
  }
  if (name === "ReadTerminal") {
    // The verb already says "terminal"; name the tab only when one was picked.
    const terminal = stringArgument(args, "terminal_id", "session_id");
    return target(truncateColumns(terminal), terminal);
  }
  if (name === "TunnelManager") {
    // The verb carries the action (Created tunnel, Closed tunnel, ...).
    const targetUrl = stringArgument(args, "targetUrl");
    if (targetUrl) return target(conciseUrl(targetUrl), summary() || targetUrl);
    const id = stringArgument(args, "id", "tunnel_id");
    return target(truncateColumns(id), summary() || id);
  }
  if (name === LSP_TOOL_NAME) {
    const lsp = summary();
    return target(truncateColumns(collapseWhitespace(lsp)), lsp);
  }

  const line = summarizeKBrainToolLine(rawName, args) ?? summary();
  return target(truncateColumns(collapseWhitespace(line)), line);
}
