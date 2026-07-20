export type ConversationExportMessage = {
  role: string;
  text: string;
};

export type ConversationCostSummary = {
  total: number;
  hasCost: boolean;
};

/** Minimal transcript shapes used by WebUI export / usage / cost helpers. */
export type TranscriptExportBlock = {
  kind?: string;
  text?: string;
  item?: {
    toolCall?: {
      name?: unknown;
      arguments?: unknown;
      [key: string]: unknown;
    };
    toolResult?: {
      content?: unknown;
      details?: unknown;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type TranscriptExportRound = {
  blocks?: readonly TranscriptExportBlock[];
  meta?: {
    usage?: {
      cost?: { total?: unknown };
      [key: string]: unknown;
    };
  };
};

export type TranscriptExportAttachment = {
  fileName?: string;
  relativePath?: string;
  [key: string]: unknown;
};

export type TranscriptExportRow =
  | { kind: "user"; text: string; attachments?: readonly TranscriptExportAttachment[] }
  | { kind: "assistant"; rounds?: readonly TranscriptExportRound[] }
  | { kind: "checkpoint"; content: string }
  | { kind: string; [key: string]: unknown };

export type TranscriptCollectedMessage = {
  role: string;
  content: string;
  usage?: unknown;
};

/** Message shapes suitable for `estimateContextUsage` (includes tool/thinking blocks). */
export type TranscriptContextMessage = {
  role: string;
  content: unknown;
  details?: unknown;
  usage?: unknown;
};

export type ActiveTranscriptContext = {
  /** Messages after the latest checkpoint (model-visible window). */
  messages: TranscriptContextMessage[];
  /** Latest checkpoint summary text, if any (folded into system prompt by the meter). */
  summaryText: string | null;
};

/** Extract visible assistant text from UiRound-style blocks. */
export function extractUiRoundText(
  round: TranscriptExportRound | null | undefined,
  options?: { includeThinking?: boolean },
): string {
  if (!round || !Array.isArray(round.blocks)) return "";
  const includeThinking = options?.includeThinking === true;
  const parts: string[] = [];
  for (const block of round.blocks) {
    if (!block || typeof block.text !== "string") continue;
    const text = block.text.trim();
    if (!text) continue;
    if (block.kind === "text") {
      parts.push(text);
      continue;
    }
    if (includeThinking && block.kind === "thinking") {
      parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

function formatAttachmentLines(attachments: readonly TranscriptExportAttachment[] | undefined): string {
  if (!Array.isArray(attachments) || attachments.length === 0) return "";
  const lines: string[] = [];
  for (const file of attachments) {
    if (!file || typeof file !== "object") continue;
    const name =
      (typeof file.fileName === "string" && file.fileName.trim()) ||
      (typeof file.relativePath === "string" && file.relativePath.trim()) ||
      "";
    if (name) lines.push(`[attachment:${name}]`);
  }
  return lines.join("\n");
}

function formatUserExportText(
  text: string | null | undefined,
  attachments?: readonly TranscriptExportAttachment[] | null,
): string {
  const body = typeof text === "string" ? text.trim() : "";
  const files = formatAttachmentLines(attachments ?? undefined);
  if (body && files) return `${body}\n${files}`;
  return body || files;
}

/**
 * Flatten virtualized transcript rows into messages for cost + markdown export.
 * Assistant rounds contribute visible text from `blocks` and optional `meta.usage` for cost.
 * Usage-only tool rounds keep empty content so cost still aggregates while export skips them.
 */
export function collectMessagesFromTranscriptRows(
  rows: readonly TranscriptExportRow[] | null | undefined,
): TranscriptCollectedMessage[] {
  if (!Array.isArray(rows)) return [];
  const out: TranscriptCollectedMessage[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    if (row.kind === "user") {
      const attachments = Array.isArray(row.attachments)
        ? (row.attachments as readonly TranscriptExportAttachment[])
        : undefined;
      const content = formatUserExportText(typeof row.text === "string" ? row.text : "", attachments);
      // Keep attachment-only turns (empty text) in the export.
      if (content) out.push({ role: "user", content });
      continue;
    }
    if (row.kind === "assistant") {
      const rounds = Array.isArray(row.rounds) ? row.rounds : [];
      for (const round of rounds) {
        const text = extractUiRoundText(round);
        const usage = round?.meta?.usage;
        if (!text && !usage) continue;
        // Do not invent "[assistant]" placeholders for tool-only / usage-only rounds.
        // Empty content is still kept so sumConversationCost can read `usage`.
        out.push({
          role: "assistant",
          content: text,
          usage,
        });
      }
      continue;
    }
    if (row.kind === "checkpoint") {
      const content = typeof row.content === "string" ? row.content.trim() : "";
      if (content) out.push({ role: "assistant", content });
    }
  }
  return out;
}

function pushContextBlocksFromRound(
  out: TranscriptContextMessage[],
  round: TranscriptExportRound | null | undefined,
): void {
  if (!round) return;
  // Gather the full assistant generation (text/thinking/toolCalls) first, then
  // emit tool results. round.meta.usage covers that generation only; anchoring
  // usage on the assistant message keeps tool output after the anchor while
  // avoiding double-counting later toolCalls/text that belong to the same round.
  const content: Array<Record<string, unknown>> = [];
  const toolResults: Array<{ content: unknown; details: unknown }> = [];
  const blocks = Array.isArray(round.blocks) ? round.blocks : [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.kind === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text });
      continue;
    }
    if (block.kind === "thinking" && typeof block.text === "string") {
      content.push({ type: "thinking", thinking: block.text });
      continue;
    }
    if (block.kind === "tool") {
      const toolCall = block.item?.toolCall;
      if (toolCall && typeof toolCall === "object") {
        content.push({
          type: "toolCall",
          name: typeof toolCall.name === "string" ? toolCall.name : "tool",
          arguments: toolCall.arguments,
        });
      }
      const toolResult = block.item?.toolResult;
      if (toolResult && typeof toolResult === "object") {
        toolResults.push({
          content: toolResult.content ?? "",
          details: toolResult.details,
        });
      }
      continue;
    }
    if (block.kind === "hostedSearch") {
      try {
        content.push({ type: "text", text: JSON.stringify(block.item ?? block) });
      } catch {
        content.push({ type: "text", text: "[hostedSearch]" });
      }
    }
  }
  if (content.length > 0) {
    out.push({
      role: "assistant",
      content,
      usage: round.meta?.usage,
    });
  } else if (round.meta?.usage) {
    // Usage-only round (no visible text/tools) — keep for cost meters only.
    out.push({
      role: "assistant",
      content: "",
      usage: round.meta.usage,
    });
  }
  for (const toolResult of toolResults) {
    out.push({
      role: "toolResult",
      content: toolResult.content,
      details: toolResult.details,
    });
  }
}

/**
 * Collect the model-visible active context window from transcript rows:
 * only messages after the latest checkpoint, including thinking / tool blocks.
 * Checkpoint summary is returned separately so callers can fold it into system prompt.
 */
export function collectActiveContextFromTranscriptRows(
  rows: readonly TranscriptExportRow[] | null | undefined,
): ActiveTranscriptContext {
  if (!Array.isArray(rows)) return { messages: [], summaryText: null };

  let lastCheckpointIndex = -1;
  let summaryText: string | null = null;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || typeof row !== "object") continue;
    if (row.kind === "checkpoint") {
      lastCheckpointIndex = i;
      const content = typeof row.content === "string" ? row.content.trim() : "";
      summaryText = content || null;
    }
  }

  const activeRows = lastCheckpointIndex >= 0 ? rows.slice(lastCheckpointIndex + 1) : rows;
  const messages: TranscriptContextMessage[] = [];
  for (const row of activeRows) {
    if (!row || typeof row !== "object") continue;
    if (row.kind === "user") {
      const text = typeof row.text === "string" ? row.text : "";
      if (text.trim()) messages.push({ role: "user", content: text });
      continue;
    }
    if (row.kind === "assistant") {
      const rounds = Array.isArray(row.rounds) ? row.rounds : [];
      for (const round of rounds) {
        pushContextBlocksFromRound(messages, round);
      }
    }
  }
  return { messages, summaryText };
}

function normalizeRoleLabel(role: string): string {
  const normalized = role.trim().toLowerCase();
  if (normalized === "user") return "User";
  if (normalized === "assistant") return "Assistant";
  if (normalized === "system") return "System";
  if (normalized === "tool" || normalized === "toolresult") return "Tool";
  return role.trim() || "Message";
}

function sanitizeFilenamePart(value: string): string {
  const cleaned = value
    .trim()
    .split("")
    .map((char) => {
      const code = char.charCodeAt(0);
      if (code < 32) return " ";
      if ('<>:"/\\|?*'.includes(char)) return " ";
      return char;
    })
    .join("")
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .trim();
  return cleaned || "conversation";
}

const DISPLAY_CONTENT_FIELD = "liveAgentDisplayContent";
const ATTACHMENTS_FIELD = "liveAgentAttachments";

function attachmentsFromMessage(message: Record<string, unknown>): TranscriptExportAttachment[] {
  const raw = message[ATTACHMENTS_FIELD];
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is TranscriptExportAttachment => !!item && typeof item === "object");
}

