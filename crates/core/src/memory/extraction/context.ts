// Compact, self-contained extraction context. The hidden pass no longer
// re-sends the whole conversation + chat system prompt (unbounded tokens,
// cache-hostile); it gets the last K user-turns verbatim plus a deterministic
// workspace-mutation digest that feeds the project-scope gate.

import type { AssistantMessage, Message, ToolCall } from "@earendil-works/pi-ai";
import {
  EXTRACTION_MESSAGE_CHAR_CAP,
  EXTRACTION_TURN_WINDOW,
  EXTRACTION_WINDOW_CHAR_CAP,
} from "../config";

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && (part as { type?: string }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

export function extractLatestUserText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "user") continue;
    const text = textOfContent(message.content);
    if (text.trim().length > 0) return text;
  }
  return "";
}

function capText(text: string, cap: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= cap) return trimmed;
  return `${trimmed.slice(0, cap)}\n... (truncated)`;
}

function toolCallsOf(message: Message): ToolCall[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.filter((part): part is ToolCall =>
    Boolean(part && typeof part === "object" && (part as { type?: string }).type === "toolCall"),
  );
}

function shortToolCallLine(toolCall: ToolCall): string {
  const args = (toolCall.arguments ?? {}) as Record<string, unknown>;
  const target =
    typeof args.file_path === "string"
      ? args.file_path
      : typeof args.path === "string"
        ? args.path
        : typeof args.command === "string"
          ? args.command
          : typeof args.query === "string"
            ? args.query
            : "";
  const summary = target ? ` ${String(target).slice(0, 120)}` : "";
  return `[tool-call] ${toolCall.name}${summary}`;
}

/** Index of the first message of the window covering the last N user-turns. */
function windowStartIndex(messages: readonly Message[], turns: number): number {
  let remaining = turns;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      remaining -= 1;
      if (remaining === 0) return i;
    }
  }
  return 0;
}

/** Render the trailing conversation window as a fenced evidence block. The
 *  LAST user turn is the extraction target; earlier turns exist to resolve
 *  corrections and pronouns. */
export function buildConversationWindowBlock(
  messages: readonly Message[],
  options?: { turns?: number; messageCharCap?: number; windowCharCap?: number },
): string {
  const turns = options?.turns ?? EXTRACTION_TURN_WINDOW;
  const messageCap = options?.messageCharCap ?? EXTRACTION_MESSAGE_CHAR_CAP;
  const windowCap = options?.windowCharCap ?? EXTRACTION_WINDOW_CHAR_CAP;

  const start = windowStartIndex(messages, turns);
  const lines: string[] = [];
  for (let i = start; i < messages.length; i++) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === "user") {
      const text = textOfContent(message.content);
      if (text.trim()) lines.push(`[user] ${capText(text, messageCap)}`);
      continue;
    }
    if (message.role === "assistant") {
      const text = textOfContent(message.content);
      if (text.trim()) lines.push(`[assistant] ${capText(text, messageCap)}`);
      for (const toolCall of toolCallsOf(message)) {
        lines.push(shortToolCallLine(toolCall));
      }
      continue;
    }
    if (message.role === "toolResult") {
      const status = message.isError ? "error" : "ok";
      lines.push(`[tool-result] ${message.toolName} → ${status}`);
    }
  }

  // Trim from the FRONT when over budget — the latest turn matters most.
  let body = lines.join("\n");
  while (body.length > windowCap && lines.length > 1) {
    lines.shift();
    body = `... (earlier context trimmed)\n${lines.join("\n")}`;
  }

  return ["<conversation-window>", body || "(empty)", "</conversation-window>"].join("\n");
}

const FS_MUTATION_TOOLS = new Set(["Write", "Edit", "Delete"]);
const READ_ONLY_TOOLS = new Set([
  "Read",
  "Image",
  "List",
  "Glob",
  "Grep",
  "MemoryManager",
  "WebFetch",
  "WebSearch",
]);
const BASH_MUTATION_PATTERN =
  /\b(mv|cp|rm|mkdir|touch|patch|tee)\b|sed\s+-i|>{1,2}\s*\S|git\s+(commit|checkout|branch|stash|apply|merge|rebase|cherry-pick)|\b(npm|pnpm|yarn|bun)\s+(add|install|remove|up(date|grade)?)|\bcargo\s+(add|remove)|\bpip3?\s+install/;

function isPathInsideWorkdir(rawPath: string, workdir: string): boolean {
  const path = rawPath.trim();
  if (!path) return false;
  // Relative paths from builtin tools resolve against the workdir.
  if (!path.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(path)) return true;
  const normalizedWorkdir = workdir.replace(/[\\/]+$/, "");
  return path === normalizedWorkdir || path.startsWith(`${normalizedWorkdir}/`);
}

function relativeToWorkdir(rawPath: string, workdir: string): string {
  const normalizedWorkdir = workdir.replace(/[\\/]+$/, "");
  return rawPath.startsWith(`${normalizedWorkdir}/`)
    ? rawPath.slice(normalizedWorkdir.length + 1)
    : rawPath;
}

/** Deterministic digest of successful workspace mutations in the LAST turn.
 *  Feeds the project-scope gate so the model never has to audit raw tool
 *  calls it can no longer see in the compact window. */
export function deriveWorkspaceMutations(
  messages: readonly Message[],
  workdir: string | undefined,
): string[] {
  const trimmedWorkdir = workdir?.trim();
  if (!trimmedWorkdir) return [];

  const start = windowStartIndex(messages, 1);
  const failedCallIds = new Set<string>();
  for (let i = start; i < messages.length; i++) {
    const message = messages[i];
    if (message?.role === "toolResult" && message.isError) {
      failedCallIds.add(message.toolCallId);
    }
  }

  const mutations: string[] = [];
  for (let i = start; i < messages.length; i++) {
    const message = messages[i];
    if (!message || message.role !== "assistant") continue;
    for (const toolCall of toolCallsOf(message as AssistantMessage)) {
      if (failedCallIds.has(toolCall.id)) continue;
      const args = (toolCall.arguments ?? {}) as Record<string, unknown>;

      if (FS_MUTATION_TOOLS.has(toolCall.name)) {
        const path = typeof args.file_path === "string" ? args.file_path : "";
        if (path && isPathInsideWorkdir(path, trimmedWorkdir)) {
          mutations.push(`${toolCall.name} ${relativeToWorkdir(path, trimmedWorkdir)}`);
        }
        continue;
      }

      if (toolCall.name === "Bash") {
        const command = typeof args.command === "string" ? args.command : "";
        if (command && BASH_MUTATION_PATTERN.test(command)) {
          mutations.push(`Bash: ${command.slice(0, 120)}`);
        }
        continue;
      }

      if (READ_ONLY_TOOLS.has(toolCall.name)) continue;

      // Unknown (likely MCP) tool: count it only when it names a workspace path.
      const path =
        typeof args.file_path === "string"
          ? args.file_path
          : typeof args.path === "string"
            ? args.path
            : "";
      if (path && isPathInsideWorkdir(path, trimmedWorkdir)) {
        mutations.push(`${toolCall.name} ${relativeToWorkdir(path, trimmedWorkdir)}`);
      }
    }
  }
  return mutations.slice(0, 16);
}
