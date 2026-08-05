import {
  SUBAGENT_BROADCAST_RECIPIENT,
  SUBAGENT_PARENT_ID,
  type SubagentMessageRecord,
} from "./types";

const DEFAULT_MAX_MESSAGES = 24;
const DEFAULT_MAX_BODY_CHARS = 2_400;

function normalizeAgentId(value: string | undefined) {
  return (value ?? "").trim();
}

function escapeInlineCode(value: string) {
  return value.replace(/`/g, "\\`");
}

function escapeInlineMarkdown(value: string) {
  return value.replace(/[`*_{}[\]()#+\-.!|>]/g, "\\$&");
}

function displayAgentLabel(agentId: string | undefined, displayName?: string) {
  const id = normalizeAgentId(agentId) || "unknown";
  const name = displayName?.trim();
  if (!name || name === id) return `\`${escapeInlineCode(id)}\``;
  return `**${escapeInlineMarkdown(name)}** (\`${escapeInlineCode(id)}\`)`;
}

function truncateMarkdown(value: string, maxChars: number) {
  const text = value.trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 40)).trimEnd()}\n\n[message truncated; original chars=${text.length}]`;
}

function quoteMarkdown(value: string) {
  const text = value.trim();
  if (!text) return "> (empty)";
  return text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

function isSharedMessage(message: SubagentMessageRecord) {
  return message.recipientId === SUBAGENT_BROADCAST_RECIPIENT;
}

function isForAgent(message: SubagentMessageRecord, agentId: string) {
  return message.recipientId === agentId;
}

function sortBySeq(messages: SubagentMessageRecord[]) {
  return messages.slice().sort((a, b) => a.seq - b.seq);
}

function renderMessage(message: SubagentMessageRecord, maxBodyChars: number) {
  const from = displayAgentLabel(message.senderId, message.senderName);
  const to = displayAgentLabel(message.recipientId, message.recipientName);
  const subject = message.subject?.trim();
  return [
    `#### #${message.seq} ${from} -> ${to}`,
    `- Channel: ${message.channel}`,
    subject ? `- Subject: ${escapeInlineMarkdown(subject)}` : "",
    `- Created at: ${new Date(message.createdAt).toISOString()}`,
    "",
    quoteMarkdown(truncateMarkdown(message.bodyMarkdown, maxBodyChars)),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function takeLatest(messages: SubagentMessageRecord[], limit: number) {
  if (messages.length <= limit) return messages;
  return messages.slice(messages.length - limit);
}

export function displayRecipientLabel(recipientId: string) {
  if (recipientId === SUBAGENT_PARENT_ID) return "parent";
  if (recipientId === SUBAGENT_BROADCAST_RECIPIENT) return "all agents";
  return recipientId;
}

/**
 * Render a bounded Markdown snapshot of the conversation-level message bus
 * for one agent. Delivery is pull-based: this snapshot is injected into the
 * agent's context at turn boundaries.
 */
export function renderMessageBusSnapshot(params: {
  messages: SubagentMessageRecord[];
  currentAgentId: string;
  currentAgentName?: string;
  maxMessages?: number;
  maxBodyChars?: number;
}) {
  const currentAgentId = normalizeAgentId(params.currentAgentId);
  if (!currentAgentId) return "";

  const maxMessages = params.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxBodyChars = params.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  const messages = sortBySeq(params.messages).filter(
    (message) =>
      message.parentConversationId.trim() &&
      message.bodyMarkdown.trim() &&
      (isForAgent(message, currentAgentId) ||
        isSharedMessage(message) ||
        message.senderId === currentAgentId),
  );
  if (messages.length === 0) return "";

  const usedSeqs = new Set<number>();
  let remainingMessages = maxMessages;
  const consume = (items: SubagentMessageRecord[]) => {
    if (remainingMessages <= 0) return [];
    const fresh = items.filter((message) => !usedSeqs.has(message.seq));
    for (const message of fresh) usedSeqs.add(message.seq);
    const selected = takeLatest(fresh, remainingMessages);
    remainingMessages -= selected.length;
    return selected;
  };

  const directInbox = consume(messages.filter((message) => isForAgent(message, currentAgentId)));
  const sharedDecisions = consume(
    messages.filter((message) => message.channel === "decision" && isSharedMessage(message)),
  );
  const openQuestions = consume(
    messages.filter(
      (message) =>
        message.channel === "question" &&
        (isForAgent(message, currentAgentId) || isSharedMessage(message)),
    ),
  );
  const recentMessages = consume(takeLatest(messages, maxMessages));

  const sections: string[] = [
    "## LiveAgent Message Bus",
    "",
    `Current agent: ${displayAgentLabel(currentAgentId, params.currentAgentName)}`,
    "Messages below are a Markdown snapshot of the conversation-level bus. Use the SendMessage tool for new cross-agent messages; do not write temporary files for communication.",
  ];

  const appendSection = (title: string, items: SubagentMessageRecord[]) => {
    if (items.length === 0) return;
    sections.push(
      "",
      `### ${title}`,
      "",
      ...items.map((message) => renderMessage(message, maxBodyChars)).flatMap((text) => [text, ""]),
    );
  };

  appendSection(
    `Direct Inbox for ${params.currentAgentName?.trim() || currentAgentId}`,
    directInbox,
  );
  appendSection("Shared Decisions", sharedDecisions);
  appendSection("Open Questions", openQuestions);
  appendSection("Recent Messages", recentMessages);

  return sections.join("\n").trim();
}