/** Extract plain text from common LiveAgent / pi-ai message shapes. */
export function extractMessagePlainText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const record = message as Record<string, unknown> & {
    role?: unknown;
    content?: unknown;
  };

  // Prefer user-visible text for attachment turns (model content may include file directives).
  const displayContent = record[DISPLAY_CONTENT_FIELD];
  const attachments = attachmentsFromMessage(record);
  if (typeof displayContent === "string" || attachments.length > 0) {
    return formatUserExportText(
      typeof displayContent === "string" ? displayContent : "",
      attachments,
    );
  }

  const content = record.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as {
      type?: unknown;
      text?: unknown;
      thinking?: unknown;
      name?: unknown;
    };
    if (typed.type === "text" && typeof typed.text === "string") {
      parts.push(typed.text);
      continue;
    }
    if (typed.type === "thinking" && typeof typed.thinking === "string") {
      // Skip raw thinking in exports by default.
      continue;
    }
    if (typed.type === "toolCall" && typeof typed.name === "string") {
      parts.push(`[tool:${typed.name}]`);
    }
  }
  return parts.join("\n").trim();
}

export function collectExportMessages(
  messages: readonly unknown[] | null | undefined,
): ConversationExportMessage[] {
  if (!Array.isArray(messages)) return [];
  const out: ConversationExportMessage[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role =
      typeof (message as { role?: unknown }).role === "string"
        ? String((message as { role: string }).role)
        : "message";
    // Skip pure tool results in user-facing export.
    if (role === "toolResult" || role === "tool") continue;
    const text = extractMessagePlainText(message);
    // Also skip usage-only assistant placeholders (empty content kept for cost).
    if (!text) continue;
    out.push({ role, text });
  }
  return out;
}

