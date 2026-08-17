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

/**
 * 快照与增量共用的可见性口径：按 seq 升序，过滤掉空消息，只保留发给本 agent、
 * 广播给全体、或由本 agent 发出的消息。两处必须同口径，否则增量会漏投或重投。
 */
function visibleBusMessages(messages: SubagentMessageRecord[], currentAgentId: string) {
  return sortBySeq(messages).filter(
    (message) =>
      message.parentConversationId.trim() &&
      message.bodyMarkdown.trim() &&
      (isForAgent(message, currentAgentId) ||
        isSharedMessage(message) ||
        message.senderId === currentAgentId),
  );
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
 *
 * 快照最多渲染 maxMessages 条，可见消息超限时会有消息未被渲染。返回值里的
 * `renderedSeq` 是「可见消息按 seq 升序的连续已渲染前缀」的最大 seq——冻结
 * 游标必须用它而不是全体可见消息的最大 seq，否则被配额挤掉的消息会被游标
 * 跳过、静默丢失。未渲染的消息留给后续 `renderMessageBusDelta` 增量补投。
 */
export function renderMessageBusSnapshot(params: {
  messages: SubagentMessageRecord[];
  currentAgentId: string;
  currentAgentName?: string;
  maxMessages?: number;
  maxBodyChars?: number;
}): { text: string; renderedSeq: number; omittedCount: number } {
  const currentAgentId = normalizeAgentId(params.currentAgentId);
  if (!currentAgentId) return { text: "", renderedSeq: 0, omittedCount: 0 };

  const maxMessages = params.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxBodyChars = params.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  const messages = visibleBusMessages(params.messages, currentAgentId);
  if (messages.length === 0) return { text: "", renderedSeq: 0, omittedCount: 0 };

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

  // 真正渲染进快照的集合是四个 selected 的并集；usedSeqs 会被 consume 标记
  // 到未入选的 fresh 消息上，不能当渲染集用。
  const renderedSeqs = new Set<number>();
  for (const bucket of [directInbox, sharedDecisions, openQuestions, recentMessages]) {
    for (const message of bucket) renderedSeqs.add(message.seq);
  }
  // 连续已渲染前缀：从最小 seq 起逐条推进，遇到第一条未渲染的可见消息即停。
  let renderedSeq = 0;
  for (const message of messages) {
    if (!renderedSeqs.has(message.seq)) break;
    renderedSeq = message.seq;
  }
  const omittedCount = messages.length - renderedSeqs.size;

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

  if (omittedCount > 0) {
    // 诚实标注省略，避免读者把快照误当全量；未渲染的消息由 delta 按 renderedSeq 补投。
    sections.push(
      "",
      `(${omittedCount} messages omitted; unrendered messages will be re-delivered via delta)`,
    );
  }

  return { text: sections.join("\n").trim(), renderedSeq, omittedCount };
}

/**
 * 渲染 seq 大于 sinceSeq 的增量消息。
 *
 * systemPrompt 里的快照按压缩纪元冻结，run 内新到的消息不回头改写 systemPrompt，
 * 而是由本函数渲染成一段增量文本挂到消息尾部投递——尾部本就在缓存断点之后、
 * 每轮重读，追加不额外损失命中率。
 *
 * 纯函数：不含时间量、不含随机量，同样输入恒等输出。无新增时返回
 * `{ text: "", lastSeq: sinceSeq }`，调用方据此完全不产生额外内容。
 */
export function renderMessageBusDelta(params: {
  messages: SubagentMessageRecord[];
  sinceSeq: number;
  currentAgentId: string;
  currentAgentName?: string;
  maxBodyChars?: number;
}): { text: string; lastSeq: number } {
  const sinceSeq = Number.isFinite(params.sinceSeq) ? params.sinceSeq : 0;
  const currentAgentId = normalizeAgentId(params.currentAgentId);
  if (!currentAgentId) return { text: "", lastSeq: sinceSeq };

  const maxBodyChars = params.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  const fresh = visibleBusMessages(params.messages, currentAgentId).filter(
    (message) => message.seq > sinceSeq,
  );
  if (fresh.length === 0) return { text: "", lastSeq: sinceSeq };

  const text = [
    "## LiveAgent Message Bus (new messages)",
    "",
    `Current agent: ${displayAgentLabel(currentAgentId, params.currentAgentName)}`,
    "Messages below arrived after the snapshot in the system prompt. Use the SendMessage tool for new cross-agent messages; do not write temporary files for communication.",
    "",
    ...fresh.map((message) => renderMessage(message, maxBodyChars)).flatMap((body) => [body, ""]),
  ]
    .join("\n")
    .trim();

  return { text, lastSeq: fresh[fresh.length - 1].seq };
}