export function conversationToMarkdown(params: {
  title?: string | null;
  messages: readonly ConversationExportMessage[];
  exportedAt?: Date | string | number;
}): string {
  const title = (params.title ?? "").trim() || "Conversation";
  const exportedAt =
    params.exportedAt instanceof Date
      ? params.exportedAt
      : params.exportedAt
        ? new Date(params.exportedAt)
        : new Date();
  const timestamp = Number.isNaN(exportedAt.getTime())
    ? new Date().toISOString()
    : exportedAt.toISOString();

  const lines: string[] = [`# ${title}`, "", `Exported: ${timestamp}`, ""];

  if (params.messages.length === 0) {
    lines.push("_No messages._", "");
    return lines.join("\n");
  }

  for (const message of params.messages) {
    lines.push(`## ${normalizeRoleLabel(message.role)}`, "", message.text.trim(), "");
  }
  return lines.join("\n");
}

export function buildConversationExportFilename(title?: string | null, at = new Date()): string {
  const stamp = Number.isNaN(at.getTime())
    ? "export"
    : at.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${sanitizeFilenamePart(title ?? "conversation")}-${stamp}.md`;
}

export function sumConversationCost(
  messages: readonly unknown[] | null | undefined,
): ConversationCostSummary {
  if (!Array.isArray(messages)) return { total: 0, hasCost: false };
  let total = 0;
  let hasCost = false;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const usage = (message as { usage?: { cost?: { total?: unknown } } }).usage;
    const costTotal = usage?.cost?.total;
    if (typeof costTotal === "number" && Number.isFinite(costTotal) && costTotal > 0) {
      total += costTotal;
      hasCost = true;
    }
  }
  return { total, hasCost };
}

export function formatUsdCost(total: number, locale = "en-US"): string {
  if (!Number.isFinite(total) || total <= 0) return "$0";
  const maximumFractionDigits = total >= 1 ? 2 : total >= 0.01 ? 4 : 6;
  return `$${new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  }).format(total)}`;
}

/** Trigger a browser download for markdown content. */
export function downloadTextFile(filename: string, content: string, mime = "text/markdown") {
  if (typeof document === "undefined") {
    throw new Error("downloadTextFile requires a DOM document");
  }
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Delay revoke so the download can start in slower webviews.
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
